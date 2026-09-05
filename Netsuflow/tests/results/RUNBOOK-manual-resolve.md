# Manual runbook: T01, T02, and the in-host half of T03

Everything in this file requires a human driving DaVinci Resolve Studio. None of
it can be automated: Resolve must be closed to replace the plugin binary, the
Inspector has to be operated by hand, and several observations are visual.

Work through the sections in order. Stop at the first FAIL and record it — the
gates are sequential on purpose.

## Before starting

1. Build a Release bundle and note its SHA-256:

   ```powershell
   $env:DAVINCI_RESOLVE_DEVELOPER_DIR = 'C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer'
   cmake -S Netsuflow/openfx -B Netsuflow/openfx/build -A x64 -DNETSUFLOW_BUILD_TESTS=ON
   cmake --build Netsuflow/openfx/build --config Release
   Get-FileHash 'Netsuflow\openfx\build\Release\NetsuFlow.ofx.bundle\Contents\Win64\NetsuFlow.ofx' -Algorithm SHA256
   ```

2. Enable instrumentation for the whole session, **before** launching Resolve:

   ```powershell
   [Environment]::SetEnvironmentVariable('NETSUFLOW_OFX_LOG', '1', 'User')
   ```

   Logs land in `%LOCALAPPDATA%\NetsuRush\netsuflow\logs\ofx-<pid>.log`. They
   contain no source, props, tokens or project paths.

3. Close Resolve completely. It holds plugin binaries open while running.

4. Record Resolve's exact version, the OS build, and the project's colour
   management mode, timeline resolution and frame rate. Put them in the report
   header — a measurement without them is not reproducible.

## Step 1 — Discovery, and the `OFX_PLUGIN_PATH` question (T01, and R6/T08)

Do the per-user variant **first**. It costs minutes and, if it works, it largely
resolves R6: NetsuRush's installer is per-user, and the standard OpenFX directory
needs elevation.

```powershell
$plugins = "$env:LOCALAPPDATA\NetsuRush\ofx-plugins"
New-Item -ItemType Directory -Force $plugins | Out-Null
Copy-Item -LiteralPath (Resolve-Path 'Netsuflow\openfx\build\Release\NetsuFlow.ofx.bundle').Path -Destination $plugins -Recurse -Force
$existing = [Environment]::GetEnvironmentVariable('OFX_PLUGIN_PATH', 'User')
$combined = if ($existing) { "$existing;$plugins" } else { $plugins }
[Environment]::SetEnvironmentVariable('OFX_PLUGIN_PATH', $combined, 'User')
```

Preserve any existing value — the variable is a semicolon-separated list on
Windows and other vendors' plugins may already be listed.

Start Resolve. Record:

- [ ] Does `NetsuFlow (Experimental)` appear in the OpenFX list?
- [ ] Under which category/group?
- [ ] If not: is there anything in Resolve's own log?

If discovery fails, fall back to the standard location in an elevated shell:

```powershell
Copy-Item -LiteralPath (Resolve-Path 'Netsuflow\openfx\build\Release\NetsuFlow.ofx.bundle').Path -Destination 'C:\Program Files\Common Files\OFX\Plugins' -Recurse -Force
```

Record which of the two worked. This single observation decides the Windows
installation strategy in R04.

**Also record: does the free (non-Studio) edition load it?** Vendor consensus is
that third-party OpenFX is Studio-only. Confirming it locally turns a community
signal into evidence for `docs/00`.

## Step 2 — T01, host contract

Insert the node in Fusion. Leave `Mode` on `Local Diagnostic` throughout this
step: no service should be involved while the host contract is under test.

The frame shows a 16-cell binary counter across the top: cell *i* is lit when bit
*i* of the frame number is set, least significant on the left. Below it is a
gradient that changes every frame. Read the counter to check the node is being
asked for the frame you think it is.

| # | Action | Record |
|---|---|---|
| 1 | Node inserted, viewer shows the pattern | counter reads the expected frame |
| 2 | Scrub forward slowly | counter tracks; no stutter, no stale frame |
| 3 | Scrub backward | same |
| 4 | Jump randomly | same |
| 5 | Play through | frame ordering in the log |
| 6 | Change timeline resolution | new dimensions honoured |
| 7 | Switch to proxy / half resolution | `scaleX`/`scaleY` in the log; does the counter still read correctly? |
| 8 | Save, close, reopen the project | parameters preserved |
| 9 | Duplicate the node | two instance ids in the log, both render |
| 10 | Delete a node | `instanceDestroyed` logged |
| 11 | Render from Deliver | output frames correct |
| 12 | Close Resolve, remove the bundle, reopen | how does Resolve report the missing plugin? |

From the log, extract and put in the report:

