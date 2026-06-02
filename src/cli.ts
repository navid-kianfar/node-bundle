import path from 'node:path'
import fs from 'node:fs'
import { Command, Option } from 'commander'
import pkgJson from '../package.json' with { type: 'json' }
import { log, pc } from './logger.js'
import { detect } from './detect.js'
import { resolveConfig, type CliOptions } from './config.js'
import { decideMode, runHost, summarize } from './orchestrate.js'
import { runDocker } from './docker.js'

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
  })
}

async function main(): Promise<void> {
  const program = new Command()
  program
    .name('node-bundle')
    .description(
      'Bundle & protect a Node.js app into a single bytecode-compiled executable, per architecture.',
    )
    .version(pkgJson.version)
    .argument('[projectDir]', 'path to the Node.js project to bundle', '.')
    .option('-o, --out <dir>', 'output directory (default: <project>/node-bundle-out)')
    .option('-n, --name <name>', 'output binary base name (default: package.json name)')
    .option('--ext <ext>', 'cosmetic extension for outputs, e.g. ".node"')
    .option('--node <version>', 'Node major version to embed (default: 22)')
    .option(
      '-t, --targets <list>',
      'comma list of targets, e.g. "linux-x64,linux-arm64" or "amd64,arm64"',
    )
    .addOption(
      new Option('-m, --mode <mode>', 'build mode').choices(['auto', 'host', 'docker']),
    )
    .addOption(
      new Option('--obfuscate <level>', 'obfuscation level').choices(['off', 'safe', 'aggressive']),
    )
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
    .action(async (projectDirArg: string, opts: CliOptions & { analyze?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), projectDirArg)
      if (!fs.existsSync(projectDir)) throw new Error(`Project directory not found: ${projectDir}`)

      const detected = await detect(projectDir, opts.entry)

      if (opts.analyze) {
        printReport(projectDir, detected)
        return
      }

      const config = resolveConfig(projectDir, opts, detected)
      const mode = decideMode(config)
      const inDocker = !!process.env.NODE_BUNDLE_IN_DOCKER // suppress redundant banners in the builder container

      if (!inDocker) {
        log.step('Plan')
        log.group(() => {
          log.info(`Mode:        ${mode}${config.mode === 'auto' ? pc.dim(' (auto)') : ''}`)
          log.info(`Targets:     ${config.targets.map((t) => `${t.platform}-${t.arch}`).join(', ')}`)
          log.info(`Node:        ${config.nodeRange}`)
          log.info(`Protection:  bytecode=${config.bytecode}, obfuscate=${config.obfuscate}`)
          log.info(`Output:      ${config.outDir}`)
        })
        log.plain('')
      }

      const result = mode === 'docker' ? await runDocker(config, detected) : await runHost(config, detected)
      if (!inDocker) summarize(result, config)

      const failed = result.artifacts.filter((a) => a.size === 0)
      if (failed.length) process.exitCode = 1
    })

  await program.parseAsync(process.argv)
}

main().catch((err: unknown) => {
  log.plain('')
  log.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
