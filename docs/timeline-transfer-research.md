# Timeline transfer between applications — research log

This document exists so the **same experiments are not run twice**. It records what was measured, how, what turned out to be a dead end, and what is still open.

Everything marked **measured** was observed at runtime, not inferred from documentation.

> Measurement environment: **DaVinci Resolve Studio 21.0.3.0007** (`DbPrjVer 17`), **Premiere Pro 26**, Windows 11.
> A measurement redone on another version must be re-recorded: several behaviours below are documented nowhere and may change between releases.

---

## 1. How to run an experiment

### 1.1 External probe (fastest)

A standalone Node script borrowing the app's bridge, without going through the app:

```js
const { getResolve, readAttribute, beginResolveOp, endResolveOp } = require("./core/resolve-proxy.js");

beginResolveOp();
try {
  const resolve = await getResolve();
  const project = await (await resolve.GetProjectManager()).GetCurrentProject();
  const mediaPool = await project.GetMediaPool();
  // …
} finally { endResolveOp(); }
```

Four rules learned the hard way:

1. **Wrap in `beginResolveOp()` / `endResolveOp()`.** Without the bracket, `getResolve()` purges the handle registry on **every** call and invalidates the handles the operation already holds.
2. **`OpenPage("edit")` before any import.** From the Color page, `ImportTimelineFromFile` is refused without a word. Conversely, `GrabStill` returns nothing outside the Color page.
3. **Name test timelines uniquely and delete them.** A name already taken makes the import fail silently — an interrupted run poisons the next one.
4. **One external connection at a time.** When the app is running it already holds a bridge; external probes worked in parallel most of the time, but Resolve stopped answering any new connection several times after a heavy operation. On repeated `getResolve() → null`, close the app or restart Resolve.

### 1.2 Bisection on the real file

Start from the real export and **remove** its peculiarities in cumulative steps (private attributes, tick attributes, filters, file references, audio, timecode/uuid/logging). Useful to find what gets in the way. Limit: if the cause is a single element, cumulative bisection may never isolate it — which is what happened, the title stayed present in every variant.

### 1.3 Convergence from below (the one that settled it)

Hand-write a **minimal accepted** XML, then graft the real file's peculiarities onto it one at a time. The first graft that breaks names the cause. That is how the title blocker was found, in three grafts.

### 1.4 Round-trip

Have the target import a document, then ask it to **re-export**:

```js
const format = await readAttribute(resolve, "EXPORT_FCP_7_XML");
await timeline.Export(path, format);
```

This is the only way to learn the exact dialect a host understands, and to tell "parameter ignored" from "parameter not read". (`readAttribute` is required: the proxy only forwards calls, so a constant would be invoked.)

### 1.5 Known-value blob diff

For an undocumented binary format: export the same element **twice**, changing only ONE known value, then compare bytes. That is what identified the font size. **Trap**: changing a value to its **default** produces no difference — the first attempt (100 → 100) was wasted for that reason.

### 1.6 What NOT to do

- **Never call `SetProperty` on a title.** Two attempts, two Resolve crashes (§ 3.5). Any new idea of that kind must be tested on a throwaway timeline first, never in the production flow.
- **Never leave a probe in production code.** A probe was wired into the import path for lack of an available external connection; it took Resolve down on the user's machine. If that is the only route, make it non-destructive **and** remove it immediately.

---

## 2. Current architecture

Two mutually exclusive vehicles, chosen by `canImportNatively` (`core/transfer/index.js`):

| Vehicle | When | What it carries |
| --- | --- | --- |
| **File import** (`importResolve.js`) | Premiere → Resolve, new timeline, linked media | Keyframes, audio levels **and** their automation, speed, titles (text and placement), nested sequences |
| **API placement** (`writeResolveAppend.js`) | Appending to an existing timeline, targeting a named timeline, media produced by the app | Positions, bounds, fixed transforms, animation through Fusion comps. **No audio levels** |

