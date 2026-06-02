# node-bundle

Bundle and **protect** a Node.js application into a **single self-contained executable**,
one per CPU architecture (amd64 / arm64), with **all dependencies included** and the
JavaScript compiled to **V8 bytecode** so your source is not shipped in readable form.

Built for the case where you install your apps on a client's servers (via Docker) and
don't want them reading or trivially reverse-engineering your code.

```
your app ──▶ run its own build (tsc / webpack / nest / …)
         ──▶ esbuild: bundle entry + ALL deps into ONE .cjs file
         ──▶ obfuscate (string-array encryption + identifier mangling)
         ──▶ pkg: compile to V8 bytecode + embed Node runtime
         ──▶ one executable per architecture  (no Node needed on the client)
```

---

## ⚠️ Read this first: what "protection" really means

This tool raises the cost of reverse-engineering a lot. It does **not** make it impossible.
Be honest with yourself about the threat model:

- **Bytecode** removes your readable JS. To inspect logic an attacker must decompile V8
  bytecode — hard, tool-assisted, lossy, but **possible**.
- **Obfuscation** encrypts string literals and mangles names. But the program must decode
  its own strings at runtime, so a determined attacker running the binary **can recover
  strings**. Treat obfuscation as a speed bump on top of bytecode, not a vault.
- **There is no DRM in client-side code.** Anything that must run on the client's machine
  can ultimately be observed on the client's machine.

