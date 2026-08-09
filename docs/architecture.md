# Architecture

Deep notes for agents and contributors. Read the section you need; do not load the whole file.

## Runtime shape

```
src-tauri/            Rust shell: WebView2 window, HEVC flag, spawn/kill of the core
  └─ spawns
core/server.js        Node service, HTTP on 127.0.0.1:8730, headless
  ├─ media-server.js  /media (Range/seek) + /stream (live ffmpeg)
  ├─ rpc.js           POST /rpc + SSE /events (~200 channels)
  ├─ resolve-bridge.js + resolve_helper.py   persistent Python bridge, JSON-lines
  ├─ resolve-proxy.js Proxy object: .Method(args) → bridge.invoke (opaque handles)
  ├─ resolve.js       status + Media Pool + import
  ├─ timeline.js      frame-accurate buildTimeline + cutTimeline (FCPXML)
  ├─ ffmpeg.js / thumbs.js / proxy.js        probe/export, CPU thumbnails, HEVC proxies
  ├─ sidecars.js      python spawns: detect.py, search.py, upscale.py, roto.py…
  ├─ aeExport.js + ae/*                      After Effects export
  └─ transfer/*                              NetsuBridge (host ⇄ host)
        ▲ HTTP/SSE (CORS open on localhost)
src/                  React renderer
  └─ lib/bridge.ts → coreClient.ts (fetch /rpc + EventSource /events)
```

- `core/` is CommonJS (`core/package.json`). The root `package.json` is `type: module` for the Vite renderer.
- The app drives DaVinci Resolve **from the outside** through the `DaVinciResolveScript` Python module (external scripting). There is no plugin loaded inside Resolve.
- `core/resolve_helper.py` loads the module via `RESOLVE_SCRIPT_API` / `RESOLVE_SCRIPT_LIB` / `PYTHONPATH`, calls `os.add_dll_directory()` on the folder holding `fusionscript.dll` **before** the import, then `scriptapp("Resolve")`. Requires *Preferences ▸ System ▸ General ▸ External scripting = Local* plus a running Resolve.

## IPC contract — three places, always

`src/lib/bridge.ts` is the only renderer↔backend contact point. It picks a transport in this order: `window.nr` (legacy, absent) → `coreClient` (Tauri/core) → a no-op `mock` so the UI still renders in a plain browser.

Any new channel must be added in **all three** places, or it is immediate debt:

| Place | File |
|---|---|
| Handler table `H` | `core/rpc.js` |
| `NrApi` interface + implementation | `src/lib/coreClient.ts` |
| `mock` fallback | `src/lib/bridge.ts` |

`core/rpc.js` entries stay thin: they delegate to the `core/` modules with injected dependencies. No business logic in `rpc.js` or `server.js`.

## Store

`src/store/` is a zustand store split into typed slices over the full state — `shell.ts` (active tab, sidebar, host status), `derush.ts`, `search.ts`, … — assembled in `index.ts` (exported as `useApp`).

Navigation is a **left sidebar**, never top tabs (product requirement). The sidebar is a 64px rail that expands into an overlay on hover, animated with framer-motion; there is no toggle button. `src/components/nav.ts` (`NAV`) is the single source of truth for the module list.

## UI system — shadcn/ui, Base UI flavor

Every UI primitive (button, dialog, dropdown, tabs, tooltip, select, popover, slider…) comes from **shadcn/ui in its Base UI flavor**. Never Radix. Never hand-roll a component shadcn already provides; add it, then own and edit the code in `src/components/ui/`.

- `components.json` → `style: "base-vega"`, `base: base`. Components import from `@base-ui/react/*`. Base UI uses a `render` prop, not `asChild`.
- Init: `npx shadcn@latest init --base base --preset vega`. Add: `npx shadcn@latest add <name>`.
- Base UI specifics: `ToggleGroup`/`Slider` are driven by `value={[…]}` + `onValueChange` (arrays); `Dialog` is controlled through `open`/`onOpenChange` and always needs a `DialogTitle` (`sr-only` if visually hidden).
- `cn` lives in `@/lib/utils` (`clsx` + `tailwind-merge`).
- `ui/color-picker.tsx` is the single source of every colour choice in the app (text, note background, frame stroke/fill, pen, board background).
- **Gotcha**: shadcn `<Card>` forces `flex flex-col gap-6 py-6 ring-1`. For a plain container add `block`/`p-0`; for a centred row add `flex-row`; replace `space-y-*` with `gap-*`.

### Theming