- [ ] **Negotiated pixel depth.** `depth=` in each render line, using the SDK's
      enum ordinals: `0` None, `1` UByte, `2` UShort, `3` Half, **`4` Float**,
      `5` Custom. `components=`: `1` is RGBA. **Settled on 2026-08-26: Resolve
      supplies `depth=4 components=1`**, i.e. 32-bit float RGBA, exactly as
      developer reports predicted. Declaring both depths was necessary.
- [ ] **Render window vs image bounds.** Are they ever different — i.e. does
      Resolve tile despite `setSupportsTiles(false)`?
- [ ] **Thread ids.** One at a time per instance, or several?
- [ ] **Sub-frame times.** Any non-integer `time=` values?
- [ ] **`interactive=`** true/false split between scrubbing and Deliver.
- [ ] **Abort.** Does `abortObserved=true` ever appear during scrubbing?

**Stop condition:** if the local CPU generator is unstable — crash, hang,
corrupt output, or a leak — do not proceed. The host contract has to be fixed
first; nothing downstream is meaningful until it is.

## Step 3 — T02, Inspector

Still in `Local Diagnostic` mode.

| Control | What to try | Record |
|---|---|---|
| Binding (single-line) | plain text, then Unicode, then 500 chars | truncation? |
| Props (multiline) | 1 KB, 10 KB, 100 KB of JSON | editing latency, truncation, newline and quote preservation |
| Diagnostic Source (multiline) | same three sizes | is editing code here tolerable at all? |
| Start Frame (int) | negative, zero, large | does the counter shift by the right amount? |
| Mode / Quality / Cache (choice) | switch each | does the render invalidate immediately? |
| Reload (push button) | click it | does Status update? does the next render log `reloaded=true`? |
| Status (disabled string) | observe | does a disabled string read as status, or as broken UI? |
| Any parameter | animate it, then undo/redo | does animation work? does undo restore? |
| Whole node | copy/paste, then save/reopen | do all values survive? |

**The decision this step exists for:** is editing real source in the Inspector
tolerable? If it is not — which `docs/10` R15 expects — the production editor
belongs in NetsuRush and the node keeps only `Binding`. Write that conclusion
down explicitly either way; it shapes `docs/07`.

## Step 4 — In-host half of T03

Only after steps 2 and 3 pass. Start the fake renderer, then switch the node's
`Mode` to `Bridge`.

```powershell
node Netsuflow\prototypes\fake-renderer\server.mjs --session "$env:LOCALAPPDATA\NetsuRush\netsuflow\session.json"
```

The pixels should look identical to Local Diagnostic mode — that is the point of
the shared fixture. Any visible difference is a bug.

| # | Action | Expected |
|---|---|---|
| 1 | Scrub sequentially | frames track, Resolve stays responsive |
| 2 | Scrub randomly and fast | same; no freeze |
| 3 | Ctrl-C the service mid-scrub | node shows the error frame; **Resolve does not hang** |
| 4 | Restart the service | rendering resumes with no Resolve restart |
| 5 | Restart with `--fault neverRespond` | error frame within the preview deadline (2 s), not a freeze |
| 6 | `--fault truncateBody` | error frame; never a corrupt one |
| 7 | `--fault disconnectAfterHeader` | error frame |
| 8 | Set Quality to Final, render from Deliver with the service down | hard render error, **never** a stale frame |
| 9 | Scrub for several minutes | check Resolve's memory in Task Manager |

The fault flag accepts any key from `DEFAULT_FAULTS` in `server.mjs`.

Record for each: what the viewer showed, whether Resolve stayed responsive, and
how long recovery took.

**Stop condition:** if a delayed or malformed response can destabilise Resolve,
stop. Do not add Remotion.

## Step 5 — The real engine in the host (H04)

Only after step 4 passes. Step 4 proves the host survives a hostile service;
this step is the first time a real browser renders into Resolve. Everything in
H01–H03 was measured outside the host, on a software renderer, against fixtures.

The short way, which does all of the below and configures the node through
Resolve's own API:

```powershell
node Netsuflow\prototypes\hyperframes-renderer	oolsender-in-resolve.mjs <page.html>
```

See [`PASTE.md`](../../prototypes/hyperframes-renderer/PASTE.md). The rest of
this step is the manual equivalent, kept because it is what the report measures.

Start the HyperFrames service and point it at the descriptor path the plugin
reads. The `--session` argument is not optional here: the service defaults to a
temporary directory, and the plugin only looks at
`%LOCALAPPDATA%\NetsuRush\netsuflow\session.json`.

```powershell
node Netsuflow\prototypes\hyperframes-renderer\server.mjs --fixture user --binding harness --session "$env:LOCALAPPDATA\NetsuRush\netsuflow\session.json"
```

