# T01: HyperFrames component embedding

## Question

Which HyperFrames editor surfaces can power a NetsuRush-themed custom editor in
Tauri/WebView2 without importing the complete Studio application?

## Preconditions

- current OpenFX HyperFrames adapter gate passed;
- isolated feature branch/worktree;
- exact HyperFrames versions pinned;
- no production navigation or user project mutation.

## Variants

1. Full `StudioApp` as a behavior reference only.
2. Custom shell using selected Studio `NLEPreview`, `Timeline`, and hooks.
3. Custom shell using SDK + Player and minimal custom controls.

## Scenarios

- import/build/typecheck each public entry point;
- open/close 100 sessions and inspect memory/listeners;
- select and edit stable elements;
- move/resize a supported element;
- change timing for clips and nested compositions;
- declared variable editing;
- undo/redo through host-owned history;
- external source edit and conflict;
- invalid source with last-valid preview;
- play, pause, seek, frame step, and duration change;
- global shortcut and text-editor focus conflicts;
- light/dark theme, scaling, keyboard-only use, and screen-reader labels;
- 10/100/1,000/5,000 element timeline performance;
- WebView2 reload and Tauri window resize;
- bundle size and cold/warm load.

## Measurements

- import/build result and exact public exports used;
- initial preview ready median/p95;
- seek-to-visible median/p95;
- edit-to-preview median/p95;
- timeline interaction frame time/p95;
- memory and listener delta after cycles;
- JS/CSS/package bundle delta;
- number and severity of style/context overrides;
- source round-trip equality for untouched content.

## Pass

SDK + Player must pass. Each Studio component is independently accepted or
rejected. The chosen set must allow NetsuRush-owned state/theme/history, preserve
source, and have an explicit fallback.

