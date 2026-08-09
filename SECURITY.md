# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security flaw.**

Use one of these two private channels instead:

- the **Security ▸ Report a vulnerability** tab of the GitHub repository (*private vulnerability
  reporting*);
- a private message to the maintainer from the [NetsumaInfo GitHub profile](https://github.com/NetsumaInfo).

A useful report states what is affected, how to reproduce it, the impact you estimate, and your
NetsuRush and Windows versions.

Expect a few days for a first reply. The fix ships before the detailed description of the flaw, and
you are credited if you want to be.

## Scope

NetsuRush is a desktop application running on the user's machine. The areas that matter most:

- the **core service** (HTTP/SSE on `127.0.0.1:8730`): it only listens on the loopback interface,
  but its CORS is open and its RPC channels run ffmpeg, Python and host scripts;
- the **media server** (`/media`, `/stream`): arbitrary file reads, path traversal;
- the **Resolve bridge** and the **Adobe panel jobs**: script execution inside third-party software;
- **Convex authentication** and the `netsurush://` deep link;
- the **bug reporter**: masking of paths, e-mails and tokens before sending.

**Out of scope**:

- vulnerabilities in DaVinci Resolve, Premiere Pro, After Effects, ffmpeg, mpv or any upstream
  dependency — report those to their vendor;
- anything requiring physical or administrator access already obtained on the machine;
- third-party ML models and weights downloaded at install time.

## Supported versions

Only the latest published release receives security fixes. NetsuRush is in beta: earlier branches
are not maintained.

## Secrets

No secret belongs in the repository. Convex keys live in `.env.local` (Git-ignored; `.env.example`
holds example values only), the bug-report webhook in `nr.config.json` under `NR_HOME`, and the
Discord OAuth secret only in the Convex environment — never in the bundle.

If you find an exposed secret in the history, report it privately rather than opening an issue.
