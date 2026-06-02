import fs from 'node:fs'
import path from 'node:path'
import { build, type Message } from 'esbuild'

export interface BundleOptions {
  /** Absolute path to the (already-compiled) entry file. */
  entry: string
  /** Absolute path of the single-file output. */
  outFile: string
  /** Package names to leave as runtime require() (native addons, opt-outs). */
  externals: string[]
  /** esbuild `target`, e.g. "node22". */
  target: string
  /** Minify identifiers/whitespace before obfuscation. */
  minify: boolean
}

export interface BundleResult {
  outFile: string
  size: number
  warnings: string[]
}

function formatMessages(msgs: Message[]): string[] {
  return msgs.map((m) => {
    const loc = m.location ? ` (${m.location.file}:${m.location.line})` : ''
    return `${m.text}${loc}`
  })
}

/**
 * Bundle the compiled application and all of its pure-JS dependencies into one
 * CommonJS file. Native packages are kept external so pkg can embed the correct
 * architecture's .node files at pack time.
 */
export async function bundleApp(opts: BundleOptions): Promise<BundleResult> {
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true })

  const result = await build({
    entryPoints: [opts.entry],
    outfile: opts.outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: opts.target,
    external: opts.externals,
    minify: opts.minify,
    keepNames: true, // NestJS & others rely on class/function .name at runtime
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent',
    metafile: false,
    // Some compiled bundles reference these; make them resolve sanely under pkg.
    define: {
      'import.meta.url': '__nb_import_meta_url',
    },
    banner: {
      js: "const __nb_import_meta_url=require('url').pathToFileURL(__filename).href;",
    },
  })

  const warnings = formatMessages(result.warnings)
  const size = fs.statSync(opts.outFile).size
  return { outFile: opts.outFile, size, warnings }
}
