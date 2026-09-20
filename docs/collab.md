# Sharing and collaboration

**Implementation status:** source integration covers the reference board, Collections, and NetsuBook
(one page or an entire notebook). Static checks do not establish live-session correctness or latency.
Native/core changes require a Tauri window restart; the running app still uses its previous native
and core code until then. Two-machine acceptance and backend deployment remain unverified.

NetsuRush supports local-first shared documents for **up to 15 members**, including the owner and
reserved invitation seats. On the reference board,
members can edit the complete persisted contract: item creation and deletion, geometry, ordering,
text, drawing, crop and trim, appearance, playback, palettes, sequences, links, embeds, and media
manifests.

The design has three deliberately separate jobs:

| Job | Owner | Data |
|---|---|---|
| Authoritative document and local durability | Rust `CollabService` + Loro + SQLite | Plaintext while open, local snapshots, encrypted outbox |
| Live transport and original media | iroh over authenticated QUIC | Signed Loro updates and hash-addressed chunks |
| Identity, recovery, and invitations | Better Auth + Convex | Membership metadata, encrypted checkpoints/heads, wrapped keys, consolidated notices |

Convex is not the live document server and iroh is not the authorization database. Loro determines
document convergence; Convex determines current membership; iroh moves already-authorized bytes.

## Surfaces

Collaboration knows nothing about boards, collections or notebooks. What it knows is a **surface**:
a lowercase module label that travels with the project.

- On Convex it is one clear field on the project row (`projects.surface`). It has to be readable
  before the recipient holds any key, because an invitation must say what it invites to and the app
  must know which local object to create when it is accepted. It is a module label, never content.
- In Rust it decides which local media a project may import (`blobs.rs#subject_data`) and is half of
  the binding key `(surface, subjectId)` — two modules may legitimately give their documents the
  same local id.
- In the renderer, `src/lib/collab/surfaces.ts` maps it to the local document: how to list what is
  bound, how to create one when an invitation is accepted, how to remove it when the project goes
  away.

A project with no surface is read as `board`, the label collaboration shipped with. Surfaces are
registered from their module (`src/components/reference/collabSurface.ts`,
`src/components/collections/collabSurface.ts`, `src/components/notebook/collabSurface.ts`), imported for their side effect from `App.tsx` so the
account panel can name a shared document even when its tab was never opened.

### The board surface

Sharing a file-backed board converts it into a library scene; the `.netsu` stays on disk as a frozen
export. The file's recents entry is linked to that scene (`sourceSceneId`), and the home screen
hides the file card while the linked scene is collaborative — otherwise the board shows twice with
nothing relating the two cards, and the file card is the wrong one to edit. Leaving or deleting the
project removes the scene and the file card returns.

`Save As` is blocked on a shared board: duplicating a scene id without defining a new collaboration
project would create two local names for one remote truth. Explicit export remains available, and
resolves every `collab:` locator to the path of its bytes on this disk
(`lib/collab/board/media.ts#withLocalMediaPaths`) — without that, the core wrote a `.netsu` made
entirely of "relocate" placeholders while reporting success.

A collaborative scene stores **no items** — the document is authoritative — so it stores instead the
durable locators of the board's local media beside them, and the grant check reads that list too.
Without it a shared board can never accept another local file: the stored scene mentions nothing.
The list is rewritten before every batch leaves (`useScenePersistence#syncCollabMedia`), so a file
dropped on the board is authorised by the time its bytes are asked for. The scene also stores a
read-only layout of at most 40 items, purely so its home-screen card has something to draw.

Before sharing, dead paths are healed (`boardMediaActions#prepareShareMedia`): the core relocates by
name alone — the open project's companion folder first, then the asset store, then every known
project's companion — reading zero bytes, since the file name carries the content fingerprint. What
stays dead but keeps an online origin is re-downloaded; whatever remains dead is marked missing on
the board so the recovery gestures take over.

### The collection surface

**Sharing a collection is archiving it.** Both jobs asked the machine for the same thing — every
shot as a standalone file that no longer depends on the source rush — so there is one pipeline and
one set of settings. `core/collectionSharing.js` runs `collectionArchive.archive` and publishes the
files it wrote; `archivePlan` already decides per shot between "already there", "copy from
elsewhere" and "produce", so ranging a shot into a shared collection encodes that shot alone.

