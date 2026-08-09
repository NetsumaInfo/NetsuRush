# Publishing an update

The NetsuRush updater reads `latest.json` from the latest release of the `NetsumaInfo/NetsuRush` GitHub repository. Archives are signed: the app refuses an unsigned release.

## Signing key

The local private key is `.tauri/netsurush-updater.key`. That folder is git-ignored. **Back the key up outside the development machine before any release**: losing it means existing installs can never accept a future update.

The public key is stored in `src-tauri/tauri.conf.json`. Unlike the private key, it can be shared.

Before packaging, set `TAURI_SIGNING_PRIVATE_KEY` to the contents of the private key. If a future key is password-protected, also set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## GitHub artefacts

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
2. Add an entry with a unique `id` to `src/data/releases.json`.
3. Run `npm run package`.
4. Run `npm run update:manifest`.
5. Create the `v<version>` tag and attach to the GitHub release: the NSIS `.exe` installer, its `.exe.sig` signature, and `latest.json`.

The `platforms.windows-x86_64.signature` field of `latest.json` holds the signature **contents**, not a link to the `.sig` file.
