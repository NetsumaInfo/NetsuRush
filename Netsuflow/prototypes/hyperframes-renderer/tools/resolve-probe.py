# Reads what the host needs, and sets the two node inputs a bridge render needs.
#
# Split out as its own file because Resolve's scripting API is Python-only:
# `fusionscript.dll` is loaded by a CPython extension module, and no Node
# binding for it exists. Everything else in this prototype is Node, so this
# stays as small as it can be — read the sizes, set two inputs, print JSON.
#
# It must run under a normally installed CPython. The Microsoft Store build
# cannot load `fusionscript.dll` at all: it fails with a bare
# "initialization of fusionscript failed without raising an exception".
import io
import json
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

API = os.environ.get(
    "RESOLVE_SCRIPT_API",
    r"C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting",
)
os.environ.setdefault("RESOLVE_SCRIPT_API", API)
os.environ.setdefault(
    "RESOLVE_SCRIPT_LIB",
    r"C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll",
)
sys.path.append(os.path.join(API, "Modules"))

GENERATOR_ID = "ofx.com.netsurush.netsuflow.generator"

# Mode is a choice parameter: 0 is Local Diagnostic, 1 is Bridge. A node left on
# 0 renders the plugin's own CPU pattern and never contacts the service, which
# is indistinguishable from a broken bridge unless you know to look.
MODE_BRIDGE = 1.0


def fail(reason):
    print(json.dumps({"ok": False, "error": reason}))
    sys.exit(1)


try:
    import DaVinciResolveScript as dvr
except Exception as error:  # noqa: BLE001 - the reason is the whole point
    fail("cannot import the Resolve scripting module: %s" % error)

resolve = dvr.scriptapp("Resolve")
if resolve is None:
    fail("Resolve is not running, or external scripting is not enabled")

project = resolve.GetProjectManager().GetCurrentProject()
if project is None:
    fail("no project is open")

width = int(project.GetSetting("timelineResolutionWidth"))
height = int(project.GetSetting("timelineResolutionHeight"))
fps = float(project.GetSetting("timelineFrameRate"))

result = {
    "ok": True,
    "project": project.GetName(),
    "width": width,
    "height": height,
    "fps": fps,
    "node": None,
}

comp = None
try:
    comp = resolve.Fusion().GetCurrentComp()
except Exception:  # noqa: BLE001 - no comp open is a normal state, not an error
    comp = None

if comp is not None:
    for tool in (comp.GetToolList() or {}).values():
        if tool.ID != GENERATOR_ID:
            continue
        if "--configure" in sys.argv:
            binding = sys.argv[sys.argv.index("--configure") + 1]
            tool.SetInput("binding", binding)
            tool.SetInput("mode", MODE_BRIDGE)
            tool.SetInput("reload", 1.0)
        result["node"] = {
            "name": tool.GetAttrs("TOOLS_Name"),
            "binding": tool.GetInput("binding"),
            "mode": tool.GetInput("mode"),
            "status": tool.GetInput("status"),
        }
        break

print(json.dumps(result))
