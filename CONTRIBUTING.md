# Contributing to NetsuRush

Thanks for your interest in NetsuRush.

Useful contributions include bug fixes, performance and accessibility work, translations, documentation, and features that help a real derushing workflow.

## Before you start

- Search existing issues before opening a new one.
- For a significant feature or any change to the workflow or architecture, open an issue first so the direction can be agreed.
- Keep one pull request focused on one change; avoid unrelated edits.

## Language

- Code, identifiers, commit messages, pull requests and issues: **English**.
- New comments and new documentation: **English**. Parts of the existing code and of `docs/` are written in French; leave them as they are and translate only a file you already need to modify.
- User-facing text is never hard-coded. Add keys to all six locales under `src/locales/` and run `npm run check:i18n`. `fr` is the source language for wording; see `src/locales/GLOSSARY.md`.

## Local setup

Requirements: Windows, Node.js 22+, Rust, Python 3.10–3.12, and FFmpeg/FFprobe.

```bash
git clone https://github.com/NetsumaInfo/NetsuRush.git
cd NetsuRush
npm ci
pip install -r python/requirements.txt
```

Then start development with `run.bat`, or in two terminals:

```bash
npm run dev
npm run tauri dev
```

Vite must be up before Tauri. The Rust shell spawns the Node core itself, so there is nothing else to start.

DaVinci Resolve Studio is only needed to test project, Media Pool and timeline features; enable external scripting (`Local`) in its preferences first. Everything else — ffmpeg, thumbnails, search, board — works without it.

### No account, no Convex, no backend needed

**Do not configure Convex to run the app.** The login gate is conditional on a single environment variable: with `VITE_CONVEX_URL` unset — which is the default, since `.env.local` is git-ignored — `convexConfigured` is false and:

- the auth gate renders the app directly, so **there is no login screen**;
- the gate's chunk is lazy, so `convex/react` and `better-auth` are never even downloaded or parsed;
- the account settings page shows a "not configured" state instead of failing;
- the bug reporter falls back to its manual form instead of using a Discord identity.

Nothing points at the maintainer's deployment: the URL lives only in an ignored `.env.local`, and the renderer reaches Convex functions through `anyApi`, so no generated file is imported. CI has no secrets and builds green — that is the proof this path works.

Only contribute **to the authentication code** if you want to set it up, and then use your **own** free Convex deployment and your **own** Discord application: see `docs/auth-setup.md`. Official builds ship with Convex configured, which is what turns the beta login on; a community build simply has no gate.

## Pull requests

1. Branch from `main` with a clear name, e.g. `fix/proxy-cache` or `feat/export-profile`.
2. Follow the existing conventions and architecture (`AGENTS.md` and `docs/code-style.md`).
3. Do not add a dependency without a clear need.
4. Explain what changes, why, any trade-offs, and how you verified it.
5. List the checks you actually ran, and say clearly what you could not test — especially anything requiring Resolve, Premiere Pro or After Effects.
6. Add screenshots or a short clip for visual changes.
7. Do not mix a broad refactor with a behaviour change in the same pull request.

## Checks

Run the checks matching the layers you touched:

| Layer | Command |
|---|---|
| Renderer (`src/`) | `npm run build` |
| Core service (`core/`) | `npm run check:core` |
| Text and translations | `npm run check:i18n` |
| Node tests | `node --test test/*.test.cjs` |
| Python tests | `python -m unittest discover -s test -p "test_*.py"` |
| Rust shell (`src-tauri/`) | `cargo check --locked` |

Add targeted tests whenever the behaviour can be verified automatically; several invariants documented in `docs/invariants.md` are locked by tests, and a new invariant should be too. Changes to `core/**` or `python/**` require a full restart of the Tauri window before runtime testing.

By contributing you agree that your contribution is distributed under the project's [GNU AGPL v3.0](LICENSE) licence, and you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
