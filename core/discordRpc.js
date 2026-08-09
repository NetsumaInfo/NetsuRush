// @ts-check
// core/discordRpc.js
// Rich Presence Discord : montre « joue à NetsuRush — Derush » sur le profil de l'utilisateur.
//
// Client IPC MAISON (zéro dépendance). La lib officielle `discord/discord-rpc` est du C++ DÉPRÉCIÉ par
// Discord ; le protocole local, lui, tient en une page : une named pipe + des frames JSON préfixées.
// L'App ID est celle de l'app OAuth beta (elle est PUBLIQUE — c'est le client_secret qui est sensible,
// et lui ne quitte jamais l'env Convex, cf. convex/auth.ts).
//
// Protocole (référence : discord/discord-rpc/documentation/hard-mode.md) :
//   • pipes \\?\pipe\discord-ipc-0 … -9 — plusieurs clients Discord (Stable/PTB/Canary) peuvent
//     cohabiter, chacun tenant la sienne → on sonde 0→9 et on garde la première qui répond.
//   • frame = [opcode uint32 LE][longueur uint32 LE][JSON utf8], écrite en UN SEUL write : deux writes
//     séparés entrelacent le header et le corps côté pipe Windows → la connexion casse.
//   • 0 HANDSHAKE {v:1, client_id} → Discord répond DISPATCH/READY avec l'utilisateur connecté.
//   • 3 PING → il FAUT renvoyer 4 PONG avec le nonce reçu tel quel, sinon Discord nous coupe.
//   • SET_ACTIVITY est plafonné à 1 envoi / 15 s ; au-delà Discord ignore EN SILENCE (aucune erreur,
//     aucune déconnexion) → sans throttle, la dernière présence peut ne jamais s'afficher.
//
// Discord absent = cas NOMINAL, pas une panne : tout échoue en silence et on retente en arrière-plan.

const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// App ID (client_id OAuth) de l'application Discord — publique. Vide = présence inactive tant qu'elle
// n'est pas renseignée (constante ici, ou `discordAppId` dans nr.config.json, ou env NR_DISCORD_APP_ID).
const DEFAULT_APP_ID = '1528402947522953316';

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const PIPE_COUNT = 10;          // discord-ipc-0 … -9
const THROTTLE_MS = 15_000;     // plafond Discord : 1 SET_ACTIVITY / 15 s
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000; // pipe qui accepte sans jamais répondre READY
const LARGE_IMAGE = 'nr_logo';  // clé d'asset (portail dev › Rich Presence › Art Assets)
// Info PUBLIQUE de l'application (nom + icône), sans authentification : c'est ce que Discord affiche
// réellement sur le profil. Sert UNIQUEMENT à rendre l'aperçu des Paramètres fidèle.
const API = 'https://discord.com/api';
const CDN = 'https://cdn.discordapp.com';
const TEXT_MIN = 2;             // Discord rejette une ligne de moins de 2 caractères
const TEXT_MAX = 128;

/** @typedef {{ enabled:boolean, showModule:boolean, showProject:boolean, showElapsed:boolean, detailsTpl:string, stateTpl:string }} DiscordPrefs */

/** @type {DiscordPrefs} */
const DEFAULT_PREFS = {
  enabled: false,
  showModule: true,
  showProject: false, // vie privée : un nom de projet peut trahir un client → opt-in explicite
  showElapsed: true,
  detailsTpl: '',
  stateTpl: '',
};

/**
 * Réglages sûrs à partir de n'importe quoi. Les deux sources sont non typées à l'exécution (JSON sur
 * disque, patch venu du RPC) : sans ça, un `detailsTpl: null` fait exploser `.trim()` dans un callback
 * de timer — donc hors de tout try/catch, donc le core meurt.
 * @param {any} raw
 * @returns {DiscordPrefs}
 */
