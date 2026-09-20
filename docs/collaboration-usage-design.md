# Collaboration usage profiles and shared collections

Status: approved for implementation on 2026-09-06.

The approved UI entry points are New Collection and Edit Folder. Enabling sharing prepares
all collection media using re-encode or remux before invitation publication. NetsuBook must
support sharing one document or an entire notebook collection. General settings expose local
cadence defaults and per-surface overrides. NetsuDraft is explicitly outside this change.

## Verified baseline

Before any modification, `development` was pushed to `origin`; the remote returned
`1f1e5604e4e7c0061193396d61a1434e5dc6edd6`. The working tree was clean.
The existing collaboration surface is the reference board. Collections and notebook
require their own typed operations, native projections, media grants and lifecycle bindings.
`convex/projects.ts` currently caps membership at ten, including reserved invitation seats.

The notebook forwards its complete block document to the store on each editor change.
`nbFlushPage` clears the dirty flag before awaiting persistence and suppresses errors;
failed saves can therefore appear clean until the next edit. This is a correctness issue
to fix alongside performance. No measured cause of typing latency has been established.

## Approach

Keep the existing native Loro document authority, authenticated iroh transport, and
Convex membership/encrypted recovery boundary. Add per-device scheduling profiles and
surface-specific operations. This avoids replacing the proven local durability path.

Alternatives considered: a single conservative schedule is simpler but penalizes writing;
independent live and offline engines duplicate conflict resolution and permission logic.
Use one durable engine with three scheduling profiles instead.

## Usage profiles

These are initial tuning targets, not measured latency promises. Local input must remain
immediate in every profile. Schedule remote delivery independently of local persistence.

| Profile | Default surface | Outgoing edit coalescing | Media behavior |
| --- | --- | --- | --- |
| Live | Notebook and writing | 40–80 ms, bounded maximum wait | Prioritize text over blobs |
| Balanced | Collections and reference board | 150–250 ms | Previews first, bounded transfers |
| Economy | User-selected on weaker computers | 750–1000 ms | One bulk transfer, full media on demand |

Preferences belong to the device; one slower participant must not downgrade everyone.
Coalesce redundant notifications, avoid full projections for unchanged revisions, bound
queues and concurrency, and yield bulk work to document edits. Changing profile must
retain pending edits and never interrupt local durability. Recovery checkpoints remain
independent of the live edit cadence; do not write to Convex for every keystroke.

## Shared collection creation and file lifecycle

The creation dialog gathers collection name, recipients, roles, media preparation choice,
and deletion permissions before creating the shared project. Initial target: fifteen total
members including the creator; pending invitations reserve seats. Centralize the limit so
future increases require capacity validation rather than scattered literal changes.

Video sharing requires a generated derivative: re-encode or remux. Never publish a source
path or silently fall back to the original. Re-encode is the default for smaller transfers;
remux reduces preparation CPU but does not guarantee smaller files or easier decoding.
Keep existing keyframe limitations visible for lossless cuts. Reuse probed encoder selection.

Prepare only missing derivatives with bounded jobs and content-based reuse. Track preparation,
failure, cancellation, ready state and transfer separately. Publish a media manifest only after
the derivative is verified and registered in the native grant path. Do not expose source
locators in shared metadata. Retrying must not duplicate entries or invitations. Failed initial
creation must roll back its empty remote project and preserve the local collection and source.

## Deletion and permissions

Each shared entry records an immutable contributor account identity derived from authenticated
native operations, never trusted from renderer input. By default, contributors may remove
their own entries globally while authorized editors retain that role. Other recipients may
hide entries locally and later restore visibility. Local hiding is private persisted state,
not a CRDT deletion; it must survive reopen without spreading to other participants.

The owner may grant a separate permission to remove other contributors' entries globally.
Proposed default: this permission is disabled, including for the owner's removal of another
contributor's entry. The owner still controls membership and whole-project deletion. Explicitly
distinguish entry removal, local hiding, downloaded-cache removal and whole-project deletion.

Enforce permissions on local native commands AND incoming authenticated updates. The existing
trusted-editor CRDT model must be reviewed before claiming entry-level security: rejecting only
UI actions is insufficient. Bind author identities and permission epochs to signed operations,
prevent forged ownership and reject unauthorized tombstones or state replacement. Preserve
valid concurrent edits when an unauthorized batch is rejected. Fail closed for clients unable
to enforce the revised protocol. Revocation does not erase previously downloaded copies.

## Notebook integration and latency

Measure typing, store updates, autosave and spellcheck independently on representative long
pages before attributing latency. Keep editor instances and selection stable; isolate metadata
subscribers from per-keystroke block changes. Serialize only for persistence or changed operations.
Make persistence revision-aware, preserve dirty state on errors, serialize saves, and flush the
correct page when switching documents. Report failure and offer a retry without losing edits.

Add notebook-specific block, order, hierarchy and rich-text operations. Use incremental text
and mark changes with a stable position mapping; replacing an entire page after concurrent
typing is unacceptable. Preserve IME composition, selections, custom blocks, undo ownership,
databases and page links. Integrate invite acceptance and reopening via the surface registry.

## Delivery sequence and verification

1. Shared scheduling policy and notebook persistence correctness, with focused behavior tests.
2. Versioned permissions and fifteen-seat enforcement, including concurrent invitations.
3. Collection operations, derivative grants, dialog, local hiding and lifecycle wiring.
4. Notebook incremental collaboration and editor binding with convergence tests.
5. NetsuBoard adaptation by Luna xhigh using the agreed common policies, without copying
   NetsuRush-specific collection or notebook assumptions into a board-only application.

Test save failures, edits during a save, page switching, bounded scheduling under continuous input,
offline recovery, duplicate retries, forged contributor identities, unauthorized remote deletion,
concurrent delete/edit, hidden-entry restoration, derivative failures and fifteen-seat races.
Run renderer build, core checks, locale parity across six languages and relevant Node tests.
For native changes use `cargo check --locked`; do not build or restart the running Tauri app.

Live acceptance requires restarted applications, distinct accounts and two machines: simultaneous
typing with selection/IME, offline/reconnect, owner offline, slow device, media interruption and
permission changes. Measure input latency, remote edit latency, CPU, memory, queue size and bytes
transferred. Tests with fifteen replicas support convergence claims but cannot establish real
fifteen-device resource usage. Report all unperformed runtime checks explicitly.
