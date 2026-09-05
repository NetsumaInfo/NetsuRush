// @ts-check
// NetsuFlow: supervises the out-of-process renderer that turns a web composition
// into frames, and proxies its HTTP editor API.
//
// Why a separate process rather than rendering inside the core: the renderer
// drives a full Chromium through the HyperFrames engine. A crash there must not
// take the core down, and its memory must be reclaimable by restarting one
// child rather than the application. The service already exists as a standalone
// prototype with its own protocol for the OpenFX plugin; this module is the
// application's half of that same service, not a second copy of it.
//
// Control goes through IPC (`flow:*`), pixels do not: a 1080p frame is 8.3 MiB
// raw, and base64 through the IPC channel for every scrub step would be absurd.
// Frames are served by `core/server.js` on `/flow/frame`, which the renderer
// consumes as a plain `<img>` URL.

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const logbus = require("./logbus");

const SERVICE_DIR = path.join(__dirname, "..", "Netsuflow", "prototypes", "hyperframes-renderer");
const SERVICE_ENTRY = path.join(SERVICE_DIR, "server.mjs");

/// The service prints one JSON line naming its ports once both servers listen.
/// Nothing else announces readiness, so this is the readiness signal.
const READY_TIMEOUT_MS = 40_000;
/// A render can legitimately take ~300 ms cold; a bake sweep answers instantly.
/// The ceiling exists so a wedged child surfaces as an error instead of a hang.
const REQUEST_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 3_000;

/// Reasons the service cannot start that are worth telling the user plainly,
/// because each has a different fix and none is a bug in this module.
function missingPrerequisite() {
  if (!fs.existsSync(SERVICE_ENTRY)) return `renderer service not found at ${SERVICE_ENTRY}`;
  if (!fs.existsSync(path.join(SERVICE_DIR, "node_modules"))) {
    return `renderer dependencies are not installed (npm install in ${SERVICE_DIR})`;
  }
  if (!fs.existsSync(path.join(SERVICE_DIR, ".browser"))) {
    return `renderer browser is not provisioned (node tools/install-chrome.mjs in ${SERVICE_DIR})`;
  }
  return null;
}

function createFlow() {
  /** @type {import('child_process').ChildProcess | null} */
  let child = null;
  /** @type {{ port: number, editorPort: number, sessionFile: string } | null} */
  let ports = null;
  /** @type {Promise<{ port: number, editorPort: number, sessionFile: string }> | null} */
  let starting = null;
  let lastError = "";

  function clear() {
    child = null;
    ports = null;
    starting = null;
  }

  /// Resolves when the service announces its ports, rejects on early exit.
  /// The child is killed on timeout rather than left behind: a service that
  /// never announced is one nothing can reach, and it holds a browser.
  function awaitAnnouncement(proc) {
    return new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("renderer service did not announce its port in time"));
      }, READY_TIMEOUT_MS);

      const settleFailure = (message) => {
        clearTimeout(timer);
        reject(new Error(message));
      };

      proc.stdout?.on("data", (chunk) => {
        buffer += String(chunk);
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line.startsWith("{")) continue;
          try {
            const announced = JSON.parse(line);
            if (typeof announced.editorPort !== "number" || announced.editorPort <= 0) continue;
            clearTimeout(timer);
            resolve({
              port: announced.port,
              editorPort: announced.editorPort,
              sessionFile: announced.sessionFile ?? "",
            });
            return;
          } catch {
            // Engine logs share this stream and are not all JSON. A line that
            // does not parse is log output, not a failure to report.
          }
        }
      });
      // The engine writes its own diagnostics to stderr continuously, so this
      // is a log feed rather than an error channel; only an exit is fatal.
      proc.stderr?.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) logbus.emit("flow", "info", text.slice(0, 500));
      });
      proc.on("error", (error) => settleFailure(`renderer service failed to spawn: ${error.message}`));
      proc.on("exit", (code) => settleFailure(`renderer service exited (code ${code})`));
    });
  }

  async function start() {
    if (ports) return ports;
    if (starting) return starting;

    const missing = missingPrerequisite();
    if (missing) {
      lastError = missing;
      throw new Error(missing);
    }

    starting = (async () => {
      // `--paste` is the mode the OpenFX node already uses: one spooled
      // composition the editor writes and the plugin reads. The application
      // edits that same spool, so both surfaces stay on one binding.
      const proc = spawn(process.execPath, [SERVICE_ENTRY, "--paste"], {
        cwd: SERVICE_DIR,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = proc;
      proc.on("exit", (code) => {
        if (child === proc) {
          clear();
          lastError = `renderer service stopped (code ${code})`;
          logbus.emit("flow", "warn", lastError);
        }
      });
      try {
        ports = await awaitAnnouncement(proc);
      } catch (error) {
        clear();
        lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
      lastError = "";
      logbus.emit("flow", "info", `renderer service ready on ${ports.editorPort}`);
      starting = null;
      return ports;
    })();

    return starting;
  }

  async function stop() {
    const proc = child;
    if (!proc) return { ok: true };
    clear();
    proc.kill();
    // SIGTERM leaves a browser behind if the service is mid-capture, so the
    // grace period is followed by a hard kill rather than by hoping.
    await new Promise((resolve) => {
      const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve(undefined); }, STOP_GRACE_MS);
      proc.on("exit", () => { clearTimeout(timer); resolve(undefined); });
    });
    return { ok: true };
  }

  /// One place that talks HTTP to the service. Every caller below is a thin
  /// wrapper, so a change of transport touches this function only.
  async function request(method, route, body) {
    const live = await start();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`http://127.0.0.1:${live.editorPort}${route}`, {
        method,
        signal: controller.signal,
        ...(body === undefined ? {} : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
      const payload = /** @type {any} */ (await response.json());
      if (!response.ok) throw new Error(payload?.error || `${route} failed (${response.status})`);
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /// Never starts the service: the page asks for status on mount, and opening
    /// a tab must not spawn a browser the user did not ask for.
    status: () => ({
      running: Boolean(ports),
      editorPort: ports?.editorPort ?? 0,
      bridgePort: ports?.port ?? 0,
      error: lastError,
      ready: missingPrerequisite() === null,
      prerequisite: missingPrerequisite() ?? "",
    }),
    start: async () => {
      const live = await start();
      return { ok: true, editorPort: live.editorPort, bridgePort: live.port };
    },
    stop,
    editorPort: () => ports?.editorPort ?? 0,

    state: () => request("GET", "/api/state"),
    save: (options) => request("POST", "/api/save", options ?? {}),
    send: () => request("POST", "/api/send", {}),

    bakeProgress: () => request("GET", "/api/bake"),
    bake: () => request("POST", "/api/bake", {}),
    bakeClear: () => request("POST", "/api/bake/clear", {}),
    bakeQuality: (quality) => request("POST", "/api/bake/quality", { quality }),

    exportInfo: () => request("GET", "/api/export"),
    exportStart: (options) => request("POST", "/api/export", options ?? {}),
    exportCancel: () => request("POST", "/api/export/cancel", {}),

    browse: (target) => request(
      "GET",
      `/api/browse${target ? `?path=${encodeURIComponent(target)}` : ""}`,
    ),
    browseNative: (target) => request("POST", "/api/browse/native", { path: target ?? "" }),
  };
}

// One service, one instance: `core/rpc.js` drives it and `core/server.js` reads
// its port to stream frames. A factory would hand each of them a separate
// supervisor, and the second one would spawn a second browser.
const flow = createFlow();

module.exports = { flow, SERVICE_DIR };