- The **brand palette** is a plain `:root` block in `src/index.css` (`--color-bg`, `--color-surface`, `--color-border`, `--color-fg`, `--color-muted`, `--color-primary`…), consumed everywhere as `var(--color-*)`.
- shadcn tokens (`--background`, `--card`, `--primary`, `--border`…) are **mapped onto that palette** inside the `.dark` block.
- The app is **force-dark**: `class="dark"` on `<html>`, otherwise components pick the light `:root`.
- The palette block must sit **after** `@theme inline` to win the name collision on `--color-border/muted/primary/accent`.
- 11 switchable palettes (8 dark, 3 light) = one `[data-theme="…"]` block + one `THEMES` entry + `settings:appearance.theme.<id>` in all 6 locales. Contrast is checked before writing (fg/bg ≥ 7:1, muted/surface ≥ 4.5:1), colours in OKLCH inside the sRGB gamut. "High contrast" is the accessibility theme and **refuses wallpapers**, since its guaranteed contrast depends on it.
- **Theme colour overrides** (`src/lib/themeColors.ts`) are inline variables on `<html>`, so they beat the `[data-theme]` block without rewriting it; removing one hands control back to the theme. Text placed **on** the accent is **computed from luminance** (`foregroundFor`) — a fixed white `--color-primary-fg` becomes illegible as soon as a light accent is picked.
- **Custom themes** (`src/lib/customThemes.ts`) are not a 12th CSS palette: they lean on a shipped palette (`base`) and patch it, because generating a `[data-theme]` block at runtime would mean guaranteeing the contrast of ten derived variables by hand. Their id (`custom:<n>`) is the key for colour overrides; the wallpaper is not indexed — the theme carries a copy. Picking a shipped palette leaves the custom theme. The lifecycle is a document's: create · edit · **Save** · rename · delete, and the Save button only appears when the displayed appearance differs from the stored one.

### Wallpaper — cost must stay that of a still image

`core/wallpaper/` + `src/lib/wallpaper.ts` + `components/theme/WallpaperLayer.tsx`, tested by `test/wallpaper.test.cjs`. An image, GIF or video sits behind the UI. It is **one global setting**, not one per palette: indexed on the theme, the visual just picked vanished as soon as another palette was tried. Video preview decoding is the app's critical resource, hence four invariants.

1. **Layer blur is composited** (`filter: blur(var(--nr-wp-blur))`), therefore continuous and immediate; a scale of pre-encoded files forced 4px steps *and* an encode wait per step, which reads as an unresponsive slider. The layer always requests the **sharp** variant — serving it a blurred one would blur twice. Blur pulls in transparency past the edges, hence the `inset: calc(var(--nr-wp-blur) * -2)` bleed. `backdrop-filter` stays banned (it re-blurs everything behind it, every frame). Baked blur survives only for the one image that panels repaint: a `filter` on a panel would blur its text, and blurring a panel's background image draws a dark rim at the seam. Those variants keep **full resolution** — a blurred image has no high frequency left, so it compresses; downscaling then letting the browser upscale produced banding. `sigma` equals the displayed radius, like CSS `blur()`, and `gblur` runs with `steps=3` (a single pass stays close to a box blur, whose square edges show on flat areas).
2. **A GIF is never served as a GIF**: it is transcoded to h264 mp4, 1080p/30fps max, no audio. Chromium decodes animated images on the CPU and **nothing can pause an animated `<img>`**.
3. **Freezing means UNMOUNTING the `<video>`**, replaced by a static poster — `pause()` would keep the decoder and texture alive. Triggers: background window (`visibilitychange` + Tauri `onFocusChanged`), `prefers-reduced-motion`, manual toggle, or **work in progress**. The busy signal (`src/lib/busyBus.ts` + `heavyJobs.ts`) has two sources: (a) the **start** of a heavy call, stamped in `coreClient#call` on an **explicit list** of channels (a prefix would catch cheap channels like `roto:setView`); (b) progress channels already broadcast, for the rest of the job. (a) is what freezes *before* the work: waiting for the first progress event would leave the animation running through model loading and process spawn, the heaviest moment. State expires after 2.5s of silence **and** zero in-flight calls, otherwise a cancelled job would freeze the wallpaper forever. `wallpaper:variant` is deliberately **not** in the list: the layer requests a variant *because* busy state changed, so including it would oscillate every 2.5s.
4. **Dedicated composite layer**: `position:fixed` + `contain:strict` + `will-change:transform`. Never `background-attachment:fixed` (full-screen repaint on every scroll frame). Settings live as `--nr-wp-*` CSS variables on `<html>`, so moving a slider re-renders no component.

Further wallpaper rules:

