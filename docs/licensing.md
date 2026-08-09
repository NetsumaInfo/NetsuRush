# Licensing and redistribution

## Original code

The original NetsuRush code is distributed under the **GNU Affero General Public License version 3.0 only** (`AGPL-3.0-only`). The full legal text is in [`../LICENSE`](../LICENSE). The SPDX/REUSE declaration — including the copyright holder — is centralised in [`../REUSE.toml`](../REUSE.toml), which keeps licence information from being lost when a file is moved or copied.

This licence allows commercial use, copying and modification, but requires among other things that notices be kept, that modifications be published under the same licence, and that the corresponding source be provided with any binary redistribution. If a modified version lets users interact with it remotely over a network, it must also offer them free access to the corresponding source.

The reference public repository for the source is <https://github.com/NetsumaInfo/NetsuRush>.

## Scope

AGPL-3.0-only covers the original code in this repository. It does **not** change the terms applying to third-party material:

- npm, Rust and Python dependencies keep their own licences;
- ffmpeg/ffprobe, DaVinci Resolve, WebView2 and any other software installed or used on the machine are **not** relicensed by NetsuRush;
- models, weights, shaders and vendored repositories under `vendor/` may carry distinct licences and restrictions;
- licence files already shipped next to bundled resources must stay distributed with those resources.

## Native player runtime (mpv, FFmpeg)

The native video player relies on **libmpv** and the **FFmpeg** libraries shipped with it. Those binaries are **not versioned in this repository**: they are distributed separately as a release asset and provisioned by [`scripts/fetch-mpv.ps1`](../scripts/fetch-mpv.ps1) into `vendor/mpv/`.

- **mpv** — GPL-2.0-or-later, with parts under LGPL-2.1-or-later.
- **FFmpeg** — LGPL-2.1-or-later, and GPL-2.0-or-later when built with `--enable-gpl`.

Those licences are **distinct from NetsuRush's AGPL-3.0-only** and are not absorbed by it. Any redistribution of those binaries — in particular the `.exe` installer, which embeds them — must ship their licence texts and make the **corresponding source** available, or state precisely where to obtain it. The release package therefore contains those licence texts plus the exact mpv and FFmpeg revisions used for the build.

Before publishing an installer or an image containing a new dependency: check its licence, keep its copyright notice, and add its text to the third-party licence artefacts if needed. Never present a third-party component as covered by NetsuRush's AGPL.

## Rules that keep the project redistributable

- **Never copy GPL or AGPL code into the tree**, not even translated into another language: it would make the whole app a derivative work of it. Studying a GPL project's UX or approach and reimplementing it is fine; copying its source is not.
- **Non-commercial (NC) model weights are optional add-ons**, always badged as such in the model catalog, and **never the default engine for a task**. Every task keeps a permissive default so a build without any NC weight loses no core capability.
- **Verify a licence at its source** (the model card, the repository) before adding a model or a dependency. Summaries and third-party mirrors have been wrong more than once, in both directions.
- A weight re-uploaded by a third party **without a declared licence** is not usable, whatever the original model's licence.

## Legal notice inside the app

NetsuRush is provided **without warranty**, per sections 15 and 16 of the AGPL. The source and the licence text are published with the project; any derived remote interface or distribution must keep visible access to that information and comply with section 13 of the AGPL.
