# Render your own page in Resolve

```bash
node tools/render-in-resolve.mjs my-page.html
```

That is the whole thing. Leave it running; Ctrl-C stops it.

It reads the open project's resolution and frame rate, starts the service,
detects whether the page is Studio-authored, and sets the Fusion node's
`Binding` and `Mode` for you. The node needs to exist in the current comp —
add a **NetsuFlow (Experimental)** generator and run the command again.

To set a catalog component's declared parameters:

```bash
node tools/render-in-resolve.mjs my-page.html --var accent=violet --var stroke_width=28
```

A folder works too, if the page has its own CSS, fonts or images:

```bash
node tools/render-in-resolve.mjs ./my-composition
```

## There is no parameter that takes code

The node's `Props` and `Diagnostic Source` fields do nothing. They are read
once when the node opens and never used again — leftovers from an Inspector
usability test. Pasting a page into them will never render anything.

The code lives in a file. The node only carries a `Binding` string that names
which composition the service should answer with.

## What your page has to expose

```js
window.__hf = { duration, seek }   // duration in seconds, seek(seconds)
```

The engine navigates to your page, calls `seek()` for each frame, waits for
`window.__hfWaitForSeekCompletion()` if you define one, and screenshots.

Two rules that are enforced rather than advised:

- **`data-width` / `data-height` must equal the host's resolution.** A mismatch
  is refused per frame, not scaled.
- **Nothing may depend on the wall clock, the network, or unseeded randomness.**
  Frame N has to paint identically every time, or the cache will serve one of
  two versions at random.

[`sandbox/index.html`](sandbox/index.html) is a working minimal example.

## Pages from the HyperFrames catalog

A page authored for HyperFrames Studio keeps its content inside a `<template>`,
reads `window.__hyperframes.getVariables()`, and publishes
`window.__timelines[id]` instead of `__hf`. None of that works against the raw
engine, and it fails silently: an empty stage, no error.

The tool detects those pages and injects [`studioShim.mjs`](studioShim.mjs),
which mounts the template, re-runs its scripts in order, answers
`getVariables()` from the page's own `data-composition-variables` declaration,
and bridges the GSAP timeline to `__hf`. `--var` overrides those declared
defaults one key at a time.

**Known defect:** a component with soft edges — a glow, a blur, a soft shadow —
renders correctly standalone and wrong in Resolve. The plugin passes straight
alpha without declaring it, so the host composites it as premultiplied. See
[H04](../../tests/results/H04-2026-08-27/report.md). Hard-edged compositions are
unaffected.

## When nothing appears

The service now logs every refusal. Watch its output:

| Line | Meaning |
|---|---|
| `[refused] stale-revision` | the binding's revision is not `0`, which is what the plugin sends |
| `[refused] bad-request: request is WxH but binding is …` | the size does not match; the message names the host's size |
| `[refused] unsupported: renderScalePpm…` | a proxy is on; set it to Full |
| `[refused] unknown-binding` | the `Binding` field does not name a binding |

If the node shows the plugin's own colour pattern instead, `Mode` is still on
`Local Diagnostic` and no service is involved at all.
