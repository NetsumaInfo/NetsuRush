# Agent Instructions

NetsuRush is a standalone desktop app (Tauri shell + Node "core" service) that drives DaVinci Resolve **from the outside** through external scripting, plus bridges to Premiere Pro and After Effects. It is not a plugin loaded inside any host.

## Language

- Code, identifiers, commit messages, PR titles/descriptions, issues: **English**.
- New comments and new docs: **English**.
- Existing comments and `docs/*` written in French: leave them; translate only a file you are already modifying. Do not open a mass-translation PR.
- UI copy is never hard-coded: add keys to **all 6 locales** in `src/locales/<lang>/` and run `npm run check:i18n`. `fr` is the source language for wording; the glossary is `src/locales/GLOSSARY.md`.

## Package Manager

- Use **npm**: `npm ci` (lockfile is `package-lock.json`). Node 22+.

## Commands

| Task | Command |
|---|---|
| Type-check + build renderer | `npm run build` |
| Type-check core service | `npm run check:core` |
| Locale parity | `npm run check:i18n` |
| All Node tests | `node --test test/*.test.cjs` |
| One Node test | `node --test test/<name>.test.cjs` |
| All Python tests | `python -m unittest discover -s test -p "test_*.py"` |
| One Python test | `python -m unittest discover -s test -p test_<name>.py` |
| Rust shell check | `cargo check --locked` (in `src-tauri/`) |
| Core alone, headless | `npm run core` |

- 23 of the 63 Node suites also have an `npm run test:*` shortcut; the rest run with `node --test`.
- `.github/workflows/ci.yml` is the source of truth for what must pass.
- There is no ESLint and no formatter config: `tsc` is the lint.

## Runtime Constraints

- A dev instance is often already running (Vite on :1420 + Tauri window). **Do not launch, close or rebuild the app**: no `npm run tauri dev`, no `npm run package`, no `cargo build`/`tauri build`. `cargo check` is the only Rust verification.
- `src/**` changes hot-reload. Changes to `core/**`, `python/**` or `src-tauri/**` need a **Tauri window restart** to respawn the core: request it, and state that until it happens the running core still executes the old code.
- Report anything that needs a running app as **not verified at runtime**, never as done.
- Project features (status, Media Pool, timelines, import) need **Resolve Studio** open with a project and *Preferences ▸ System ▸ General ▸ External scripting = Local*. Without it the bridge returns `connected:false` and the rest of the app still works.

## External References

| Need | File |
|---|---|
| Setup, branch and PR rules | `CONTRIBUTING.md` |
| Product vision, modules, risks | `docs/prd.md` |
| Phase-2 tutorial discovery and community hub (design only) | `docs/community-hub.md` |
| Runtime layout, IPC, UI system, theming, settings map | `docs/architecture.md` |
| Rules that break correctness if violated | `docs/invariants.md` |
| Per-module notes (board, `.netsu`, voice, models, roto) | `docs/modules.md` |
| Adobe CEP panel and timeline transfer | `docs/host-bridges.md` |
| Packaging, first-run setup, auth, presence | `docs/distribution.md` |
| One-time Convex/Discord auth provisioning | `docs/auth-setup.md` |
| Code structure and cleanliness rules | `docs/code-style.md` |
| Timeline-transfer research log (read before reopening) | `docs/timeline-transfer-research.md` |
| Windows compatibility notes | `docs/windows-compatibility.md` |
| Release process | `docs/releasing.md` |
| Authenticode, SmartScreen reputation, Defender false positives | `docs/code-signing.md` |
| Security policy | `SECURITY.md` |
| Licensing (AGPL-3.0-only, third-party notices) | `LICENSE`, `LICENSES/`, `docs/licensing.md` |

## Key Conventions

- **Every new IPC channel is added in three places**: handler table in `core/rpc.js`, `NrApi` + implementation in `src/lib/coreClient.ts`, `mock` in `src/lib/bridge.ts`.
- `core/` is CommonJS; the repo root is `type: module` for the Vite renderer.
- Import alias `@/` → `src/`.
- **UI comes from shadcn/ui in its Base UI flavor** (`src/components/ui/`), never Radix, and never a hand-rolled equivalent of a component shadcn provides. Base UI uses a `render` prop, not `asChild`.
- **Tooltips**: always the project `Tooltip` component; never a native `title=`.
- **No JS-driven animation on grids** (no GSAP, no framer-motion `layout`/`AnimatePresence`): it competes with video decoding. Use CSS and `content-visibility`.
- **Frame math is an invariant.** `endFrame` is inclusive on the Resolve side; set the timeline frame rate before creating a timeline; remap detector frames onto Resolve's frame count. Details in `docs/invariants.md` — do not touch `core/timeline.js` without reading it.
- **Cutting and extraction are lossless** (`-c copy`), which means the cut snaps to keyframes and is **not** frame-exact — accepted, and warned about in the UI. Only a re-encode cuts to the frame, and it must do so exactly (`core/export/frameCut.js`). Encoders are **never hard-coded per vendor**: the proxy and export paths resolve a probed hardware encoder (NVENC, AMF or Quick Sync) and fall back to hardware H.264, then to `libx264`. Never trigger `libx265` automatically. Details in `docs/invariants.md`.
- **Licence hygiene** (the app is distributed under AGPL-3.0-only and must stay redistributable): never copy GPL/AGPL code into the tree, even translated. Non-commercial ML weights are allowed only as clearly badged optional add-ons and are never the default for a task; every task keeps a permissive default engine.
- **Every runtime dependency added must also update packaging** — see the checklist in `docs/distribution.md`.
- Never commit: `dist/`, `nr.config.json`, `.env.local`, `.venv/`, `vendor/`, `*.node`.

## Commit Attribution

- Do **not** add `Co-Authored-By` or any other AI attribution trailer to commits.
- Keep one PR to one change; describe what changed, why, and which checks were actually run.
