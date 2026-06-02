import path from 'node:path'
import fs from 'node:fs'
import { Command, Option } from 'commander'
import pkgJson from '../package.json' with { type: 'json' }
import { log, pc } from './logger.js'
import { detect } from './detect.js'
import { resolveConfig, type CliOptions } from './config.js'
import { decideMode, runHost, summarize, type RunResult } from './orchestrate.js'
import { runDocker, runMonorepoDocker } from './docker.js'
import { findWorkspaceRoot, readPackageName, runMonorepoDeploy } from './monorepo.js'
import type { ResolvedConfig } from './types.js'

type Options = CliOptions & {
  analyze?: boolean
  monorepo?: boolean
  workspaceInclude?: string
  monorepoDeploy?: boolean
  monorepoRoot?: string
  monorepoPkg?: string
}

function splitList(v?: string): string[] | undefined {
  if (!v) return undefined
  const out = v.split(',').map((s) => s.trim()).filter(Boolean)
  return out.length ? out : undefined
}

function printReport(projectDir: string, detected: Awaited<ReturnType<typeof detect>>): void {
  log.step('Analysis')
  log.group(() => {
    log.info(`Project:        ${projectDir}`)
    log.info(`Package mgr:    ${detected.packageManager}`)
    log.info(`Language:       ${detected.isTypeScript ? 'TypeScript' : 'JavaScript'}`)
    log.info(`Module type:    ${detected.moduleType}`)
    log.info(`Build tooling:  ${detected.frameworks.join(', ') || '(none detected)'}`)
    log.info(`Build command:  ${detected.buildCommand ?? '(none — assuming prebuilt JS)'}`)
    log.info(`Native addons:  ${detected.natives.join(', ') || '(none)'}`)
    const existing = detected.entryCandidates.filter((c) => fs.existsSync(c))
    log.info(`Entry (found):  ${existing[0] ? path.relative(projectDir, existing[0]) : '(none yet — build first)'}`)
    const ws = findWorkspaceRoot(projectDir)
    if (ws) log.info(`Workspace root: ${ws} ${pc.dim('(use --monorepo)')}`)
  })
}

function printPlan(mode: string, autoNote: string, config: ResolvedConfig): void {
  log.step('Plan')
  log.group(() => {
    log.info(`Mode:        ${mode}${autoNote}`)
    log.info(`Targets:     ${config.targets.map((t) => `${t.platform}-${t.arch}`).join(', ')}`)
    log.info(`Node:        ${config.nodeRange}`)
    log.info(`Protection:  bytecode=${config.bytecode}, obfuscate=${config.obfuscate}`)
    log.info(`Output:      ${config.outDir}`)
  })
  log.plain('')
}

async function main(): Promise<void> {
  const program = new Command()
  program
    .name('node-bundle')
    .description(
      'Bundle & protect a Node.js app into a single bytecode-compiled executable, per architecture.',
    )
    .version(pkgJson.version)
    .argument('[projectDir]', 'path to the Node.js project (or workspace package) to bundle', '.')
    .option('-o, --out <dir>', 'output directory (default: <project>/node-bundle-out)')
    .option('-n, --name <name>', 'output binary base name (default: package.json name)')
    .option('--ext <ext>', 'cosmetic extension for outputs, e.g. ".node"')
    .option('--node <version>', 'Node major version to embed (default: 22)')
    .option('-t, --targets <list>', 'comma list of targets, e.g. "linux-x64,linux-arm64" or "amd64,arm64"')
    .addOption(new Option('-m, --mode <mode>', 'build mode').choices(['auto', 'host', 'docker']))
    .addOption(new Option('--obfuscate <level>', 'obfuscation level').choices(['off', 'safe', 'aggressive']))
    .option('--no-bytecode', 'disable V8 bytecode compilation (debug only)')
    .option('--no-build', "skip the project's own build step")
    .option('--build-command <cmd>', 'override the detected build command')
    .option('--entry <file>', 'override the (post-build) entry file')
    .option('--assets <globs>', 'comma list of extra file globs to embed (pkg assets)')
    .option('--external <pkgs>', 'comma list of extra packages to keep out of the bundle')
    .option('--fresh-install', 'copy project to temp and reinstall deps before building')
    .option('--keep-temp', 'keep the .node-bundle working directory')
    .option('--esbuild-target <t>', 'esbuild target (default: node<version>)')
    .option('--analyze', 'detect & print a report, then exit (no build)')
    .option('--monorepo', 'treat target as a pnpm-workspace package (build via pnpm deploy)')
    .option('--workspace-include <list>', 'monorepo: only copy these top-level subtrees (faster)')
    // Internal flags used by the in-container monorepo step.
    .addOption(new Option('--monorepo-deploy', 'internal').hideHelp())
    .addOption(new Option('--monorepo-root <dir>', 'internal').hideHelp())
    .addOption(new Option('--monorepo-pkg <name>', 'internal').hideHelp())
    .action(async (projectDirArg: string, opts: Options) => {
      // ── Internal: runs INSIDE the per-arch container. Deploy the workspace
      //    package to a self-contained dir, then bundle it with the host pipeline.
      if (opts.monorepoDeploy) {
        const appDir = runMonorepoDeploy({
          root: opts.monorepoRoot!,
          pkg: opts.monorepoPkg!,
          include: splitList(opts.workspaceInclude),
        })
        const det = await detect(appDir)
        const cfg = resolveConfig(appDir, { ...opts, build: false }, det)
        const res = await runHost(cfg, det)
        if (!process.env.NODE_BUNDLE_IN_DOCKER) summarize(res, cfg)
        if (res.artifacts.some((a) => a.size === 0)) process.exitCode = 1
        return
      }

      const projectDir = path.resolve(process.cwd(), projectDirArg)
      if (!fs.existsSync(projectDir)) throw new Error(`Project directory not found: ${projectDir}`)

      const detected = await detect(projectDir, opts.entry)

      if (opts.analyze) {
        printReport(projectDir, detected)
        return
      }

      // ── Monorepo: orchestrate per-arch deploy+bundle inside containers.
      if (opts.monorepo) {
        const workspaceRoot = findWorkspaceRoot(projectDir)
        if (!workspaceRoot) {
          throw new Error(`--monorepo: no pnpm-workspace.yaml found at or above ${projectDir}`)
        }
        const packageName = readPackageName(projectDir)
        if (!packageName) throw new Error(`--monorepo: no "name" in ${projectDir}/package.json`)

        const config = resolveConfig(projectDir, opts, detected)
        printPlan('docker', pc.dim(` (monorepo: ${packageName})`), config)
        const result = await runMonorepoDocker(config, {
          workspaceRoot,
          packageName,
          include: splitList(opts.workspaceInclude),
        })
        summarize(result, config)
        if (result.artifacts.some((a) => a.size === 0)) process.exitCode = 1
        return
      }

      // ── Standard single-package flow.
      const config = resolveConfig(projectDir, opts, detected)
      const mode = decideMode(config)
      const inDocker = !!process.env.NODE_BUNDLE_IN_DOCKER
      if (!inDocker) printPlan(mode, config.mode === 'auto' ? pc.dim(' (auto)') : '', config)

      const result: RunResult =
        mode === 'docker' ? await runDocker(config, detected) : await runHost(config, detected)
      if (!inDocker) summarize(result, config)
      if (result.artifacts.some((a) => a.size === 0)) process.exitCode = 1
    })

  await program.parseAsync(process.argv)
}

main().catch((err: unknown) => {
  log.plain('')
  log.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
