import fs from 'node:fs'
import path from 'node:path'
import type { PackageManager } from './types.js'

export function detectPackageManager(projectDir: string, pkgJson: Record<string, unknown>): PackageManager {
  const pmField = typeof pkgJson.packageManager === 'string' ? pkgJson.packageManager : ''
  if (pmField.startsWith('pnpm')) return 'pnpm'
  if (pmField.startsWith('yarn')) return 'yarn'
  if (pmField.startsWith('npm')) return 'npm'

  if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) return 'yarn'
  if (fs.existsSync(path.join(projectDir, 'package-lock.json'))) return 'npm'
  return 'npm'
}

/** `<pm> run <script>` */
export function runScriptCmd(pm: PackageManager, script: string): string {
  if (pm === 'yarn') return `yarn ${script}`
  if (pm === 'npm') return `npm run ${script}`
  return `pnpm run ${script}`
}

/** Run a local binary: `<pm> exec <bin> <args>` */
export function execBinCmd(pm: PackageManager, bin: string): string {
  if (pm === 'yarn') return `yarn ${bin}`
  if (pm === 'npm') return `npx --no-install ${bin}`
  return `pnpm exec ${bin}`
}

/** Install all dependencies (incl. dev — we need the build toolchain).
 *  Uses the reproducible lockfile install when a lockfile is present. */
export function installCmd(pm: PackageManager, projectDir: string): string {
  const has = (f: string) => fs.existsSync(path.join(projectDir, f))
  if (pm === 'yarn') return has('yarn.lock') ? 'yarn install --frozen-lockfile' : 'yarn install'
  if (pm === 'npm') return has('package-lock.json') ? 'npm ci' : 'npm install'
  return has('pnpm-lock.yaml') ? 'pnpm install --frozen-lockfile' : 'pnpm install'
}
