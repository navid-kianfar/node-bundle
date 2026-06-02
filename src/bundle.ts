import fs from 'node:fs'
import path from 'node:path'
import { build, type Message, type Plugin } from 'esbuild'

export interface BundleOptions {
  /** Absolute path to the entry file (compiled JS, or a prior bundle stage). */
  entry: string
  /** Absolute path of the single-file output. */
  outFile: string
  /** Package names to leave as runtime require() (native addons, opt-outs). */
  externals: string[]
  /** esbuild `target`, e.g. "node22". */
  target: string
  /** Minify identifiers/whitespace. */
  minify: boolean
  /** Externalize EVERY bare import (used for the app-only obfuscation stage). */
  externalizeAllPackages?: boolean
}

export interface BundleResult {
  outFile: string
  size: number
  warnings: string[]
  /** Every specifier left external (natives, opt-outs, all packages in app-only mode). */
  externalized: string[]
  /** Bare specifiers externalized because they failed to resolve (optional peers). */
  externalizedMissing: string[]
}

function formatMessages(msgs: Message[]): string[] {
  return msgs.map((m) => {
    const loc = m.location ? ` (${m.location.file}:${m.location.line})` : ''
    return `${m.text}${loc}`
  })
}

/** Top-level package name of a bare specifier ("@scope/n/sub" -> "@scope/n"). */
export function packageNameOf(spec: string): string {
  if (spec.startsWith('@')) {
    const parts = spec.split('/')
    return parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]!
  }
  return spec.split('/')[0]!
}

const RESOLVE_SENTINEL = Symbol('nb-resolve')

/**
 * esbuild plugin controlling what stays out of the bundle:
 *  - declared externals (native addons) -> runtime require()
 *  - in app-only mode, EVERY bare import -> external (so we bundle just app code)
 *  - otherwise, bare imports that fail to resolve -> external (NestJS optional
 *    peers like kafkajs/mqtt/redis that are lazily require()d inside try/catch)
 */
function externalizePlugin(
  externals: Set<string>,
  missing: Set<string>,
  externalizedAll: Set<string>,
  externalizeEverything: boolean,
): Plugin {
  const ext = (p: string) => {
    externalizedAll.add(p)
    return { path: p, external: true as const }
  }
  return {
    name: 'nb-externalize',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === 'entry-point') return null
        if (args.path.startsWith('.') || path.isAbsolute(args.path)) return null
        if (args.path.startsWith('node:')) return ext(args.path)
        if (externalizeEverything) return ext(args.path)
        if (externals.has(args.path) || externals.has(packageNameOf(args.path))) return ext(args.path)
        if (args.pluginData === RESOLVE_SENTINEL) return null // recursion guard
        const r = await build.resolve(args.path, {
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: RESOLVE_SENTINEL,
        })
        if (r.errors.length > 0) {
          missing.add(args.path)
          return ext(args.path)
        }
        return r
      })
    },
  }
}

/**
 * Bundle the entry and (unless externalizeAllPackages) all of its pure-JS
 * dependencies into one CommonJS file. Native packages and unresolvable optional
 * peers are kept external so pkg can embed/guard them at pack time.
 */
export async function bundleApp(opts: BundleOptions): Promise<BundleResult> {
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true })

  const externalsSet = new Set(opts.externals)
  const missing = new Set<string>()
  const externalizedAll = new Set<string>()

  const result = await build({
    entryPoints: [opts.entry],
    outfile: opts.outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: opts.target,
    minify: opts.minify,
    keepNames: true, // NestJS & others rely on class/function .name at runtime
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent',
    metafile: false,
    // We bundle already-compiled JS — ignore any project tsconfig (and its
    // "extends" chain, which won't exist in a deployed package).
    tsconfigRaw: '{}',
    plugins: [
      externalizePlugin(externalsSet, missing, externalizedAll, opts.externalizeAllPackages ?? false),
    ],
    define: {
      'import.meta.url': '__nb_import_meta_url',
    },
    banner: {
      js: "const __nb_import_meta_url=require('url').pathToFileURL(__filename).href;",
    },
  })

  return {
    outFile: opts.outFile,
    size: fs.statSync(opts.outFile).size,
    warnings: formatMessages(result.warnings),
    externalized: [...externalizedAll].sort(),
    externalizedMissing: [...missing].sort(),
  }
}
