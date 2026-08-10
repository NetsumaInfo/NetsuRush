# Community hub — tutorial discovery and sharing (phase 2)

> **Design document. Nothing is built.** Scope, constraints and open questions for the two
> server-backed surfaces planned after the local toolset is stable: **NetsuLearn** (tutorial
> discovery) and **NetsuHub** (script / preset / plugin exchange and forum).
>
> It records an **intent, not a spec**: the shape of both surfaces is meant to be refined with
> users and with Resolve creators themselves once the app has an audience. Read the sections
> below as a starting position to argue with, except where a line is marked frozen.
>
> Related: [`prd.md`](prd.md) §1.1 for where this sits in the product; `perso/communaute-et-monetisation.md`
> for the business model, licence and moderation policy — the decisions frozen there are
> inputs here, not to be re-litigated.

## 1. The problem

Premiere Pro and After Effects have a discovery layer built by fifteen years of SEO: type a
task, get a tutorial, a preset pack, a plugin. DaVinci Resolve does not, even though the
knowledge exists:

- **Tutorials exist but are unfindable.** The good ones are often on small channels with weak
  titles and no SEO. A newcomer searching "davinci resolve <task>" gets a wall of generic
  beginner content and misses the channel that actually answers the question.
- **Tools live in community pockets.** Scripts, Fusion macros, DCTLs, PowerGrades and OFX
  plugins are scattered across the Blackmagic forum, WeSuckLess, Reddit, private Discords and
  isolated repos. You find them only if you already know where to look.
- **Yet Resolve's real strength is authoring and sharing.** Making a macro, a PowerGrade or a
  DCTL is easy; *distributing* it is what has no home.

NetsuRush is already the window a Resolve user keeps open next to Resolve. That is the right
place to close the gap — not to host another website nobody visits.

## 2. Gate — when this starts

This phase costs money every month (server, bandwidth, storage) and time every week
(moderation). It is **not** started on enthusiasm. Preconditions, all of them:

1. Phase-1 modules are runtime-verified, not just green in CI.
2. A measured install base with returning users — a catalogue with no audience is a ghost town,
   and a ghost town is what kills the second attempt too.
3. A monthly infrastructure budget cap fixed in advance (see §6.4).
4. Legal entity in place if anything is ever paid (prerequisite tracked in the monetisation doc).

Cheapest first slice, if the full block stalls: the **idea board and the request forum** — no
file storage, no payment, no supply-chain risk, and they create the audience the catalogue
needs.

## 3. NetsuLearn — tutorial discovery

### 3.1 What the page is

Not a search box on an empty page. A landing surface that has something to show before the user
types anything:

- **Popular by theme** — Fusion, colour grading, Fairlight, editing, delivery, scripting,
  workflow/hardware. Popularity is computed over a rolling window, not all-time, so 2019
  content stops dominating.
- **New releases** — recent uploads from tracked channels, so a creator publishing today gets
  visibility on day one instead of after months of SEO.
- **Rising / small channels** — a slot reserved for low-subscriber channels with high
  engagement. This is the whole point: the discovery gap is a *small channel* problem, and a
  pure popularity ranking would recreate it.
- **By Resolve version** — a tutorial for the Fusion page in 17 can be actively misleading in
  20. Version is a first-class filter, not a tag in the description.

### 3.2 Search

The query is a task, not a keyword: *"track a mask in Fusion"*, *"match two cameras"*,
*"remove a hum on a voice track"*. Facets: page (Media / Cut / Edit / Fusion / Color / Fairlight
/ Deliver), Resolve version, level, language, duration, free vs Studio-only feature.

Retrieval runs over indexed **metadata plus transcript** (YouTube captions when available), so
a technique demonstrated mid-video is reachable even when the title never mentions it. That
also gives **deep links with a timestamp** — the answer, not the 22-minute video.

