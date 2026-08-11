# Invariants

Rules that break correctness when violated. Each one already fixed a real bug. Locked by tests where a test can express them.

## DaVinci Resolve API

Official references: [Scripting API wiki](https://wiki.dvresolve.com/developer-docs/scripting-api) · [readthedocs mirror](https://resolvedevdoc.readthedocs.io/en/latest/readme_resolveapi.html). **The authoritative source is the `README.txt` shipped with the installed Resolve** (`…/Support/Developer/Scripting/`): it matches the API actually available on the machine.

Object chain in use: `resolve.GetProjectManager()` → `.GetCurrentProject()` → `.GetMediaPool()` / `.GetMediaStorage()`. The Media Pool is walked recursively: `GetRootFolder()` → `GetClipList()` + `GetSubFolderList()`. Clip properties come from `item.GetClipProperty('File Path' | 'FPS' | 'Frames' | 'Duration' | 'Resolution' | 'Format')` — **exact, case-sensitive** names.

All calls are defensively `await`ed: the bridge returns promises. Frame math stays in JS on top of the proxy.

### Frame-accurate timeline — DO NOT BREAK

`buildTimeline` (`core/timeline.js`) references the **original MediaPoolItem** with in/out frames. Never re-export a file and re-import it — that shifted every cut. Four cumulative rules:

1. **`endFrame` is INCLUSIVE** on the Resolve side (official doc: startFrame 0 / endFrame 23 = 24 frames). TransNetV2 already returns inclusive values; ffmpeg/seconds convert as `round(sec*fps) - 1`.
2. **`GetSourceEndFrame` is INCLUSIVE too.** Measured on Resolve Studio 21.0.3 with whole, untrimmed clips: a 96-frame file filling 96 timeline frames reports `ssf=0, sef=95`. Reading it as exclusive costs the LAST FRAME of every clip and fabricates a 95/96 speed on a clip that was never retimed — false retimes everywhere, real ones drowned in them. `srcOut = sef`; reverse (`ssf > sef`) covers `[sef, ssf]`; `ssf == sef` is a freeze holding one frame. Locked by `test/resolve-source-range.test.cjs`.
3. **Before `CreateEmptyTimeline`, call `proj.SetSetting('timelineFrameRate', clipFPS)`** — otherwise the timeline takes the *project* rate (e.g. 24) instead of the clip's (e.g. 23.976), Resolve reconforms, and cuts drift. This was *the* "not accurate" bug.
4. **Frame-space remap**: compare `item.GetClipProperty('Frames')` (Resolve's truth) with the detector's frame count; if they differ, remap linearly `round(f*(resF-1)/(detF-1))` to absorb the decoding offset.

`AppendToTimeline([{ mediaPoolItem, startFrame, endFrame }, …])` receives the mapped segments. Re-import goes through `MediaStorage.AddItemListToMediaPool(paths)`.

### The handle registry is purged ONCE per operation, not on every `getResolve()`

`getResolve()` clears the Python helper's handle registry to start clean. But a high-level operation calls it **several times** — directly, then through `timeline.js` helpers that each call it again — and purging every time invalidates handles the operation has held since its first call: `RuntimeError: invalid handle or Resolve not connected` mid-flight, more likely the longer the operation (seen on a transfer with fallback). The `beginResolveOp`/`endResolveOp` bracket numbers the operation and `getResolve()` only purges on the **first** call of that number; outside a bracket the original behaviour is kept. Locked by `test/resolve-handle-reset.test.cjs`. Corollary: every new channel touching Resolve must go through `guarded`/`rOp`, or it purges under the others' feet.

### `CloseProject` fails SILENTLY — verify by name

`pm.CloseProject(proj)` returns `false` without closing anything and without saying why (observed from the Fusion, Color and Fairlight pages, which hold the project). The trap: `LoadProject(name)` then finds the project **still open** and returns a truthy object, so an unchecked `CloseProject`→`LoadProject` sequence reports success while having released nothing. Rule, applied in `optimize.js#reloadProject`: **`OpenPage('edit')` before closing** if the current page holds the project, then verify `pm.GetCurrentProject().GetName() !== name` — the return value of `CloseProject` proves nothing. Restore the original page in both the success and failure paths.

## Video playback = short HEVC proxy, hardware encoded

Tauri's **WebView2 decodes HEVC** through `<video>` — verified `canPlayType('video/mp4;codecs="hvc1…"')` = `"probably"`, with `--enable-features=PlatformHEVCDecoderSupport` set in `src-tauri/src/lib.rs` before the webview is created. Raw h264/`.mp4` sources do not always play, so a short proxy is transcoded anyway. ⚠️ The Adobe CEP panel is a **different engine** (CEF 99, no HEVC) and receives h264 instead.

`ffmpeg:proxy` transcodes a **short segment** (≤10s, looping) to **8-bit HEVC `.mp4`**, height snapped to a cell-size step (capped at 520p, low quality accepted for a fast encode).

### No encoder is hard-coded — read this before assuming a vendor

**HEVC is hardware-encoded on all three vendors.** `core/proxyEncoder.js#selectProxyEncoder` is a pure function (testable without ffmpeg) that picks, in order:

| Step | Encoder | Note |
|---|---|---|
| 1 | `hevc_nvenc` · `hevc_amf` · `hevc_qsv` | whichever **passed the probe** on this machine |
| 2 | `h264_nvenc` · `h264_amf` · `h264_qsv` | a player that accepts HEVC accepts H.264, so hardware beats format fidelity |
| 3 | `libx264` | universal CPU fallback |

**Falling to step 2 is never about the brand** — it means no HEVC encoder passed the probe on that machine (old GPU, driver refusal, ffmpeg build). An AMD or Intel machine whose HEVC encoder works stays on step 1, exactly like an NVIDIA one.

**Listing an encoder is not being able to use it.** A Windows ffmpeg build advertises `h264_qsv` and `h264_amf` even with no Intel or AMD GPU present, so `core/export/capabilities.js` probes in **two passes**: is the encoder alive at all (`canEncode(['-c:v', enc])`), then does it work **with the real profile and pixel format** (`hevc_nvenc` can be alive yet unable to do 10-bit, so `h265_main10` degrades to CPU instead of failing at export time). `codecEncoderOptions['h265_main']` therefore holds only encoders that actually produced a frame here.

**`libx265` is only ever used on an explicit CPU request, never automatically**: it is too slow for hover-to-play, and its HEVC may not decode in the packaged WebView2. `selectFastProxyEncoder` short-circuits the full probe for the first double-click (an optimistic guess from the GPU vendor list) — the encode is still protected by the CPU fallback if the driver refuses.

**The only genuinely NVIDIA-specific profiles** are `h264_high444`, `h265_rext444_8` and `h265_rext444_10`, flagged `nvencOnly` in the capability probe because no other vendor encodes HEVC RExt 4:4:4. They are not probed on AMF or QSV and go to the CPU there. General export also forces 4:4:4 to CPU on purpose, while the processing hub probes it separately with its exact pipeline arguments rather than inferring it from Main 10.

### Encoding arguments

- Short segment, NVENC: `-preset p1 -tune ull -rc-lookahead 0` (fastest cold start). AMF and QSV have their own equivalents in `proxyVideoArgs`; the CPU path uses `-preset ultrafast -tune zerolatency`.
- Full preview: `-preset p2 -cq 30 -b:v 0 -pix_fmt yuv420p -tag:v hvc1` + AAC, `-movflags +faststart`.
- **`-tag:v hvc1` is mandatory**, otherwise `<video>` refuses the file.
- **`-pix_fmt yuv420p` forces 8-bit** (anime sources are often 10-bit).
- Cached in `os.tmpdir()/netsurush-proxies`, written as `.tmp` then **atomically renamed**; **`-f mp4` is mandatory** because the `.tmp` extension stops ffmpeg from guessing the muxer.
- Served over HTTP `/media`.

**GPU/CPU division of labour (product requirement)**: hardware encodes the proxies, the CPU stays reserved for thumbnails (still images) and light decoding as much as possible. Priority queue `proxyGate` (hover/click `high` > prewarm `low`), `PROXY_MAX=5` — sized on the ~8 parallel NVENC sessions measured on the reference machine, so it is a conservative bound elsewhere rather than a vendor assumption; thumbnails use `thumbGate` (`THUMB_MAX≈cores/2`, disk cache). `prewarm()` warms every shot in the background after detection.

Preview audio (`PreviewVideo`, prop `audible`): muted by default, but the **hovered** card plays sound at the adjustable `hoverVolume` (default 20%). Autoplaying previews stay muted (up to ~24 simultaneous `<video>`). `muted` is driven imperatively (the JSX attribute stays constant so autoplay is always allowed), with a muted fallback if Chromium blocks audible autoplay. Because player volume 0 acts as a global mute, Settings ▸ Media ▸ Previews exposes **both** sliders and shows "muted by player volume" — the page used to show only the hover slider, greyed out, with no way to fix it.

## Thumbnails — ONE cache for the whole app

`core/thumbs.js` is the single source, addressed by `(file, timestamp, preset)`. The timestamp is **always** `thumbTime(in, out)` (`src/lib/utils.ts`), so cutting, collections, live timeline, board picker and search results all target the same entry and therefore the same file on disk. Aiming at the middle of a shot on the search side alone doubled every thumbnail.

The search index **no longer stores thumbnails**: a 1000-shot database was spending ~20 KB per shot, re-encoded to base64 on every query, for images the shared cache already holds. Leftover rows are classified with *previews* in Settings ▸ Storage (family `reusable`) rather than with expensive analyses — it is a cache you can clear without losing anything. **Face** crops stay in the database: a face box is not a frame, nothing else carries it.

After each indexed clip, `warmIndexedThumbs` builds that clip's missing thumbnails on a low-priority queue (the GPU stays with the proxies), deliberately detached. A search additionally warms the renderer cache in **one** call, without encoding anything; otherwise each card fires its own request and saturates the core's sockets.

## Shot detection (`python/detect.py`)

Two selectable models, cache in SQLite `~/.netsurush/netsurush.db`, table **`scene_cache_v3`**, PK `(file_path, threshold, model)` — cache separated per model. PySceneDetect was removed; do not bring it back.

- **TransNetV2** (default): bundled weights, CPU. The UI threshold is a **precision preset** (`PRESETS`), not a raw number.
- **OmniShotCut** (MIT): more accurate on transitions and dissolves, **no threshold** (auto mode, slider disabled). Fully local: repo vendored under `vendor/`, patched so `.to("cuda")` becomes device-aware, weights read offline through an env var.

Commands: `serve` (**JSON-lines daemon**, the nominal mode — models stay warm between jobs), `detect <video> [thr] [model]` (one-shot fallback if the daemon dies), `get <video> [model]` (reads the cache **without** loading a model → instant shots when reopening).

**Progress** is `PROGRESS:<pct>` on stderr, on an **absolute monotonic** 0..100 scale per job (load 2..5, extraction 5..55, inference 55..98). `STAGE:*` markers carry **only** the phase, never a percentage — the old `STAGE:infer`→18% remap made the bar go backwards; do not reintroduce it. The core adds a monotonic clamp per path.

**Parallelism**: a pool of detect daemons (max 6) sized by `core/scheduler.js`, the central resource scheduler (free VRAM via nvidia-smi, RAM fallback). The renderer asks for the concurrency (`nr.detectConcurrency()`), so batch cutting is not hard-capped. `onScenesProgress` listeners filter by `p.path`, so parallel jobs never drive another clip's bar.

## ffmpeg

- Cutting/extracting is **lossless**: `-c copy -avoid_negative_ts make_zero`. Never re-encode.
- `probe` returns duration and dimensions **only**. The full keyframe scan (`-skip_frame nokey`) was too slow on long files and was removed. Do not add it back.
- `ffprobe` keyframes, when needed: `pts_time` + `pict_type==I` (not the deprecated `pkt_pts_time`).
- **The version is PINNED** — `$FfmpegVersion` in `scripts/setup.ps1` is the single source, and the download URL carries it. The `ffmpeg-release-full.7z` alias is **forbidden**: it is a moving target that jumped a major version without a single repo change, while the fallback stayed two majors behind. The zip fallback exists only for machines without a 7z extractor, and **never a `master` build**: its libplacebo/Vulkan sometimes fails to initialise, which breaks Turbo upscaling.
- `$FfmpegAccepted` (PowerShell) and `FFMPEG_ACCEPTED_VERSIONS` (`core/setup.js`) declare the **same** versions, equality locked by `test/packaging.test.cjs`: PowerShell provisions, Node checks at startup, and two diverging lists would loop the user back to the install screen forever.
- **An existing install is RE-READ, not assumed valid**: `ffmpegReady` compares the binary's reported version against the accepted list. `Test-Path` alone kept a legacy build forever, so no already-installed machine would ever receive the pinned version. The setup therefore **replaces** a binary in place (Windows refuses to overwrite a running `.exe` but allows renaming it).
- **The version check lives in `quickSetupReady`, not only in `ffmpegReady`**: `setupStatus` reads `quickReady ? true : ffmpegReady(...)`, so an install carrying `setupCompletedAt` short-circuits the check. Putting it only there made it unreachable for exactly the population a version bump must catch. To keep that startup path process-free, `setup.ps1` writes `ffmpegVersion` into the config and the check compares strings; it only asks the binary for a legacy config lacking the key.
- **One ffmpeg invocation per probe**: read encoders from **stdout** and the version from **stderr** (the banner), so without `-hide_banner`. Asking `-encoders` then `-version` cost 159 ms instead of 85. Both languages **parse then compare** — a regex on one side and a value comparison on the other diverge on edge cases.
- **Extraction: bsdtar first** (`System32\tar.exe`, shipped with Windows 10 1803+, reads 7z through libarchive), 7-Zip second — probed in `%ProgramFiles%` too, not just on `PATH`.
- **NVENC: modern API only** (`-preset p1..p7` + `-tune ull|hq`). ffmpeg 9.0 **removed** the deprecated presets (`llhq`, `llhp`, `bd`) and the `vbr_hq`/`cbr_hq` modes; reintroducing them breaks all hardware encoding. Locked by `test/packaging.test.cjs`.
- **The native player's ffmpeg is a different ffmpeg**: the `avcodec-*.dll` files next to libmpv follow mpv's release cadence, not this pin. `scripts/fetch-mpv.ps1` checks them **by pattern**; pinning a specific soname declared the runtime incomplete as soon as a newer mpv build arrived.

## Export

- **Global encode gate** (`core/export/gate.js`, tested): `exportClips` bounded its own shots, but nothing bounded two concurrent calls — 5 renders meant 5 × N ffmpeg processes (NVENC sessions saturated, slower than running in series). The gate is the single truth for in-flight encodes; the effective limit is the lowest limit among running jobs.
- **Output names come from a profile TEMPLATE** (`core/export/naming.js`, tested): default `{base}_{index}`, i.e. the historical naming exactly — changing that default would rename every existing profile's output. Tokens: `{base} {source} {index} {total} {start} {end} {duration} {label} {profile} {codec} {container} {date} {time}`, resolved **by the core**. The profile editor does not reimplement the resolver; it asks for the name over `export:previewName`, because a preview announcing a different name than the written file is worse than no preview, and the same channel populates the "Insert" menu. Four rules:
  - names are **planned before the encode pool** (shots finish in arbitrary order; reserving as they go would make numbers depend on speed);
  - names are **reserved against the disk and against the batch** (suffix ` (2)`, the same convention as `core/ae/codecs.js#uniquePath` — two dedup conventions in one app read as a bug), otherwise a template without an index made two ffmpeg processes write the same file and `-y` silently destroyed an earlier export;
  - an **empty token takes the separators before it** (cleaned token by token, never a global separator pass over the result, which damaged literal text such as "ep01 - scene");
  - an **unknown token stays visible** in the name; silently erasing a typo looks like a broken template.
  - In **merge** mode the template resolves **without index** and `{duration}` is the **sum** of the shots, the only real length of the produced file. A destination imposed by the caller (`savePath`/`savePaths`) bypasses the template.
- **Black spacer in merge mode** (`core/export/spacer.js`): end to end, two consecutive shots touch frame-exactly and nothing marks the cut. The spacer is **an encoded piece like the others, never a filter**, because merging goes through the `concat` demuxer in stream-copy mode, which refuses the moment a parameter changes between pieces. It is therefore built **after** the shots, at the dimensions / rate / codec / sample rate / channel count **read back from the first produced piece**: a 44.1 kHz silence in front of 48 kHz shots breaks the copy and re-encodes the whole thing. Three rules: shots **without an audio track** get a spacer without audio; in copy mode the silence is **encoded in the shots' codec** (you cannot copy a stream you just generated — hence a codec→encoder table for the four codecs whose encoder is not named after the decoder); and the spacer goes **between** shots, never at the ends, since a montage opening or closing on black looks truncated. A build failure does **not** abort the merge (logged fallback without spacer): losing the whole encode over a cosmetic detail would be worse.

## Preferences shared across origins

`core/prefs.js` + `src/hooks/useSharedPrefs.ts`, tested by `test/shared-prefs.test.cjs`. `localStorage` is **per origin** — the Tauri app (`tauri://`), the CEP panel (`http://127.0.0.1:8730/app`) and detached windows each had their own copy. Since the shot cache is keyed on **(file, model, threshold, options)**, a clip cut in the app came back "not cut" in the panel.

The core therefore owns a key→value bag (`NR_HOME/prefs.json`, atomic write, SSE `prefs:changed` broadcasting the **patch**) and the renderer mirrors **work** settings into it: detection model/preset/options, export profiles and selections, insertion mode. **Window** settings (active host, player width, pinning) stay local. Only the app seeds the empty file (`!IS_REMOTE`) — a panel seeding it would impose its defaults on the app. Loop guard: an `applying` flag plus a JSON comparison of the last push. `useShotDetection` additionally falls back to the model's known cut when the exact option triplet does not match: showing cached shots beats re-running the same detection.

## Console log and bug report

Settings ▸ System ▸ Console. Three sources merged into a renderer ring buffer: (1) the UI, via `src/lib/appConsole.ts` patching `console.*`; (2) the core service and (3) the Python sidecars, via `core/logbus.js` (ring of 800, console patch, `logbus.py(name, chunk)` on every sidecar's stderr, `STAGE:/PROGRESS:/PHASE:` markers excluded) broadcast over SSE `console:log`. Tested by `test/bug-report.test.cjs`.

Five log-quality rules, each fixing a silent information loss:

1. **stderr chunks are re-joined** (`logbus.py`): a sidecar's stderr arrives split anywhere, so an incomplete fragment is held until the next line. Flushed by an idle timer (400 ms) or explicitly.
2. **Python tracebacks are grouped into ONE `error` entry**, including `During handling of the above exception` chains. Closing the block is **deferred by one line** (otherwise the second traceback of a chain split into separate entries), so a test reading the snapshot right after must flush first.
3. **Repetitions are counted, not stacked** (core and renderer, 15s window): a failing loop no longer evicts the useful history. The core re-broadcasts the **same** entry when its counter moves, and the renderer updates it in place.
4. **`unhandledRejection` / `uncaughtException` of the core are logged**, with the exit delayed by 150 ms on an uncaught exception so the SSE message gets out. An `Error` passed to `console.error` is formatted as `name: message + stack` — `JSON.stringify(Error)` produced `{}`.
5. **Resource load failures are captured in the capture phase** (`appConsole.captureResourceErrors`): the `error` event of an `<img>/<video>/<script>` does not bubble and reaches neither `console.error` nor `window.onerror`. `MediaError` codes are translated (network vs decode) — "the preview stays black" used to happen without a single log line.

Bug report (`components/settings/console/` → `bug:report` → `core/bugreport.js`): a sorted Discord embed plus attachments (log `.txt`, machine snapshot, screenshots). The webhook is configured **outside** the repo (`bugWebhook` in `NR_HOME/nr.config.json`, or `NR_BUG_WEBHOOK`); `bug:status` reports whether it exists. Discord's limits are enforced **before** sending (an overflow returns 400 = report lost without the tester knowing), hence `buildEmbed` being exported and tested.

- **Nothing the machine already knows is asked of the user**: `core/bugContext.js` reads GPU and driver, CPU, RAM, VRAM, OS, torch/onnx/asr backends, ffmpeg encoders, free disk, setup state. Probes are bounded (6s) so a slow measurement returns `null` instead of holding the form. Context is **re-collected at send time by the core**, never taken from the request. When the read fails (service down, not restarted after a `core/` change), the card opens a **manual** field — otherwise the report went out with no machine information at all.
- **Discord identity is taken from the signed-in account** (snowflake id + nickname), with free text as a fallback: a hand-typed nickname made it impossible to reach the author again.
- **Taxonomy** (`bugReportShared.ts`): 20 categories in 3 groups, organised by the **nature** of the defect — the product area is already covered by the "Module" field (list = `NAV`). Severity and frequency only appear for a problem; a suggestion is filed as severity `idea`. "Something else" and "I have a question" open a short field whose text goes into the embed **title**, otherwise those reports arrive with no useful label. Ids are **stable slugs** (they travel to Discord); labels live in the locales.
- **Voice: plain words, informal register**, like the rest of the app. Labels stay **short** because segmented choices share the width. **No explanatory copy**: no subtitle listing what gets sent, no "(optional)" suffixes. The video field asks for a **downloadable link**, not a title — the point is to get the source.
- **Layout**: rows are `grid gap-3 sm:grid-cols-2` (one column under 640px) and choices are full-width segmented groups with `grow shrink basis-0`. With fixed two columns and text-width segments, the last frequency option fell outside the 560px CEP panel. Borders and radii come from the component (`spacing={0}` + `variant="outline"`); redeclaring them produced double borders.
- **Redaction before sending** (`redact`): paths reduced to the file name (often the cause), `/Users|home/<x>`, e-mails, webhooks and tokens.
- **Attachments**: cumulative adding (a bare `<input file>` replaced the selection on every open), drag-and-drop, **Ctrl+V paste** (the reflex after a screenshot shortcut), removal by thumbnail. **Limits come from the service** (`bug:status` → `maxAttachments`/`maxAttachmentMB`), not from renderer constants: Discord allows 10 attachments per message, two of which are ours, hence 8; and 10 MB per file on an unboosted server, 50 at level 2, 100 at level 3. The limit follows the **webhook's** server, which no API exposes, so a config key can raise it. `input.value` is cleared after each pick, otherwise re-picking the **same** file fires no event.
- **A "Download" button** always writes the full report (context + description + log) locally, even when sending fails — without it, everything the tester just wrote is lost exactly when the app is misbehaving.