- **Lowering opacity must move toward the THEME, never toward black.** `--nr-wp-dim` is `--color-bg`, not black: the main layer composites its media *over* the app background, so at 40% you see 60% of `--color-bg`; a black veil in panels made them darker than the theme, the exact opposite of the promise. `opacity: 0` disables the wallpaper entirely (`wallpaperActive`), otherwise panels stayed translucent over nothing and the UI was never exactly the chosen palette.
- Surface translucency (`--nr-ui-opacity`, default 60%, floor `MIN_UI_OPACITY`) redefines `--background`/`--card`/`--sidebar`/`--secondary`/`--muted` with `color-mix` **only** under `nr-wallpaper-on`. Two selector traps, both hit for real: `.dark` lives on `<html>` itself, so the rule must be `html.nr-wallpaper-on.dark` (double class) and not a descendant, or nothing matches; and the brand variables are redeclared on `body`, because on the same element `--color-bg` referencing itself is a cycle and the property becomes invalid. Side effect, wanted: theme previews that redeclare `--color-*` under their own `[data-theme]` stay opaque. `color-mix` is Chrome 111+, absent from the Adobe CEP panel, which therefore renders **no** wallpaper at all rather than half of one. `--popover` and menu surfaces stay opaque.
- **A panel that floats over content cannot simply be translucent** — you would see the buttons of the module underneath, not the wallpaper. Such panels carry `.nr-wp-surface`, which repaints the wallpaper in a `position: fixed` layer aligned to the window and then clipped by the panel (pixel-exact seam with the main layer). That layer uses the **still** image even for animated wallpapers: a second `<video>` for a 240px drawer would be one more decoder.
- **The title bar is a surface like any other.** Excluding it left a black slab above a wallpaper visible everywhere else. The defect that had motivated the exclusion — background resized to a button group — comes from a **transformed** ancestor becoming the containing block of a fixed background. General rule: **no element carrying `.nr-wp-surface`/`.bg-card`/`.bg-sidebar`/`.bg-background` may live under a transformed ancestor.** Centre sub-navs with `flex justify-center`, never `-translate-x-1/2`. Controls and segmented-control containers (`toggle-group`, `tabs-list`) stay excluded — a control must read as a flat block.
- **Crop is set in a dedicated window, on the image**: handled rectangle, source pixel dimensions, quarter turns, mirrors. The rectangle always has the window's aspect ratio (inverted on a quarter turn) and the chosen region **fills** the screen: offering 16:9/4:3/1:1 or a "contain" fit showed a crop the user would not get, since a wallpaper is re-cropped to fill anyway. Geometry lives in `src/lib/cropRect.ts` (pure, clamped, minimum size) and the model carries a normalised `crop` rather than an offset/zoom pair. Edits stay **draft** until Apply — cropping live would flash the whole background behind the window on every dragged pixel. An animated wallpaper is cropped **in motion**; a frozen first frame tells you nothing about a second later. Crop is **not baked into the file** (one wallpaper is shared by several themes). `fitStyle` is the single translation of crop into CSS, shared by preview and real layer; duplicating it means a preview that lies.
- Every continuous setting lives in **local** state during the gesture, and both the slider and its number field read that local value — wired to the stored value, the field froze while dragging. `previewWallpaperSetting` is the only place that names the CSS variables of a setting, because one setting can drive several (opacity drives both `--nr-wp-opacity` and `--nr-wp-dim`).
- Every setting has a typed number field next to its slider (`ui/number-spin.tsx`), all stepping by **1**: at 4 or 5, aiming at a value with keyboard or wheel becomes impossible and the field is pointless.

### Performance rules for grids — non-negotiable

- **No JS animation on grids.** GSAP (permanent rAF ticker) and framer-motion `layout`/`AnimatePresence` (projection loop) both saturated the main thread and GPU and competed with video decoding. GSAP was uninstalled.
- The shot grid renders every card (**no virtualisation** — tried, removed, judged bad UX) with `content-visibility:auto` to skip off-screen paint.
- A play-slot cap (`maxPlaying`) limits simultaneous `<video>` elements.
- Scroll smoothing pauses previews based on **velocity** (fast flick > ~2.2 px/ms → pause, slow scroll keeps playing). Pause the `<video>` **element**; never gate its mounting on a scroll flag — that breaks autoplay (tried, broken). The signal self-heals through a timer.
- Re-mounting without a flash relies on `lib/thumbCache.ts` (thumbnail served synchronously) plus a proxy cache keyed by segment id.

## Settings — 9 tabbed pages

`src/features/settings/nav.ts` is the **single source** of the settings map (page ids, tabs, icons): the side nav, the title-bar sub-nav and the router all read the same list, otherwise the three diverge. It holds pure data only — no page component — so the title bar does not pull the settings code at startup.

Pages: **Account** (Profile · Discord) · **Interface** (Theme · Language · Navigation) · **Media** (Previews) · **AI** (Video · Dictation · Indexing — the models tab has id `models`, label "Video") · **Export** · **Adobe** · **Storage** (Media cache · Cleanup · Project cache · Projects) · **System** (Updates · Compatibility · Console) · **About**.

- The active tab is remembered **per page** (`settingsTab: Record<SettingsPage,string>` in `store/shell`).
- `openSettings(page, tab)` is the only external entry point.
- Tabs live in the **title bar**; when the window is pinned the bar hides them, so `SettingsPanel` renders a `Tabs` fallback at the top of the page. A single-tab page shows no sub-nav (`hasSettingsTabs`).
- Flags are **hand-made SVG** (`components/language/FlagIcon.tsx`), never emoji: Windows has no glyph for regional indicators, so "🇫🇷" rendered as "FR".
