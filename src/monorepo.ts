import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log, pc } from './logger.js'

/** Directory names never copied into the build context. */
const COPY_EXCLUDE = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  '.node-bundle',
  'node-bundle-out',
])

/** Walk up from startDir to find the pnpm workspace root (pnpm-workspace.yaml). */
export function findWorkspaceRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Read a package.json "name" field. */
export function readPackageName(dir: string): string | undefined {
  const p = path.join(dir, 'package.json')
  if (!fs.existsSync(p)) return undefined
  try {
    const name = (JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string }).name
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}

export interface MonorepoDeployOptions {
  /** Workspace root (read-only). */
  root: string
  /** Target package name (e.g. "@kalagh/provider-whatsapp"). */
  pkg: string
  /** Optional top-level subtrees (relative to root) to copy; default: everything. */
  include?: string[]
}

/** Should this path be skipped when copying the workspace? */
function skipCopy(p: string): boolean {
  const b = path.basename(p)
  // Drop incremental build caches so `tsc` does a fresh emit (a stale
  // tsconfig.tsbuildinfo without its dist makes tsc skip emitting entirely).
  return COPY_EXCLUDE.has(b) || b.endsWith('.tsbuildinfo')
}

/** Copy the workspace into a writable build dir (root may be a read-only mount). */
function copyWorkspace(root: string, dest: string, include?: string[]): void {
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(root, { withFileTypes: true })

  // Root-level files: manifests, lockfile, workspace yaml, .npmrc, tsconfig*, turbo.json …
  for (const e of entries) {
    if (e.isFile() && !skipCopy(e.name)) {
      fs.copyFileSync(path.join(root, e.name), path.join(dest, e.name))
    }
  }

  const dirs = entries.filter((e) => e.isDirectory() && !COPY_EXCLUDE.has(e.name)).map((e) => e.name)
  const chosen = include?.length ? dirs.filter((d) => include.includes(d)) : dirs
  // The root postinstall (e.g. native rebuild scripts) usually lives in scripts/.
  if (dirs.includes('scripts') && !chosen.includes('scripts')) chosen.push('scripts')

  for (const d of chosen) {
    fs.cpSync(path.join(root, d), path.join(dest, d), { recursive: true, filter: (s) => !skipCopy(s) })
  }
}

/** Find a package directory by name within a (non-node_modules) tree. */
function findPackageDir(root: string, name: string): string | undefined {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    const pj = path.join(dir, 'package.json')
    if (fs.existsSync(pj)) {
      try {
        if ((JSON.parse(fs.readFileSync(pj, 'utf8')) as { name?: string }).name === name) return dir
      } catch {
        /* ignore */
      }
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) {
        stack.push(path.join(dir, e.name))
      }
    }
  }
  return undefined
}

/** Ensure the package's compiled output dir exists in the deployed app
 *  (pnpm deploy can drop a gitignored dist/). Copies it from the build tree. */
function ensureBuiltOutput(buildDir: string, appDir: string, pkg: string): void {
  const pkgDir = findPackageDir(buildDir, pkg)
  if (!pkgDir) return
  let main = 'dist/index.js'
  try {
    const m = (JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { main?: string }).main
    if (m) main = m
  } catch {
    /* ignore */
  }
  const outTop = main.replace(/^\.\//, '').split('/')[0] || 'dist'
  const src = path.join(pkgDir, outTop)
  const dst = path.join(appDir, outTop)
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    fs.cpSync(src, dst, { recursive: true })
  }
}

/**
 * Reproduce a pnpm-workspace package's deploy: install at the (copied) root,
 * build the target + its workspace deps, then `pnpm deploy` it into a
 * self-contained directory that node-bundle can treat as a single package.
 * MUST run on the target OS/arch (i.e. inside the per-arch Linux container).
 * Returns the absolute path of the deployed app directory.
 */
export function runMonorepoDeploy(opts: MonorepoDeployOptions): string {
  const buildDir = path.join(os.tmpdir(), 'nb-mono-build')
  const appDir = path.join(os.tmpdir(), 'nb-mono-app')
  const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }
  const sh = (cmd: string) => execSync(cmd, { cwd: buildDir, stdio: 'inherit', env })
  const q = (s: string) => JSON.stringify(s)

  log.step(`Monorepo deploy: ${pc.bold(opts.pkg)}`)
  fs.rmSync(buildDir, { recursive: true, force: true })
  fs.rmSync(appDir, { recursive: true, force: true })

  log.group(() => {
    log.info(`Workspace root: ${opts.root}`)
    log.info(`Copying workspace${opts.include?.length ? ` (subtrees: ${opts.include.join(', ')})` : ' (all)'}…`)
  })
  copyWorkspace(opts.root, buildDir, opts.include)

  const hasLock = fs.existsSync(path.join(buildDir, 'pnpm-lock.yaml'))
  execSync('corepack enable', { cwd: buildDir, stdio: 'inherit', env })
  log.group(() => log.info(`pnpm install${hasLock ? ' --frozen-lockfile' : ''}…`))
  sh(hasLock ? 'pnpm install --frozen-lockfile' : 'pnpm install')
  log.group(() => log.info(`Building ${opts.pkg} (+ workspace deps)…`))
  sh(`pnpm --filter ${q(opts.pkg)}... build`)
  log.group(() => log.info(`pnpm deploy --prod → ${appDir}`))
  sh(`pnpm --filter ${q(opts.pkg)} deploy --prod --legacy ${q(appDir)}`)

  if (!fs.existsSync(path.join(appDir, 'package.json'))) {
    throw new Error(`pnpm deploy did not produce ${appDir}/package.json — check the package name (${opts.pkg}).`)
  }
  // pnpm deploy can omit a gitignored build output dir — make sure it's there.
  ensureBuiltOutput(buildDir, appDir, opts.pkg)
  log.group(() => log.success(`Deployed self-contained package → ${appDir}`))
  return appDir
}
