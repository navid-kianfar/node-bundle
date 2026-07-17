import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { log } from './logger.js'

/**
 * Node built-in module names. A userland package that shares one of these names
 * (the "buffer", "string_decoder", "punycode", … polyfills, pulled in as
 * transitive deps of native packages) must NEVER be staged: `require("buffer")`
 * resolves to the builtin in plain Node, but inside a pkg snapshot an embedded
 * node_modules/buffer SHADOWS the builtin — and these browser polyfills lack
 * Node-only APIs (e.g. buffer.constants.MAX_STRING_LENGTH, which pino needs),
 * so the app crashes at startup.
 */
const NODE_BUILTIN_NAMES = new Set(builtinModules)

/**
 * Stage externalized (native) packages into <tmpDir>/node_modules so pkg can
 * resolve their runtime require()s from the snapshot.
 *
 * Why: pkg's static tracer resolves bare requires against the real filesystem.
 * Under pnpm, node_modules/<name> is a symlink into node_modules/.pnpm/…, and
 * the traced files end up in the snapshot at paths that do NOT form a valid
 * node_modules chain next to the bundle — so `require('better-sqlite3')` fails
 * at runtime with MODULE_NOT_FOUND even though pkg "saw" the package.
 *
 * The fix: materialize each external package (symlinks dereferenced) into the
 * pack config dir's own node_modules/, together with its transitive runtime
 * dependency closure (dependencies + optionalDependencies + resolvable peers —
 * e.g. better-sqlite3 needs `bindings` at runtime). The whole tree is embedded
 * via a pkg asset glob and resolves with plain Node semantics inside the
 * snapshot, regardless of the project's package-manager layout.
 */
export interface StageResult {
  /** Package names staged (copied) into tmpDir/node_modules. */
  staged: string[]
  /** Names that could not be resolved anywhere (left to pkg's own tracing). */
  unresolved: string[]
}

function readPkgName(dir: string): string | undefined {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name?: string
    }
    return typeof pj.name === 'string' ? pj.name : undefined
  } catch {
    return undefined
  }
}

/** Nearest ancestor of `file` (inclusive) that holds a package.json. */
function owningPackageDir(file: string, stopAt: string): string | undefined {
  let dir = path.dirname(file)
  while (dir.length >= stopAt.length && dir.startsWith(stopAt)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** Node-style resolution of a package DIRECTORY: walk ancestors of `fromDir`
 *  looking for node_modules/<name>. Works for flat (npm/yarn) and pnpm
 *  (.pnpm/<pkg>@<v>/node_modules siblings) layouts alike. */
function resolvePackageDir(fromDir: string, name: string): string | undefined {
  let dir = fromDir
  const nameParts = name.split('/')
  while (true) {
    const cand = path.join(dir, 'node_modules', ...nameParts)
    if (fs.existsSync(path.join(cand, 'package.json'))) {
      try {
        return fs.realpathSync(cand)
      } catch {
        return cand
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Locate a package inside node_modules/.pnpm/<key>/node_modules/<name>. */
function findInPnpmStore(projectDir: string, name: string): string | undefined {
  const store = path.join(projectDir, 'node_modules', '.pnpm')
  if (!fs.existsSync(store)) return undefined
  const flat = name.replace('/', '+') // @scope/name -> @scope+name in store keys
  for (const key of fs.readdirSync(store)) {
    if (key !== flat && !key.startsWith(`${flat}@`)) continue
    const cand = path.join(store, key, 'node_modules', ...name.split('/'))
    if (fs.existsSync(path.join(cand, 'package.json'))) {
      try {
        return fs.realpathSync(cand)
      } catch {
        return cand
      }
    }
  }
  return undefined
}

export function stageNativePackages(
  projectDir: string,
  tmpDir: string,
  nativeFiles: string[],
  externals: string[],
): StageResult {
  const destRoot = path.join(tmpDir, 'node_modules')
  const staged = new Map<string, string>() // name -> source real dir
  const unresolved: string[] = []
  const queue: string[] = [] // real dirs whose deps still need staging

  const copyPackage = (realDir: string): void => {
    const name = readPkgName(realDir)
    if (!name || staged.has(name)) return
    // Skip polyfills that shadow a Node builtin inside the pkg snapshot.
    if (NODE_BUILTIN_NAMES.has(name)) return
    staged.set(name, realDir)
    const dest = path.join(destRoot, ...name.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(realDir, dest, {
      recursive: true,
      dereference: true, // materialize pnpm symlinks
      force: true,
      // deps are staged explicitly as siblings; don't drag nested trees along
      filter: (src) => path.basename(src) !== 'node_modules',
    })
    queue.push(realDir)
  }

  // 1. Seed from every discovered .node file's owning package (covers packages
  //    only reachable through pnpm's store dir, e.g. @img/sharp-<platform>).
  for (const rel of nativeFiles) {
    const abs = path.resolve(projectDir, rel)
    if (!fs.existsSync(abs)) continue
    const owner = owningPackageDir(fs.realpathSync(abs), projectDir)
    if (owner) copyPackage(owner)
  }

  // 2. Seed from declared externals resolvable at the project root (native
  //    package names + user --external opt-outs — those are runtime requires too).
  //    Packages that are deps-of-deps have no root-level node_modules link under
  //    pnpm — fall back to searching the .pnpm virtual store.
  for (const name of externals) {
    if (staged.has(name)) continue
    const dir = resolvePackageDir(projectDir, name) ?? findInPnpmStore(projectDir, name)
    if (dir) copyPackage(dir)
    else unresolved.push(name)
  }

  // 3. Transitive runtime closure: dependencies, optionalDependencies and any
  //    peers that are actually installed.
  while (queue.length) {
    const realDir = queue.shift()!
    let pj: Record<string, unknown>
    try {
      pj = JSON.parse(fs.readFileSync(path.join(realDir, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >
    } catch {
      continue
    }
    const depNames = new Set<string>([
      ...Object.keys((pj.dependencies as Record<string, string>) ?? {}),
      ...Object.keys((pj.optionalDependencies as Record<string, string>) ?? {}),
      ...Object.keys((pj.peerDependencies as Record<string, string>) ?? {}),
    ])
    for (const dep of depNames) {
      if (staged.has(dep)) continue
      const dir = resolvePackageDir(realDir, dep)
      if (dir) {
        const already = staged.get(readPkgName(dir) ?? dep)
        if (already && already !== dir) {
          log.warn(`Staging ${dep}: multiple versions in the native closure — keeping the first.`)
          continue
        }
        copyPackage(dir)
      }
      // absent optional/peer deps are fine — the package guards them at runtime
    }
  }

  return { staged: [...staged.keys()].sort(), unresolved }
}
