import fs from 'node:fs'
import path from 'node:path'
import { log, pc } from './logger.js'
import type { StaticDir } from './types.js'

export interface GatherResult {
  /** Extra pkg asset globs (relative to tmpDir) for embedded static dirs. */
  embedAssets: string[]
  /** Map of embedded destination -> its path inside the snapshot, for the env hint. */
  embedManifest: Record<string, string>
}

/**
 * Materialize the configured static dirs.
 *
 *  - embed:true  → copy the source into <tmpDir>/<to> and return an asset glob so
 *    pkg bakes it into the binary. Accessible at runtime under the app root
 *    inside the snapshot (also surfaced via the NODE_BUNDLE_STATIC env hint).
 *  - embed:false → copy the source into <outDir>/<to>, so it ships as a plain
 *    folder NEXT TO the binary (served from the process working directory,
 *    matching the common `<cwd>/public` pattern).
 */
export function gatherStaticDirs(
  staticDirs: StaticDir[],
  projectDir: string,
  tmpDir: string,
  outDir: string,
): GatherResult {
  const embedAssets: string[] = []
  const embedManifest: Record<string, string> = {}
  if (staticDirs.length === 0) return { embedAssets, embedManifest }

  const toRel = (p: string) => p.split(path.sep).join('/')

  for (const dir of staticDirs) {
    const src = path.resolve(projectDir, dir.from)
    if (!fs.existsSync(src)) {
      log.warn(`static dir "${dir.from}" not found — skipping`)
      continue
    }
    const destBase = dir.embed ? tmpDir : outDir
    const dest = path.resolve(destBase, dir.to)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(src, dest, { recursive: true, dereference: true })

    if (dir.embed) {
      const rel = toRel(path.relative(tmpDir, dest))
      embedAssets.push(`${rel}/**/*`)
      embedManifest[dir.to] = rel
      log.group(() => log.info(`Embedded static dir ${pc.bold(dir.from)} → ${dir.to} ${pc.dim('(in binary)')}`))
    } else {
      log.group(() =>
        log.info(`Sidecar static dir ${pc.bold(dir.from)} → ${path.relative(outDir, dest) || dir.to} ${pc.dim('(next to binary)')}`),
      )
    }
  }
  return { embedAssets, embedManifest }
}

/**
 * Write a prelude that, at startup under pkg, sets `NODE_BUNDLE_STATIC` to a
 * JSON map of { to → absolute snapshot path } for every embedded static dir, so
 * app code can locate embedded assets without hard-coding snapshot paths.
 */
export function writeStaticEnvPrelude(tmpDir: string, embedManifest: Record<string, string>): string | undefined {
  if (Object.keys(embedManifest).length === 0) return undefined
  const prelude = `// node-bundle: expose embedded static dirs to the app via env.
;(function () {
  if (!process.pkg) return
  var path = require('path')
  var base = path.dirname(process.argv[1])
  var MAP = ${JSON.stringify(embedManifest)}
  var out = {}
  for (var k in MAP) out[k] = path.join(base, MAP[k])
  process.env.NODE_BUNDLE_STATIC = JSON.stringify(out)
})();
`
  const file = path.join(tmpDir, 'nb-static-prelude.js')
  fs.writeFileSync(file, prelude)
  return file
}
