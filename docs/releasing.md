# Publishing an update

The NetsuRush updater reads `latest.json` from the latest release of the `NetsumaInfo/NetsuRush` GitHub repository. Archives are signed: the app refuses an unsigned release.

## Signing key

The local private key is `.tauri/netsurush-updater.key`. That folder is git-ignored. **Back the key up outside the development machine before any release**: losing it means existing installs can never accept a future update.

The public key is stored in `src-tauri/tauri.conf.json`. Unlike the private key, it can be shared.

Before packaging, set `TAURI_SIGNING_PRIVATE_KEY` to the contents of the private key **and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to an empty string**. The second one is not optional even when the pair carries no password: without it the CLI prints `Decrypting updater signing key, expect a prompt for password` and waits on stdin, so a build launched from a script or from CI hangs forever after the installer is written — the `.exe` is there, the `.sig` never comes. Set it to the real password the day the key gets one.

Set `NETSURUSH_SIGN_COMMAND` in the same session to also Authenticode-sign the build; without it `build.ps1` warns and ships an unsigned installer. Authenticode, SmartScreen reputation and Defender false positives are a separate axis from the updater signature above — see [`code-signing.md`](code-signing.md).

## GitHub artefacts

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
2. Add an entry with a unique `id` to `src/data/releases.json`.
3. Run `npm run package`.
4. Run `npm run update:manifest`.
5. Create the `v<version>` tag and attach to the GitHub release: the NSIS `.exe` installer, its `.exe.sig` signature, and `latest.json`.

6. Compute and publish the installer's SHA-256 in the release notes:

   ```powershell
   (Get-FileHash .\src-tauri\target\release\bundle\nsis\*-setup.exe -Algorithm SHA256).Hash
   ```

7. Upload the installer to VirusTotal. If Defender is the only engine flagging it, submit it at [microsoft.com/wdsi/filesubmission](https://www.microsoft.com/en-us/wdsi/filesubmission) as **"Software developer – false positive"** and link the VirusTotal report in the release notes. If several engines agree, do not publish — investigate the build.

The `platforms.windows-x86_64.signature` field of `latest.json` holds the signature **contents**, not a link to the `.sig` file.

Steps 6 and 7 stay part of every release until the signing certificate has accumulated SmartScreen reputation; the rationale and the escalation path are in [`code-signing.md`](code-signing.md).

## Building the release in CI

Once SignPath signs the builds, packaging **must** happen on a runner: the Foundation attests that the binary came from this public repository, which a local build cannot demonstrate. `.github/workflows/release.yml` covers steps 3, 4, 6 and part of 7 — it builds the installer, has it signed, regenerates the updater signature over the signed file, writes `latest.json`, computes the SHA-256 and uploads everything as artefacts.

The order changes accordingly: bump the version and the release entry, push the `v<version>` tag, let the workflow run, then download its `netsurush-release` artefact and attach its contents to the GitHub release. The workflow never creates or publishes the release itself.
