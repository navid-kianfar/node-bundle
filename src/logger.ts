import pc from 'picocolors'

let indent = 0
const pad = () => '  '.repeat(indent)

export const log = {
  /** A top-level numbered/▶ step. */
  step(msg: string): void {
    process.stderr.write(`${pc.cyan(pc.bold('▶'))} ${pc.bold(msg)}\n`)
  },
  info(msg: string): void {
    process.stderr.write(`${pad()}${pc.dim('·')} ${msg}\n`)
  },
  success(msg: string): void {
    process.stderr.write(`${pad()}${pc.green('✓')} ${msg}\n`)
  },
  warn(msg: string): void {
    process.stderr.write(`${pad()}${pc.yellow('⚠')} ${pc.yellow(msg)}\n`)
  },
  error(msg: string): void {
    process.stderr.write(`${pad()}${pc.red('✗')} ${pc.red(msg)}\n`)
  },
  dim(msg: string): void {
    process.stderr.write(`${pad()}${pc.dim(msg)}\n`)
  },
  plain(msg: string): void {
    process.stderr.write(`${msg}\n`)
  },
  group<T>(fn: () => T): T {
    indent++
    try {
      return fn()
    } finally {
      indent--
    }
  },
  async groupAsync<T>(fn: () => Promise<T>): Promise<T> {
    indent++
    try {
      return await fn()
    } finally {
      indent--
    }
  },
}

export { pc }
