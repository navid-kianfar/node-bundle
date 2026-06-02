import fs from 'node:fs'
import path from 'node:path'
import { exec as pkgExec } from '@yao-pkg/pkg'
import type { BuildArtifact, Target } from './types.js'

export interface PackOptions {
  /** Directory containing a package.json whose `bin` points at the bundle. */
  configDir: string
  outDir: string
  name: string
  ext: string
  /** Major Node version pkg should embed, e.g. "22". */
  nodeRange: string
  targets: Target[]
  bytecode: boolean
  /** Embedded-content compression. */
  compress?: 'GZip' | 'Brotli' | 'None'
}

export interface PackOutcome {
  artifacts: BuildArtifact[]
  /** Target strings for which pkg failed to produce bytecode and fell back to source. */
  bytecodeFailures: string[]
}

/** Tee process stdout/stderr through a line scanner while still printing. */
function captureConsole(onText: (text: string) => void): () => void {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  const wrap =
    (orig: typeof origOut) =>
    (chunk: unknown, ...rest: unknown[]): boolean => {
      try {
        onText(typeof chunk === 'string' ? chunk : String(chunk))
      } catch {
        /* ignore scanner errors */
      }
      // @ts-expect-error - passthrough of variadic write args
      return orig(chunk, ...rest)
    }
  process.stdout.write = wrap(origOut) as typeof process.stdout.write
  process.stderr.write = wrap(origErr) as typeof process.stderr.write
  return () => {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

export function pkgTargetString(nodeRange: string, t: Target): string {
  return `node${nodeRange}-${t.platform}-${t.arch}`
}

export async function pack(opts: PackOptions): Promise<PackOutcome> {
  fs.mkdirSync(opts.outDir, { recursive: true })
  const artifacts: BuildArtifact[] = []
  const bytecodeFailures = new Set<string>()

  for (const t of opts.targets) {
    const targetStr = pkgTargetString(opts.nodeRange, t)
    const outName = `${opts.name}-${t.platform}-${t.arch}${opts.ext}`
    const outFile = path.join(opts.outDir, outName)

    const args = [opts.configDir, '--targets', targetStr, '--output', outFile]
    if (!opts.bytecode) args.push('--no-bytecode')
    if (opts.compress && opts.compress !== 'None') args.push('--compress', opts.compress)

    const restore = captureConsole((text) => {
      if (/Failed to make bytecode/i.test(text)) bytecodeFailures.add(targetStr)
    })
    try {
      await pkgExec(args)
    } finally {
      restore()
    }

    const exists = fs.existsSync(outFile)
    if (exists) fs.chmodSync(outFile, 0o755)
    artifacts.push({
      target: t,
      path: outFile,
      size: exists ? fs.statSync(outFile).size : 0,
    })
  }

  return { artifacts, bytecodeFailures: [...bytecodeFailures] }
}