The neutral exchange document (`core/transfer/doc.js`) is shared by both. `core/transfer/xmeml/prepare.js` is the only entry point for pre-import fixes: titles (`graphics.js`) and exploded audio channels (`audioChannels.js`).

---

## 3. Premiere → Resolve: what is ESTABLISHED

### 3.1 One element without media makes the WHOLE import fail, silently

**Measured.** A Premiere title is synthetic media (`<mediaSource>GraphicAndType</mediaSource>`) whose `<file>` carries **no `<pathurl>`**. Its mere presence makes `ImportTimelineFromFile` return `None` — no exception, no message, no log — whatever the options, the declared version (`4` or `5`), the presence of `<!DOCTYPE>`, or the path form.

The same file imports **perfectly** through File ▸ Import ▸ Timeline: the UI can open a dialog for missing media, a script call cannot.

That was the cause of **sixteen consecutive refusals** wrongly attributed to the document header.

**Fix in place**: `graphics.js` translates those elements before import — the title becomes a `<generatoritem>`, the rest (colour matte, adjustment layer) is dropped.

### 3.2 The return value of `ImportTimelineFromFile` proves nothing

**Measured.** The call can return `None` on a **successful** import. The only reliable check is listing the project's timelines BEFORE and AFTER. Without it you chain attempts believing they failed — and each one adds its timeline to the project (that was the origin of the "stray timelines").

### 3.3 A sequence named "1" is refused without options

**Measured.** `ImportTimelineFromFile(path)` fails when the sequence is called `1`, but succeeds with `{timelineName: "…"}`. `12`, `1a`, `1 ` (trailing space) and `Sequence 1` all pass with no options. Unexplained; the workaround is to always pass `timelineName`.

### 3.4 `explodedTracks="true"` duplicates every stereo file

**Measured.** Premiere emits a stereo file placed on ONE track as **two mono `<clipitem>`s**, one per channel, on two distinct `<track>`s differing only by `<sourcetrack><trackindex>`. Resolve takes it literally and places both.

**Fix in place**: `audioChannels.js` keeps only the lowest-ranked channel and removes the track that held nothing else. Guard: two clips at the **same** rank are not an exploded stereo pair but sound deliberately placed twice — leave them alone.

### 3.5 A title's style does not survive — five routes, five dead ends

| # | Route | Measured result |
| --- | --- | --- |
| 1 | `fontsize` in the FCP7 `<generatoritem>` | **Read, stored, re-exported verbatim — never applied to the render.** Two very different values (200 then 597) give the same image |
| 2 | Edit the title after import | `GetFusionCompCount()` = 0 · `GetProperty('Text'\|'Size'\|'Font')` = `null` · `AddFusionComp()` = `null` · the exported comp is **empty** |
| 3 | Describe a Text+ in FCP7 | Resolve exports its own as an empty `<clipitem>` (`<mediaSource>Slug</mediaSource>`), **without its text** |
| 4 | `SetProperty("ZoomX")` on the title | Returns `null`, then **crashes Resolve**. Reproduced twice, including with `SetCurrentTimeline` set first |
| 5 | Native `.drt` format | A ZIP of XML. Carries only the title **type** (`Text+` inside a `FieldsBlob`) — no styled text, no size, no font |

What DOES survive: **text, track, start frame, duration** — exactly.
What does not: **font and size**, which fall back to Resolve's defaults.

Reading on the Premiere side is correct and verified (§ 4); it is Resolve's importer that ignores it. The expected style is logged and the result carries a `titlesApproximated` flag.

### 3.6 `InsertFusionTitleIntoTimeline` is a RIPPLE, not a placement

**Measured.** On a five-clip timeline, inserting a title at frame 5 **cut** the clip under the playhead and shifted **three video and six audio tracks** by the title's duration:

```
V1 BEFORE ["1.mov@0-29","3.mov@194-290","5.mov@392-494"]
   AFTER  ["1.mov@0-5","Text+@5-130","1.mov@130-154","3.mov@319-415",…]
```

