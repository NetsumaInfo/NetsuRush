# NetsuRush community platform — product and technical specification

> **Approved design; implementation has not started.** This document defines the staged launch of
> the NetsuRush community website and its later desktop integration: **NetsuLearn** for curated
> DaVinci Resolve tutorial discovery and **NetsuHub** for the forum and resource catalogue.
>
> Related: [`prd.md`](prd.md) for the wider product and [`distribution.md`](distribution.md) for
> the existing account boundary. The sibling `NetsuRush Site web` project is the website client.

## 1. Mission

DaVinci Resolve does not mainly have a lack-of-content problem. It has a discovery problem:

- useful tutorials exist on small channels but disappear in broad YouTube results;
- scripts, Fusion macros, DCTLs, PowerGrades and presets are split across the Blackmagic forum,
  We Suck Less, Reactor, Reddit, Discord servers and isolated repositories;
- publishing a small Resolve resource is disproportionately difficult for a new creator;
- Discord is immediate but not a durable, public or search-friendly knowledge archive;
- existing repositories are valuable but assume that the user already knows where and how to look.

NetsuRush should be the accessible front door to that ecosystem: surface creators, make questions
and resources easy to publish, keep answers public, and connect discovery to assisted installation.
It must not claim ownership over the Resolve community or silently copy its work.

The long-term outcome is fewer reasons for a new editor to believe that Resolve has no tutorial,
preset, plugin or community for the task they need.

## 2. Product principles

1. **Public reading, authenticated participation.** Anyone can browse and search. An account is
   required to post, comment, vote, bookmark or upload. Illegal-content reporting remains accessible
   without an account, with abuse controls.
2. **One account across website and app.** Better Auth and Convex remain the shared identity and
   data boundary. Discord and Google are launch sign-in methods and can be linked to one account.
3. **Useful participation stays free.** Reading, asking, answering, sharing links and submitting
   ordinary free resources are not subscription features.
4. **Creators remain visible.** Tutorials use the official YouTube embed and always link to the
   creator. NetsuRush never re-hosts or downloads public tutorial videos.
5. **Local tools remain independent.** A community outage never disables NetsuCut, NetsuSearch,
   NetsuLab or another local module.
6. **NetsuRush never executes community code.** Installation can place a reviewed file in a Resolve
   folder, but execution remains an explicit action inside Resolve.
7. **Money does not buy trust.** A subscription never grants trusted-author status, faster review of
   dangerous code, moderation immunity or higher organic ranking.
8. **No hidden paid discovery.** Sponsorships and promoted placements are visibly labelled.
9. **A focused social network.** Profiles, follows and feeds connect people around Resolve topics;
   NetsuRush does not optimise for generic viral attention or infinite passive consumption.
10. **Start narrow, then earn complexity.** Native video, paid third-party sales and hosted binary
   applications are later phases, not launch requirements.

## 3. Existing foundation

The website already has TanStack Start, the shared Convex client, Better Auth with Discord, public
marketing pages, a beta download flow, an ideas board, and a `/presets` route that marks the
community catalogue as future work. This is a foundation to extend, not a new product to scaffold.

The community website can start before every desktop module is runtime-verified if it remains
operationally separate and describes the application honestly. Assisted installation stays gated on
live verification and the security conditions in this document.

## 4. NetsuLearn — curated tutorial discovery

### 4.1 Product

NetsuLearn is a better-organised search over a deliberately curated set of Resolve channels. Its
advantage comes from selection and editorial structure, not from replacing YouTube.

The landing surface contains:

- recent uploads from tracked channels;
- collections by Resolve page or workflow;
- a rotating area for small or specialised channels;
- tutorials grouped by language, level and Resolve version;
- outstanding tutorial requests from NetsuHub, visible to creators.

Before sign-in, the home page shows a useful editorial mix. A member can then select the subjects
they care about—for example Fusion, Color, Fairlight, editing, motion design, anime/AMV, scripting or
audio—and follow individual channels. Their home page combines recent tutorials, discussions,
resources and requests from those explicit choices. Every selected subject can be viewed, added or
removed from the feed settings; personalisation is not inferred secretly from browsing behaviour.

Small-channel discovery is an editorial rotation, not a secret engagement score. Project-authored
annotations are visibly distinct from YouTube fields.

