export type ObfuscationLevel = 'off' | 'safe' | 'aggressive'

export type BuildMode = 'host' | 'docker' | 'auto'

export type PackageManager = 'pnpm' | 'yarn' | 'npm'

/** A single build target. Platform is fixed to linux for the Docker-deploy use case,
 *  but kept explicit so it can be widened later. */
export interface Target {
  platform: 'linux' | 'macos' | 'win'
  /** Node/pkg arch token: x64 | arm64 | armv7 */
  arch: 'x64' | 'arm64' | 'armv7'
}

/** Fully-resolved configuration after merging CLI flags, config file and detection. */
export interface ResolvedConfig {
  /** Absolute path to the target project root. */
  projectDir: string
  /** Absolute path to the output directory for the final executables. */
  outDir: string
  /** Base name for output binaries (without arch suffix). */
  name: string
  /** Optional cosmetic extension appended to each binary (e.g. ".node"). */
  ext: string
  /** Major Node version that pkg embeds (e.g. "22"). */
  nodeRange: string
  targets: Target[]
  mode: BuildMode
  obfuscate: ObfuscationLevel
  /** Compile to V8 bytecode (pkg). Disable only for debugging. */
  bytecode: boolean
  /** Run the project's own build (tsc/webpack/nest) before re-bundling. */
  runProjectBuild: boolean
  /** Explicit build command override (otherwise auto-detected). */
  buildCommand?: string
  /** Explicit entry override (post-build). Otherwise auto-detected. */
  entry?: string
  /** Extra files to embed into the binary (pkg asset globs, relative to project). */
  assets: string[]
  /** Package names to keep OUT of the esbuild bundle (left as runtime require, packed by pkg). */
  externals: string[]
  /** In docker mode, copy the project to a temp dir and reinstall deps for the target arch. */
  freshInstall: boolean
  /** Keep the .node-bundle/tmp working directory after a successful build. */
  keepTemp: boolean
  /** Target ECMAScript level for the esbuild bundle (helps obfuscator compatibility). */
  esbuildTarget: string
}

export interface DetectResult {
  packageManager: PackageManager
  isTypeScript: boolean
  /** "module" | "commonjs" (from package.json type, defaulting to commonjs). */
  moduleType: 'module' | 'commonjs'
  /** Detected `${pm} run build`-style command, if a build script exists. */
  buildCommand?: string
  /** Ordered candidate entry files (post-build), most-likely first. Absolute paths. */
  entryCandidates: string[]
  /** Human-readable build tooling detected (webpack, nest, tsc, ...). */
  frameworks: string[]
  /** Top-level package names that ship native .node addons. */
  natives: string[]
  /** package.json contents of the target project. */
  pkgJson: Record<string, unknown>
}

export interface BuildArtifact {
  target: Target
  /** Absolute path to the produced executable. */
  path: string
  /** Size in bytes. */
  size: number
}
