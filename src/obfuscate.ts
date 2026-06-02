import { builtinModules } from 'node:module'
import JavaScriptObfuscator, { type ObfuscatorOptions } from 'javascript-obfuscator'
import type { ObfuscationLevel } from './types.js'

/**
 * Module specifiers must stay as plain string literals so pkg can trace and embed
 * them (native addons, dynamic-loaded packages). The obfuscator's string-array
 * transform would otherwise turn `require('bcrypt')` into `require(decode(..))`,
 * which pkg cannot resolve. We reserve every Node built-in and every externalized
 * package name from string-array transformation.
 */
function reservedStringPatterns(externals: string[]): string[] {
  const names = new Set<string>()
  for (const b of builtinModules) {
    names.add(b)
    names.add(`node:${b}`)
  }
  for (const e of externals) names.add(e)
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...names].map((n) => `^${escape(n)}$`)
}

/**
 * Build obfuscator options for the given level.
 *
 * Rationale: the final artifact is V8 bytecode, which already erases identifiers
 * and high-level structure. What *remains* readable in bytecode are string
 * literals (URLs, SQL, messages, keys). So both presets prioritise string-array
 * encryption. `selfDefending`/`debugProtection` are intentionally OFF — pkg
 * re-parses and bytecode-compiles this output, which would corrupt those guards,
 * and they're moot once there's no JS source to protect.
 */
function optionsFor(level: Exclude<ObfuscationLevel, 'off'>): ObfuscatorOptions {
  const base: ObfuscatorOptions = {
    target: 'node',
    compact: true,
    simplify: true,
    // Safe to rename top-level names: esbuild already produced a fully self-contained
    // bundle, so nothing outside references them. This also mangles the function names
    // V8 would otherwise store in bytecode for stack traces. esbuild's keepNames still
    // restores .name at runtime from the (encoded) string array, preserving framework
    // behaviour (NestJS, class-validator, etc.).
    renameGlobals: true,
    identifierNamesGenerator: 'mangled-shuffled',
    stringArray: true,
    stringArrayThreshold: 1, // encode ALL strings (a lower value leaves some inline as plaintext)
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayIndexShift: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersType: 'function',
    selfDefending: false,
    debugProtection: false,
    disableConsoleOutput: false,
    unicodeEscapeSequence: false,
  }

  if (level === 'safe') {
    return {
      ...base,
      stringArrayEncoding: ['base64'],
      controlFlowFlattening: false,
      deadCodeInjection: false,
      splitStrings: false,
      numbersToExpressions: false,
      transformObjectKeys: false,
    }
  }

  // aggressive
  return {
    ...base,
    stringArrayEncoding: ['rc4'],
    splitStrings: true,
    splitStringsChunkLength: 8,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,
    numbersToExpressions: true,
    transformObjectKeys: true,
  }
}

export function obfuscateCode(
  code: string,
  level: Exclude<ObfuscationLevel, 'off'>,
  externals: string[] = [],
): string {
  const options: ObfuscatorOptions = {
    ...optionsFor(level),
    reservedStrings: reservedStringPatterns(externals),
  }
  const result = JavaScriptObfuscator.obfuscate(code, options)
  return result.getObfuscatedCode()
}