The project already runs a text/vision embedding stack for `NetsuSearch`; the same idea applies
here, but the index lives **server-side** — the client never downloads the corpus.

**Smallest shippable version:** the search bar alone. A good advanced search over an indexed
corpus of Resolve tutorials already solves the stated problem; the editorial feed of §3.1 is the
part that makes it a place people come back to. If the editorial surface proves too costly to
curate, shipping only the search is a valid endpoint, not a failure.

### 3.3 Channel directory

A curated list of Resolve channels with a **specialty** (colour, Fusion/VFX, audio, workflow,
scripting, anime/AMV, broadcast), language, activity level, and whether they cover Studio-only
features. Community-submitted, human-approved. This is the piece that is genuinely hard to get
elsewhere and cheap to maintain.

### 3.4 Watching, and what the creator gets

Videos play **in the official YouTube embed**, inside the app. That is the whole trick, and it
makes the alignment easy rather than tense:

- The **view counts for the creator**, with the ads and the monetisation that come with it. An
  embedded watch is a normal watch.
- The channel is **visible and clickable** — name, avatar, subscriber count, specialty. The user
  discovers the creator, not an anonymous clip, and can subscribe or dig through their catalogue
  from there.
- **"Open in YouTube"** is always one click away, for comments, the full channel, or a bigger
  window.

So the interest runs both ways: creators generally *want* to be surfaced to an audience of
Resolve users. That opens follow-ups worth exploring with them — featured slots, a creator
submitting their own videos, sponsored placement (see §7).

The consequence, and it is the only hard line here: **the app never re-hosts or re-encodes the
video.** The yt-dlp relay used by the reference board (`/ytstream`, see
[`modules.md`](modules.md)) is a local mood-board convenience and stays there — routing a public
tutorial feed through it would strip the view from the creator, which is exactly backwards.
Transcripts are indexed for search and excerpted only as a short snippet with a timestamped
link, never republished whole.

Creators can **claim their channel**, correct its specialty and tags, and opt out entirely.

### 3.5 Data pipeline and quota

Ingestion is a **server-side job**, never a client call:

- **The API key lives on the server, never in the client.** With the codebase public, a key
  shipped in the app is a key given away. Convex already holds the project's server-side
  secrets for the auth gate; the same pattern applies here — the app calls Convex, Convex (or a
  job on the VPS) calls YouTube.
- YouTube Data API v3 has a hard daily quota (10 000 units/day by default) and `search.list`
  costs 100 units per call, so a per-keystroke client search would also exhaust the quota in
  minutes even if the key were safe.
- The server crawls tracked channels' uploads playlists (cheap: `playlistItems.list` = 1 unit),
  refreshes statistics in batches, and stores the result. The client only ever queries the
  project's own API, and search runs against that stored index — not against YouTube live.
- Cold-start seed: manual list of known Resolve channels. Growth: community submissions +
  "channels also watched by users who searched X" once there is traffic.

**Risk to accept up front:** the whole surface depends on one third-party API and its terms.
Quota increases require a review by Google, and terms change. The mitigation is that the index
is cached server-side and degrades to a static list, not that the dependency disappears.

## 4. NetsuHub — community exchange

### 4.1 Objects, by risk tier

The taxonomy from the monetisation doc, extended with what Resolve actually ships around, and
ordered by **what happens on the user's machine**. This ordering, not the file extension, drives
the UI and the moderation effort.

| Tier | Objects | What installing means | Handling |
|---|---|---|---|
| **Inert data** | LUTs (`.cube`), PowerGrade stills (`.drx`), Fusion `.setting` node trees without expressions, still/board assets | A file is copied into a folder; Resolve parses it as data | App may place the file after an explicit confirmation |
| **Executable-adjacent** | Fusion macros and templates containing Lua expressions, DCTLs (compiled and run on the GPU by Resolve) | Resolve compiles/evaluates author-written code inside its own process | Placed only with an explicit, worded warning; source shown before install |
| **Executable** | Python/Lua scripts for Resolve's and Fusion's scripting API | Full user-level code execution, disk and network access — *when the user runs it from Resolve's menu* | Installed by the app **only from certified authors**, under the conditions of §4.1.1. Never executed by the app |
| **Vendor-installed** | OFX plugins | Vendor installer, registry, DLLs | Out of scope — link to the author's installer |
| **No artefact** | Ideas / feature requests, tutorial requests, help threads | Nothing | Free of all the above |

