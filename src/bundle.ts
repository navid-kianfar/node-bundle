import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { build, type Message, type Plugin } from 'esbuild'

/** Every Node built-in module name (bare, no "node:" prefix). */
const NODE_BUILTINS = new Set(builtinModules)

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
  /** Project root — anchors per-module __dirname preservation. The final bundle
   *  is expected to live two directories below it (.node-bundle/tmp). */
  projectDir?: string
  /** Files whose side effects run before the entry (esbuild `inject`) — used for
   *  the shared-library extraction prelude. */
  inject?: string[]
}

export interface BundleResult {
  outFile: string
  size: number
  warnings: string[]
  /** Every specifier left external (natives, opt-outs, all packages in app-only mode). */
  externalized: string[]
  /** Bare specifiers externalized because they failed to resolve (optional peers). */
  externalizedMissing: string[]
  /** node_modules package dirs (absolute) whose inlined code uses __dirname/__filename —
   *  they likely read sibling data files at runtime and should be embedded as assets. */
  dirnamePackages: string[]
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
        // A Node built-in (buffer, events, crypto, …) must map to the REAL
        // builtin, never a userland polyfill of the same name that happens to be
        // installed (e.g. the "buffer" npm package, which lacks
        // buffer.constants.MAX_STRING_LENGTH and breaks pino/thread-stream).
        // build.resolve() below would pick the userland copy — short-circuit it.
        if (NODE_BUILTINS.has(args.path)) return ext(args.path)
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
 * Bundling relocates every module into one file, so the runtime __dirname no
 * longer points at each module's original directory — breaking the very common
 * `path.join(__dirname, '../data/file')` pattern. This plugin restores original
 * semantics by injecting per-module `__filename`/`__dirname` constants computed
 * from `__nb_root` (resolved at runtime from the bundle's own location, so the
 * SAME code works inside a pkg snapshot and on a plain filesystem).
 *
 * It also records which node_modules packages use __dirname/__filename — the
 * caller embeds their non-code files as pkg assets so those runtime reads
 * resolve inside the snapshot.
 */
function preserveDirnamePlugin(projectDir: string, dirnamePkgs: Set<string>): Plugin {
  const owningPackageDir = (file: string): string | undefined => {
    let dir = path.dirname(file)
    while (dir.includes('node_modules')) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir
      const parent = path.dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
    return undefined
  }

  return {
    name: 'nb-preserve-dirname',
    setup(build) {
      build.onLoad({ filter: /\.(c|m)?js$/ }, async (args) => {
        let src: string
        try {
          src = await fs.promises.readFile(args.path, 'utf8')
        } catch {
          return null
        }
        const needsDir = /__dirname|__filename/.test(src)
        const needsMeta = /import\.meta/.test(src)
        if (!needsDir && !needsMeta) return null

        const relFile = path.relative(projectDir, args.path).split(path.sep).join('/')
        const lines: string[] = []
        if (needsDir) {
          lines.push(
            `var __filename=require("path").join(__nb_root,${JSON.stringify(relFile)}),` +
              `__dirname=require("path").dirname(__filename);`,
          )
          if (args.path.includes('node_modules')) {
            const pkgDir = owningPackageDir(args.path)
            if (pkgDir) dirnamePkgs.add(pkgDir)
          }
        }
        if (needsMeta) {
          lines.push(
            `var __nb_import_meta_url=require("url").pathToFileURL(require("path").join(__nb_root,${JSON.stringify(relFile)})).href;`,
          )
        }

        // Keep a shebang (if any) on the first line — injecting above it would
        // turn it into a syntax error.
        let contents: string
        if (src.startsWith('#!')) {
          const nl = src.indexOf('\n')
          contents = nl === -1 ? src : `${src.slice(0, nl + 1)}${lines.join('')}\n${src.slice(nl + 1)}`
        } else {
          contents = `${lines.join('')}\n${src}`
        }
        return { contents }
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
  const dirnamePkgs = new Set<string>()
  const projectDir = opts.projectDir ?? path.dirname(opts.entry)

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
    inject: opts.inject ?? [],
    plugins: [
      preserveDirnamePlugin(projectDir, dirnamePkgs),
      externalizePlugin(externalsSet, missing, externalizedAll, opts.externalizeAllPackages ?? false),
    ],
    define: {
      'import.meta.url': '__nb_import_meta_url',
    },
    // __nb_root: where the project root lives at runtime. The bundle always sits
    // at <root>/.node-bundle/tmp/<bundle>.cjs, so three ups from the file — valid
    // on the real filesystem AND inside a pkg snapshot (both keep that layout).
    // NOTE: must not reference __dirname/__filename directly — the entry module's
    // injected `var __dirname` hoists over the banner and would shadow them as
    // undefined. process.argv[1] (pkg entry) / module.filename are hoist-proof.
    banner: {
      js:
        "var __nb_file=(process.pkg&&process.argv[1])||(typeof module!=='undefined'&&module.filename)||'.';" +
        "var __nb_root=require('path').resolve(__nb_file,'..','..','..');" +
        'const __nb_import_meta_url=require(\'url\').pathToFileURL(__nb_file).href;',
    },
  })

  return {
    outFile: opts.outFile,
    size: fs.statSync(opts.outFile).size,
    warnings: formatMessages(result.warnings),
    externalized: [...externalizedAll].sort(),
    externalizedMissing: [...missing].sort(),
    dirnamePackages: [...dirnamePkgs].sort(),
  }
}
