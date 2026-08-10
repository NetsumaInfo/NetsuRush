# Export Black Pause Control

## Goal

Make the merged-export black-gap setting immediately understandable and remove the browser-native hover treatment reported on its numeric field.

## Interface

- Rename the French label from `Noir entre les plans` to `Pause noire` and translate the same concise meaning in all six locales.
- Display and edit the duration in seconds, using the localized unit `s`, while preserving the existing millisecond value in the export profile and core contract.
- Support fractional seconds so the current 100 ms precision remains available (`0.1 s` increments, from `0` to `10 s`).
- Show the existing Base UI custom tooltip on hover and keyboard focus: it explains that the value is the duration of black inserted between merged shots.
- Avoid native browser validation or hover UI on this control. The shared numeric control must retain its keyboard, wheel, disabled, clamping, blur, and Enter behavior.

## Scope

The export profile editor and its six locale files are in scope. If the native hover comes from the shared `NumberSpin`, fix it without changing the displayed units or semantics of its other consumers. Audit interactive `title` attributes and visible native controls across `src/components` with the existing regression test.

## Verification

- Add or update focused tests for seconds-to-milliseconds conversion, translated labels, and the absence of native tooltip attributes.
- Run `npm run check:i18n`, `node --test test/custom-tooltips.test.cjs`, the focused export tests, and `npm run build`.
- Renderer changes may be inspected through hot reload. Any behavior requiring the running Tauri application remains explicitly unverified unless observed.