### 4.2 Search

The first version indexes only:

- video title and description;
- channel name and identifier;
- public tags when returned by YouTube;
- duration, publication date and embeddability;
- creator-provided or editorial annotations: Resolve page, task, language, level, Resolve version
  and Free-versus-Studio compatibility.

Captions and transcripts are explicitly out of scope. The official captions download endpoint
requires permission to edit the video, and transcripts are unnecessary for the intended experience.

Search weights exact title matches above descriptions, then channel names and annotations. Filters
cover Media, Cut, Edit, Fusion, Color, Fairlight and Deliver, plus language, level, version, duration
and Free/Studio. A small maintained synonym dictionary can bridge terms such as `mask`/`masque`;
embeddings are not a launch dependency.

Every query hits the NetsuRush index in Convex or the VPS, never YouTube directly. Privacy-conscious
zero-result statistics guide channel curation and tutorial requests.

### 4.3 Directory, claims and playback

Each channel page exposes name, avatar, banner, languages, specialties, recent tutorials, linked
resources/posts, follower count and a YouTube link. Members can follow it without subscribing on
YouTube; the UI keeps the two actions distinct.

There are three separate channel workflows:

1. **Community suggestion:** any member proposes a missing channel for the searchable directory.
2. **Creator listing request:** the owner asks to add and claim their channel, proves ownership, and
   supplies languages, subjects and representative videos.
3. **Sponsored spotlight request:** a listed/claimed channel asks for a time-limited paid showcase.
   Sponsorship never becomes a requirement for ordinary listing or organic search inclusion.

All requests enter a visible moderation state. A claimed creator can correct NetsuRush annotations,
submit videos, respond to tutorial requests, publish channel updates and opt out.

Playback is user-initiated in the official YouTube player. NetsuRush does not obscure player controls,
manufacture autoplay views or promise that every play will count. `Open in YouTube` and `View channel`
remain one click away. Non-embeddable videos fall back to YouTube. The local `/ytstream` NetsuBoard
convenience is never used for the public tutorial feed.

### 4.4 Ingestion and quota

The API key stays server-side. At the 2026-08-30 research snapshot, `search.list` has a default
granular bucket of 100 calls per day, while projects generally receive 10,000 daily units for other
endpoints. `channels.list`, `playlistItems.list` and `videos.list` cost one unit per call. Re-check
these values immediately before implementation.

Ingestion flow:

1. a moderator approves a channel identifier;
2. `channels.list` resolves its uploads playlist;
3. an initial import reads the playlist and batches video metadata;
4. YouTube WebSub notifications announce new or updated uploads;
5. scheduled reconciliation catches missed notifications and removals;
6. YouTube API data is refreshed or deleted within the current policy window of 30 days.

Search exposes an explicit stale state during an outage rather than presenting old metrics as current.

