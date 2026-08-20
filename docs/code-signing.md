# Code signing and Windows reputation

Two unrelated signatures exist in this project and they are constantly confused.

| | Updater signature | Authenticode signature |
|---|---|---|
| Key | `.tauri/netsurush-updater.key` (minisign) | A code signing certificate from a CA |
| Checked by | The Tauri updater, inside the app | Windows, SmartScreen, Defender, Smart App Control |
| Covered by | [`releasing.md`](releasing.md) | This document |

An unsigned release is refused **by the updater**; it is accepted by Windows, which merely distrusts it. Publishing an updater-signed installer does nothing for SmartScreen.

## What signing does and does not buy

Signing does **not** remove the SmartScreen prompt on release day. Microsoft removed the EV instant-bypass in 2024, so OV, EV and Artifact Signing all build reputation the same way: organically, through download volume, over weeks. There is no submission form for consumer SmartScreen reputation and no way to buy it.

What it does buy, and why it is still the single highest-value change:

- **Reputation accumulates on the certificate, not only on the file hash.** Unsigned, every release starts from zero and the warning never stops. Signed with a stable certificate, each release inherits what the previous ones earned.
- The prompt names a **verified publisher** instead of an unknown one.
- Defender's machine-learning classifiers weight "unsigned" heavily. Signing is what moves `Trojan:Script/Wacatac.B!ml`-class false positives off this installer.
- Windows 11 **Smart App Control** blocks unsigned executables outright, regardless of SmartScreen.

## Choosing a certificate

| Option | Cost | Available to | Notes |
|---|---|---|---|
| **SignPath Foundation** | Free | OSI-licensed open source | This repository is public and AGPL-3.0-only. Requires a **verifiable CI build**, MFA, a manual approval per release, and a published "Code signing policy" page. Disqualifying condition: **any commercial dual-licensing**. The bundled libmpv is GPL-2.0-or-later, which is OSI-approved and does not disqualify — what would is any proprietary component in the tree. |
| **Azure Artifact Signing** (ex-Trusted Signing) | ~$9.99/month | Organizations in the US, Canada, EU, UK, AU, NZ, JP, KR, SG, CH, NO, IL. **Individuals: US and Canada only.** | Microsoft's recommended non-Store path. No hardware token, integrates with CI. From France it needs a **registered legal entity**; the Azure billing account type must match the identity validation type. Validation takes 1–20 business days. |
| **OV certificate** | $150–300/year | Worldwide, individuals included | The fallback when the two above are closed. Since June 2023 the private key must live on an HSM or USB token. |
| **EV certificate** | $400+/year | Worldwide | No SmartScreen advantage over OV since 2024. Not worth the premium here. |

**Use the same certificate for NetsuRush and NetsuBoard.** Reputation is keyed on the certificate thumbprint, so one certificate signing both products pools what each earns instead of building two reputations from zero. Two rules that outlive the choice:

- **Never change certificate once reputation has started building.** A renewal with a new thumbprint resets it.
- **Sign after staging, never before.** `scripts/build.ps1` stages `core/`, `python/`, the mpv DLLs and `dist/` into `src-tauri/resources/` before `tauri build`. Modifying a file after it is signed breaks its signature.

## Two wiring shapes, and the trap between them

Where the signature happens decides whether the updater still works.

- **In-build** (Azure Artifact Signing, `signtool`): Tauri runs the signing tool on each binary *during* bundling, then computes the updater's minisign signature over the already-signed installer. Nothing else to do.
- **Post-build** (SignPath): the finished `.exe` is submitted, signed and returned. Authenticode **rewrites the bytes**, so the `.sig` that `tauri build` wrote over the unsigned file no longer matches. Left alone, every installed copy would refuse the update, because `create-update-manifest.mjs` reads that stale `.sig` off disk and copies it into `latest.json`.

  The signature must therefore be regenerated on the signed installer, **before** the manifest is built:

  ```powershell
  npx tauri signer sign <path-to-signed-setup.exe>
  ```

  `.github/workflows/release.yml` does this in order: build → SignPath → re-sign → manifest.

## SignPath, in practice

`.github/workflows/release.yml` builds the installer on a runner and submits it. The SignPath step is skipped while `vars.SIGNPATH_ORGANIZATION_ID` is unset, so the workflow is usable before the application is accepted — it then produces an unsigned installer, exactly like a local `npm run package`.

To turn it on, set these on the repository:

| Kind | Name |
|---|---|
| Secret | `SIGNPATH_API_TOKEN` |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` (contents of `.tauri/netsurush-updater.key`) |
| Variable | `SIGNPATH_ORGANIZATION_ID` |
| Variable | `SIGNPATH_PROJECT_SLUG` |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` |

