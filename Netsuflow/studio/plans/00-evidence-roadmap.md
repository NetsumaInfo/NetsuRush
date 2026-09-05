# NetsuFlow Studio evidence roadmap

## Rule

The current NetsuFlow OpenFX/HyperFrames extension remains the active project.
Studio implementation does not start because documentation exists; it starts
when the prerequisite evidence below is recorded.

## Gate 0: Current extension

Required before any production Studio code:

- real HyperFrames session connected through the existing bridge;
- random and backward frame requests validated;
- alpha, color, fps, duration, and render-scale contract validated;
- common cache includes source, binding, props, and frame-control revisions;
- Fusion controls validated for constants and keyframes;
- renderer crash/restart and Resolve host recovery validated;
- Windows packaging, repair, offline behavior, and uninstall validated;
- remaining risks reflected in root `STATUS.md`.

Isolated Studio package/component spikes may start after the real renderer gate,
but they do not enter production navigation or packaging before Gate 0 passes.

## Gate 1: HyperFrames editor surface

Run T01 and choose every component independently:

```text
SDK                  required foundation
Player               required foundation
Studio NLEPreview    accept or custom fallback
Studio Timeline      accept or custom fallback
Studio SourceEditor  accept or engine-neutral editor fallback
Studio Inspector     accept or NetsuRush custom inspector
Studio FileTree      accept or NetsuRush project explorer
Studio server        adopt only required public helpers
```

Output: dated T01 report, pinned versions/export fingerprints, adopted surface,
bundle/runtime budget, and rejected-component reasons.

## Gate 2: Engine-neutral Studio foundation

Execute
[`2026-08-27-studio-foundation-implementation.md`](2026-08-27-studio-foundation-implementation.md)
with a fake adapter first. Deliver a hidden/developer-gated module capable of
project registration, composition listing, session lifecycle, capabilities,
source snapshots, deterministic preview, diagnostics, and clean close/reopen.

Output: tested common contracts that contain no HyperFrames DOM assumptions.

## Gate 3: HyperFrames authoring

Create a new implementation plan from the exact T01 API evidence. Deliver SDK/
Player integration, chosen Studio components, source revisions, code/preview,
variables, basic clip timeline, and recovery.

Output: one known project editable manually without Resolve or AI.

Run R05 Phases A and B while completing this gate. Single-element selection and
the manual Inspector must be proven before the agent receives element context.

## Gate 4: Resolve assets

Run T02, then plan and implement the extended Media Pool descriptor and asset
catalog. Deliver linked file assets first, then copied/proxy modes only when
their evidence passes.

Output: reliable asset insertion into a HyperFrames composition.

## Gate 5: Resolve publishing

Run T03. Implement rendered import/insert as the required first product path.
Enable automatic live OpenFX insertion only if parameter assignment and
recovery are proven; otherwise ship a guided binding workflow.

Output: versioned publish records and repairable Resolve delivery.

## Gate 6: AI redesign

Run R03 after manual Studio workflows exist. Collect current-agent failures and
manual baselines. Run T04 before selecting provider/model/interaction. Implement
the change-set assistant as a separate plan only if it passes.

Output: an optional assistant with typed proposals, diff, preview, explicit
apply, and separate publish approval.

T06's Studio and context-attachment phases are part of this gate. The agent
consumes the existing typed manual-edit model; it does not introduce a parallel
mutation language.

## Gate 6A: Fusion selection overlay

Run the OpenFX phases of R05/T06 only after the fixed parameter lifecycle is
stable. Deliver hover and single selection first, then X/Y drag. Native
promotion, resize, rotation, and multi-selection remain gated by persistence
and coordinate-fidelity evidence.

Output: either a measured Fusion overlay integration or an explicit decision to
keep selection in Studio while retaining stable declared controls in Fusion.

## Gate 7: Remotion

Run T05 Phase A before HyperFrames-specific UI assumptions spread. Add the real
Remotion adapter only after the renderer/license/product gates are approved.

Output: engine switch between separate projects with shared Studio/Resolve
infrastructure, not automatic source translation.

## Release order

```text
Extension
  -> Studio manual HyperFrames editor
  -> Resolve Media Pool
  -> rendered publish
  -> live publish
  -> redesigned AI assistant
  -> Remotion adapter
```

This order may be shortened by evidence, but no later feature weakens an earlier
correctness or safety gate.
