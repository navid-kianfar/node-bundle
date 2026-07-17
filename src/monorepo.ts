import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fg from 'fast-glob'
import { log, pc } from './logger.js'
import type { BuildPackage, StaticDir } from './types.js'

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
  /** Extra workspace packages to build and gather (e.g. a co-located frontend). */
  buildPackages?: BuildPackage[]
}

export interface MonorepoDeployResult {
  /** Absolute path of the deployed, self-contained app directory. */
  appDir: string
  /** Static dirs produced by building `buildPackages` (paths relative to appDir). */
  staticDirs: StaticDir[]
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
  let chosen: string[]
  if (include?.length) {
    // Entries may be nested ("apps/socket") — copy just that subtree. If a
    // parent ("apps") is also listed, the parent wins.
    const norm = Array.from(new Set(include.map((i) => i.split('/').filter(Boolean).join('/'))))
    const tops = new Set(norm.filter((i) => !i.includes('/')))
    chosen = norm
      .filter((i) => (i.includes('/') ? !tops.has(i.split('/')[0]!) : dirs.includes(i)))
      .filter((i) => fs.existsSync(path.join(root, i)))
  } else {
    chosen = dirs
  }
  // The root postinstall (e.g. native rebuild scripts) usually lives in scripts/.
  if (dirs.includes('scripts') && !chosen.includes('scripts')) chosen.push('scripts')

  for (const d of chosen) {
    const dst = path.join(dest, d)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.cpSync(path.join(root, d), dst, { recursive: true, filter: (s) => !skipCopy(s) })
  }

