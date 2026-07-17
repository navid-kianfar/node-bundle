import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BuildArtifact, DetectResult, ResolvedConfig, Target } from './types.js'
import { log, pc } from './logger.js'
import type { RunResult } from './orchestrate.js'
import { hostTarget } from './orchestrate.js'

function dockerAvailable(): boolean {
  try {
    execSync('docker version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Locate the installed tool root (the dir holding dist/ and package.json). */
function toolRoot(): string {
  // At runtime this module is bundled into dist/cli.cjs, so __dirname === <root>/dist
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist', 'cli.cjs'))) {
    throw new Error(
      'Docker mode needs the built tool (dist/cli.cjs). Run `pnpm build` in node-bundle first.',
    )
  }
  return root
}

function writeDockerfile(contextDir: string, nodeRange: string): void {
  const dockerfile = `# syntax=docker/dockerfile:1
FROM node:${nodeRange}-bookworm

# Toolchain for native addons (node-gyp) + git for git-hosted transitive deps,
# + corepack so the target project's pinned pnpm/yarn is available.
RUN apt-get update \\
 && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \\
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /opt/node-bundle
# package.json + install first so tool-code changes don't re-install deps
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY dist ./dist

ENV NODE_BUNDLE_IN_DOCKER=1
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENTRYPOINT ["node", "/opt/node-bundle/dist/cli.cjs"]
`
  fs.writeFileSync(path.join(contextDir, 'Dockerfile'), dockerfile)
}

/** Create the builder build-context (tool dist + Dockerfile) outside any project. */
function setupBuilderContext(nodeRange: string): string {
  const root = toolRoot()
  const contextDir = path.join(os.tmpdir(), 'node-bundle-docker-ctx')
  fs.rmSync(contextDir, { recursive: true, force: true })
  fs.mkdirSync(contextDir, { recursive: true })
  fs.copyFileSync(path.join(root, 'package.json'), path.join(contextDir, 'package.json'))
  fs.cpSync(path.join(root, 'dist'), path.join(contextDir, 'dist'), { recursive: true })
  writeDockerfile(contextDir, nodeRange)
  return contextDir
}

function platformFlagFor(t: Target): string {
  return `linux/${t.arch === 'x64' ? 'amd64' : t.arch}`
}

function ensureLinuxTargets(config: ResolvedConfig): void {
  const nonLinux = config.targets.filter((t) => t.platform !== 'linux')
  if (nonLinux.length) {
    throw new Error(
      `Docker mode only builds linux targets (got ${nonLinux
        .map((t) => `${t.platform}-${t.arch}`)
        .join(', ')}). Use --mode host for macOS/Windows targets.`,
    )
  }
}

function buildBuilderImage(contextDir: string, t: Target, image: string): void {
  const host = hostTarget()
  const emulated = host.arch !== t.arch
  log.step(`Docker build: ${pc.bold(`${t.platform}-${t.arch}`)}${emulated ? pc.dim(' (emulated)') : ''}`)
  log.group(() => {
    log.info(`Builder image: ${image}`)
    execSync(`docker build --platform ${platformFlagFor(t)} -t ${image} ${JSON.stringify(contextDir)}`, {
      stdio: 'inherit',
    })
  })
}

function collectArtifact(config: ResolvedConfig, t: Target): BuildArtifact {
  const outFile = path.join(config.outDir, `${config.name}-${t.platform}-${t.arch}${config.ext}`)
  const exists = fs.existsSync(outFile)
  if (exists) fs.chmodSync(outFile, 0o755)
  return { target: t, path: outFile, size: exists ? fs.statSync(outFile).size : 0 }
}

/** Common docker run args (volumes/caches) shared by both flows. */
function baseRunArgs(config: ResolvedConfig, t: Target): string[] {
  return [
    'run',
    '--rm',
    '--platform',
    platformFlagFor(t),
    '-v',
    `${config.outDir}:/work/out`,
    '-v',
    'node-bundle-pkgcache:/root/.pkg-cache',
    '-v',
    'node-bundle-pnpmstore:/root/.local/share/pnpm',
  ]
}

/** Args for the inner single-package invocation. */
function innerArgs(config: ResolvedConfig, arch: string): string[] {
  const args = [
    '/work/project',
    '--mode',
    'host',
    '--targets',
    `linux-${arch}`,
    '--node',
    config.nodeRange,
    '--obfuscate',
    config.obfuscate,
    '--out',
    '/work/out',
    '--name',
    config.name,
    '--esbuild-target',
    config.esbuildTarget,
    '--fresh-install',
  ]
  if (config.ext) args.push('--ext', config.ext)
  if (!config.bytecode) args.push('--no-bytecode')
  if (!config.runProjectBuild) args.push('--no-build')
  if (config.buildCommand) args.push('--build-command', config.buildCommand)
  if (config.entry) args.push('--entry', config.entry)
  if (config.assets.length) args.push('--assets', config.assets.join(','))
  if (config.externals.length) args.push('--external', config.externals.join(','))
  // Static dirs are resolved on the host; pass them pre-parsed (from paths are
  // relative to the project, mounted at /work/project) to the in-container step.
  if (config.staticDirs.length) {
    args.push('--gather-json', JSON.stringify({ staticDirs: config.staticDirs }))
  }
  return args
}

/**
 * Build each target's executable inside a per-arch Linux container, so native
 * addons and V8 bytecode are produced natively for that architecture.
 */
export async function runDocker(config: ResolvedConfig, _detected: DetectResult): Promise<RunResult> {
  if (!dockerAvailable()) {
    throw new Error('Docker is required for --mode docker but `docker version` failed. Is Docker running?')
  }
  ensureLinuxTargets(config)

  const contextDir = setupBuilderContext(config.nodeRange)
  fs.mkdirSync(config.outDir, { recursive: true })
  const artifacts: BuildArtifact[] = []

  for (const t of config.targets) {
    const image = `node-bundle-builder:node${config.nodeRange}-${t.arch}`
    buildBuilderImage(contextDir, t, image)

    log.step(`Pack in container: ${pc.bold(`${t.platform}-${t.arch}`)}`)
    execFileSync(
      'docker',
      [
        ...baseRunArgs(config, t),
        '-v',
        `${config.projectDir}:/work/project:ro`,
        image,
        ...innerArgs(config, t.arch),
      ],
      { stdio: 'inherit' },
    )
    artifacts.push(collectArtifact(config, t))
  }

  if (!config.keepTemp) fs.rmSync(contextDir, { recursive: true, force: true })
  return { artifacts, bytecodeFailures: [], warnings: [] }
}

export interface MonorepoDockerOptions {
  workspaceRoot: string
  packageName: string
  include?: string[]
}

/**
 * Monorepo flow: mount the whole workspace (read-only) per arch, run the pnpm
 * install/build/deploy recipe inside the container, then bundle the deployed app.
 */
export async function runMonorepoDocker(
  config: ResolvedConfig,
  opts: MonorepoDockerOptions,
): Promise<RunResult> {
  if (!dockerAvailable()) {
    throw new Error('Docker is required for --monorepo but `docker version` failed. Is Docker running?')
  }
  ensureLinuxTargets(config)

  const contextDir = setupBuilderContext(config.nodeRange)
  fs.mkdirSync(config.outDir, { recursive: true })
  const artifacts: BuildArtifact[] = []

  for (const t of config.targets) {
    const image = `node-bundle-builder:node${config.nodeRange}-${t.arch}`
    buildBuilderImage(contextDir, t, image)

    log.step(`Deploy + pack in container: ${pc.bold(`${t.platform}-${t.arch}`)}`)
    const inner = [
      '.',
      '--monorepo-deploy',
      '--monorepo-root',
      '/work/mono',
      '--monorepo-pkg',
      opts.packageName,
      '--targets',
      `linux-${t.arch}`,
      '--node',
      config.nodeRange,
      '--obfuscate',
      config.obfuscate,
      '--out',
      '/work/out',
      '--name',
      config.name,
      '--esbuild-target',
      config.esbuildTarget,
    ]
    if (config.ext) inner.push('--ext', config.ext)
    if (!config.bytecode) inner.push('--no-bytecode')
    if (opts.include?.length) inner.push('--workspace-include', opts.include.join(','))
    // Thread the build/gather spec (e.g. the co-located frontend) into the
    // in-container deploy step, which has the whole workspace available.
    if (config.buildPackages.length || config.staticDirs.length) {
      inner.push(
        '--gather-json',
        JSON.stringify({ buildPackages: config.buildPackages, staticDirs: config.staticDirs }),
      )
    }

    execFileSync(
      'docker',
      [...baseRunArgs(config, t), '-v', `${opts.workspaceRoot}:/work/mono:ro`, image, ...inner],
      { stdio: 'inherit' },
    )
    artifacts.push(collectArtifact(config, t))
  }

  if (!config.keepTemp) fs.rmSync(contextDir, { recursive: true, force: true })
  return { artifacts, bytecodeFailures: [], warnings: [] }
}
