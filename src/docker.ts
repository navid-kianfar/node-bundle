import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { BuildArtifact, DetectResult, ResolvedConfig } from './types.js'
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

function writeDockerfile(contextDir: string, nodeRange: string): string {
  const dockerfile = `# syntax=docker/dockerfile:1
FROM node:${nodeRange}-bookworm

# Toolchain for building native addons during the target install
RUN apt-get update \\
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \\
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /opt/node-bundle
COPY package.json ./
COPY dist ./dist
RUN npm install --omit=dev --no-audit --no-fund

ENV NODE_BUNDLE_IN_DOCKER=1
ENTRYPOINT ["node", "/opt/node-bundle/dist/cli.cjs"]
`
  const dfPath = path.join(contextDir, 'Dockerfile')
  fs.writeFileSync(dfPath, dockerfile)
  return dfPath
}

/** Build the args for the inner (in-container) node-bundle invocation. */
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

  const nonLinux = config.targets.filter((t) => t.platform !== 'linux')
  if (nonLinux.length) {
    throw new Error(
      `Docker mode only builds linux targets (got ${nonLinux
        .map((t) => `${t.platform}-${t.arch}`)
        .join(', ')}). Use --mode host for macOS/Windows targets.`,
    )
  }

  const root = toolRoot()
  const contextDir = path.join(config.projectDir, '.node-bundle', 'docker-ctx')
  fs.rmSync(contextDir, { recursive: true, force: true })
  fs.mkdirSync(contextDir, { recursive: true })
  fs.copyFileSync(path.join(root, 'package.json'), path.join(contextDir, 'package.json'))
  fs.cpSync(path.join(root, 'dist'), path.join(contextDir, 'dist'), { recursive: true })
  writeDockerfile(contextDir, config.nodeRange)

  fs.mkdirSync(config.outDir, { recursive: true })

  const host = hostTarget()
  const artifacts: BuildArtifact[] = []

  for (const t of config.targets) {
    const platformFlag = `linux/${t.arch === 'x64' ? 'amd64' : t.arch}`
    const image = `node-bundle-builder:node${config.nodeRange}-${t.arch}`
    const emulated = host.arch !== t.arch

    log.step(`Docker build: ${pc.bold(`${t.platform}-${t.arch}`)}${emulated ? pc.dim(' (emulated)') : ''}`)
    log.group(() => {
      log.info(`Builder image: ${image}`)
      execSync(`docker build --platform ${platformFlag} -t ${image} ${JSON.stringify(contextDir)}`, {
        stdio: 'inherit',
      })
    })

    log.step(`Pack in container: ${pc.bold(`${t.platform}-${t.arch}`)}`)
    const runArgs = [
      'run',
      '--rm',
      '--platform',
      platformFlag,
      '-v',
      `${config.projectDir}:/work/project:ro`,
      '-v',
      `${config.outDir}:/work/out`,
      '-v',
      'node-bundle-pkgcache:/root/.pkg-cache',
      image,
      ...innerArgs(config, t.arch),
    ]
    execFileSync('docker', runArgs, { stdio: 'inherit' })

    const outName = `${config.name}-${t.platform}-${t.arch}${config.ext}`
    const outFile = path.join(config.outDir, outName)
    const exists = fs.existsSync(outFile)
    if (exists) fs.chmodSync(outFile, 0o755)
    artifacts.push({ target: t, path: outFile, size: exists ? fs.statSync(outFile).size : 0 })
  }

  if (!config.keepTemp) {
    fs.rmSync(path.join(config.projectDir, '.node-bundle'), { recursive: true, force: true })
  }

  return { artifacts, bytecodeFailures: [], warnings: [] }
}
