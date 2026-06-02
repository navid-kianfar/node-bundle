import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'

export interface NativeScan {
  /** Package names (scoped-aware) that ship or build native .node addons. */
  packages: string[]
  /** Relative paths (from project root) of discovered .node files, for reporting. */
  files: string[]
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
  if (!fs.existsSync(nmDir)) return { packages: [], files: [] }

  const [nodeFiles, gypFiles] = await Promise.all([
    fg(['**/*.node'], { cwd: nmDir, followSymbolicLinks: false, suppressErrors: true }),
    fg(['**/binding.gyp'], { cwd: nmDir, followSymbolicLinks: false, suppressErrors: true }),
  ])

  const packages = new Set<string>()
  const files: string[] = []

  const add = (relUnderNm: string) => {
    // top-level package (path is already relative to the outermost node_modules)
    packages.add(pkgNameFromRel(relUnderNm))
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

  return {
    packages: [...packages].filter(Boolean).sort(),
    files: files.sort(),
  }
}
