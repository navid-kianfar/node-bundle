import fs from 'node:fs'
import path from 'node:path'
import type {
  BuildMode,
  BuildPackage,
  DetectResult,
  ObfuscationLevel,
  ResolvedConfig,
  StaticDir,
  Target,
} from './types.js'

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
  /** Path to an external config file (JSON), outside the project. */
  config?: string
  /** CLI convenience for sidecar static dirs: "from[:to],…". */
  static?: string
  /** Serialized StaticDir[]+BuildPackage[] threaded to the in-container step. */
  gatherJson?: string
}

/** The file/package.json config schema (a superset of CliOptions plus arrays).
 *  `build` is omitted from the CliOptions base (there it's the --no-build
 *  boolean); the config's build-packages list lives under `buildPackages`. */
interface FileConfig extends Partial<Omit<CliOptions, 'build' | 'assets'>> {
  externals?: string[]
  assets?: string[] | string
  staticDirs?: Array<string | Partial<StaticDir>>
  buildPackages?: Array<string | Partial<BuildPackage>>
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

function readJsonFile(p: string, label: string): FileConfig {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as FileConfig
  } catch (e) {
    throw new Error(`Failed to parse ${label}: ${(e as Error).message}`)
  }
}

/**
 * Resolve project config from three co-located sources, lowest precedence first:
 *   1. a `node-bundle.config.json` / `.node-bundle.json` file in the project,
 *   2. a `node-bundle` key inside the project's package.json,
 *   3. an explicit external `--config <path>` file (wins over the above).
 * CLI flags (applied by the caller) override all of these.
 */
function loadFileConfig(projectDir: string, pkgJson: Record<string, unknown>, external?: string): FileConfig {
  let cfg: FileConfig = {}
  for (const f of ['node-bundle.config.json', '.node-bundle.json']) {
    const p = path.join(projectDir, f)
    if (fs.existsSync(p)) {
      cfg = readJsonFile(p, f)
      break
    }
  }
  if (pkgJson['node-bundle'] && typeof pkgJson['node-bundle'] === 'object') {
    cfg = { ...cfg, ...(pkgJson['node-bundle'] as FileConfig) }
  }
  if (external) {
    const p = path.resolve(external)
    if (!fs.existsSync(p)) throw new Error(`--config file not found: ${p}`)
    cfg = { ...cfg, ...readJsonFile(p, external) }
  }
  return cfg
}

/** Normalize a "from[:to]" string or a partial object into a StaticDir. */
function toStaticDir(v: string | Partial<StaticDir>, embedDefault: boolean): StaticDir | undefined {
  if (typeof v === 'string') {
    const [from, to] = v.split(':')
    if (!from) return undefined
    return { from, to: to || path.basename(from), embed: embedDefault }
  }
  if (!v.from) return undefined
  return { from: v.from, to: v.to || path.basename(v.from), embed: v.embed ?? embedDefault }
}

function toBuildPackage(v: string | Partial<BuildPackage>): BuildPackage | undefined {
  // string form: "pkg:from:to" (embed defaults to false)
  if (typeof v === 'string') {
    const [pkg, from, to] = v.split(':')
    if (!pkg) return undefined
    return { package: pkg, from: from || 'dist', to: to || path.basename(pkg), embed: false }
  }
  if (!v.package) return undefined
  return {
    package: v.package,
    script: v.script,
    from: v.from || 'dist',
    to: v.to || path.basename(v.package),
    embed: v.embed ?? false,
  }
}

export function resolveConfig(
  projectDir: string,
  cli: CliOptions,
  detected: DetectResult,
): ResolvedConfig {
  const fileCfg = loadFileConfig(projectDir, detected.pkgJson, cli.config)
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

  const fileAssets = Array.isArray(fileCfg.assets)
    ? fileCfg.assets
    : typeof fileCfg.assets === 'string'
      ? splitList(fileCfg.assets)
      : []
  const assets = Array.from(new Set([...splitList(pick('assets')), ...fileAssets]))

  // staticDirs: config array (any embed flag) + CLI --static (sidecar only).
  const staticDirs: StaticDir[] = []
  for (const s of fileCfg.staticDirs ?? []) {
    const d = toStaticDir(s, false)
    if (d) staticDirs.push(d)
  }
  // A --gather JSON payload (set by the monorepo orchestrator for the in-container
  // step) carries already-resolved static dirs so they don't need re-parsing.
  if (cli.gatherJson) {
    try {
      const g = JSON.parse(cli.gatherJson) as { staticDirs?: StaticDir[]; buildPackages?: BuildPackage[] }
      for (const d of g.staticDirs ?? []) staticDirs.push(d)
    } catch {
      /* ignore malformed internal payload */
    }
  }
  for (const s of splitList(cli.static)) {
    const d = toStaticDir(s, false)
    if (d) staticDirs.push(d)
  }

  const buildPackages: BuildPackage[] = []
  for (const b of fileCfg.buildPackages ?? []) {
    const bp = toBuildPackage(b)
    if (bp) buildPackages.push(bp)
  }
  if (cli.gatherJson) {
    try {
      const g = JSON.parse(cli.gatherJson) as { buildPackages?: BuildPackage[] }
      for (const bp of g.buildPackages ?? []) buildPackages.push(bp)
    } catch {
      /* ignore */
    }
  }

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
    staticDirs,
    buildPackages,
  }
}