#### 4.1.1 Scripts — installed, never executed

Scripts are a first-class part of what makes Resolve and Fusion worth sharing, and asking every
user to copy-paste code into a text editor is friction that kills the feature. So the app does
place script files in the right folder.

**The line that stays frozen is a different one: NetsuRush never *executes* community code.**
Installing a script writes a file into Resolve's `Scripts` folder; nothing runs until the user
picks it from Resolve's own menu. No auto-run on install, no run-on-startup hook, no silent
background update.

Conditions, all required, because a placed script is a real supply-chain surface:

- **Certified authors only.** Only accounts vetted and co-opted by the project can publish
  installable scripts. Everyone else can still post code as text in the forum — that path stays
  copy-paste.
- **Reviewed version, pinned by hash.** What was reviewed is what ships: the server stores a
  hash of the exact reviewed file, the client verifies it after download, and a new version goes
  through review again. An author's account being compromised must not silently push new code to
  every installed user.
- **No silent updates.** An update is a user action, showing what changed.
- **Source is readable before and after install**, in the app, with author, licence and version.
- **Install is a confirmed action with a plain warning**, worded for what it is: third-party code
  that will run with your user's rights when you launch it.
- **An install manifest** records every file placed, so uninstall is exact and complete.
- **Revocation.** A certified author can be delisted and a specific version flagged; the app
  warns on a flagged installed script.

Everything above the line stays as it is: macros with Lua expressions and DCTLs get the same
warning-plus-visible-source treatment, inert data installs quietly, OFX stays out.

### 4.2 Install assistance

What the app does for inert data, macros/DCTL and certified scripts: know where the file goes,
check that Resolve is closed or that a restart is needed, copy it, and offer a clean uninstall
(the app owns a manifest of what it placed, so removal is exact).

Target locations on Windows — **to verify against a real install before coding**, and to detect
at runtime rather than hard-code:

| Object | Location |
|---|---|
| Fusion macros | `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Macros` |
| Edit-page templates (titles, transitions, effects, generators) | `…\Support\Fusion\Templates\Edit\<category>` |
| Scripts (Comp / Edit / Utility) | `…\Support\Fusion\Scripts\<scope>` — written by the app only for certified-author scripts (§4.1.1) |
| LUTs and DCTLs | `%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\LUT` |
| PowerGrades (`.drx`) | Not a file drop — imported through the Gallery; the app can only hand the file over and explain the step |
| OFX plugins | Vendor installer, out of scope |

Cross-checks the installer flow owes the user: Resolve version compatibility, free vs Studio,
required ResolveFX, and a declared dependency list.

### 4.3 Forum and requests

Three thread types, because they have different lifecycles:

- **Request a tutorial** — "nobody has covered X". Visible to creators as a demand signal; this
  is the loop that gets new tutorials made, and it is the most original part of the whole idea.
- **Request a preset / macro / script** — someone in the community builds it, and it lands in
  the catalogue.
- **Help** — plain Q&A, searchable, public (SEO and archive value; Discord has neither).

Requests carry votes so demand is measurable, and can be **fulfilled**: a thread links to the
tutorial or catalogue entry that answers it and closes.

### 4.4 Trust and moderation

Two levels, as already decided: **trusted authors** (known Resolve creators, co-opted) publish
directly; **everyone else** goes through review. Additional levers, since review time is the
scarce resource:

