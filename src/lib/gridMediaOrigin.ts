// Origin that serves grid media when the Tauri asset protocol is absent (Adobe CEP panel, browser).
//
// Chromium pools HTTP/1.1 connections per host name, six to a pool. On 127.0.0.1 the panel already
// holds two of them for good (the shell's EventSource and the app's), and every /rpc queues there
// too, so dozens of <video> were left with three or four sockets. The same core under its other
// loopback name gets a pool of its own. The core's media guard accepts both names.
const SIBLING_HOST: Record<string, string> = {
  "127.0.0.1": "localhost",
  localhost: "127.0.0.1",
};

// The core binds 127.0.0.1 only, while `localhost` may be tried on ::1 first. Windows is slow to
// refuse that attempt, and whatever else listens on [::1] at this port would receive every grid
// URL, token included. So the sibling is used only once it has answered quickly as this very core.
const PROBE_BUDGET_MS = 150;

export function gridMediaOrigin(base: string): string {
  const url = new URL(base);
  url.hostname = SIBLING_HOST[url.hostname] ?? url.hostname;
  return url.origin;
}

/** The sibling origin once proven to be the same core; null keeps grid media on `base`. */
export async function verifiedGridMediaOrigin(base: string): Promise<string | null> {
  try {
    const origin = gridMediaOrigin(base);
    const { origin: own, port } = new URL(base);
    if (origin === own) return null;
    // /healthz carries no token, so the probe itself hands nothing to a stranger. A unique URL names
    // exactly one timing entry.
    const url = `${origin}/healthz?probe=${Date.now()}`;
    const started = performance.now();
    const response = await fetch(url, { cache: "no-store" });
    const beacon = response.ok ? (await response.json()) as { app?: unknown; port?: unknown } : null;
    const sameCore = beacon?.app === "netsurush" && String(beacon.port) === port;
    // The network stack stamps the timing entry; the wall clock would also count every task that held
    // the main thread meanwhile, a first render included. It is only the fallback.
    const entry = performance.getEntriesByName(url).pop();
    const elapsed = entry ? entry.duration : performance.now() - started;
    return sameCore && elapsed <= PROBE_BUDGET_MS ? origin : null;
  } catch {
    return null; // unparsable base, or nothing answers under that name: grid media stay on `base`
  }
}