Adding a video track does not change the target (still V1). Locking the lower tracks simply makes the insertion **fail**. `placeTitles` therefore refuses as soon as the timeline carries anything (`insertWouldRippleTimeline`).

**Untested but logical corollary**: on an **empty** timeline, inserting titles in **increasing** position order cannot shift anything — each insertion lands after the previous one. That is the basis of open lead § 5.4.

### 3.7 Export constants of the installed version

```
EXPORT_AAF = 0 · EXPORT_DRT = 1 · EXPORT_FCP_7_XML = 3 · EXPORT_FCPXML_1_10 = 6
```

### 3.8 Anatomy of the `.drt` (useful if we come back to it)

A ZIP archive containing:

```
project.xml
MediaPool/Master/MpFolder.xml
SeqContainer/<uuid>.xml
```

Settings live in **hexadecimal** `<FieldsBlob>` elements whose strings are **UTF-16BE** (`004e0075006d004c00610079006500720073` = `NumLayers`). The title clip appears as `Sm2TiVideoClip` / `PrettyType: Fusion Title` with `Text+` encoded in its blob — **the type only**, not the content.

---

## 4. Reading on the Premiere side: what is ESTABLISHED

### 4.1 A native title's text CANNOT be read through the API

**Measured.** `getValue()` on a native title's source-text parameter returns an **opaque** value — a single `ļ` character for a whole sentence. The modern graphics accessor returns nothing either on a native title (it only covers templates coming from After Effects).

The same parameter travels **base64-encoded in the FCP7 export**, where text and font are readable. That is the source in use.

### 4.2 Anatomy of the source-text blob

FlatBuffers, undocumented. Established by observation:

- 12 bytes of header, then a nested buffer; magic `44 33 22 11` at offset 8.
- **Strings**: 4-byte little-endian length, UTF-8 bytes, trailing zero. That is the pattern `flatStrings()` picks up — the structure is not decoded.
- **Font size**: a `float32`, **absent when it equals the default**, which is **100**. Measured on two exports of the same title: at 100 the blob is 328 bytes and holds a single float (`4.0`, another setting); at 200 it is 332 bytes and additionally carries `00 00 48 43` = 200.0.
- `fontSizeFrom()` keeps the largest float in `[8, 2000]` — the other measured settings are an order of magnitude smaller.

**Fixtures**: both real blobs live in `test/transfer-xmeml-graphics.test.cjs` (size 100 and size 200), plus the blob of a layer with no text. Any future decoding must stay green on those three.

### 4.3 Displayed size = font size × layer scale

**Measured.** Enlarging a title by dragging its box changes the **layer scale** (plain text in the XML), not the font size. A 200 pt title at 298.26% displays as **597**. The two are merged, since the target has a single size setting.

### 4.4 A graphic carries SEVERAL layers

**Measured.** A Premiere graphic emits **one `<effect>` per layer** — text, shape, motion. Reading only the first landed on a layer with no text and the title disappeared (`strings: []`, `effectName: ""`).

And the effect name is **never** a substitute for the text: a "Vector Motion" layer had its name glued in front of the title (`"Vector Motion\ntest beta\nyes"`). The text comes from the blob, only.

### 4.5 Units and conversions (already in place, do not re-research)

- `Motion.Position` and `Anchor Point` are **normalised 0..1**, not pixels.
- `Scale` and `Opacity` are percentages, rotation is in degrees.
- Audio level is a 0..1 float **offset by 15 dB**: `dB = 20·log₁₀(v) + 15`. 0 dB ≈ 0.178.
- An **audio** medium has no frame rate and Premiere invents one (measured: `2.754e-8` on a `.wav`).

---

## 5. OPEN leads — Premiere → Resolve

In decreasing order of promise.

### 5.1 ⭐ FCPXML 1.10 instead of FCP7 XML

