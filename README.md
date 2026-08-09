<div align="center">
  <img src="src-tauri/icons/128x128.png" alt="NetsuRush" width="112" height="112">

# NetsuRush

**A footage-review hub for DaVinci Resolve Studio.** Preview your rushes, detect shots with AI, cut losslessly, and build a frame-accurate timeline — without ever re-encoding or shifting a cut.

[![Licence: AGPL v3](https://img.shields.io/badge/licence-AGPL--3.0--only-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-lightgrey.svg)

</div>

NetsuRush is a **standalone desktop app**, not a plugin: a **Tauri** shell plus a local **Node "core"** service that talks to Resolve through external scripting (`DaVinciResolveScript`). It reads Media Pool clips, detects shot boundaries, and hands back cuts or a whole timeline. Around that core sit a reference board, a notebook, a script editor, AI processing tools and bridges to Premiere Pro and After Effects.

Because the app drives Resolve **from the outside**, nothing is installed inside your editor and Resolve never has to be restarted to pick up a new version.

## Features

| Module | What it does |
|---|---|
| **NetsuCut** | Footage review: preview, AI shot detection, lossless cutting, frame-accurate timeline building, shot collections |
| **NetsuSearch** | Find a shot by describing it (SigLIP 2), plus duplicates, groups and face search |
| **NetsuBoard** | Infinite reference board — images, videos, YouTube, notes, drawing |
| **NetsuBook** | Notebook with linked pages, databases and exports |
| **NetsuDraft** | Script-first writing where one paragraph is one shot |
| **NetsuLab** | Upscaling, frame interpolation, depth, background removal, matting, interactive roto |
| **NetsuTalk** | Transcription, silence removal, subtitles, text-based editing |
| **NetsuBoost** | Frees host resources (cache, stray processes, memory) during heavy work |
| **NetsuBridge** | Moves a timeline between editing applications |
| **NetsuPilot** | AI copilot driving the app and Resolve through tools |

Everything above is implemented and type-checked, and the invariants are covered by tests. Two areas have **never been exercised end to end at runtime**: the AI copilot (it needs an API key or a local CLI agent) and the Premiere Pro / After Effects side of the bridges (they need those applications installed). Bug reports on those two are especially welcome.

> [!NOTE]
> Everything that touches a **project** (status, Media Pool, timelines, import) needs DaVinci Resolve **Studio** — the free edition does not expose the scripting API. The rest of the app (ffmpeg work, thumbnails, search, board, notebook, processing) runs perfectly with Resolve closed.

## Getting started

### Prerequisites

- **Windows** with WebView2 (shipped with Windows 11)
- **Node.js 22+** and **Rust / Cargo** (the Tauri toolchain)
- **Python 3.10–3.12** and **ffmpeg / ffprobe** on your `PATH`
- **DaVinci Resolve Studio**, only for project features: open a project, then enable *Preferences ▸ System ▸ General ▸ External scripting = `Local`* and restart Resolve

> [!TIP]
> For ffmpeg, use the version pinned in `scripts/setup.ps1`. The installed app checks its ffmpeg version, but a development `PATH` is not checked — an older build will silently behave differently from what ships.

### Run it

```bash
git clone https://github.com/NetsumaInfo/NetsuRush.git
cd NetsuRush
npm ci
pip install -r python/requirements.txt

run.bat
```

`run.bat` is an interactive launcher: it checks your toolchain, installs npm packages when the lockfile changed, starts Vite, waits for it, then starts the Tauri window (which spawns the core itself). To do it by hand, in two terminals:

```bash
npm run dev        # Vite renderer with HMR on :1420 — must be up first
npm run tauri dev  # Tauri window; the Rust shell spawns the Node core on :8730
```

> [!IMPORTANT]
> **You do not need an account or any backend to run the app.** The login gate only exists when `VITE_CONVEX_URL` is set, and `.env.local` is git-ignored — so a fresh clone opens straight into the app, offline. See [`CONTRIBUTING.md`](CONTRIBUTING.md) if you want to work on the authentication code itself.

Renderer changes hot-reload. Changes under `core/`, `python/` or `src-tauri/` require closing the Tauri window and starting it again, because the core is respawned at launch.

### Build and package

```bash
npm run build     # type-check + build the renderer into dist/
npm run package   # NSIS installer → src-tauri/target/release/bundle/nsis/
```

The installer is `currentUser` (no admin rights) and carries a portable `node.exe`, so the person receiving it installs nothing else. On **first launch**, the app provisions about 2.5 GB into `%LOCALAPPDATA%\NetsuRush`: an adaptive Python venv, a matching ONNX runtime, the pinned ffmpeg build, and the default model weights. A "continue without" button starts the app in degraded mode.

> [!WARNING]
> The native player runtime (libmpv and its ffmpeg DLLs) is **not** versioned in this repository: mpv is GPL-2.0-or-later and ffmpeg LGPL/GPL, licences distinct from this project's AGPL that require shipping their corresponding sources. It is distributed as a release asset and fetched by `scripts/fetch-mpv.ps1`. Without it the app builds and runs, but the native video player stays unavailable.

## Hardware

No NVIDIA GPU is required. NVIDIA, AMD and Intel are each accelerated when their runtime or encoder passes a **real probe** at first launch — H.264 and H.265 alike, since `hevc_amf` and `hevc_qsv` are used exactly like `hevc_nvenc` — and the CPU path always takes over otherwise. See the [Windows compatibility matrix](docs/windows-compatibility.md).

## How it works

```
src-tauri/          Rust shell: WebView2 window, HEVC flag, spawn/kill of the core
      │ spawn
core/server.js      Node service on 127.0.0.1:8730
  ├─ media-server   /media (Range/seek) + /stream (live ffmpeg)
  ├─ rpc            POST /rpc + SSE /events
  ├─ resolve-bridge + resolve_helper.py → external Python bridge to Resolve
  ├─ adobe          round-trip jobs to the CEP panel (Premiere / After Effects)
  └─ ffmpeg · thumbs · proxy · sidecars · timeline · export · transfer · reference
      │ HTTP/SSE
src/                React renderer (lib/bridge.ts → coreClient.ts)
```

| Folder | Contents |
|---|---|
| `src/` | React renderer — UI, zustand store, `lib/bridge.ts` as the single contact point with the backend |
| `core/` | Node service (CommonJS): RPC, media server, Resolve bridge, ffmpeg, sidecars, export |
| `python/` | ML sidecars: shot detection, search, upscaling, roto, voice |
| `src-tauri/` | Rust shell: window, native mpv player, NSIS packaging |
| `adobe-cep/` | CEP extension for Premiere Pro and After Effects (committed, zero build) |
| `convex/` | Optional authentication backend |
| `scripts/` | Build, packaging, dependency provisioning, checks |
| `test/` | Node (`*.test.cjs`) and Python (`test_*.py`) suites |

## Documentation

| Topic | File |
|---|---|
| Agent and contributor instructions | [`AGENTS.md`](AGENTS.md) |
| Setting up, branching, pull requests | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Runtime layout, IPC, UI system, theming | [`docs/architecture.md`](docs/architecture.md) |
| Rules that break correctness if violated | [`docs/invariants.md`](docs/invariants.md) |
| Per-module engineering notes | [`docs/modules.md`](docs/modules.md) |
| Adobe panel and timeline transfer | [`docs/host-bridges.md`](docs/host-bridges.md) |
| Packaging, first-run setup, accounts | [`docs/distribution.md`](docs/distribution.md) |
| Third-party licences before redistributing | [`docs/licensing.md`](docs/licensing.md) |

## Inspiration

NetsuRush would not look the way it does without these projects. Each one shaped a specific part of it:

| Project | What it inspired |
|---|---|
| [AMVerge](https://github.com/AMVerge-team/AMVerge) | The footage-review experience: shot grid on the left, sticky player on the right, hover-to-play, "play everything". Also its approach to hardware encoder detection and to dead-frame deduplication |
| [Ultimate-AMV](https://github.com/ElishaPervez/Ultimate-AMV) | Editing-workflow ideas for anime and music-video work |
| [scene-scout](https://github.com/Mark-Shun/scene-scout) | The natural-language shot search, whose core approach it follows |
| [Sammie-Roto-2](https://github.com/Zarxrax/Sammie-Roto-2) | Roto Studio: point prompting, partial re-propagation, non-destructive mask post-processing, matte refinement stepped frame by frame |
| [AnimRef](https://github.com/lettucegoblin/AnimRef) | The infinite reference board, rebuilt in React |
| [BeeRef](https://github.com/rbreu/beeref) | Reference-board interaction ideas |
| [AppFlowy](https://github.com/AppFlowy-IO/AppFlowy) | The notebook: block gutter, breadcrumb, page mentions, icon picker, document tabs |

> [!NOTE]
> These are **inspirations, not sources**: what was taken is the idea, the interaction design, the problem worth solving. Nothing was copied — every feature above is an independent implementation, written from scratch for this codebase. That matters legally as much as morally, since several of these projects are GPL or AGPL licensed: see [`docs/licensing.md`](docs/licensing.md).

Also worth naming: **PureRef** for the idea of a single living document file, and **autocut** for silence removal.

## Resources

- [DaVinci Resolve scripting API — wiki](https://wiki.dvresolve.com/developer-docs/scripting-api)
- [DaVinci Resolve scripting API — readthedocs mirror](https://resolvedevdoc.readthedocs.io/en/latest/readme_resolveapi.html)
- The authoritative reference is the `README.txt` shipped with your Resolve install, under `Support/Developer/Scripting/`
