import fs from 'node:fs'
import path from 'node:path'
import type { BuildMode, DetectResult, ObfuscationLevel, ResolvedConfig, Target } from './types.js'

/** Raw options coming from the CLI (commander) or the programmatic API. */
export interface CliOptions {
  out?: string
  name?: string
  ext?: string
  node?: string
  targets?: string
  mode?: BuildMode
  obfuscate?: ObfuscationLevel
  bytecode?: boolean // false => --no-bytecode
  build?: boolean // false => --no-build
  buildCommand?: string
  entry?: string
  assets?: string
  external?: string
  freshInstall?: boolean
  keepTemp?: boolean
  esbuildTarget?: string
}

const ARCH_ALIASES: Record<string, Target['arch']> = {
  amd64: 'x64',
  x64: 'x64',
  x86_64: 'x64',
  'x86-64': 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
  armv7: 'armv7',
  armv7l: 'armv7',
  arm: 'armv7',
}

const PLATFORM_ALIASES: Record<string, Target['platform']> = {
  linux: 'linux',
  macos: 'macos',
  darwin: 'macos',
  mac: 'macos',
  win: 'win',
  windows: 'win',
  win32: 'win',
}

export function normalizeArch(token: string): Target['arch'] {
  const a = ARCH_ALIASES[token.toLowerCase()]
  if (!a) throw new Error(`Unknown architecture "${token}". Use amd64/x64, arm64/aarch64, or armv7.`)
  return a
}

/** Parse "linux-x64,arm64,amd64" into Target[]. Bare arch tokens default to linux. */
export function parseTargets(input: string): Target[] {
  const out: Target[] = []
  for (const raw of input.split(',').map((s) => s.trim()).filter(Boolean)) {
    let platform: Target['platform'] = 'linux'
    let archToken = raw
    const dash = raw.indexOf('-')
    if (dash > 0) {
      const maybePlat = PLATFORM_ALIASES[raw.slice(0, dash).toLowerCase()]
      if (maybePlat) {
        platform = maybePlat
        archToken = raw.slice(dash + 1)
      }
    }
    const arch = normalizeArch(archToken)
    if (!out.some((t) => t.platform === platform && t.arch === arch)) out.push({ platform, arch })
  }
  if (out.length === 0) throw new Error('No valid targets parsed.')
  return out
}

function sanitizeName(name: string): string {
  const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  return base.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'app'
}

function splitList(v: string | undefined): string[] {
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []
}

function loadConfigFile(projectDir: string): Partial<CliOptions> & { externals?: string[]; assets?: string[] } {
  for (const f of ['node-bundle.config.json', '.node-bundle.json']) {
    const p = path.join(projectDir, f)
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'))
      } catch (e) {
        throw new Error(`Failed to parse ${f}: ${(e as Error).message}`)
      }
    }
  }
  return {}
}

export function resolveConfig(
  projectDir: string,
  cli: CliOptions,
  detected: DetectResult,
): ResolvedConfig {
  const fileCfg = loadConfigFile(projectDir)
  const pick = <K extends keyof CliOptions>(k: K): CliOptions[K] =>
    cli[k] !== undefined ? cli[k] : (fileCfg as CliOptions)[k]

  const nodeRange = pick('node') ?? '22'
  const targetsStr = pick('targets') ?? 'linux-x64,linux-arm64'
  const pkgName = typeof detected.pkgJson.name === 'string' ? detected.pkgJson.name : 'app'

  const externals = Array.from(
    new Set([
      ...detected.natives,
      ...splitList(pick('external')),
      ...((fileCfg.externals as string[]) ?? []),
    ]),
  )

  const assets = Array.from(
    new Set([...splitList(pick('assets')), ...((fileCfg.assets as string[]) ?? [])]),
  )

  return {
    projectDir,
    outDir: path.resolve(projectDir, pick('out') ?? 'node-bundle-out'),
    name: sanitizeName(pick('name') ?? pkgName),
    ext: pick('ext') ?? '',
    nodeRange,
    targets: parseTargets(targetsStr),
    mode: pick('mode') ?? 'auto',
    obfuscate: pick('obfuscate') ?? 'safe',
    bytecode: pick('bytecode') ?? true,
    runProjectBuild: pick('build') ?? true,
    buildCommand: pick('buildCommand') ?? detected.buildCommand,
    entry: pick('entry'),
    assets,
    externals,
    freshInstall: pick('freshInstall') ?? false,
    keepTemp: pick('keepTemp') ?? false,
    esbuildTarget: pick('esbuildTarget') ?? `node${nodeRange}`,
  }
}