Two consequences the interface states plainly:

- Turning sharing on turns **Archive to disk** on, and holds it there. A collection that has no
  folder of its own takes the one the app proposes (`collections:defaultArchiveDir`), which the
  archive card then shows and the user is free to change.
- Peers receive the collection **in the format its owner archives in**. The archive card is the only
  place that format is chosen; there is no second, quieter profile behind the sharing panel.

Only shot files travel. The source rush is never published, and an archive entry that resolved to
the source is refused rather than sent whole.

**Who may do what**, in one model, one menu per person in the collection's sharing card:

| Menu entry | Role + delegation | May |
|---|---|---|
| Read-only | `viewer` | Receive the shots. Nothing else: no adding, no removing, no inviting. |
| Editing — their own shots | `editor` | Add shots, and remove or edit **what they contributed**. The default. |
| Editing — every shot | `editor` + `canDeleteOthers` | The same, over everyone's contributions. |
| (the owner's row) | `owner` | Everything, without delegating anything to themselves — they can delete the project outright. |

Sharing is a card in the collection editor with the same shape as **Media** and **Archive to disk**:
one switch. Turning it on publishes the collection; turning it off deletes the shared project (the
owner keeps the local collection) or leaves it (an invited member's copy goes with the share).

`convex/collectionEntries` is the authority: one row per shared shot, carrying its contributor and
whether it was removed. The projection walks those rows rather than the document's own tombstones,
so removal is a membership decision, not a CRDT race. A row claimed but absent from the document —
a publication that failed after claiming its identity — is skipped, never drawn as a nameless shot.

The one thing the document cannot enforce is *field* ownership: a CRDT has no per-entry author, so
"an editor does not rewrite someone else's shot metadata" is a renderer gate
(`useSharedCollection#canEdit`), not a server rule. Existence, which is what matters, is server-ruled.

Demoting an editor to viewer clears their delegated removal, so a later promotion does not hand it
back silently. The role also travels with the local collection (`collaboration.role`), because
**Range** and the collection list must know a read-only share without opening it — without that, the
shot entered the local copy, publication was refused, and it stayed there invisible and unshared.

### NetsuBook surfaces

`notebook` shares the notebook tree; `notebook-page` shares only the selected document. The header
opens the existing people/invitation dialog for either scope. Whole-notebook and individual-page
bindings cannot overlap. NetsuDraft and local `scriptId` associations are excluded.

Each page, block and database has a stable surface entry. Rich text uses independent LoroText
containers and Unicode scalar offsets; marks are separate operations. An accepted edit carries its
base revision, and the native service retains bounded historical frontiers so concurrent typing can
merge against the state the editor actually saw. This does not provide cell-level merging for
database JSON: concurrent changes to the same database field remain last-writer-wins.

The editor applies changed blocks without adding remote changes to local undo history and defers
projection during IME composition. These paths still need real editor acceptance for selection,
undo, nested blocks, tables and simultaneous typing. Autosave retains dirty state on failure and
serializes newer snapshots behind an in-flight save.

Media import preflight writes a device-local allowlist from the actual notebook store, including
file-backed notebooks. Native manifests carry hashes, never source paths. Downloads run in a bounded
background queue so waiting for a file does not hold the text submission loop. Received documents
use local page/database ids; binding metadata retains the local source file path for reopening.
Portable export of downloaded collaboration media still needs separate acceptance; native display
URLs must not be treated as portable asset addresses.

### Device-local cadence

General settings expose a default profile and overrides for Reference, Collections, NetsuBook and
individual documents. A new device defaults to Live for writing and Balanced for other surfaces.
Existing explicit preferences remain authoritative. No profile is stored in the shared document.

| Profile | Edit batching | Concurrent bulk downloads | Automatic media |
|---|---:|---:|---|
| Live | 60 ms | 2 | Enabled |
| Balanced | 200 ms | 2 | Enabled |
| Economy | 900 ms | 1 | On explicit request |

These are scheduling intervals, not measured end-to-end latency. Local typing is immediate in every
profile. Native peer sync permits one active exchange and one trailing request per project/peer,
which prevents edit bursts from spawning unbounded duplicate exchanges. Checkpoint publication
retains the existing durable outbox and its independent schedule.

### Adding a surface

1. **Register it** from the module, once, with `registerCollabSurface({ id, labelKey, listBindings,
   adopt, forget, onRemoved?, open? })`. The account panel, the invitations and the notifications
   pick it up with no change of their own. Add `surface.<id>` to `src/locales/*/collab.json`.
2. **Store the binding.** The local document must remember its `projectId`, the way a scene stores
   `collaboration.projectId`, so `listBindings` can answer after a restart.
3. **Bridge the document.** Diff the module's model into `CollabOp`s, project the native projection
   back into it, and import its local media. The board operation contract lives in
   `src/lib/collab/types.ts` and `src-tauri/src/collab/ops.rs`; a module whose shape it cannot
   express adds its own operations to both, and its own reader to `blobs.rs#subject_data` so its
   media can be authorised by name.
4. **Mount the shared UI.** `CollaborationDialog` (invite, roles, rotation, leave/delete) and
   `CollabStatus` (presence pill) take props only; the module supplies `onShare`, which publishes
   its document through `createCollaborativeProject`. A surface whose permission is richer than the
   two roles sets `memberRoles={false}` and owns that choice itself, so it is never settable in two
   places; removing a member and cancelling an invitation stay in the dialog either way.

## Runtime architecture

`src-tauri/src/collab/service.rs` runs one actor for the process. It owns every open Loro document,
project role, key epoch, local SQLite store, outbox, peer roster, media-retention pins, and Convex
client. The actor serializes document mutations so two renderer windows cannot race the same project.

The React renderer is a projection consumer. It submits versioned typed operations and replaces its
state with the total projection returned by Rust. It does not own a second Loro document, export
CRDT updates, select arbitrary peers or key recipients, or persist keys. Windows obtain independent
leases on the same native project; the final lease closing releases it.

The renderer obtains a short-lived Convex JWT from Better Auth and passes it to Rust in memory. Rust
validates the deployment URL against the one pinned at build time (`src-tauri/build.rs` reads
`VITE_CONVEX_URL`), keeps the token out of logs and disk, registers the device, and calls the pinned
deployment directly. The renderer refreshes authentication every five minutes while a shared
document is open. Collaboration pauses when the session cannot refresh, but accepted local edits
remain durable in SQLite.

Everything collaborative lives under `<data>/collab` — key ring, per-project SQLite stores, blob
store — where `<data>` resolves exactly like `DATA_DIR` in `core/config.js` (`~/.netsurush`, not
`%LOCALAPPDATA%\NetsuRush`, which holds the runtime and the models). Resolving it anywhere else
means Rust reads an empty directory, finds no document, and refuses every media.

## Document and operation contract

The document format and the renderer-to-native operation protocol are independently versioned at
version 1. Unknown versions fail closed.

The document contains fixed maps/lists for metadata, items, item order, strokes, and stroke order.
Items and strokes use never-reused ids and tombstones. Projection filters tombstoned children even if
a concurrent move leaves an order entry behind, so deletion wins over stale movement.

Operations are typed Rust enums with `deny_unknown_fields`. A batch is validated completely before it
is committed. Non-finite geometry, invalid ranges, oversized arrays/strings, unsupported URL schemes,
sender file paths, malformed hashes, unknown fields, and unknown protocols are rejected. If any
operation is invalid, no operation in the batch is applied.

Geometry, crop, trim, and other coupled values are atomic registers instead of unrelated scalar keys.
Text uses Loro text operations. A finished stroke is one immutable encoded value, not thousands of
point operations; erasing part of a stroke deletes it and creates replacement segments. Undo and redo
are local Loro history actions and cannot undo another member's action.

Drag previews, selection, pan/zoom, active tools, in-progress strokes, and playback position remain
local. Geometry is published after the committed gesture, not on every pointer frame. Shared cursors
and presence are intentionally not claimed by this version.

### Renderer bridge rules

A module's own store is a render cache; the Loro document is authoritative. Four rules keep the two
from fighting each other, and breaking any of them makes the document unusable rather than merely
wrong:

- **Local edits are coalesced.** Mutations use the device's 60/200/900 ms profile and leave as one
  operation batch. One batch per pointer frame saturates the outbox and the publication debounce.
- **A local apply never triggers a projection reload.** The native side announces every apply,
  including this window's own; the announcement carrying the revision the local apply just returned
  is consumed, not acted on. Rebuilding from the document mid-gesture destroys the objects the
  gesture holds.
- **A projection never touches selection beyond dead references.** Selection and edit targets belong
  to the user; only ids that no longer exist are dropped. A projection that arrives while a local
  batch is pending is held until the batch has left, then re-read.
- **A pending batch belongs to the project the view was on.** Leaving a shared document replaces the
  renderer's items in the same store. Diffing those against what the project last sent produces a
  deletion of the entire document, so a batch whose project is no longer the current one is dropped
  instead of sent.
- **Stacking is diffed on `z`, not on array position.** The document order is the render order, and
  the projection numbers `z` from it.
- **The projection rebuilds a display address, it does not only forward one.** A hashed media is
  addressed through the native protocol, which the renderer cannot compute; everything else follows
  the module's ordinary rule.
- **A shared media carries its declared type.** Addressing by fingerprint drops the file extension,
  so the type stated by the document is the only thing left that identifies an animated image. The
  type also decides how the media protocol answers a request with no `Range`: only a video or audio
  blob is capped at a first chunk, because only those ask for the rest. An `<img>` issues one plain
  request and takes whatever body it gets for the whole file.
- **A stroke holds no editable field, so editing one is a delete plus an add on the same id.** The
  document keeps a tombstone rather than removing the entry, so the add must be allowed to revive
  it. A LIVE id is still refused — that one is a genuine collision.
- **`collab:<hash>` is not a path, and no feature may hand it to the core.** The Node service only
  knows files on disk; a shared media exists only as bytes in the blob store. Any feature that
  resolves a ref against the disk needs the `isCoreFileRef` guard
  (`src/lib/collab/currentProject.ts`), and a feature that cannot work on a shared media must be
  withheld at its ENTRY POINT rather than refused at the bottom of its chain.
- **One registry answers "where is this shared media".** `currentProject.ts` resolves a `collab:`
  ref for display wherever it is asked for — a sequence's frames, a strip under a player, an
  off-DOM export renderer — because the projection only names an address for each item's own media.

## Local durability and offline recovery

Every acknowledged native edit is committed in one SQLite transaction with:

1. the Loro update;
2. a monotonically increasing device sequence;
3. the exact sealed and signed outbox envelope.

The network send happens only afterward. A crash therefore republishes the same sequence, ciphertext,
hash, and signature. Convex accepts an identical retry and rejects sequence reuse with different
content.

Publications are scheduled after three idle seconds and no later than thirty seconds after the first
unpublished edit. Transient failures retry at 30, 60, 120, 240, 480, then 900 seconds. Authorization
or read-only failures do not retry blindly. Every durable publish rechecks membership and role in
Convex.

Convex stores one encrypted checkpoint per project and at most one unabsorbed head per proved device.
Small ciphertexts are inline; larger ciphertexts use file storage. A file-backed payload must first be
registered to the authenticated project, account, and device. Cleanup accepts only such a reservation,
so an arbitrary Convex storage id cannot be deleted through a collaboration mutation.

Opening a project imports the checkpoint and every head, verifies their Ed25519 signatures and
XChaCha20-Poly1305 authentication, merges them, and republishes any local branch. Consequently, text,
layout, drawing, URLs, and media manifests recover even when their author is offline.

Compaction never snapshots the live document directly. It builds a temporary Loro document from the
selected checkpoint and selected server heads, then commits with compare-and-swap on the checkpoint
epoch and every consumed head revision. A head changed during compaction survives. Published,
unabsorbed heads are never deleted automatically. After thirty days, the owner sees the device, age,
and encrypted size and may discard one only through a second destructive confirmation. That decision
is written to the bounded project audit trail.

## Identity, authorization, and keys

The native service creates one persistent Ed25519 device identity. Its public key is also the iroh
EndpointId. A separate X25519 key receives project-key envelopes; Ed25519 material is never converted
into an exchange key. Private identity and project-key files are protected with Windows DPAPI for the
current account and are written with replace-existing, write-through atomic replacement.

Device registration is challenge based and single use. The device signs a versioned statement binding
the Convex account, challenge, device id, signing key, exchange key, and endpoint id. Convex verifies
the proof before the device may publish or receive an envelope. An account may register at most five
devices. Forgetting a device writes a durable server tombstone before deleting its active row, so the
same native identity cannot silently re-enrol itself with a still-live web session.

Roles are `owner`, `editor`, and `viewer`:

- owner: invite, change roles, remove members, rotate keys, delete the project, and edit;
- editor: edit and provision a newly registered authorized device for the current epoch;
- viewer: recover and render, but cannot publish or mutate shared state.

Viewer checks exist in controls, store mutators, native commands, P2P admission, and Convex
mutations. Possessing a project key is not authorization.

Project content uses a random 32-byte key per epoch. Heads, checkpoints, and direct P2P updates use
domain-separated XChaCha20-Poly1305 subkeys and random nonces; their authenticated clear header
carries project, device, sequence, checkpoint base, key epoch, purpose, and ciphertext hash. Project
keys are wrapped per device with HPKE X25519/HKDF-SHA256/ChaCha20-Poly1305, with protocol, project,
epoch, and the resolved recipient exchange key bound into the HPKE context.

Removing a member, downgrading a writer, or forgetting a device marks rotation pending and removes the
affected envelopes. During rotation, new publications are rejected. The owner writes envelopes for
all current proved devices at `currentEpoch + 1`; Convex advances the epoch only after every envelope
exists. Only a successfully committed checkpoint prunes obsolete key envelopes. A removed device
retains anything it legitimately decrypted before removal, but cannot obtain the new epoch or publish
a new head.

Device revocation is not account-session revocation. The tombstone blocks the forgotten native
identity used by NetsuRush; an attacker who also controls the account session and deliberately
creates a brand-new native identity is an account-compromise case and must be handled by revoking the
account session/credentials.

## P2P synchronization

iroh runs one persistent endpoint with versioned ALPNs for document and blob protocols. QUIC proves
the remote EndpointId. Connections start closed and are admitted through:

1. the global device allowlist derived from current shared projects;
2. the per-project roster;
3. the writer bit for inbound document updates;
4. a versioned Ed25519 signature binding author, project, and exact payload.

As soon as a refreshed active-project roster contains another device, the endpoint starts listening;
it does not wait for the local user to make the next edit. Rebuilding authority replaces the complete
per-project roster map, so closing the final lease removes that project's network authorization even
when the same peer remains connected for another project.

Frames and version vectors have hard size limits, exchanges time out after thirty seconds, and media
requests are bound to a hash currently referenced by the open project. An inbound P2P write refreshes
the online Convex roster at most once per project every thirty seconds; durable publication always
checks again. If Convex is unreachable, the service may use its locally signed cached roster. This
preserves local-first availability but delays a revocation until connectivity returns.

Direct connections are preferred and iroh's encrypted relay fallback is accepted. Relay operators can
observe connection metadata and ciphertext sizes, not document or media plaintext.

## Media

The CRDT stores a manifest, never an absolute path or object URL. A local asset manifest contains a
lowercase BLAKE3 hash, safe display name, MIME type, and byte length — and may carry the hash and
size of a small JPEG preview (2 MiB cap, refused without a hashed original). Remote links, embeds,
and YouTube items synchronize their URL/id metadata and are fetched independently.

Local bytes live in Rust's separate `collab/blobs` store. **Import is authorized by a random
256-bit, one-use, fifteen-minute grant created only by the native file picker
(`nr_pick_trusted_files`) or a trusted WebView2 OS drop** (`nr://file-paths` carries a grant beside
every path). The recovery path for an already saved document accepts only a canonical regular file
found in that document — as the surface's reader returns it — or in the application-owned reference
asset directory. Canonicalization occurs before confinement and rejects links. Images are capped at
2 GiB and videos at 256 GiB.

A surface with no reader in `blobs.rs#subject_data` grants nothing by name: its documents still share
their media through the two trusted origins above, so a missing reader costs a re-import, never a
wrong authorisation.

Transfers are requested on demand over the project-authorized iroh connection. One connection
carries the whole media: chunks are requested over successive streams on it, each bounded by its own
timeout. They resume from the partial length, use 4 MiB chunks with per-chunk BLAKE3 verification,
enforce the declared final size, then verify the full hash before atomic promotion. HTTP range
playback is served only through `http://collab.localhost/<project>/<hash>` after the active native
lease proves the project is open and its document references that hash. The protocol rejects
non-Tauri/non-development browser origins (`http://localhost:1420` in dev) and never emits wildcard
CORS.

The projection appears before media downloads, and it carries the set of content hashes whose bytes
are already in the local blob store: the renderer paints a placeholder for anything absent instead of
pointing an element at a blob URL that would 404. Previews resolve in a batch of their own (four at a
time) before any original. Originals resolve images first, then the rest by ascending size, two at a
time — one on machines with four cores or fewer.

Failed P2P attempts create at most one media-request notification per project/hash/hour from that
device; Convex coalesces at most 64 hashes into one requester/project row.

Availability has two honest states:

- **No holder online:** the manifest exists, but no authorized source is reachable now.
- **Archived media unavailable:** this device collected its retained copy and recovery elsewhere is
  only best effort.

Current references are pinned per local project. When the final pin disappears, a marker starts a
thirty-day grace period. Re-pinning removes the marker. Interrupted partials expire after 24 hours.
Leaving, deleting, or aborting a project drops its pin file so it cannot retain media forever.

## Convex data and free-plan controls

Convex can read account ids, public profiles, friendships, project ids, surface labels, roles, device
public keys, timestamps, epochs, ciphertext sizes, media hashes requested by a member, and traffic
patterns. It cannot read document plaintext, project keys, sender paths, or original media.

Collaboration uses these tables: `profiles`, `friends`, `friendRequests`, `userDevices`,
`revokedDevices`, `deviceRegistrationChallenges`, `projects`, `projectMembers`, `projectInvites`,
`projectKeyEnvelopes`, `projectCheckpoints`, `projectHeads`, `projectPayloadUploads`, `projectInbox`,
`projectMediaRequests`, `collectionEntries`, and the bounded `projectAuditEvents` security history.
For Collections, the server additionally sees opaque entry ids, contributor ids and removal flags;
it remains authoritative for global removal. This registry requires connectivity to load membership
and remove an item globally. Local hiding never writes to it.

Cost controls are structural:

- live document and original-media traffic bypass Convex;
- membership is capped at 15, devices at 5/account, and projects at 100/account;
- point-in-time recovery calls replace live document subscriptions;
- Account settings reads lightweight project summaries; member profiles and pending invitations are
  fetched only for the single project whose collaboration dialog is open;
- one current head per device and one checkpoint per project bound recovery rows;
- each device may hold at most three registered unfinished recovery uploads;
- one unread activity row per user/project is reused and is not rewritten for repeat edits by the
  same actor;
- missing-media notices are coalesced for an hour in native code and on the server;
- normal publication performs one roster query; the second occurs only after key rotation;
- P2P authorisation reads are cached for thirty seconds;
- queries use indexes and bounded `take` calls on user-controlled lists;
- audit writes occur only for rare member, device, rotation, and stale-head decisions and retain at
  most 200 rows/project;
- original images and videos never consume Convex file egress.

Encrypted recovery payloads and bug-report attachments, not media originals, are the expected egress
drivers. Exceeding Free limits can cause function errors, so SQLite/outbox durability is required and
the UI must never report backend recovery as complete before acknowledgement.

## People, invitations, activity and lifecycle

NetsuRush keeps its own friend graph because Discord OAuth identifies the account but does not expose
the Discord friend list. The authenticated Discord `/users/@me` response synchronizes the account's
stable numeric Discord id and current normalized Discord username into optional, exact profile
indexes; the renderer cannot claim either value. A request accepts that Discord id, that username, or
the existing NetsuRush handle. It performs bounded exact index reads, deduplicates one account found
through multiple keys, and fails closed when distinct accounts match.

Only people on that list may be invited. Invitations expire after seven days, reserve one of fifteen
seats, and grant editor or viewer — not owner.

Project creation is transactional at product level: Convex metadata is created, Rust opens the local
document, the surface seeds it, then the initial encrypted checkpoint is forced. The document becomes
collaborative only after that checkpoint and the owner envelope are recoverable. A failure before
this boundary calls the empty-project rollback (`createCollaborativeProject`).

Convex keeps one consolidated activity row per recipient/project. Repeat edits by the same actor do
not cause repeat inbox writes until the row is cleared; another actor is added to the same row. On the
next authenticated launch, the app shows a transient localized toast unless that project is already
open, and keeps the durable message in **Settings ▸ Account ▸ Sharing** until dismissed. Media
requests use the same row with distinct wording that asks a holder to open the document and remain
online.

Accepting an invitation marks the same row as key-provisioning-needed for existing writers. An
already-running app reacts to that single backend change by refreshing its native roster and wrapping
the current project key for every missing proved device; there is no project polling loop.

Accepting creates at most one local document per project — a re-invitation never mints a second
identical one. The account settings list names each project by its bound document, or by its creation
date when nothing binds it, and offers delete (owner) or leave (member) directly on the row.
Projects with no document on this machine are collapsed behind one count line.

Leaving closes the native project, removes local retention pins, deletes the caller's envelopes,
pending uploads, request and inbox rows, and forces rotation. Deleting a project is owner-only and
deletes every Convex row and referenced recovery storage object. The owner cannot leave; they must
delete. The current running device cannot revoke itself.

## Limits and residual risks

- The WebView renderer is trusted to display plaintext that the user can already see. A renderer
  compromise can read visible content and invoke other pre-existing desktop capabilities; raw
  collaboration keys still never enter JS.
- Previously authorized members may retain old plaintext, exported files, screenshots, and old key
  epochs. Cryptographic revocation cannot erase them.
- A signed cached roster preserves offline collaboration, so membership revocation is delayed during
  a Convex outage. Rotation and durable publishing remain blocked until the backend returns.
- Authorized writers are not treated as Byzantine adversaries. Signatures make corruption detectable,
  but a legitimate editor can intentionally create undesirable valid edits.
- Convex upload URLs are capabilities. Retained file payloads require ownership reservations, but a
  malicious authorized writer could still abandon a raw upload before registration; operational
  storage monitoring remains necessary.
- The pre-existing Tauri asset protocol still has broad scope for local media. Collaboration imports
  do not rely on that scope, but it remains a renderer-compromise impact outside this feature.
- There is no background Windows service. Closed applications do not transfer media; recovery and
  notifications resume at the next launch.
- Media deleted after all peers' grace periods may be gone everywhere.
- Shared cursors, background sync while the app is closed, Byzantine moderation, server-readable
  search and shallow history truncation are not provided.

## Verification and operations

`test/collaboration-contract.test.cjs` checks the shape of the stack: no prototype escape hatch in
the native command surface, the documentation and security pointers, the surface registry contract,
the board's ownership of its own publication, the `isCollabRef`/`isCoreFileRef` guards on every path
that would otherwise hand a shared media to the core, and collaboration copy present in all six
locales. The rest is `npm run build`, `npm run check:core`,
`npm run check:i18n` and `cargo check --locked`.

Before releasing this, perform a real two-machine Windows session with two distinct accounts:

1. restart both Tauri windows so the new Rust core is running;
2. create a project from an existing document and verify its initial checkpoint;
3. invite an editor and a viewer, then exercise concurrent edits;
4. disconnect each machine in turn and verify SQLite edits recover through Convex after reconnect;
5. close the media holder, verify `No holder online`, reopen it, and verify resumable transfer;
6. revoke a device and remove a member, verify rotation blocks publication until committed, then
   verify the old device cannot publish or reconnect;
7. inspect the Convex dashboard for one head/device, one inbox row/recipient/project, bounded media
   requests, no original media, and no orphaned retained upload reservations;
8. inspect Free-plan function, database I/O, file storage, and egress metrics after the session.
