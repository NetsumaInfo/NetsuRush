# Live thumbnail playback

## Scope and behavior

Derush, Timeline Live and Collections use the shot-card media hook. Search uses
its own thumbnail/proxy loader. Both now delegate playback activity to
`src/lib/usePreviewActivity.ts`, and both render `PreviewVideo`.

- Autoplay requests come from strict viewport intersection. The previous 400 px
  playback margin let offscreen rows compete with visible rows.
- There is no application quota of 52 simultaneous previews. Every visible card
  can receive a start. This does not guarantee a particular frame rate when the
  GPU, CPU, storage or WebView media implementation is saturated.
- Visible starts and speculative mounts share one animation-frame queue. Visible
  work comes first; creation is paced at one to three grants per frame according
  to the preceding frame interval. Existing playback is never paused by scrolling.
- Paused decoders form a cache of at most 18 entries. Its capacity shrinks as
  playing previews approach a retention target of 72. That number is a cache
  policy, not a claimed browser limit or a cap on visible playback.
- A full paused cache defers speculative creation until room returns. It does not
  create a decoder only to immediately evict it, and it does not poll each frame.
- Each card cancels its own pending work. Opening or closing a view no longer
  clears global queues that may still belong to another mounted view.
- Playback attempts are scoped to their source and requested state. An obsolete
  rejected `play()` cannot restart an offscreen or unmounted card. Autoplay denial
  gets one muted retry; `canplay` can resume a currently requested preview after
  an interrupted load. Source changes explicitly reapply playback.
- Unmounting explicitly pauses, removes the source and calls `load()` to release
  media resources. Setup restores the source after effect replay in development.

These changes are in the renderer. They do not change proxy encoding, cache
identity, audio preferences, grid geometry or the main player's media.

## Remaining performance work

1. **Measure in Tauri on the real media.** Compare visible-card count, playing
   count, startup delay, dropped video frames and scroll frame time. Test warm
   proxies, rapid downward scrolling, reversal, density changes and module
   switches. A scheduler test does not benchmark decoding or painting.
2. **Separate mosaic proxies from side-player proxies.** `core/proxy.js` currently
   scales video but does not reduce source frame rate, and the same proxy serves
   the grid and side player. A dedicated mosaic profile could limit frame rate
   and resolution without reducing the side player's fidelity. It needs its own
   versioned cache key and generation/resolve contract, including the toolbar.
3. **Measure the resolution floor.** Current height tiers begin at 360 pixels,
   and configured proxy height takes precedence over a card's measured height.
   Small dense cards can decode substantially more pixels than they display.
   Additional smaller tiers should be evaluated together with the mosaic profile.
4. **Profile actual decoder selection.** Hardware encoding does not prove hardware
   decoding in WebView2. Compare the existing formats on the target system before
   choosing new defaults. Audio is also present by default even though autoplay
   cards are muted; a mosaic-specific silent asset needs a separate hover-audio
   strategy.
5. **Validate preloading inside nested scroll containers.** The shared observer
   uses the document viewport. Root margins do not remove ancestor clipping;
   effective lookahead needs measurement in each layout before changing roots.
6. **Legacy animated WebP.** The image compatibility path hides a paused preview
   but cannot pause animation like an HTML video. New settings already normalize
   the old WebP choice to WebM; assess remaining legacy assets before removing it.

## Validation

Behavioral tests cover more than 52 visible requests, priority over speculative
mounts, scroll cancellation, cache pressure, idempotent release, idle queue
shutdown, muted autoplay retry and stale-promise cancellation. Existing grid
checks retain the CSS geometry and cache-resolution contracts.

Playback smoothness and actual simultaneous decoding in the running Tauri window
have **not been verified at runtime**. No Tauri restart or packaging was performed.
