# R02: Resolve editor bridge

## Decision

Can NetsuFlow identify Media Pool assets, place live/rendered output, update it,
and recover relationships across Resolve restarts without unsafe name/path
guessing?

## Current evidence

The installed API documents stable IDs, Media Pool traversal/import, explicit
timeline placement, markers with custom data, item enumeration, rendered media
replacement, and OFX Generator insertion. [ST-BMD-SCRIPTING-LOCAL]

NetsuRush already aggregates file-backed Media Pool clips and polls a Resolve
signature. [ST-NR-MEDIA]

## Questions

1. Which IDs remain stable across save/reopen, timeline duplication, and Resolve
   restart?
2. What properties distinguish file-backed and generated/offline items?
3. Can the current Python aggregate return IDs and metadata with acceptable
   performance on large pools?
4. Can `InsertOFXGeneratorIntoTimeline()` be followed by deterministic binding
   assignment through Fusion scripting?
5. How can a published item be correlated without polluting user-visible names?
6. What is the safest flattened update strategy?
7. What happens if the project/timeline changes during render/import?

## Experiment

Run T02 and T03 on a disposable Resolve project. Never use a production project.
Create fixtures for duplicate names, nested bins, offline media, image
sequences, generated clips, alpha output, multiple timeline uses, copied
timelines, project close/reopen, and interrupted publishing.

## Decision rule

The Media Pool bridge passes when file-backed assets can be tracked by stable
identity and unavailable items are classified correctly. Publishing passes when
both render/import and either automatic or clearly manual live-binding flows are
recoverable. Automatic live insertion is optional; misleading automation is not.