References: [quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost),
[push notifications](https://developers.google.com/youtube/v3/guides/push_notifications),
[caption permissions](https://developers.google.com/youtube/v3/docs/captions/download), and
[developer policies](https://developers.google.com/youtube/terms/developer-policies).

## 5. NetsuHub forum

### 5.1 Focused native forum

The forum is built in the existing TanStack/Convex website instead of a separate Discourse instance
or a Discord-only community. This preserves one identity, one search, direct request-to-resource
links and consistent design. Version one is focused Q&A and sharing, not a clone of every mature
forum feature.

Discord can remain a realtime social space. Durable answers belong on the public forum so they are
linkable, indexed and still useful months later.

### 5.2 Post types and navigation

| Type | Purpose | Completion |
|---|---|---|
| Help / question | Resolve workflow or troubleshooting | An answer can be accepted; thread becomes solved |
| Tutorial request | A subject the community cannot find | Fulfilled by a NetsuLearn entry |
| Resource request | A missing preset, macro, script or plugin | Fulfilled by a catalogue entry |
| Share / showcase | Technique, breakdown, image or YouTube link | Open discussion |
| Resource discussion | Support and feedback for one catalogue version | Linked to the resource |
| Announcement | Project, creator or moderation news | Restricted roles |

Navigation exposes recent, unanswered, solved, followed and category-filtered views. Public SSR URLs
and titles are stable for search engines.

### 5.3 Low-friction publishing

Visitors see real posts immediately; the homepage is not a login wall. The composer is a simple
rich-text experience and supports formatted text, code, pasted images, YouTube URL previews, Resolve
version, operating system, Free/Studio fields and an autosaved local draft.

Authentication appears only when publishing or interacting. The draft and intended action survive
the Google or Discord OAuth round trip. Comments reuse a smaller composer. One reply level plus
mentions avoids unreadable infinite nesting.

### 5.4 Media policy

At launch:

- images are metadata-stripped, decoded and re-encoded to a safe format;
- YouTube links use the official embed;
- ordinary links get a safe preview without executing third-party page content;
- native video and audio uploads are disabled;
- arbitrary ZIP and executable attachments are disabled in forum posts;
- resource files use the catalogue submission flow and the post links to that record.

Operational defaults are six images per post, 5 MB per input image and 1,920 pixels on the longest
stored edge. Server configuration owns these limits.

Native video is a later managed-media feature, not a raw R2 download. If demand and recurring revenue
justify it, use a transcoding service such as Cloudflare Stream. Its current published price starts
at USD 5 per 1,000 stored minutes plus USD 1 per 1,000 delivered minutes. Enabling it requires
per-user duration quotas, copyright reporting, moderation, deletion and cost alerts.

### 5.5 Identity and reputation

Better Auth supports Google and Discord plus account linking. NetsuRush requests only minimal sign-in
scopes; it does not read a member's Discord servers, Google Drive or YouTube account.

Public roles are member, verified creator, trusted resource author, moderator and administrator.
Helpful and accepted answers can appear on profiles, but no opaque global score decides who may
speak. New-account rate limits handle abuse without making legitimate beginners prove themselves.

Public profiles provide avatar, banner, biography, languages, Resolve specialties, verified links,
YouTube channel when applicable, posts, accepted answers, published resources and curated public
collections. Members control which optional fields are visible. Profiles have stable public URLs and
can be followed.

### 5.6 Social graph and community home

Members can follow people, claimed YouTube channels and subject tags. Following is deliberately
simple: no friend approval model, private messaging or automatic contact import in the first release.

The signed-in home feed can contain:

- new videos from followed channels and selected subjects;
- posts and accepted answers from followed creators;
- newly approved resources in followed categories;
- open tutorial/resource requests matching selected subjects;
- clearly labelled editorial and sponsored spotlights.

Ranking starts with recency, explicit follows, selected subjects and small editorial rotations. It
does not use an opaque engagement-maximising algorithm. Users can switch to a purely chronological
view, inspect why an item appears, mute a subject/creator and reset their choices. The feed is finite
and paginated rather than an endless autoplay surface.

Notifications cover direct replies, mentions, accepted answers, followed-resource releases and
moderation decisions. Bulk creator/channel activity is summarised to avoid notification spam.

## 6. Low-friction resource catalogue

### 6.1 Drag-and-drop submission

The key product difference is that publishing starts with one action: drag a file or folder into the
website or desktop app. NetsuRush then:

1. inspects the dropped item locally and identifies the likely Resolve resource type from extension
   and content;
2. extracts safe metadata and shows the detected destination;
3. asks only for missing title, description, licence, compatibility and preview information;
4. explains whether the file is data, code-adjacent, executable source or a binary application;
5. uploads supported source/data resources to quarantine and shows a visible validation state;
6. creates a support/discussion page when the resource is approved.

Dropping a binary application still saves work: NetsuRush extracts safe local metadata and prepares
the catalogue form, but it does not upload the binary in the initial phases. The verified publisher
supplies its official download page instead.

The user should not need to research repository formats, package manifests or installation paths
before sharing a `.setting`, LUT, DCTL or script. Advanced authors may edit the generated metadata.

Folders are packaged only after inspection. Archive creation rejects secrets, caches, project files
and unrelated content before upload. The final confirmation lists every included file.

### 6.2 Risk tiers

| Tier | Objects | Launch handling |
|---|---|---|
| Inert data | LUTs, `.drx`, expression-free `.setting`, stills | Automated checks plus lightweight moderation |
| Executable-adjacent | Fusion macros/templates with expressions, DCTLs | Source visible, warning and human review |
| Executable source | Python/Lua Resolve or Fusion scripts | Reviewed per version; installable only from trusted authors |
| Vendor binary | OFX, applications, DLLs, installers | Metadata page and verified external author link initially |
| No artefact | Questions, ideas and requests | Forum workflow only |

Binary applications are not hosted initially. Later hosting requires verified publishers, signature
checks, malware analysis, a dedicated review process and explicit size/cost limits.

### 6.3 Validation lanes

Fast review comes from demonstrated trust, never payment:

- **new author:** automated checks followed by normal moderation;
- **verified author:** verified identity/ownership and a priority queue;
- **trusted author:** a clean publishing history; inert resources can publish after automated checks
  with human spot checks;
- **executable or binary content:** human security review every version, regardless of author or
  subscription.

The target for an ordinary low-risk resource is a decision within 24 hours when moderator capacity
allows it. Verified/trusted authors should receive a result substantially faster. The UI shows queue
position category, last review activity and any requested correction instead of an unexplained wait.

### 6.4 Submission and installation contract

Every resource declares author, source, exact licence, redistribution permission, Resolve versions,
operating systems, Free/Studio requirements, dependencies, semantic version, changelog and support
discussion. Missing redistribution permission blocks hosting; NetsuRush may link to the original page.

Approved versions are immutable and addressed by SHA-256. A new upload creates a new review. The
desktop app verifies the digest, records an exact install manifest and never silently updates or
executes community code. Revoked versions remain identifiable and trigger warnings.

Initial upload limit is 25 MB per version. Larger resources need moderator approval or external
hosting. Limits are server-configured.

### 6.5 Relationship with Reactor and existing communities

[Reactor](https://gitlab.com/WeSuckLess/Reactor) is the open-source package manager created by the We
Suck Less community for Fusion and Resolve. It proves the value of central package discovery, while
its repository/forum packaging workflow illustrates the accessibility gap NetsuRush targets.

NetsuRush links to original Reactor, We Suck Less, Blackmagic forum and creator pages, invites
authors to claim entries, and avoids bulk copying posts or packages. Any future bridge requires
explicit cooperation and licence-compatible metadata, not scraping.

## 7. Architecture and storage

| Component | Responsibilities |
|---|---|
| Website | SSR pages, forum/catalogue/search UI and OAuth entry points |
| Desktop app | Browse community surfaces, drag-and-drop submission, assisted installs, digest checks |
| Convex | Users, linked identities, roles, posts, comments, votes, reports, metadata and entitlements |
| VPS worker | YouTube ingestion, heavier search jobs, file validation, malware scans and maintenance |
| Cloudflare R2 | Quarantined uploads, approved immutable resources and processed images |
| YouTube | Tutorial hosting, playback and source metadata |
| Stripe | Later support subscriptions and marketplace payments |

No API secret is shipped in a renderer or desktop client.

### 7.1 R2 decision

Cloudflare R2 Standard is selected. Its current published allowance includes 10 GB-month, one million
Class A operations and ten million Class B operations monthly, with no direct Internet egress fee.
Beyond that, Standard storage is USD 0.015 per GB-month.

R2 is not always the lowest raw storage price. It fits NetsuRush because the objects are small, the
free allowance covers a large early catalogue, a popular download is less likely to create a traffic
bill, and S3 compatibility preserves migration. Convex remains the authority for ownership,
moderation, licences and visibility; R2 stores bytes only.

### 7.2 Trust zones and upload pipeline

Use a private quarantine bucket and a public approved bucket behind a project domain. Final object
keys contain resource ID, version and digest and are chosen server-side.

1. authenticated client receives a short-lived, single-purpose upload URL;
2. server checks role, quota, declared type and expected size;
3. client uploads directly to quarantine;
4. worker checks actual size, file signature, archive paths and content;
5. images are safely decoded, stripped and re-encoded;
6. archives reject encryption, traversal, links and unexpected executable content;
7. malware and type-specific static checks run;
8. human review follows the risk lane;
9. approved bytes move to an immutable key and their digest is recorded;
10. rejected or abandoned quarantine objects expire automatically.

Ten thousand 100 KB presets occupy about 1 GB; ten thousand processed 500 KB screenshots occupy
about 5 GB. This representative catalogue remains within the current free allowance.

Provider-neutral object keys are stored in Convex. Migration copies immutable objects, verifies
digests, changes the delivery origin and retains the old provider through a rollback window.

References: [R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Backblaze B2](https://www.backblaze.com/cloud-storage/pricing),
[Bunny Storage](https://bunny.net/pricing/storage/), and
[Cloudflare Stream](https://developers.cloudflare.com/stream/pricing/).

## 8. Business model

The platform should fund infrastructure, moderation and continued development without making the
community feel rented.

### 8.1 Revenue order

1. voluntary one-time support and relevant founding sponsors;
2. a small NetsuRush Supporter membership after legal/accounting readiness;
3. clearly marked creator or product sponsorships;
4. a paid marketplace only after free catalogue trust and seller compliance exist;
5. a native-video allowance only if recurring revenue covers managed delivery and moderation.

### 8.2 Supporter pricing and benefits

The exact subscription price is not frozen. EUR 2 is highly accessible but fixed payment fees take a
large percentage. EUR 5 leaves more useful funding while participation remains free. Validate a
simple offer with early users; a practical launch hypothesis is EUR 5 monthly plus a discounted
annual option, while one-time contributions can start lower.

Supporter benefits may include an optional badge, more saved collections, larger non-essential
image/profile limits, experimental feature access, project updates and a future managed-media quota.
They never include basic posting, free downloads, organic ranking, trusted-author status or bypassing
security review.

At current French public Stripe pricing, a standard EEA card costs 1.5% plus EUR 0.25 and Stripe
Billing adds 0.7% of Billing volume. VAT, refunds, disputes and taxes are additional. Re-check legal
residence and pricing before publishing net-revenue claims.

### 8.3 Sponsorships

Good candidates include Resolve educators, hardware vendors and relevant plugin developers. A sponsor
may fund a collection, newsletter section, event or visibly promoted placement. Every sponsorship
states who paid, its duration and what was promised. Sponsors cannot suppress criticism, buy trusted
status or alter organic results secretly.

A claimed YouTube channel can request a sponsored spotlight page or campaign containing its own
presentation, specialties, selected videos, posting schedule and direct subscription link. NetsuRush
reviews it for relevance and disclosure before publication. Sponsored channel cards carry a visible
label in every placement, have start/end dates, and are excluded from organic ranking calculations.
An unpaid editorial spotlight remains possible for genuinely useful small channels and is labelled
as editorial rather than sponsored.

Prepare a sponsor page only after measuring a real audience: active users, tutorial clicks,
languages, countries and community participation. Do not sell unmeasured impressions.

### 8.4 Paid marketplace gate

The free catalogue comes first. Selling third-party resources introduces seller identity, VAT,
consumer rights, refunds, disputes and platform reporting. Stripe Connect is likely, but does not
decide who is legally responsible for tax.

Before the first sale: create a legal entity; obtain jurisdiction-specific advice; implement seller
onboarding, buyer/seller terms, licence warranties, IP complaints, VAT responsibility, refunds,
chargebacks and DAC7 analysis. A 10–15% platform commission is a planning range only; interview
creators and model full costs before freezing it.

References: [Stripe Billing](https://stripe.com/fr/billing/pricing),
[Connect tax guidance](https://docs.stripe.com/tax/connect), and
[platform reporting](https://docs.stripe.com/connect/platform-tax-reporting).

## 9. Moderation and legal readiness

Moderation time is scarcer than storage. Day-one controls include rate limits, provider email
verification where reliable, report/block/mute, audit trails, spam and link checks, progressive
new-account limits, separate risk queues, plain removal reasons, appeals and resource revocation.

Before public writes, publish Terms of Service, Privacy Policy, Community Guidelines, a copyright and
trademark complaint process, resource licence rules and a notice-and-action contact. The EU Digital
Services Act includes duties for hosting/online platforms such as accessible reporting and reasons
for restrictions; exact obligations require jurisdiction-specific review.

Do not collect OAuth scopes or personal data merely because they might help later. YouTube embeds,
analytics, authentication cookies and payment providers must appear accurately in privacy/consent
disclosures.

References: [Better Auth social sign-on](https://better-auth.com/docs/basic-usage),
[account linking](https://better-auth.com/docs/concepts/users-accounts), the EU
[DSA overview](https://digital-strategy.ec.europa.eu/en/policies/digital-services-act), and
[notice-and-action guidance](https://digital-strategy.ec.europa.eu/en/policies/dsa-notice-and-action-mechanism).

## 10. Delivery sequence

### Stage 0 — present foundation

- marketing site, beta download, shared Convex/Discord auth, ideas board and catalogue placeholder.

### Stage 1 — public forum

- Google plus Discord sign-in and account linking;
- public SSR post lists/details;
- posts, comments, votes, accepted answers, reports and moderation basics;
- public member/creator profiles, subject selection and simple follows;
- processed images and YouTube embeds; no native video or arbitrary attachments;
- community and legal documents.

### Stage 2 — NetsuLearn

- manually seeded channel directory;
- server-side metadata ingestion and compliant refresh;
- title/description/channel/tag search and filters;
- recent uploads, tutorial requests, channel suggestions and claims;
- community-suggestion and creator-listing request workflows;
- mixed community home built from explicit subjects and follows.

### Stage 3 — free catalogue

- drag-and-drop detection and prefilled submission;
- R2 quarantine/approved zones;
- inert resources, licences, immutable versions and support discussions;
- manual download first, then live-verified assisted installation.

### Stage 4 — sustainability

- Supporter membership, sponsor page, sponsored-channel request and spotlight workflows, richer
  collections, cost and moderation analytics.

### Stage 5 — higher risk

- trusted executable authors, seller research, Stripe Connect/marketplace compliance;
- hosted binaries and native video only after demand, safety and unit economics are proven.

Each stage is useful alone. Revenue features never block the public forum, tutorial directory or free
catalogue from delivering the mission.

## 11. Success measures

- weekly public readers and authenticated contributors;
- searches leading to tutorial clicks and zero-result rate;
- independent channels receiving outbound visits;
- selected-subject retention, meaningful follows and chronological-feed usage;
- community/creator channel requests approved and claimed;
- median time to first useful answer and solved-question rate;
- requests fulfilled by tutorials or resources;
- submission-to-approval conversion and moderation queue age by risk lane;
- repeat downloaders, support activity, reports and appeals;
- cost per active contributor and per thousand downloads;
- supporter revenue coverage of community operating cost.

Analytics are aggregate and privacy-conscious. Search logs do not become profiles of what an
individual editor is learning.

## 12. Decisions still required

| Decision | Required by | Working position |
|---|---|---|
| Forum category/tag vocabulary | Stage 1 | Start with §5.2 and a small Resolve-page taxonomy |
| Minimum age and jurisdiction-specific terms | Public writes | Legal review before launch |
| Moderator capacity and response target | Public writes | At least one backup moderator before growth campaigns |
| Google OAuth and account-link collisions | Stage 1 | Deliberate linking; never force-link unverified matches |
| Initial subjects and home-feed explanation | Stage 1 | Explicit choices, recency and visible reasons; no behavioural inference |
| YouTube quota/policy audit | Stage 2 | Re-check official console immediately before implementation |
| Accepted resource formats | Stage 3 | Start with inspectable Resolve assets |
| Trusted-author promotion/revocation | Stage 3 | Identity plus clean history, never payment |
| R2 domain and cost alert thresholds | Stage 3 | Configure alerts before uploads open |
| Supporter price and annual option | Stage 4 | Test accessibility of EUR 2–5; full free participation remains |
| Sponsored channel offer and disclosure format | Stage 4 | Fixed duration and clear label; never required for directory inclusion |
| Marketplace commission and tax model | Stage 5 | Validate 10–15% range with creators and advisers |
| Native video eligibility/quotas | Stage 5 | No launch promise; managed streaming only |

## 13. Explicit first-release non-goals

- replacing YouTube, Reactor, We Suck Less, Blackmagic, Reddit or Discord;
- indexing transcripts or hosting tutorial videos;
- hosting arbitrary applications, OFX installers or executable archives;
- executing or silently updating community code;
- selling third-party resources before legal and operational readiness;
- a general-purpose network unrelated to Resolve, private messaging, contact importing, stories,
  short-video autoplay or an opaque engagement-maximising feed;
- making local NetsuRush tools depend on a community account or server.