It prints its port and session file once the session is warm, which takes a few
seconds — that cold start is the measurement H03 built the mode default around,
and this is the first chance to feel it rather than read it.

In the Inspector: `Mode` to `Bridge`, and type `harness` into `Binding`. An empty
`Binding` is not a bug to debug — the node has no default.

**Three service-side constraints decide whether anything renders at all.** All
three fail loudly rather than silently, which is why they look like bugs the
first time:

- The revision must match. The plugin hardcodes `sourceRevision = "0"` while
  every fixture declares `rev-0`, so **out of the box they never match** and
  every frame is refused as `stale-revision`. Pass `--revision 0`. Measured in
  [H04](H04-2026-08-27/report.md); it is the first thing that will stop you.

- The binding's declared size must equal the size the host asks for. `--fixture
  user` is 1920x1080, so the comp must be 1920x1080. A mismatch answers
  `bad-request` on every frame. `--fixture diagnostic` is 320x180 and will
  therefore fail in any normal timeline — use it only in a 320x180 comp.
- The render scale must be 1:1. Any Fusion proxy or Resolve timeline-proxy
  setting other than full answers `renderScalePpm other than 1000000 is not
  implemented yet`. Rendering full-size and calling it scaled would be silently
  wrong pixels, so the service refuses instead. Set proxy to Off/Full before
  concluding anything.

To render a composition of your own rather than a fixture, pass its folder. The
size is required and not guessed, for the reason above:

```powershell
node Netsuflow\prototypes\hyperframes-renderer\server.mjs --project Netsuflow\prototypes\hyperframes-renderer\sandbox --size 1920x1080 --binding harness --session "$env:LOCALAPPDATA\NetsuRush\netsuflow\session.json"
```

`sandbox/index.html` is a scratch composition kept for exactly this: it
implements the `window.__hf` contract and nothing else, so anything that breaks
after editing it is the edit.

Then the strongest available check, the one T03 used, now with a real browser
behind it: point `--fixture diagnostic` at a 320x180 comp, because that fixture
paints exactly what the plugin's own Local Diagnostic mode computes. **Toggling
`Mode` must change nothing on screen.** Any visible difference is a bug, and a
colour shift is the one to look hardest for — it would mean the capture path or
the host's colour management is touching pixels that H02 measured as untouched.

| # | Action | Expected |
|---|---|---|
| 1 | In a 320x180 comp with `--fixture diagnostic`, toggle `Mode` | no visible change at all |
| 2 | Hold on one frame, then re-enter the node | second view is instant — the cache, seen from the host |
| 3 | Scrub sequentially | frames track |
| 4 | Scrub backwards | same; H03 measured no penalty, confirm the host agrees |
| 5 | Scrub randomly and fast | same; no freeze, no wrong frame |
| 6 | Switch to `--project sandbox --size 1920x1080` and restart | your own composition renders; note the first-frame wait |
| 7 | Add a second NetsuFlow node with the same `Binding` | both render; one session serves both |
| 8 | Ctrl-C the service mid-scrub | error frame; **Resolve does not hang** |
| 9 | Restart the service | rendering resumes with no Resolve restart |
| 10 | Kill every `chrome-headless-shell` process from Task Manager | error frame, then recovery without restarting the service |
| 11 | Quality to Final, render from Deliver | completes, and **never** substitutes a stale frame |
| 12 | Scrub for several minutes | Resolve's and node's memory in Task Manager |

Record wall-clock for the first frame after each service start. That number is
the one H03 could not obtain: cold start measured through the host, including
whatever Resolve adds on top of the 5.5 s the service takes alone.

**Do not modify the plugin** unless a host-contract defect is actually
demonstrated. A wrong frame, a hang, or a crash is a defect. Slowness is not —
it is a measurement, and it belongs in the report.

**Stop condition:** if Resolve can be hung or crashed by the real engine, stop
and record it. Do not begin the NetsuRush integration plan.

## Afterwards

1. Write the reports into dated directories, one per test:
   `tests/results/T01-<date>/report.md`, `T02-<date>/`, and append the in-host
   section to the existing `T03-2026-08-26/report.md` or supersede it with a new
   dated one. Step 5 gets its own `tests/results/H04-<date>/report.md`. Do not
   overwrite prior reports.
2. Attach the log files.
3. Update `STATUS.md`: move each row from unverified to confirmed or failed based
   on what was observed, not on what was expected.
4. Update `docs/10` if a risk's likelihood changed.
5. Remove the plugin and undo the `OFX_PLUGIN_PATH` change by restoring its
   previous value — do not delete the variable outright.

Mark anything not actually observed as not run. A blank in a report is
recoverable; a wrong PASS is not.