The Foundation also requires, on the project side: MFA on GitHub and on SignPath, defined Author / Reviewer / Approver roles with every external contribution reviewed, a manual approval for each release, product name and version metadata on the signed binaries (`bundle.publisher`, `bundle.copyright` and `version` in `tauri.conf.json`), and a public **"Code signing policy"** page.

## Wiring a signing tool into the build

For the in-build shape, signing is opt-in through the `NETSURUSH_SIGN_COMMAND` environment variable. `scripts/build.ps1` reads it, writes a `--config` overlay (`src-tauri/tauri.sign.conf.json`, git-ignored) carrying `bundle.windows.signCommand`, and passes it to `tauri build`. Tauri then runs the command once per binary in the package, with `%1` replaced by the file path.

A permanent `signCommand` is deliberately **not** committed to `tauri.conf.json`: it would break every build on a machine without the signing tool installed.

```powershell
$env:NETSURUSH_SIGN_COMMAND = 'trusted-signing-cli -e https://neu.codesigning.azure.net -a <account> -c <profile> -d NetsuRush %1'
npm run package
```

`bundle.publisher` is `Haim Faraj`. It must be kept **identical to the subject of the certificate**, and identical to NetsuBoard's.

## What the running app must not do

Defender scores the **process tree**, not only the installer. A detection naming `app.exe` and its pid is a runtime verdict.

The chain here is `app.exe` → `resources\bin\node.exe` → `powershell.exe` → a Python venv → downloaded wheels and model weights. Every link is legitimate and none can be removed, so the shape of the calls is what is left to control:

- `core/setup.js` launches `setup.ps1` with **`-File`**. It previously used `-Command` with `& ([scriptblock]::Create([IO.File]::ReadAllText(...)))` — code built at runtime from a file read at runtime, under `-ExecutionPolicy Bypass`, in a hidden window. AMSI scans the constructed block, and that combination is what fileless loaders look like. `-File` is the ordinary shape and hides nothing.
- The UTF-8 that scriptblock existed to force comes from the **BOM on `scripts/setup.ps1`**. Removing that BOM turns every accent in the setup UI into mojibake.
- `-ExecutionPolicy Bypass` remains, because the default `Restricted` policy blocks an unsigned `.ps1` outright. The fix is to **Authenticode-sign `setup.ps1`** once a certificate exists — `.ps1` files take a signature like any PE — and drop to `-ExecutionPolicy RemoteSigned`. Test that on a clean machine first: if the staged script ever carries a mark-of-the-web, `RemoteSigned` refuses it and first-run setup fails outright.

This product provisions far more than NetsuBoard — a Python interpreter, a venv, torch wheels, model weights — so its download-and-execute surface is inherently larger. That is structural and cannot be engineered away; a stable signing certificate is what makes it read as legitimate rather than as a staged payload.

## Known remaining trigger — the uninstaller

`src-tauri/windows/installer-hooks.nsh` still copies `uninstall-cleanup.ps1` into `%TEMP%` and runs it with `powershell.exe -ExecutionPolicy Bypass -File`. That is the canonical dropper invocation, and the string sits in clear text inside the compiled installer, so it is scanned at **install** time even though the code only runs on uninstall.

NetsuBoard removed this by rewriting its cleanup as plain NSIS file operations. **That port is not mechanical here**: this script parses `nr.config.json` to resolve a relocatable cache root, validates a `.netsurush-cache-root` marker before deleting anything, and globs `faiss_*` files. NSIS has no JSON parser, and a wrong move deletes the venv, the downloaded weights and the SQLite database holding the hand-entered character roster.

Two viable routes, neither applied yet:

1. **Port the fixed paths to NSIS and keep PowerShell for nothing.** Have the core write the resolved cache root to a one-line `cache-root.txt` in `NR_HOME`, which the uninstaller reads with `FileRead`. Removes PowerShell from the uninstall path entirely; costs a small change in `core/config.js`.
2. **Keep PowerShell, drop the `%TEMP%` drop.** Copy the script to `$PLUGINSDIR` instead — NSIS's own scratch directory, auto-removed, no predictable path. This only softens the pattern; `-ExecutionPolicy Bypass` still appears in the binary.

Route 1 is the real fix. Route 2 is an hour's work and can ship first.

## When a release is flagged anyway

1. Upload the installer to **VirusTotal** first. If Defender is the only engine flagging it, it is a machine-learning false positive. If several engines agree, stop and investigate the build.
2. Submit it at [microsoft.com/wdsi/filesubmission](https://www.microsoft.com/en-us/wdsi/filesubmission), category **"Software developer – false positive"**, signed in so the verdict is trackable.
3. If a shipped version stays blocked, escalate at [msrc.microsoft.com/report](https://msrc.microsoft.com/report).
4. Publish the installer's SHA-256 on the release page.

Never tell a tester to add a Defender exclusion. It trains them to disable protection for an unknown binary, and it hides the problem instead of fixing it.
