# Resolve timeline publishing

## Two delivery products

Studio supports two explicit publication modes. They solve different problems
and must never be presented as interchangeable.

## Live NetsuFlow binding

```text
Studio project revision
  -> immutable NetsuFlow binding
  -> NetsuFlow OpenFX Generator
  -> frame requests during Resolve/Fusion evaluation
```

Advantages:

- source edits can invalidate the binding without re-importing a movie;
- Fusion/OpenFX parameters can remain editable and keyframeable;
- downstream Fusion nodes see a normal image source;
- alpha remains available through the pixel contract.

Limitations:

- playback depends on the renderer service and cache;
- packaged runtime and browser availability become project dependencies;
- heavy compositions can miss interactive deadlines;
- automatic insertion and binding assignment are not yet proven.

The installed SDK documents `InsertOFXGeneratorIntoTimeline(generatorName)`.
T03 must determine whether the returned item exposes a stable route to the
NetsuFlow parameter, and whether that route survives save/reopen, copy/paste,
duplicate timeline, and Resolve restart. [ST-BMD-SCRIPTING-LOCAL]

## Flattened render

```text
Studio revision
  -> HyperFrames render
  -> versioned artifact
  -> Resolve ImportMedia
  -> AppendToTimeline with explicit record frame
```

Advantages:

- predictable Resolve playback;
- portable handoff when the artifact is collected;
- no live renderer dependency during final editing.

Limitations:

- source parameters are no longer editable through the clip;
- every update creates or replaces media;
- update semantics can affect multiple timeline uses if implemented through
  `MediaPoolItem.ReplaceClip()` carelessly.

The default update policy is versioned media, not global replacement:

```text
title-main__nf_r0007.mov
title-main__nf_r0008.mov
```

Replacing all uses of an existing MediaPoolItem requires a separate explicit
action and test evidence.

## Publish record

Every successful or partially successful publish writes a record:

```ts
interface PublishRecord {
  id: string;
  projectId: string;
  compositionId: string;
  sourceRevision: string;
  engine: "hyperframes" | "remotion";
  target: "live-ofx" | "render-import" | "render-insert";
  resolveProjectId: string;
  resolveTimelineId?: string;
  resolveItemId?: string;
  mediaId?: string;
  bindingId?: string;
  artifactPath?: string;
  recordFrame?: number;
  createdAt: string;
  status: "complete" | "partial" | "failed";
}
```

Names are display metadata; IDs and revisions are identity.

## Transaction model

Publishing is a recoverable multi-step operation:

1. validate the exact source revision;
2. resolve project/timeline identity and frame rate;
3. create binding or render artifact;
4. import/insert in Resolve;
5. attach a marker or metadata correlation when supported;
6. verify the returned item and expected placement;
7. write the publish record;
8. expose repair when any later step fails.

The operation never deletes a prior artifact automatically.

## Timeline positioning

Resolve frame math follows the existing NetsuRush invariants. The publish
coordinator uses explicit record frames and reconciles inclusive Resolve end
frames with engine duration. It sets/validates timeline fps and resolution
before placement where the workflow creates a new timeline. [ST-NR-INVARIANTS]

## Synchronization

Initial synchronization is command-driven with bounded polling:

- Studio playhead may optionally follow the Resolve timecode.
- Resolve playhead follow is opt-in to avoid fighting user navigation.
- Publishing uses an immutable frame/range snapshot.
- Project/timeline changes during publish abort before mutation when possible.
- Live binding changes invalidate the renderer; they do not rewrite the Resolve
  timeline item.

Real bidirectional event synchronization is not a first-release promise.

## Verification

T03 must cover placement, fps, duration, alpha, save/reopen, duplicate timeline,
source revision updates, disconnected Resolve, user project switches mid-job,
partial import, duplicate names, and repair.

