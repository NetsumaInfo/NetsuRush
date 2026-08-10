# Export Black Pause Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the merged-export gap control with a concise localized “black pause” setting displayed in seconds and backed by a custom Base UI tooltip.

**Architecture:** Keep `ExportProfile.mergeGap` and the core contract in integer milliseconds. Isolate presentation conversion in a small export UI helper, then make `ProfileEditor` render seconds through the existing shared `NumberSpin`. Wrap only this setting in the project tooltip, leaving other `NumberSpin` consumers unchanged.

**Tech Stack:** React 19, TypeScript, react-i18next, Base UI tooltip, Node test runner.

---

### Task 1: Specify the seconds presentation contract

**Files:**
- Create: `src/components/export/blackPause.ts`
- Create: `test/export-black-pause.test.cjs`

- [x] **Step 1: Write the failing conversion test**

Create a Node test that transpiles `blackPause.ts` with TypeScript and asserts `millisecondsToSeconds(1500) === 1.5`, `secondsToMilliseconds(1.5) === 1500`, and rounding of floating-point input to integer milliseconds.

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test test/export-black-pause.test.cjs`

Expected: FAIL because `src/components/export/blackPause.ts` does not exist.

- [x] **Step 3: Add the minimal conversion helper**

```ts
export const BLACK_PAUSE_MAX_SECONDS = 10;
export const BLACK_PAUSE_STEP_SECONDS = 0.1;

export function millisecondsToSeconds(milliseconds: number): number {
  return milliseconds / 1000;
}

export function secondsToMilliseconds(seconds: number): number {
  return Math.round(seconds * 1000);
}
```

- [x] **Step 4: Run the focused test**

Run: `node --test test/export-black-pause.test.cjs`

Expected: PASS.

### Task 2: Render the custom seconds control

**Files:**
- Modify: `src/components/export/ProfileEditor.tsx:35-38,299-311`
- Modify: `test/export-black-pause.test.cjs`

- [x] **Step 1: Add failing source-contract assertions**

Assert that `ProfileEditor.tsx` imports the four black-pause exports, wraps the `NumberSpin` in `Tooltip`, uses `millisecondsToSeconds`, commits through `secondsToMilliseconds`, and renders the localized `editor.seconds` unit and `editor.mergeGapHint` tooltip.

- [x] **Step 2: Run the test to verify the new assertions fail**

Run: `node --test test/export-black-pause.test.cjs`

Expected: FAIL because the editor still displays raw milliseconds and has no tooltip wrapper.

- [x] **Step 3: Implement the editor change**

Import `Tooltip`, `TooltipTrigger`, and `TooltipContent`, plus the black-pause helper. Render `NumberSpin` through a tooltip trigger, display values from `0` to `10` in `0.1` second steps, commit back to milliseconds, and render `t("editor.seconds")` beside it. Use `t("editor.mergeGapHint")` as the tooltip content.

- [x] **Step 4: Run the focused test**

Run: `node --test test/export-black-pause.test.cjs`

Expected: PASS.

### Task 3: Localize the concise label and tooltip

**Files:**
- Modify: `src/locales/fr/export.json`
- Modify: `src/locales/en/export.json`
- Modify: `src/locales/es/export.json`
- Modify: `src/locales/de/export.json`
- Modify: `src/locales/ja/export.json`
- Modify: `src/locales/zh/export.json`
- Modify: `test/export-black-pause.test.cjs`

- [x] **Step 1: Add failing locale assertions**

Load all six JSON files and require non-empty `editor.mergeGap`, `editor.mergeGapHint`, and `editor.seconds`. Assert the French values are exactly `Pause noire`, `Durée du noir ajouté entre chaque plan fusionné`, and `s`.

- [x] **Step 2: Run the test to verify the locale assertions fail**

Run: `node --test test/export-black-pause.test.cjs`

Expected: FAIL because the new hint and seconds keys are absent and the old label remains.

- [x] **Step 3: Update all six translations**

Use concise equivalents of “Black pause” and a complete tooltip explaining the black inserted between merged shots. Replace `milliseconds` with `seconds` because the old unit key is only consumed by this control.

- [x] **Step 4: Run focused and locale checks**

Run: `node --test test/export-black-pause.test.cjs`

Expected: PASS.

Run: `npm run check:i18n`

Expected: PASS, or report any pre-existing unrelated locale failure separately.

### Task 4: Audit and verify the finished UI change

**Files:**
- Verify: `src/components/export/ProfileEditor.tsx`
- Verify: `src/components/export/blackPause.ts`
- Verify: `src/locales/*/export.json`
- Verify: `test/custom-tooltips.test.cjs`

- [x] **Step 1: Run the tooltip regression audit**

Run: `node --test test/custom-tooltips.test.cjs`

Expected: 3 passing tests and no native interactive `title` or visible native file control.

- [x] **Step 2: Run the Impeccable detector once**

Run: `node C:\Users\haimf\.agents\skills\impeccable\scripts\detect.mjs --json src/components/export/ProfileEditor.tsx src/components/export/blackPause.ts`

Expected: no blocking finding caused by this change.

- [x] **Step 3: Build the renderer**

Run: `npm run build`

Expected: TypeScript and Vite exit successfully.

- [x] **Step 4: Review the final diff and commit**

Run: `git diff --check` and `git diff -- src/components/export/ProfileEditor.tsx src/components/export/blackPause.ts src/locales test/export-black-pause.test.cjs`.

Commit only the implementation files with: `git commit -m "fix: clarify merged export black pause"`.