function sanitizePrefs(raw) {
  const out = { ...DEFAULT_PREFS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of /** @type {const} */ (['enabled', 'showModule', 'showProject', 'showElapsed'])) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  for (const k of /** @type {const} */ (['detailsTpl', 'stateTpl'])) {
    if (typeof raw[k] === 'string') out[k] = raw[k];
  }
  return out;
}

/**
 * GET JSON, court et sans dépendance. Timeout : une API muette ne doit pas laisser une requête pendre.
 * @param {string} url
 * @returns {Promise<any>} frontière réseau : le contenu n'est garanti par rien, les appelants gardent.
 */
async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const pipePath = (i) => (process.platform === 'win32'
  ? `\\\\?\\pipe\\discord-ipc-${i}`
  : path.join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp', `discord-ipc-${i}`));

/** Ligne d'activité valide, ou undefined : Discord veut 2..128 caractères, et refuse une string vide. */
function clampText(s) {
  const t = String(s ?? '').trim();
  if (t.length < TEXT_MIN) return undefined;
  return t.length > TEXT_MAX ? t.slice(0, TEXT_MAX) : t;
}

/** Substitue {module} / {projet} dans un gabarit utilisateur. */
function fillTemplate(tpl, ctx) {
  return String(tpl)
    .replace(/\{module\}/g, ctx.module || '')
    .replace(/\{projet\}/g, ctx.project || '');
}

/**
 * @param {object} deps
 * @param {any} deps.CONFIG
 * @param {(channel:string, payload:any)=>void} deps.broadcast
 * @param {string} deps.dataDir
 */
function createDiscordRpc({ CONFIG, broadcast, dataDir }) {
  const appId = String(CONFIG?.discordAppId || process.env.NR_DISCORD_APP_ID || DEFAULT_APP_ID || '');
  const prefsFile = path.join(dataDir, 'discord-rpc.json');

  /** @type {DiscordPrefs} */
  let prefs = { ...DEFAULT_PREFS };
  try {
    prefs = sanitizePrefs(JSON.parse(fs.readFileSync(prefsFile, 'utf8')));
  } catch (_) { /* premier lancement */ }

  /** @type {import('node:net').Socket | null} */
  let sock = null;
  let probing = false; // une sonde 0→9 est en vol (sock encore null) — cf. connect()
  let buf = Buffer.alloc(0);
  /** @type {{ username?:string, global_name?:string } | null} */
  let user = null;
  let connected = false;
  /** @type {string | null} */
  let error = null;
  let stopped = false;
  /** @type {{ name:string, imageUrl:string|null } | null} */
  let appInfo = null; // nom + vignette réels de l'app Discord (aperçu des Paramètres)
  let appInfoLoading = false;

  /** @type {{ module:string|null, project:string|null }} */
  let ctx = { module: null, project: null };
  const startedAt = Math.floor(Date.now() / 1000); // « temps écoulé » = depuis l'ouverture de NetsuRush

  let retryMs = RECONNECT_MIN_MS;
  /** @type {NodeJS.Timeout | null} */
  let retryTimer = null;
  /** @type {NodeJS.Timeout | null} */
  let throttleTimer = null;
  /** @type {NodeJS.Timeout | null} */
  let handshakeTimer = null;
  let lastSentAt = 0;
  let pending = false; // une activité attend la fin de la fenêtre de 15 s

  function persist() {
    try {
      const tmp = prefsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(prefs));
      fs.renameSync(tmp, prefsFile);
    } catch (_) { /* best-effort */ }
  }
  /**
   * Nom + vignette RÉELS de l'application, tels que Discord les affichera. Sans l'asset `nr_logo`,
   * Discord retombe sur l'icône de l'app : l'aperçu doit faire exactement le même repli, sinon il
   * montre une image que personne ne verra jamais. Endpoints publics, aucun jeton — et le core les
   * appelle plutôt que le renderer : pas de CORS, et une seule requête pour toute la session.
   */
  async function loadAppInfo() {
    if (!appId || appInfo || appInfoLoading) return;
    appInfoLoading = true;
    try {
      const rpc = await fetchJson(`${API}/v10/applications/${appId}/rpc`);
      let imageUrl = rpc?.icon ? `${CDN}/app-icons/${appId}/${rpc.icon}.png?size=160` : null;
      // `large_image` désigne l'asset s'il existe : il gagne sur l'icône.
      try {
        const assets = await fetchJson(`${API}/v9/oauth2/applications/${appId}/assets`);
        const hit = Array.isArray(assets) && assets.find((a) => a && a.name === LARGE_IMAGE);
        if (hit) imageUrl = `${CDN}/app-assets/${appId}/${hit.id}.png?size=160`;
      } catch (_) { /* pas d'asset publié : l'icône fait le travail, comme sur le profil */ }
      appInfo = { name: String(rpc?.name || 'NetsuRush'), imageUrl };
      emit();
    } catch (_) {
      /* hors ligne ou App ID inconnue : l'aperçu garde son repli local, rien à signaler */
    } finally {
      appInfoLoading = false;
    }
  }

  function snapshot() {
    // `preview` = l'activité RÉELLE que produirait un envoi maintenant (toggle ignoré). L'aperçu des
    // Paramètres l'affiche tel quel : une seconde implémentation côté renderer finirait par diverger
    // du rendu Discord (clamps 2..128, gabarits, toggles).
    return { enabled: prefs.enabled, connected, user, appId: !!appId, prefs, error, preview: buildActivity(true), app: appInfo };
  }
  function emit() {
    try { broadcast && broadcast('discord:changed', snapshot()); } catch (_) {}
  }

  // --- Transport -----------------------------------------------------------

  function writeFrame(op, payload) {
    if (!sock || sock.destroyed) return;
    try {
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const head = Buffer.alloc(8);
      head.writeUInt32LE(op, 0);
      head.writeUInt32LE(body.length, 4);
      sock.write(Buffer.concat([head, body])); // header + corps en UN write, cf. en-tête de fichier
    } catch (_) { /* pipe morte : le handler 'close' relancera */ }
  }

  /** Un chunk peut couper une frame en deux ou en contenir plusieurs → on accumule et on découpe. */
  function onData(chunk) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const op = buf.readUInt32LE(0);
      const len = buf.readUInt32LE(4);
      if (buf.length < 8 + len) break; // frame incomplète : on attend la suite
      const body = buf.subarray(8, 8 + len).toString('utf8');
      buf = buf.subarray(8 + len);
      let msg = null;
      try { msg = JSON.parse(body); } catch (_) { continue; }
      handleFrame(op, msg);
    }
  }

  function handleFrame(op, msg) {
    if (op === OP_PING) { writeFrame(OP_PONG, msg); return; } // nonce renvoyé tel quel
    if (op === OP_CLOSE) { error = msg?.message || null; teardown(); return; }
    if (op !== OP_FRAME) return;
    if (msg?.cmd === 'DISPATCH' && msg?.evt === 'READY') {
      if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
      connected = true;
      error = null;
      retryMs = RECONNECT_MIN_MS;
      user = msg?.data?.user ? { username: msg.data.user.username, global_name: msg.data.user.global_name } : null;
      emit();
      push(true); // première présence dès la connexion, sans attendre un changement d'onglet
    }
  }

  /**
   * Sonde les pipes 0→9 : la première qui accepte est la bonne (Stable, PTB ou Canary).
   * `probing` est indispensable : `sock` reste null pendant toute la sonde, donc sans ce drapeau un
   * simple aller-retour sur le toggle lance une 2e boucle et on finit avec deux sockets vivants.
   */
  function connect() {
    if (stopped || sock || probing || !prefs.enabled || !appId) return;
    probing = true;
    let i = 0;
    const tryPipe = () => {
      if (stopped || !prefs.enabled) { probing = false; return; }
      if (i >= PIPE_COUNT) { probing = false; scheduleRetry(); return; } // Discord n'est pas lancé : on retentera
      const s = net.createConnection(pipePath(i));
      let settled = false;
      s.once('connect', () => {
        settled = true;
        probing = false;
        // La sonde est asynchrone : entre-temps l'utilisateur a pu couper la présence, ou le core
        // s'arrêter. Sans ce garde, on publierait une présence pendant l'extinction.
        if (stopped || !prefs.enabled) { s.destroy(); return; }
        sock = s;
        buf = Buffer.alloc(0);
        s.on('data', onData);
        s.on('error', () => teardown(s));
        s.on('close', () => teardown(s));
        writeFrame(OP_HANDSHAKE, { v: 1, client_id: appId });
        // Une pipe qui accepte mais ne répond jamais READY (un autre programme sur discord-ipc-N)
        // laisserait la connexion en suspens pour toujours : on la coupe et on retente.
        handshakeTimer = setTimeout(() => { if (!connected) teardown(s); }, HANDSHAKE_TIMEOUT_MS);
        if (handshakeTimer.unref) handshakeTimer.unref();
      });
      s.once('error', () => {
        if (settled) return; // socket déjà adopté : c'est le handler teardown ci-dessus qui gère
        s.destroy();
        i += 1;
        tryPipe(); // cette pipe n'existe pas → on essaie la suivante
      });
    };
    tryPipe();
  }

  /**
   * @param {import('node:net').Socket} [s] socket émetteur — un socket ORPHELIN (remplacé depuis) ne
   * doit surtout pas faire tomber la connexion courante en mourant.
   */
  function teardown(s) {
    if (s && sock && s !== sock) { try { s.destroy(); } catch (_) {} return; }
    if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
    if (sock) { try { sock.destroy(); } catch (_) {} }
    sock = null;
    buf = Buffer.alloc(0);
    const was = connected;
    connected = false;
    user = null;
    if (was) emit();
    scheduleRetry();
  }

  /** Backoff exponentiel plafonné — et seulement si la présence est active. */
  function scheduleRetry() {
    if (stopped || !prefs.enabled || !appId || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS);
      connect();
    }, retryMs);
    if (retryTimer.unref) retryTimer.unref();
  }

  // --- Activité ------------------------------------------------------------

  /**
   * Construit l'activité depuis les prefs + le contexte courant. `null` = présence effacée.
   * @param {boolean} [force] ignore le toggle maître — sert à l'APERÇU des Paramètres, qui doit montrer
   * ce que la présence donnerait même quand elle est coupée.
   */
  function buildActivity(force) {
    if (!prefs.enabled && !force) return null;
    const moduleLabel = prefs.showModule ? (ctx.module || '') : '';
    const projectLabel = prefs.showProject ? (ctx.project || '') : '';
    // Un gabarit renseigné REMPLACE la ligne auto (c'est tout l'intérêt de le proposer).
    const details = prefs.detailsTpl.trim()
      ? clampText(fillTemplate(prefs.detailsTpl, { module: moduleLabel, project: projectLabel }))
      : clampText(moduleLabel);
    const state = prefs.stateTpl.trim()
      ? clampText(fillTemplate(prefs.stateTpl, { module: moduleLabel, project: projectLabel }))
      : clampText(projectLabel);

    /** @type {Record<string, any>} */
    const activity = { assets: { large_image: LARGE_IMAGE, large_text: 'NetsuRush' } };
    if (details) activity.details = details;
    if (state) activity.state = state;
    if (prefs.showElapsed) activity.timestamps = { start: startedAt }; // SECONDES (pas des ms)
    return activity;
  }

  /**
   * @param {Record<string, any> | null} [explicit] activité forcée (null = effacer) ; sinon on construit
   * depuis les réglages courants.
   */
  function sendActivity(explicit) {
    lastSentAt = Date.now();
    pending = false;
    // Désarmer le timer en vol : il porte une échéance calculée sur un envoi PRÉCÉDENT. Le laisser
    // vivre le ferait tirer à l'intérieur de la fenêtre de 15 s → Discord ignore, et la garde
    // `if (throttleTimer) return` de push() empêchait tout ré-armement : présence figée.
    if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
    writeFrame(OP_FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: explicit === undefined ? buildActivity() : explicit }, // pid obligatoire ; null = efface
      nonce: crypto.randomUUID(),
    });
  }

  /**
   * Envoie l'activité en respectant le plafond de 15 s. Un envoi trop tôt serait ignoré EN SILENCE :
   * on garde donc l'intention (`pending`) et on rejoue le DERNIER état à l'ouverture de la fenêtre —
   * l'utilisateur qui zappe entre 5 onglets voit bien le 5e, pas le 1er.
   * @param {boolean} [now] contourne le throttle (connexion, ou bascule du toggle : réponse immédiate)
   */
  function push(now) {
    if (!connected) return;
    const since = Date.now() - lastSentAt;
    if (now || since >= THROTTLE_MS) { sendActivity(); return; }
    pending = true;
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      if (pending && connected) sendActivity();
    }, THROTTLE_MS - since);
    if (throttleTimer.unref) throttleTimer.unref();
  }

  // --- API publique --------------------------------------------------------

  function state() {
    void loadAppInfo(); // rattrape un boot hors ligne : l'aperçu se complètera via SSE
    return snapshot();
  }

  /** @param {Partial<DiscordPrefs>} patch */
  function setPrefs(patch) {
    const was = prefs.enabled;
    prefs = sanitizePrefs({ ...prefs, ...patch }); // le patch vient du RPC : rien n'est garanti
    persist();
    if (!prefs.enabled && was) {
      // Fermer la pipe suffit à retirer la présence ; l'effacement explicite est une ceinture (il peut
      // tomber dans la fenêtre de throttle et être ignoré, d'où le teardown juste après).
      if (connected) sendActivity(null);
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      teardownQuiet();
    } else if (prefs.enabled && !was) {
      retryMs = RECONNECT_MIN_MS;
      connect();
    } else if (prefs.enabled) {
      // Throttle NORMAL, surtout pas de bypass : la frappe dans un champ texte appelle setPrefs à
      // chaque caractère. Forcer l'envoi noierait Discord de frames qu'il ignore en silence, et le
      // texte FINAL serait le seul à passer à la trappe. L'aperçu des Paramètres, lui, est instantané.
      push();
    }
    emit();
    return snapshot();
  }

  /**
   * Ferme la connexion sans programmer de reconnexion (toggle off / arrêt du core). La sonde
   * éventuellement en vol se sabordera d'elle-même : son callback `connect` relit `stopped`/`enabled`.
   */
  function teardownQuiet() {
    if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
    if (sock) { try { sock.destroy(); } catch (_) {} }
    sock = null;
    buf = Buffer.alloc(0);
    connected = false;
    user = null;
  }

  /** @param {{ module?:string|null, project?:string|null }} next */
  function setContext(next) {
    const module = next?.module ?? null;
    const project = next?.project ?? null;
    if (module === ctx.module && project === ctx.project) return snapshot();
    ctx = { module, project };
    push();
    emit(); // l'aperçu des Paramètres suit le module ouvert, sans attendre le throttle de 15 s
    return snapshot();
  }

  function stop() {
    stopped = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
    if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
    // Effacement explicite puis fermeture (c'est elle qui conclut). On passe `null` SANS toucher à
    // `prefs` : le muter ici risquerait de faire persister `enabled:false` par un setPrefs en vol
    // (le core met un instant à mourir) → la présence ne reviendrait jamais au prochain lancement.
    if (connected) sendActivity(null);
    teardownQuiet();
  }

  function boot() {
    void loadAppInfo(); // même présence coupée : l'aperçu des Paramètres doit être fidèle
    if (prefs.enabled) connect();
  }

  return { state, setPrefs, setContext, stop, boot };
}

module.exports = { createDiscordRpc };