- Review effort follows the risk tier of §4.1 — a `.cube` is not read line by line, a DCTL is.
- Automated pre-checks before human review: file type vs declared type, size, archive contents,
  Lua/DCTL source presence, licence field filled.
- Reports, takedown path, and author identity tied to the existing Discord account.

**Open and unquantified:** sustainable review volume and announced turnaround for a solo
maintainer. This is the single most likely cause of failure for this phase.

## 5. Client integration

- Two new tabs alongside the existing modules, following the app's own UI system — shadcn/ui in
  its Base UI flavour, project `Tooltip`, no native `title=`, and no JS-driven animation over
  grids (see [`architecture.md`](architecture.md) and [`invariants.md`](invariants.md)).
- All copy goes through the six locales; `fr` is the source language.
- **Both tabs degrade to a clear offline state.** They are the first parts of the app that stop
  working without network, and phase-1 modules must keep working when they do.
- The catalogue is browsable from the website too; downloads deep-link back into the app via
  `netsurush://` (already implemented for OAuth).
- Every new RPC is wired in the three usual places: `core/rpc.js`, `NrApi` + `coreClient.ts`,
  and the `mock` in `bridge.ts`.

## 6. Backend

### 6.1 Split of responsibilities

Convex already backs the beta auth gate (Better Auth + Discord). It keeps identity, and small
mutable state (votes, threads, catalogue metadata). The **VPS** takes what Convex is a poor or
expensive fit for:

- YouTube crawling and scheduled ingestion jobs;
- the search index and embedding computation;
- static file serving for catalogue artefacts, behind a cache/CDN;
- scanning of uploads.

One account, one identity provider, two clients (app and website). No second login.

### 6.2 What the server must never become

A dependency of phase 1. If the community server is down, derush, search, processing and
transfer keep working — that separation is an architectural rule, not a deployment detail.

### 6.3 Abuse surface

Public write endpoints are new territory for this project: rate limiting, upload size caps,
malware scanning, and moderation queues are day-one requirements, not hardening passes.

### 6.4 Cost drivers

Bandwidth on downloads, storage of versioned artefacts, index compute, and Convex usage. All
four grow with success, and only donations/subscription grow with them. A monthly cap with a
degradation plan (throttle downloads before losing the service) is fixed **before** launch.

## 7. Open questions

| # | Question | Status |
|---|---|---|
| 1 | Popularity window and ranking formula, incl. the small-channel slot | Open — determines whether the feed reproduces the problem it is fixing |
| 2 | YouTube quota tier to request, and where the crawl job runs (Convex scheduled function vs VPS worker) | Open — the key stays server-side either way |
| 2b | Featured slots and sponsored placement for creators — worth exploring *with* them, once there is an audience | Open — revenue and discovery upside; needs a clear "sponsored" label |
| 3 | Own forum vs hosted Discourse vs Discord only | Open — a real forum's value is SEO + public archive |
| 4 | Sustainable moderation volume and announced turnaround | ⚠️ Open — main failure mode |
| 5 | Co-opting mechanism for trusted authors | Open |
| 6 | Monthly infrastructure budget cap and degradation plan | Open — gate on starting the phase |
| 7 | Mandatory licence field on every uploaded artefact (upload ToS) | Open — needed before the first upload, not after |
| 8 | Certification process for script authors: who qualifies, how a version is reviewed, how fast | ⚠️ Open — the trust anchor of the whole installable-script feature |
| 8b | Signing: server-signed manifest vs hash pinning alone | Open — hash pinning is the minimum |
| 9 | Creator opt-in vs opt-out for channel listing — listing is expected to be wanted, so opt-out with a claim flow is the working assumption | Open |
| — | NetsuRush never *executes* community code — installing a certified script places a file; Resolve runs it only when the user asks | **Frozen** |
| — | Playback through the official YouTube embed; no re-hosting, no re-encoding | **Frozen** |
| — | The community server is never a dependency of phase-1 modules | **Frozen** |