**Practical guidance:** for anything that truly must stay secret (signing keys, the "secret
sauce" algorithm, license validation that can't be patched out), keep it **server-side**
behind an API. Use this tool to protect the bulk of your application code and to make
casual copying / inspection impractical — which is what it does very well.

---

## Requirements

| Need | Why |
|------|-----|
| **Node.js ≥ 18** | to run the tool |
| **Docker** (running) | to build for an OS/arch different from your machine — i.e. building **Linux** binaries on **macOS/Windows**, and to build any app with **native addons**. See [Build modes](#build-modes). |
| Your project's package manager (npm/pnpm/yarn) | the tool runs your real build |

> Building Linux binaries from macOS/Windows **requires Docker** because pkg's V8 bytecode
> is host-specific and is rejected at startup when embedded in a different-OS/arch binary
> (verified). Docker mode builds each architecture *natively* inside a Linux container.

## Install / build the tool

```bash
pnpm install      # or npm install
pnpm build        # produces dist/cli.cjs
# optional: npm link   (to get a global `node-bundle` command)
```

## Quick start

```bash
# Analyse a project without building anything:
node dist/cli.cjs /path/to/your/app --analyze

# Build protected Linux binaries for amd64 + arm64 (auto-selects Docker on macOS):
node dist/cli.cjs /path/to/your/app --targets amd64,arm64 --node 22 --obfuscate safe
```

Outputs land in `<project>/node-bundle-out/`:

```
node-bundle-out/
  yourapp-linux-x64      # amd64
  yourapp-linux-arm64
```

Run one (no Node required on the host):

```bash
./node-bundle-out/yourapp-linux-x64 --your --app --args
```

## Build modes

| Mode | When | What it does |
|------|------|--------------|
| `host` | building for the **same OS+arch** you're on, pure-JS apps | runs the whole pipeline locally — fastest |
| `docker` | building **cross-OS/arch** (e.g. Linux from a Mac) or apps with **native addons** | builds each target *inside a `linux/<arch>` container* via QEMU, so native addons and bytecode are generated natively and correctly |
| `auto` *(default)* | — | picks `docker` when bytecode-cross-target or native addons make `host` unreliable, otherwise `host` |

Native `.node` addons are **architecture-specific machine code** and cannot be
cross-compiled by copying — `auto` will route those builds through Docker.

## CLI reference

```
node-bundle [projectDir] [options]

  -o, --out <dir>          output dir (default: <project>/node-bundle-out)
  -n, --name <name>        output base name (default: package.json "name")
      --ext <ext>          cosmetic extension, e.g. ".node"
      --node <version>     Node major version to embed (default: 22)
  -t, --targets <list>     e.g. "linux-x64,linux-arm64" or "amd64,arm64"
  -m, --mode <mode>        auto | host | docker   (default: auto)
      --obfuscate <level>  off | safe | aggressive (default: safe)
      --no-bytecode        disable V8 bytecode (debug only; weakens protection)
      --no-build           skip your project's own build step
      --build-command <c>  override the detected build command
      --entry <file>       override the (post-build) entry file
      --assets <globs>     comma list of extra files to embed (pkg assets)
      --external <pkgs>    comma list of extra packages to keep out of the bundle
      --fresh-install      copy project to temp + reinstall before building
      --keep-temp          keep the .node-bundle/ working dir
      --esbuild-target <t> esbuild target (default: node<version>)
      --analyze            detect & print a report, then exit
```

### Architecture aliases

`amd64`, `x86_64` → `x64` · `aarch64` → `arm64` · bare arch tokens default to `linux`.

## Config file

Drop a `node-bundle.config.json` in the project root (CLI flags override it). See
[`templates/node-bundle.config.example.json`](templates/node-bundle.config.example.json).

## Obfuscation levels

| Level | Identifier mangling | String encryption | Control-flow flattening | Notes |
|-------|--------------------|-------------------|-------------------------|-------|
| `off` | – | – | – | bytecode only |
| `safe` *(default)* | yes | base64 string array (all strings) | no | minimal runtime cost; good default |
| `aggressive` | yes | rc4 + string splitting | yes + dead-code injection | strongest; slower build & some runtime cost |

Module specifiers (`require('x')`) and Node built-ins are always left intact so pkg can
still find and embed them. `selfDefending`/`debugProtection` are intentionally disabled —
they break once the output is bytecode-compiled.

## Deploying with Docker

The binaries are **glibc**-based — run them on a glibc image (`distroless/cc-debian12`,
`debian:bookworm-slim`, `ubuntu`). **Do not use Alpine/musl.** See
[`templates/Dockerfile.distroless`](templates/Dockerfile.distroless) for a minimal
multi-arch runtime image.

```dockerfile
FROM gcr.io/distroless/cc-debian12
COPY node-bundle-out/myapp-linux-x64 /usr/local/bin/myapp
ENTRYPOINT ["/usr/local/bin/myapp"]
```

## Native addons (bcrypt, sharp, better-sqlite3, prisma, …)

Detected automatically (by scanning `node_modules` for `.node` files / `binding.gyp`),
kept out of the JS bundle, and embedded by pkg. Because they're machine code, such apps
**must** build in `docker` mode (one container per arch). Some packages that resolve their
native binary dynamically (notably **sharp**, **prisma**'s query engine) may need extra
help — add their platform packages or engine files via `--assets`, and test the binary.

## Limitations & gotchas

- **ESM with top-level `await`** can't be emitted as CommonJS; such entries aren't supported
  by the default pipeline. Most server apps (tsc→CJS, webpack, NestJS) are fine.
- **Dynamic `require(variable)`** can't be traced into the bundle. The tool surfaces esbuild
  warnings; add the module via `--assets`/`--external` if needed.
- **Alpine/musl** runtime images won't run these glibc binaries.
- Binaries are large (~60–75 MB) because they embed the full Node runtime. That's expected
  for self-contained executables.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `V8 rejected the bytecode cache … cross-platform bytecode` | You built cross-OS/arch in `host` mode. Use `--mode docker` (default auto does this). |
| `Could not locate a compiled entry file` | Pass `--entry <post-build .js>`, or ensure your build produces e.g. `dist/main.js`. |
| `Dynamic require may fail at run time` (pkg warning) | A dynamic `require()` couldn't be bundled — add the target via `--assets`/`--external`. |
| Binary exits with loader/`not found` error | You're on Alpine/musl — switch to a glibc base image. |
| Docker mode: `docker version failed` | Start Docker Desktop / the daemon. |

## How it works (internals)

1. **detect** — reads `package.json`: package manager, TS vs JS, build command, native addons, entry candidates.
2. **build** — runs your project's real build (so framework transforms like NestJS decorator metadata are preserved — esbuild alone would drop them).
3. **bundle** — esbuild collapses the built entry + all pure-JS deps into one `.cjs`; native packages stay external.
4. **obfuscate** — javascript-obfuscator encrypts strings + mangles names (module specifiers reserved).
5. **pack** — `@yao-pkg/pkg` compiles the bundle to V8 bytecode and embeds the Node runtime, once per target arch.
6. In **docker** mode, steps 1–5 run inside a `linux/<arch>` container so everything is native to the target.

## License

MIT