**The most promising lead, never tested.**

`ImportTimelineFromFile` accepts FCPXML, and the installed version exposes `EXPORT_FCPXML_1_10 = 6`. Modern FCPXML describes titles **far more richly** than FCP7: a `<title>` element carries `<text>` with named `<text-style>` entries (`font`, `fontSize`, `fontColor`, `alignment`, `bold`, `italic`) — exactly what is missing.

Premiere does not produce FCPXML, but the app does not need it to: it already holds a complete neutral document, so it can **write** the FCPXML itself.

Procedure:

1. In Resolve, build a timeline with a styled Text+ (known text, font, size), export it as `EXPORT_FCPXML_1_10` and **read what Resolve writes**. That is the reference dialect.
2. If the style is there: re-import that same file and check it comes back (round-trip).
3. If the round-trip holds, write an FCPXML generator from the neutral document.

Risk: FCPXML requires a `<resources>` section (`asset`, `format`, `effect`) heavier than FCP7 — this is a full writer to produce, not a patch.

### 5.2 AAF for audio levels

`EXPORT_AAF = 0` exists. AAF is the reference audio exchange format and natively carries gain and automation. Untested in both directions. Interest: it would be the only known way to place audio levels through the **API** (§ 5.4), which has none.

### 5.3 `SetProperty` on a Text+ (≠ an imported title)

The crash (§ 3.5 route 4) was observed on the **text generator produced by the import**. It has **never** been tested on a **Text+** created by `InsertFusionTitleIntoTimeline`. If that one accepts it, the crash is a bug specific to imported generators and lead § 5.4 becomes markedly stronger.

To be tested on a throwaway timeline, never in production.

### 5.4 An "API" vehicle with exact titles

On an **empty** timeline, `InsertFusionTitleIntoTimeline` cannot shift anything (§ 3.6). Hence:

1. Create the empty timeline.
2. Place every title in **increasing** position order, styling each one through `ImportFusionComp` (`fusion/titleText.js` already does that work).
3. Place the clips at their absolute positions (`AppendToTimeline` with `recordFrame`), which does not ripple.

Gain: **exact** titles (text, font, size, colour, position).
Cost: you lose what only the import provides — **audio levels** (no API command exists) and keyframes other than those carried by Fusion.

This is a **product trade-off**, not a technical problem. It could be exposed per transfer in the NetsuBridge tab.

### 5.5 Write a `.drt` ourselves

The format is now partly known (§ 3.8). A hand-made `.drt` would bypass every FCP7 import limitation, but it means writing undocumented binary `FieldsBlob` structures — fragile from one Resolve version to the next (`DbPrjVer` is versioned). **Last resort only.**

### 5.6 Minor leftovers

- `sourceClipsFolders` (a list of bin folders) has never been tried — might help media resolution; unrelated to titles.
- Check whether the `fontsize` behaviour changes on another Resolve version: it may simply be a 21.0.3 defect.
- Title colour and alignment have not been extracted from the blob (only text, font and size). Pointless while nothing on the target accepts them.

---

## 6. Resolve → Premiere Pro: **never run**

The code exists (`adobeBridge.placeTimeline` → panel job → the host placement script), the frame math is locked by `test/adobe-timeline-live.test.cjs` and `test/transfer-ppro-units.test.cjs`, but **no real transfer has ever been performed in this direction**.

What is established elsewhere and applies here:

- Reading animation on the Resolve side goes through `Timeline.Export(EXPORT_FCP_7_XML)` — the API exposes no keyframe (`resolveXml.js` + `mergeAnimation.js`).
- Writing on the Premiere side uses `overwriteClip` at ticks, never `insertClip`.
- Adding tracks goes through the undocumented QE DOM and **clamps to the last track while saying so**, rather than losing the clip.

### Major open lead: Premiere's native import

