import fs from 'node:fs'
import path from 'node:path'
import type { DetectResult } from './types.js'
import { detectPackageManager, runScriptCmd, execBinCmd } from './pm.js'
import { scanNatives } from './natives.js'

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}

function asRecord(v: unknown): Record<string, string> {
  return v && typeof v === 'object' ? (v as Record<string, string>) : {}
}

/** Detect build tooling from dependency names + well-known config files. */
function detectFrameworks(projectDir: string, allDeps: Record<string, string>): string[] {
  const found: string[] = []
  const has = (name: string) => name in allDeps
  const fileExists = (f: string) => fs.existsSync(path.join(projectDir, f))

  if (has('@nestjs/core') || fileExists('nest-cli.json')) found.push('nestjs')
  if (has('webpack') || fileExists('webpack.config.js') || fileExists('webpack.config.ts')) found.push('webpack')
  if (has('vite')) found.push('vite')
  if (has('rollup')) found.push('rollup')
  if (has('tsup')) found.push('tsup')
  if (has('esbuild')) found.push('esbuild')
  if (has('@swc/core') || has('@swc/cli')) found.push('swc')
  if (has('typescript') || fileExists('tsconfig.json')) found.push('tsc')
  return found
}

/** Build an ordered list of likely post-build entry files (absolute paths). */
export function resolveEntryCandidates(
  projectDir: string,
  pkgJson: Record<string, unknown>,
  override?: string,
): string[] {
  const abs = (p: string) => path.resolve(projectDir, p)
  const out: string[] = []
  const push = (p?: string) => {
    if (!p) return
    const a = abs(p)
    if (!out.includes(a)) out.push(a)
  }

  if (override) {
    push(override)
    return out
  }

  // package.json "main"
  if (typeof pkgJson.main === 'string') {
    push(pkgJson.main)
    // if main points at TS source, also guess its compiled location
    if (pkgJson.main.endsWith('.ts')) {
      push(pkgJson.main.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js'))
    }
  }

  // package.json "bin"
  const bin = pkgJson.bin
  if (typeof bin === 'string') push(bin)
  else if (bin && typeof bin === 'object') {
    const first = Object.values(bin as Record<string, string>)[0]
    push(first)
  }

  // common compiled outputs
  for (const c of [
    'dist/main.js',
    'dist/index.js',
    'dist/src/main.js',
    'dist/src/index.js',
    'dist/server.js',
    'dist/app.js',
    'build/main.js',
    'build/index.js',
    'out/index.js',
    'lib/index.js',
  ]) push(c)

  // plain-JS apps without a build step
  for (const c of ['index.js', 'src/index.js', 'server.js', 'app.js', 'src/main.js']) push(c)

  return out
}

export async function detect(projectDir: string, entryOverride?: string): Promise<DetectResult> {
  const pkgPath = path.join(projectDir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`No package.json found in ${projectDir}`)
  }
  const pkgJson = readJson(pkgPath)
  const deps = asRecord(pkgJson.dependencies)
  const devDeps = asRecord(pkgJson.devDependencies)
  const allDeps = { ...deps, ...devDeps }

  const packageManager = detectPackageManager(projectDir, pkgJson)
  const scripts = asRecord(pkgJson.scripts)
  const hasTsConfig = fs.existsSync(path.join(projectDir, 'tsconfig.json'))
  const isTypeScript = hasTsConfig || 'typescript' in allDeps

  let buildCommand: string | undefined
  if (typeof scripts.build === 'string' && scripts.build.trim()) {
    buildCommand = runScriptCmd(packageManager, 'build')
  } else if (isTypeScript && hasTsConfig) {
    buildCommand = execBinCmd(packageManager, 'tsc')
  }

  const frameworks = detectFrameworks(projectDir, allDeps)
  const natives = (await scanNatives(projectDir)).packages

  return {
    packageManager,
    isTypeScript,
    moduleType: pkgJson.type === 'module' ? 'module' : 'commonjs',
    buildCommand,
    entryCandidates: resolveEntryCandidates(projectDir, pkgJson, entryOverride),
    frameworks,
    natives,
    pkgJson,
  }
}
