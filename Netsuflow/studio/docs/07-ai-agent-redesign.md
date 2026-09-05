# AI agent redesign

## Decision

The current NetsuRush agent is not accepted as the Studio agent foundation from
a product-behavior perspective. Its registry, streaming, provider adapters, and
permission code are useful audit material, but the concept and interaction model
must be reevaluated from first principles. [ST-NR-AGENT]

Studio implementation does not begin by adding more tools to the current chat.
It begins with user-task research and a controlled change-set prototype.

## Product role

The agent is an editing collaborator, not a hidden automation layer. It should
help the user:

- create a composition from an intent and selected assets;
- explain and repair validation errors;
- propose timing, layout, parameter, and source changes;
- generate code while preserving project conventions;
- compare variants at selected frames;
- publish only after the user understands the target and effect.

Studio remains fully usable without the agent.

## Core interaction

```text
User request
  -> scoped context snapshot
  -> agent plan
  -> typed proposed operations
  -> static validation
  -> sandboxed candidate session
  -> preview frames + source diff
  -> user apply/reject/edit
  -> atomic apply
  -> post-apply validation
```

The default output is a proposed change set, not direct filesystem or Resolve
mutation.

## Change-set contract

```ts
interface EditorChangeSet {
  id: string;
  projectId: string;
  compositionId: string;
  baseRevision: string;
  summary: string;
  operations: EditorOperation[];
  requestedPreviewFrames: number[];
  publishIntent?: PublishIntent;
}

type EditorOperation =
  | { type: "source.patch"; path: string; edits: TextEdit[] }
  | { type: "element.setText"; elementId: string; value: string }
  | { type: "element.setStyle"; elementId: string; values: Record<string, string> }
  | { type: "clip.setTiming"; elementId: string; start: number; duration: number; track: number }
  | { type: "asset.insert"; assetId: string; target: InsertTarget }
  | { type: "variable.set"; variableId: string; value: unknown };
```

No operation contains a free-form shell command.

## Context policy

The agent receives the smallest useful snapshot:

- active project and engine metadata;
- active composition source or selected bounded regions;
- capability report and diagnostics;
- current selection and playhead;
- declared variables;
- user-selected Media Pool assets and metadata;
- project style/instruction files;
- prior accepted change-set summaries.

It does not receive unrelated files, credentials, raw core logs, the entire
Media Pool, or arbitrary local filesystem access by default.

## Tool model

Tools are separated by effect:

### Read

```text
studio_project.read
studio_composition.read
studio_selection.read
studio_assets.search
studio_validate
studio_preview.capture
```

### Draft-only

```text
studio_changes.propose
studio_changes.validate
studio_changes.preview
studio_changes.revise
```

### Commit/publish

```text
studio_changes.apply
studio_binding.create
studio_render.start
studio_resolve.publish
```

Commit and publish tools consume an already validated change-set or publish
record; they do not accept a second unrelated free-form instruction.

## Permissions

The current global risk labels are too coarse for Studio UX. The redesigned
model distinguishes:

| Effect | Default |
|---|---|
| read project/selection | allowed |
| render temporary preview | allowed within quotas |
| create draft change set | allowed |
| write project source | explicit Apply |
| copy/create managed media | explicit confirmation |
| mutate Resolve timeline | explicit Publish confirmation |
| replace/delete media or timeline items | destructive confirmation |

Provider requests, local model inference, file mutation, render expense, and
Resolve mutation are separate permissions.

## Model/provider strategy

The agent architecture is provider-neutral. Evaluation uses a fixed task set,
not provider reputation. Candidate runtimes must support:

- structured tool calls or schema-constrained output;
- cancellation and partial failure reporting;
- bounded context construction;
- deterministic-enough operation validation;
- BYOK/local privacy labeling;
- reproducible model/provider/version records in test reports.

The system may use separate models for planning, code editing, and visual review
only if measured quality justifies the complexity.

## Evaluation corpus

R03 and T04 define at least these tasks:

1. change text and color without touching timing;
2. place one chosen Media Pool image for a finite range;
3. repair an invalid duration attribute;
4. add a title entrance while preserving unrelated GSAP code;
5. modify a declared variable instead of hard-coding its value;
6. refuse or safely fall back on a dynamic unsupported element;
7. explain a stale source revision conflict;
8. generate two previewable variants;
9. publish only after explicit approval;
10. recover cleanly from cancelled render/Resolve disconnect.

Score correctness, unrelated edits, source validity, preview parity, number of
repair turns, latency, tokens/cost, user approvals, and recoverability.

## Stop conditions

Do not ship the agent as an automatic editor if it:

- frequently changes unrelated source;
- cannot produce operations that pass deterministic validation;
- hides fallbacks or unsupported edits;
- loses work on stale revisions;
- mutates Resolve before explicit publish intent;
- requires unrestricted shell/filesystem access for ordinary tasks;
- is materially worse than direct manual editing on the evaluation corpus.

