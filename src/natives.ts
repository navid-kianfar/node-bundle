import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'

export interface NativeScan {
  /** Package names (scoped-aware) that ship or build native .node addons. */
  packages: string[]
  /** Relative paths (from project root) of discovered .node files, for reporting. */
  files: string[]
  /** Package names that ship plain shared libraries (.so/.dylib/.dll, not .node).
   *  These are dlopen()ed by native code at runtime and CANNOT be loaded from the
   *  pkg snapshot — they must be extracted to a real directory at startup. */
  sharedLibPackages: string[]
}

/** Given a path relative to a node_modules dir, return the owning package name
 *  (handles @scope/name). e.g. "@img/sharp-x/foo.node" -> "@img/sharp-x". */
function pkgNameFromRel(rel: string): string {
  const parts = rel.split('/')
  if (parts[0]?.startsWith('@') && parts.length > 1) return `${parts[0]}/${parts[1]}`
  return parts[0] ?? rel
}

/**
 * Scan an installed project's node_modules for native addons.
 * Returns the set of package names that should be treated as "native" — both the
 * direct owner of each .node file and the top-level package it lives under, so
 * esbuild externalizes them and pkg embeds them instead of us trying to inline
 * architecture-specific machine code.
 */
export async function scanNatives(projectDir: string): Promise<NativeScan> {
  const nmDir = path.join(projectDir, 'node_modules')
  if (!fs.existsSync(nmDir)) return { packages: [], files: [], sharedLibPackages: [] }

  // dot: true is required for pnpm layouts — the real files live under
  // node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/…, and fast-glob skips
  // dot-directories by default (which silently hides every native addon).
  const [nodeFiles, gypFiles, libFiles] = await Promise.all([
    fg(['**/*.node'], { cwd: nmDir, dot: true, followSymbolicLinks: false, suppressErrors: true }),
    fg(['**/binding.gyp'], { cwd: nmDir, dot: true, followSymbolicLinks: false, suppressErrors: true }),
    fg(['**/*.{so,dylib,dll}', '**/*.so.*'], {
      cwd: nmDir,
      dot: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    }),
  ])

  const packages = new Set<string>()
  const files: string[] = []

  const add = (relUnderNm: string) => {
    // top-level package (path is already relative to the outermost node_modules);
    // skip store dirs like ".pnpm" — they're layout, not package names
    const top = pkgNameFromRel(relUnderNm)
    if (!top.startsWith('.')) packages.add(top)
    // direct owner (segment after the *last* nested node_modules/, if any)
    const marker = 'node_modules/'
    const idx = relUnderNm.lastIndexOf(marker)
    if (idx >= 0) packages.add(pkgNameFromRel(relUnderNm.slice(idx + marker.length)))
  }

  for (const f of nodeFiles) {
    files.push(path.join('node_modules', f))
    add(f)
  }
  for (const g of gypFiles) add(g)

  // Owners of plain shared libraries (dlopen'ed at runtime, not require()d).
  const sharedLibPackages = new Set<string>()
  for (const f of libFiles) {
    const marker = 'node_modules/'
    const idx = f.lastIndexOf(marker)
    const owner = pkgNameFromRel(idx >= 0 ? f.slice(idx + marker.length) : f)
    if (owner && !owner.startsWith('.')) sharedLibPackages.add(owner)
  }

  return {
    packages: [...packages].filter(Boolean).sort(),
    files: files.sort(),
    sharedLibPackages: [...sharedLibPackages].sort(),
  }
}
