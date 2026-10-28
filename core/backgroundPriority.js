// @ts-check
// Background work (grid proxies, thumbnails, shot detection) runs BELOW the interface.
//
// Each of these spawns ffmpeg or Python processes that decode video on the CPU: up to a dozen proxy
// encodes, a dozen thumbnail seeks and a detection decoding a whole episode can run at once. At normal
// priority they take the same share of the CPU as the WebView and this service, so a click waited
// behind them and the grid's own <video> decoders starved while scrolling. Below normal, they only
// get what the interface leaves; with nothing else to do they still use the whole machine.
// On Windows a child inherits its parent's priority class, so the ffmpeg a Python sidecar spawns
// lands below normal too.

const os = require('os');

/** @param {{ pid?: number } | null | undefined} child */
function lowerPriority(child) {
  if (!child || !child.pid) return;
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) { /* process already gone */ }
}

module.exports = { lowerPriority };