The same reasoning as for Resolve applies **in mirror, and has never been exploited**: Premiere can import an FCP7 XML (`app.project.importFiles([path])`), and Resolve can export one. A Resolve timeline could therefore arrive in Premiere **with its keyframes and audio levels**, instead of being placed clip by clip by ExtendScript.

Test in this order:

1. `Timeline.Export(path, EXPORT_FCP_7_XML)` on an animated Resolve timeline.
2. Import that file into Premiere **by hand** and look at what arrives: transforms, keyframes, audio levels, titles.
3. If it holds, call `importFiles` from the CEP panel.

That is exactly the approach that unblocked Premiere → Resolve. **Do not do it backwards**: start with the manual import, which tells you in a minute what the format really carries.

Expected trap, by symmetry with § 3.1: a Resolve title or a media without a file in the exported XML could make the import fail on the Premiere side. Verify with a montage that contains one.

---

## 7. Resolve → After Effects: **XML is dead**

**After Effects no longer imports XML.** Recent versions removed a large part of the exchange formats; do not go down that route in either direction.

This has no consequence: the app does not use XML for AE. That pair has its **dedicated pipeline** (`core/aeExport.js` + `core/ae/*`), which writes an ExtendScript `.jsx` executed by AE — a comp is built layer by layer, with no exchange format at all. Two delivery routes already exist: run the script inside the **open** AE through `$.evalFile`, or fall back to launching `AfterFX.exe -r`.

Open leads for this pair, by interest:

1. **Carry keyframes in the `.jsx`.** ExtendScript both reads and writes everything on the AE side — `setValueAtTime` exists. This is the richest of the three applications and nothing limits it. Reading on the Resolve side is already done (`resolveXml.js`); it "only" needs translating into AE calls.
2. **Audio levels.** AE exposes `Audio Levels` as an animatable property — so what the Resolve API cannot **write**, AE can receive. Resolve → AE is the only one of the three pairs where audio automation is transportable in full.
3. **Titles.** A Resolve title is not readable (§ 3.5), so there is nothing to carry until that is solved. A **Premiere** title is readable (§ 4) — a Premiere → AE pair, unsupported today because Dynamic Link covers it natively, would not have that problem.

**After Effects stays a DESTINATION only** (`TRANSFER_TARGETS.aeft = []`): Premiere and AE already talk through Dynamic Link, so a transfer between those two would add nothing.

---

## 8. Supported pairs — status

| Pair | Vehicle | Status |
| --- | --- | --- |
| Premiere → Resolve | FCP7 XML import (fallback: API placement) | **Verified at runtime.** Clips, keyframes, transforms, audio levels, de-duplicated audio, titles in the right place. Title style approximated (§ 3.5) |
| Resolve → Premiere | API placement through the CEP panel | **Never run.** Lead § 6 |
| Resolve → After Effects | Dedicated `.jsx` script | **Never run.** Leads § 7 |
| Premiere → After Effects | — | Out of scope (Dynamic Link) |
| After Effects → * | — | AE is not a source |

---

## 9. Where things live

| File | Role |
| --- | --- |
| `core/transfer/importResolve.js` | Exchange-file import, before/after listing, style report |
| `core/transfer/xmeml/prepare.js` | The only entry point for pre-import fixes |
| `core/transfer/xmeml/graphics.js` | Title reading (blob), translation to `<generatoritem>` |
| `core/transfer/xmeml/audioChannels.js` | Re-joining exploded stereo channels |
| `core/transfer/xmeml/normalize.js` | Header variants (safety net, not the main cause) |
| `core/transfer/resolveTitles.js` | API title placement — refuses on a non-empty timeline |
| `core/transfer/resolveXml.js` | Animation reading on the Resolve side (FCP7 export) |
| `core/transfer/premiereXml.js` | Animation reading on the Premiere side (FCP7 export) |
| `test/transfer-xmeml-graphics.test.cjs` | Real blob fixtures + title invariants |
| `test/transfer-xmeml-audio.test.cjs` | Exploded-channel invariants |
