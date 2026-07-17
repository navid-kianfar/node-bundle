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

## Install

```bash
npm install -g @navid-kianfar/node-bundle    # global `node-bundle` command
# or run without installing:
npx -y @navid-kianfar/node-bundle --help
```

<details>
<summary>From source</summary>

```bash
pnpm install
pnpm build        # produces dist/cli.cjs
# optional: npm link   (to get a global `node-bundle` command)
```
</details>

## Quick start

```bash
# Analyse a project without building anything:
node-bundle /path/to/your/app --analyze

# Build protected Linux binaries for amd64 + arm64 (auto-selects Docker on macOS):
node-bundle /path/to/your/app --targets amd64,arm64 --node 22 --obfuscate safe
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

## Monorepos (pnpm workspaces)

If your app is a package inside a pnpm workspace (its deps use `workspace:*`), a plain
single-folder build can't resolve those internal packages or the shared base tsconfig.
Use `--monorepo` — point it at the package directory and the tool will, inside each
per-arch Linux container:

1. find the workspace root (`pnpm-workspace.yaml`),
2. `pnpm install` → `pnpm --filter <pkg>... build` → `pnpm --filter <pkg> deploy --prod`
   (producing a self-contained package), then
3. bundle + obfuscate + bytecode-pack that deployed package.

```bash
node-bundle path/to/providers/whatsapp --monorepo \
  --workspace-include providers \
  --targets amd64,arm64 --out ./out --name whatsapp
```

- `--workspace-include providers` copies only that top-level subtree into the build
  context (much faster than copying a monorepo that also contains a big frontend).
  Omit it to copy the whole workspace.
- Requires **pnpm** + **Docker** (the recipe runs in containers so native addons and
  bytecode are produced for each target arch).
- **Native modules must be in the deployed closure.** Optional peers (e.g. `better-sqlite3`
  behind drizzle) and dynamically-resolved natives (e.g. `sharp`) may be dropped by
  `pnpm deploy --prod`; ensure they're real dependencies (or add them) so they get embedded.

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
      --monorepo           build a pnpm-workspace package (install+build+deploy, then bundle)
      --workspace-include <list>  monorepo: only copy these subtrees, nested ok (faster)
      --static <dirs>      comma "from[:to]" dirs shipped NEXT TO the binary (sidecar)
      --config <path>      external JSON config file (outside the project)
```

### Architecture aliases

`amd64`, `x86_64` → `x64` · `aarch64` → `arm64` · bare arch tokens default to `linux`.

## Config

Configuration can live in three places (highest precedence first): **CLI flags** →
an external file passed with **`--config <path>`** → a **`node-bundle` key inside
`package.json`** → a **`node-bundle.config.json`** file in the project root. See
[`templates/node-bundle.config.example.json`](templates/node-bundle.config.example.json).

```jsonc
// package.json
{
  "name": "myapp",
  "node-bundle": {
    "targets": "amd64,arm64",
    "obfuscate": "safe",
    "external": ["sharp"],
    "assets": ["templates/**/*"],        // embedded into the binary (globs)
    "staticDirs": [                       // whole folders shipped with the app
      { "from": "public", "to": "public", "embed": false }
    ]
  }
}
```

### Shipping static folders (frontends, templates, certs…)

A `staticDir` is delivered one of two ways:

| `embed` | Where it lands | Served from | Use when |
|---------|----------------|-------------|----------|
| `false` *(sidecar)* | a real folder **next to the binary** in the output dir | the process working directory (`<cwd>/<to>`) | the app already reads `process.cwd()/public` (most web apps) |
| `true` *(embed)* | **inside the binary** (V8 snapshot) | `JSON.parse(process.env.NODE_BUNDLE_STATIC)[to]` at runtime | you want one truly self-contained file |

Embedded dirs set `NODE_BUNDLE_STATIC` to a JSON map of `{ to → absolute snapshot path }`
so app code can locate them without hard-coding `/snapshot/...` paths.

### Building & gathering extra packages (monorepo)

In `--monorepo` mode, `buildPackages` builds another workspace package (e.g. a
co-located frontend) and gathers its output as a static dir — replacing the usual
`COPY --from=frontend .../dist ./public` Docker step:

```jsonc
{
  "node-bundle": {
    "buildPackages": [
      { "package": "@acme/frontend", "from": "dist", "to": "public", "embed": false }
    ]
  }
}
```

node-bundle builds `@acme/frontend` in the same pass as your app (inside each per-arch
container), then places its `dist/` as `public/` next to the binary. Make sure the
package's subtree is copied into the build context (`--workspace-include`).

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

## Using node-bundle *inside* a Docker build

If you protect your app as part of `docker build` (rather than running node-bundle on
your machine and COPYing the result in), use `--mode host` and target only the stage's
own architecture — each `docker buildx` platform stage already *is* the target arch, and
Docker-in-Docker is not available during a build:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm AS protect
# native-addon toolchain (only needed if your app has native deps)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install -g @navid-kianfar/node-bundle
WORKDIR /app
COPY . .
ARG TARGETARCH
# amd64/arm64 are accepted aliases; bare arch tokens default to linux
RUN node-bundle . --mode host --targets ${TARGETARCH} --node 22 --obfuscate safe \
    --out /out --name myapp \
 && mv /out/myapp-linux-* /out/myapp

FROM gcr.io/distroless/cc-debian12
COPY --from=protect /out/myapp /usr/local/bin/myapp
ENTRYPOINT ["/usr/local/bin/myapp"]
```

Build both architectures natively in one go:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t registry/myapp:1.0 --push .
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
