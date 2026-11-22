"""Background priority for the heavy sidecars (indexing, cut detection).

At normal priority, eight ffmpeg decoders plus the Python workers held every core at 100 % and the
app's own UI stalled while an index ran. Below-normal keeps all the idle CPU for the job but lets
the interface go first. On Windows, child processes inherit a below-normal class, so the ffmpeg
processes these sidecars spawn follow without being touched one by one."""
import os
import sys


def lower_if_asked():
    if os.environ.get("NETSURUSH_LOW_PRIORITY") != "1":
        return
    try:
        if sys.platform == "win32":
            import ctypes
            BELOW_NORMAL_PRIORITY_CLASS = 0x4000
            kernel32 = ctypes.windll.kernel32
            kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS)
        else:
            os.nice(5)
    except Exception:  # noqa: BLE001  (priority is a comfort, never a reason to fail)
        pass