  // Nested includes ("providers/packages") need their ancestors' plain files too
  // (shared tsconfig.base.json, package.json, .npmrc live next to the subtree).
  const doneAncestors = new Set<string>()
  for (const d of chosen) {
    const parts = d.split('/')
    for (let i = 1; i < parts.length; i++) {
      const anc = parts.slice(0, i).join('/')
      if (doneAncestors.has(anc)) continue
      doneAncestors.add(anc)
      const srcDir = path.join(root, anc)
      const dstDir = path.join(dest, anc)
      fs.mkdirSync(dstDir, { recursive: true })
      for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (e.isFile() && !skipCopy(e.name)) {
          fs.copyFileSync(path.join(srcDir, e.name), path.join(dstDir, e.name))
        }
      }
    }
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
 * pnpm deploy copies packages from the content-addressable store — which never
 * contains node-gyp BUILD artifacts (build/Release/*.node compiled post-install
 * in the build tree). Heal the deployed virtual store by copying any native
 * artifact that exists in the build tree's .pnpm dir but is missing from the
 * matching deployed .pnpm dir (matched by <pkg>@<version>, ignoring peer-hash
 * suffixes).
 */
function ensureNativeArtifacts(buildDir: string, appDir: string): void {
  const srcStore = path.join(buildDir, 'node_modules', '.pnpm')
  const dstStore = path.join(appDir, 'node_modules', '.pnpm')
  if (!fs.existsSync(srcStore) || !fs.existsSync(dstStore)) return

  const artifacts = fg.sync(['*/node_modules/**/*.{node,so,dylib,dll}', '*/node_modules/**/*.so.*'], {
    cwd: srcStore,
    dot: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  })
  if (artifacts.length === 0) return

  const dstKeys = fs.readdirSync(dstStore)
  let copied = 0
  for (const rel of artifacts) {
    const slash = rel.indexOf('/')
    if (slash <= 0) continue
    const srcKey = rel.slice(0, slash)
    const rest = rel.slice(slash + 1)
    const base = srcKey.split('_')[0]! // strip peer-dependency hash
    for (const dstKey of dstKeys) {
      if (dstKey !== base && !dstKey.startsWith(`${base}_`)) continue
      const dstFile = path.join(dstStore, dstKey, rest)
      if (fs.existsSync(dstFile)) continue
      fs.mkdirSync(path.dirname(dstFile), { recursive: true })
      fs.copyFileSync(path.join(srcStore, rel), dstFile)
      copied++
    }
  }
  if (copied > 0) {
    log.group(() => log.success(`Restored ${copied} native build artifact(s) dropped by pnpm deploy`))
  }
}

/**
 * Reproduce a pnpm-workspace package's deploy: install at the (copied) root,
 * build the target + its workspace deps, then `pnpm deploy` it into a
 * self-contained directory that node-bundle can treat as a single package.
 * MUST run on the target OS/arch (i.e. inside the per-arch Linux container).
 * Also builds any `buildPackages` (e.g. a co-located frontend) and gathers
 * their output into the deployed app as static dirs.
 */
export function runMonorepoDeploy(opts: MonorepoDeployOptions): MonorepoDeployResult {
  const buildDir = path.join(os.tmpdir(), 'nb-mono-build')
  const appDir = path.join(os.tmpdir(), 'nb-mono-app')
  // CI=1 + confirmModulesPurge=false: these run non-interactively in a container,
  // so pnpm must never block on a TTY prompt (e.g. when a filtered build's
  // dep-status check wants to re-sync node_modules).
  const env = {
    ...process.env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    CI: '1',
    npm_config_confirmModulesPurge: 'false',
  }
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

  // A partial workspace copy can leave declared patches "unused" (their target
  // package isn't in any present project's closure) — pnpm install/deploy would
  // hard-fail with ERR_PNPM_UNUSED_PATCH. pnpm 11 reads settings from
  // pnpm-workspace.yaml; the .npmrc spelling covers pnpm ≤10.
  const wsYaml = path.join(buildDir, 'pnpm-workspace.yaml')
  if (fs.existsSync(wsYaml)) {
    fs.appendFileSync(wsYaml, '\n# added by node-bundle (partial workspace copy)\nallowUnusedPatches: true\n')
  }
  fs.appendFileSync(path.join(buildDir, '.npmrc'), '\nallow-non-applied-patches=true\n')

  const hasLock = fs.existsSync(path.join(buildDir, 'pnpm-lock.yaml'))
  execSync('corepack enable', { cwd: buildDir, stdio: 'inherit', env })
  log.group(() => log.info(`pnpm install${hasLock ? ' --frozen-lockfile' : ''}…`))
  sh(hasLock ? 'pnpm install --frozen-lockfile' : 'pnpm install')

  // Build the target and every extra package (e.g. a co-located frontend) in ONE
  // filtered build, while dev deps are still installed — a second `pnpm --filter`
  // pass would re-run pnpm's dep-status check and try to re-sync node_modules.
  const buildFilters = [
    `--filter ${q(opts.pkg)}...`,
    ...(opts.buildPackages ?? []).map((bp) => `--filter ${q(bp.package)}...`),
  ].join(' ')
  log.group(() => log.info(`Building ${opts.pkg}${opts.buildPackages?.length ? ' + gathered packages' : ''} (+ workspace deps)…`))
  sh(`pnpm ${buildFilters} build`)

  log.group(() => log.info(`pnpm deploy --prod → ${appDir}`))
  sh(`pnpm --filter ${q(opts.pkg)} deploy --prod --legacy ${q(appDir)}`)

  if (!fs.existsSync(path.join(appDir, 'package.json'))) {
    throw new Error(`pnpm deploy did not produce ${appDir}/package.json — check the package name (${opts.pkg}).`)
  }
  // pnpm deploy can omit a gitignored build output dir — make sure it's there.
  ensureBuiltOutput(buildDir, appDir, opts.pkg)
  // …and it drops node-gyp build artifacts (they're not in the content store).
  ensureNativeArtifacts(buildDir, appDir)
  log.group(() => log.success(`Deployed self-contained package → ${appDir}`))

  // Gather the (already-built) extra packages' output into the deployed app.
  const staticDirs = gatherBuiltPackages(buildDir, appDir, opts.buildPackages ?? [])
  return { appDir, staticDirs }
}

/**
 * Copy each already-built `buildPackage`'s output into the deployed app under
 * `.nb-gather/<i>`, returning a StaticDir for each (with `from` relative to the
 * app dir) so the host pipeline can embed it into the binary or ship it as a
 * sidecar folder. The build itself happens earlier, alongside the target's
 * build, while dev deps are present.
 */
function gatherBuiltPackages(buildDir: string, appDir: string, buildPackages: BuildPackage[]): StaticDir[] {
  if (buildPackages.length === 0) return []
  const out: StaticDir[] = []
  const gatherRoot = path.join(appDir, '.nb-gather')

  buildPackages.forEach((bp, i) => {
    log.step(`Gather: ${pc.bold(bp.package)}`)
    const pkgDir = findPackageDir(buildDir, bp.package)
    if (!pkgDir) {
      log.warn(`build package "${bp.package}" not found in the workspace — skipping`)
      return
    }
    const srcOut = path.join(pkgDir, bp.from)
    if (!fs.existsSync(srcOut)) {
      log.warn(`build output "${bp.from}" not found for ${bp.package} (looked in ${srcOut}) — skipping`)
      return
    }
    const rel = path.join('.nb-gather', String(i))
    const dest = path.join(gatherRoot, String(i))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(srcOut, dest, { recursive: true, dereference: true })
    out.push({ from: rel, to: bp.to, embed: bp.embed })
    log.group(() =>
      log.success(`Gathered ${bp.package}/${bp.from} → ${bp.to} ${pc.dim(bp.embed ? '(embed)' : '(sidecar)')}`),
    )
  })
  return out
}
