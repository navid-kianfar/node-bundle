import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'

/**
 * Shared libraries (.so/.dylib/.dll) cannot be dlopen()ed from the pkg snapshot:
 * the C runtime knows nothing about pkg's virtual filesystem. Packages like
 * prebuilt-tdlib resolve such a library's path with require.resolve() and hand
 * it to native code — inside a binary that path would be /snapshot/… and the
 * dlopen fails.
 *
 * The fix is a small PRELUDE injected into the final bundle. At startup (only
 * when running under pkg) it:
 *   1. copies each shared-lib package from the snapshot's embedded
 *      node_modules to a real directory (os.tmpdir()/nb-x-<hash>, hashed over
 *      name@version so repeated runs reuse it), and
 *   2. patches Module._resolveFilename so ANY require()/require.resolve() of
 *      those packages resolves to the extracted real files.
 *
 * Everything else keeps loading from the snapshot; only the dlopen-sensitive
 * packages are redirected.
 */
export interface LibManifestEntry {
  name: string
  version: string
}

/**
 * Manifest of packages to extract at startup. Empty (no extraction) unless at
 * least one shared-lib package exists. When one does, the WHOLE staged tree is
 * extracted, not just the .so owners:
 *  - pkg's own .node loader copies addons to ISOLATED temp files, which breaks
 *    $ORIGIN-relative rpath links to sibling packages (e.g. sharp's addon in
 *    "@img/sharp-linux-arm64" links libvips from "@img/sharp-libvips-linux-arm64");
 *  - an extracted package's own require()s (better-sqlite3 → bindings) must
 *    resolve beside it, and the staged tree is a complete closure by
 *    construction.
 */
export function buildLibManifest(
  tmpDir: string,
  libPackages: string[],
  stagedPackages: string[],
): LibManifestEntry[] {
  if (libPackages.length === 0) return []
  const stagedNm = path.join(tmpDir, 'node_modules')

  const out: LibManifestEntry[] = []
  for (const name of new Set([...libPackages, ...stagedPackages])) {
    const dir = path.join(stagedNm, ...name.split('/'))
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        version?: string
      }
      out.push({ name, version: pj.version ?? '0' })
    } catch {
      /* not staged — skip */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Write the runtime prelude into tmpDir and return its absolute path. */
export function writeExtractPrelude(tmpDir: string, manifest: LibManifestEntry[]): string {
  const builtins = JSON.stringify([...new Set(builtinModules)])
  const prelude = `// node-bundle: extract dlopen'ed shared-library packages to a real directory.
;(function () {
  if (!process.pkg) return
  var MANIFEST = ${JSON.stringify(manifest)}
  if (!MANIFEST.length) return
  var fs = require('fs')
  var path = require('path')
  var os = require('os')
  var crypto = require('crypto')
  var Module = require('module')
  var BUILTINS = ${builtins}

  // The bundle lives at <snapshotRoot>/.node-bundle/tmp/<bundle>.cjs and the
  // staged packages at <that dir>/node_modules.
  var srcNm = path.join(path.dirname(process.argv[1]), 'node_modules')
  var key = crypto
    .createHash('sha1')
    .update(MANIFEST.map(function (m) { return m.name + '@' + m.version }).join('|'))
    .digest('hex')
    .slice(0, 12)
  var root = path.join(os.tmpdir(), 'nb-x-' + key)
  var xnm = path.join(root, 'node_modules')
  var doneMarker = path.join(root, '.nb-complete')

  function copyDir(s, d) {
    fs.mkdirSync(d, { recursive: true })
    var entries = fs.readdirSync(s, { withFileTypes: true })
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i]
      var sp = path.join(s, e.name)
      var dp = path.join(d, e.name)
      if (e.isDirectory()) copyDir(sp, dp)
      else if (e.isFile() && !fs.existsSync(dp)) fs.copyFileSync(sp, dp)
    }
  }

  // Never redirect a bare Node builtin name (buffer, string_decoder, …) — a
  // userland package with that name may sit in the staged closure, but
  // require('buffer') must keep resolving to the core module.
  var names = []
  for (var i = 0; i < MANIFEST.length; i++) {
    if (BUILTINS.indexOf(MANIFEST[i].name) === -1) names.push(MANIFEST[i].name)
  }
  if (!names.length) return

  // Extract once; a completion marker keyed on name@version lets later boots
  // (and concurrent instances sharing the tmp dir) skip the whole copy.
  if (!fs.existsSync(doneMarker)) {
    for (var i = 0; i < names.length; i++) {
      try {
        copyDir(path.join(srcNm, names[i]), path.join(xnm, names[i]))
      } catch (e) {
        // Package not embedded for this platform — leave its resolution alone.
      }
    }
    try { fs.writeFileSync(doneMarker, key) } catch (e) {}
  }

  var orig = Module._resolveFilename
  Module._resolveFilename = function (request) {
    if (typeof request === 'string') {
      for (var i = 0; i < names.length; i++) {
        var n = names[i]
        if (request === n || request.indexOf(n + '/') === 0) {
          var args = Array.prototype.slice.call(arguments)
          args[0] = path.join(xnm, request)
          try {
            return orig.apply(this, args)
          } catch (e) {
            break // fall through to normal resolution
          }
        }
      }
    }
    return orig.apply(this, arguments)
  }
})();
`
  const file = path.join(tmpDir, 'nb-extract-prelude.js')
  fs.writeFileSync(file, prelude)
  return file
}
