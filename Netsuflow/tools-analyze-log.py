#!/usr/bin/env python3
"""Summarise a NetsuFlow OFX instrumentation log into the facts T01 asks for.

Usage: python tools-analyze-log.py [logfile]
"""
import collections, glob, os, sys

DEPTHS = {0: "None", 1: "UByte", 2: "UShort", 3: "Half", 4: "Float", 5: "Custom"}
COMPONENTS = {0: "None", 1: "RGBA", 2: "RGB", 3: "Alpha", 4: "Custom"}

path = sys.argv[1] if len(sys.argv) > 1 else None
if path is None:
    base = os.path.expandvars(r"%LOCALAPPDATA%\NetsuRush\netsuflow\logs")
    candidates = sorted(glob.glob(os.path.join(base, "*.log")), key=os.path.getmtime)
    if not candidates:
        sys.exit(f"no log under {base}")
    path = candidates[-1]

rows = []
with open(path, encoding="utf-8", errors="replace") as handle:
    for line in handle:
        fields = dict(
            part.split("=", 1) for part in line.strip().split(" ") if "=" in part
        )
        if fields:
            rows.append(fields)

renders = [r for r in rows if r.get("action") == "render"]
print(f"{path}\n{len(rows)} lines, {len(renders)} render calls\n")

if not renders:
    print("No render call recorded yet. Scrub the timeline, then re-run.")
    sys.exit(0)

def uniq(key):
    return sorted({r.get(key) for r in renders if key in r})

depths = uniq("depth")
comps = uniq("components")
print(f"depth        : {', '.join(f'{d} ({DEPTHS.get(int(d), d)})' for d in depths)}")
print(f"components   : {', '.join(f'{c} ({COMPONENTS.get(int(c), c)})' for c in comps)}")
print(f"render scale : {', '.join(sorted({(r.get('scaleX','?')+'x'+r.get('scaleY','?')) for r in renders}))}")
print(f"interactive  : {', '.join(uniq('interactive'))}")
print(f"instances    : {', '.join(uniq('instance'))}")

threads = collections.Counter(r.get("thread") for r in renders)
print(f"render threads: {len(threads)} distinct -> {dict(threads)}")
ui_threads = {r.get("thread") for r in rows if r.get("action") in ("instanceCreated", "reload")}
overlap = ui_threads & set(threads)
print(f"UI-action threads: {sorted(ui_threads)}"
      + ("  [SHARED with render]" if overlap else "  [disjoint from render threads]"))

tiled = [r for r in renders
         if (r.get("winX1"), r.get("winY1")) != ("0", "0")
         or r.get("winX2") != r.get("imageW") or r.get("winY2") != r.get("imageH")]
print(f"partial render windows (tiling): {len(tiled)} of {len(renders)}")
for r in tiled[:5]:
    print(f"   win=({r.get('winX1')},{r.get('winY1')})-({r.get('winX2')},{r.get('winY2')}) image={r.get('imageW')}x{r.get('imageH')}")

subframe = [r for r in renders if "." in r.get("time", "")]
print(f"sub-frame times: {len(subframe)}"
      + (f" -> {[r['time'] for r in subframe[:5]]}" if subframe else ""))

aborts = sum(1 for r in renders if r.get("abortObserved") == "true")
print(f"aborts observed: {aborts}")

fallbacks = collections.Counter(r["fallback"] for r in renders if "fallback" in r)
print(f"fallbacks: {dict(fallbacks) if fallbacks else 'none'}")

statuses = collections.Counter(
    " ".join(v for k, v in r.items() if k == "status") for r in renders if "status" in r)
print(f"statuses: {dict(statuses)}")

frames = [(r.get("time"), r.get("sourceFrame")) for r in renders]
print(f"\nframe mapping (time -> sourceFrame), first 12:")
for t, s in frames[:12]:
    print(f"   {t:>8} -> {s}")
repeats = collections.Counter(frames)
dupes = {k: v for k, v in repeats.items() if v > 1}
print(f"repeated (time, frame) requests: {len(dupes)}"
      + (f" e.g. {list(dupes.items())[:3]}" if dupes else ""))
