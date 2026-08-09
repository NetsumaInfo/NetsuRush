// @ts-check
// core/resolve-bridge.js
// Spawn persistant de resolve_helper.py et dialogue JSON-lines. Resolve est piloté
// DEPUIS L'EXTÉRIEUR via le module Python DaVinciResolveScript (pas de binding JS natif).
//
// API : connect() / status() / reset() / invoke(handle, method, args) / listMediaPool() / readTimeline(name).
// invoke() renvoie un scalaire OU un handle opaque {__handle__} re-passable en argument
// → la frame-math (3 invariants) reste écrite en JS, seuls les appels Resolve transitent ici.

const { spawn } = require("node:child_process");
const path = require("node:path");
const { CONFIG, RESOLVE_PYTHON } = require("./config");

// Env scripting Resolve. Defaults Windows ; surchargeables via nr.config.json (install).
function bridgeEnv() {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  const api =
    CONFIG.resolveScriptApi ||
    "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting";
  const lib =
    CONFIG.resolveScriptLib ||
    "C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll";
  env.RESOLVE_SCRIPT_API = api;
  env.RESOLVE_SCRIPT_LIB = lib;
  env.PYTHONPATH = path.join(api, "Modules") + (env.PYTHONPATH ? path.delimiter + env.PYTHONPATH : "");
  return env;
}

// Garde-fou anti-gel : un appel Resolve qui ne répond jamais (helper Python bloqué sur l'API pendant
// un switch de projet, handle wedgé…) figerait TOUTE l'UI, le pont étant SÉQUENTIEL et sans échéance.
// 90 s : les invokes réels sont sous-seconde et les ops JS s'awaitent en série (jamais empilées dans
// `pending` par simple file d'attente) → ce délai ne se déclenche que sur un vrai blocage. Au feu : on
// rejette l'appel ET on tue le helper (respawn au prochain appel) → l'app récupère au lieu de geler.
const RPC_TIMEOUT_MS = 90_000;

function createResolveBridge() {
  let child = null;
  let buf = "";
  let seq = 1;
  const pending = new Map();

  function ensure() {
    if (child) return;
    const helper = path.join(__dirname, "resolve_helper.py");
    child = spawn(RESOLVE_PYTHON, ["-u", helper], { env: bridgeEnv() });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || "resolve helper error"));
      }
    });
    child.stderr.on("data", () => {}); // le helper logge sur stdout uniquement
    child.on("exit", () => {
      for (const p of pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(new Error("resolve helper terminé")); }
      pending.clear();
      child = null;
    });
    child.on("error", (err) => {
      for (const p of pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(err); }
      pending.clear();
      child = null;
    });
  }

  function rpc(method, params) {
    ensure();
    const id = seq++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      // Échéance dure : au-delà de RPC_TIMEOUT_MS sans réponse, on considère le helper figé → reject +
      // kill (le child=null force un respawn propre au prochain appel ; les autres pending, coincés
      // derrière le même blocage, sont rejetés par le handler d'exit).
      entry.timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error("resolve helper sans réponse (timeout)"));
        try { if (child) child.kill(); } catch (_) {}
      }, RPC_TIMEOUT_MS);
      if (entry.timer.unref) entry.timer.unref();
      pending.set(id, entry);
      try {
        child.stdin.write(JSON.stringify({ id, method, params: params || {} }) + "\n");
      } catch (err) {
        pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err);
      }
    });
  }

  // Coupe-circuit de connexion. Quand Resolve est FERMÉ, le `connect` côté Python refait
  // `import DaVinciResolveScript` + `scriptapp("Resolve")` à CHAQUE appel : mesuré 4-6 s, payés par
  // toute lecture (statut, Media Pool, timelines) AVANT même de tomber sur le cache — qui, lui,
  // répond en 1 ms. Après un échec on renvoie donc « pas connecté » instantanément pendant
  // COOLDOWN_MS. Le poller (core/resolve-watch, via resolveSignature) sonde en `force` à sa propre
  // cadence → la détection de réouverture de Resolve est INCHANGÉE. Un succès réarme tout.
  const CONNECT_COOLDOWN_MS = 5000;
  let lastFailAt = 0;
  let lastFailErr = null;

  /** @param {{force?:boolean}} [opts] */
  async function connect(opts) {
    if (!(opts && opts.force) && lastFailAt && Date.now() - lastFailAt < CONNECT_COOLDOWN_MS) {
      return { connected: false, error: lastFailErr, cooldown: true };
    }
    try {
      const r = await rpc("connect");
      if (r && r.connected) { lastFailAt = 0; lastFailErr = null; }
      else { lastFailAt = Date.now(); lastFailErr = (r && r.error) || "Resolve injoignable"; }
      return r;
    } catch (e) {
      lastFailAt = Date.now();
      lastFailErr = String(e);
      throw e;
    }
  }

  return {
    connect,
    // Réarme le coupe-circuit : à appeler quand on SAIT que Resolve vient de (ré)ouvrir, pour ne pas
    // servir un « hors ligne » périmé pendant le reste du cooldown.
    resetBackoff: () => { lastFailAt = 0; lastFailErr = null; },
    status: () => rpc("status"),
    reset: () => rpc("reset"),
    invoke: (handle, method, args) => rpc("invoke", { handle, method, args }),
    // Attribut simple (constantes d'export EXPORT_FCP_7_XML…) : ce ne sont pas des méthodes, et
    // les figer en dur côté JS les lierait à une version de Resolve.
    attr: (handle, name) => rpc("attr", { handle, name }),
    listMediaPool: () => rpc("listMediaPool"),
    readTimeline: (name) => rpc("readTimeline", { name: name || null }),
    sig: () => rpc("resolveSig"),
    stop: () => {
      if (child) {
        try {
          child.kill();
        } catch {}
        child = null;
      }
    },
  };
}

module.exports = { createResolveBridge };