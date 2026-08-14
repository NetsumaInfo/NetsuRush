// @ts-check
// core/rpc.js
// Câblage des canaux métier en HTTP (ex-ipcMain.handle). Expose :
//   POST /rpc   { channel, args:[...] } -> { ok, result } | { ok:false, error }
//   GET  /events  (SSE)                 -> push { channel, payload } (barres de progression)
// Les modules métier sont des modules core/ (electron-free). L'argument Electron `e`
// (utilisé pour e.sender.send des progressions) est remplacé par un shim qui diffuse en SSE.
//
// Les canaux resolve:* exigent le pont Python externe actif (Resolve + scripting externe = Local).

const path = require("path");
const { CONFIG, DATA_DIR, saveConfig } = require("./config");
const { watchModules } = require("./devReload");
const { t } = require("./i18n");
const ffmpeg = require("./ffmpeg");
const thumbs = require("./thumbs");
const proxy = require("./proxy");
const resolveMod = require("./resolve"); // pont Python externe à resolve-proxy
const { beginResolveOp, endResolveOp, bridge, getOpDepth } = require("./resolve-proxy"); // bracket d'op (reset sûr du registre) + pont brut (arrêt/reconnexion)
const timeline = require("./timeline"); // frame-math identique, Resolve via le pont
const sidecars = require("./sidecars");
const turbo = require("./turbo"); // panier temps réel : shader GLSL libplacebo, RTX VSR ou ArtCNN R ONNX
const models = require("./models"); // gestionnaire de modèles app-wide (download à la demande / delete / statut)
const scheduler = require("./scheduler"); // mesure VRAM (nvidia-smi) — sert l'avertissement de la page Modèles
const pipeline = require("./pipeline"); // pipeline ordonné : chaîne de transforms fichier→fichier
const roto = require("./roto"); // Roto Studio : daemon SAM interactif (scaffold)
const dictate = require("./dictate"); // dictée vocale push-to-talk (réutilise le daemon whisper)
const voice = require("./voice"); // module voix : transcription + silences (sous-titres, montage texte)
const exportMod = require("./export"); // export fichier piloté par profil (remux/encode, GPU/CPU, merge)
const audioLang = require("./audioLang"); // normalisation des étiquettes de langue des pistes audio
const { createReferenceStore, scanFolder, writeExportFile } = require("./reference");
const wallpaper = require("./wallpaper");
const { createCollectionStore } = require("./collections"); // dossiers de plans gardés (bibliothèque)
const { createCollectionArchive } = require("./collectionArchive"); // archivage disque d'une collection + changement de dossier
const { createArchiveQueue } = require("./archiveQueue"); // archivages différés (upscale = GPU pris longtemps)
const { createUpscaleLedger } = require("./upscaleLedger"); // registre des sorties d'upscale (anti double production)
const encodeGate = require("./export/gate"); // portail global du nombre d'encodages en vol
const { createLibraryStore } = require("./library"); // rushs importés (entrée du derush, sans Media Pool)
const { createCutEditsStore } = require("./cutEdits"); // édits de découpe persistés par modèle (Découpage)
const { createScriptStore } = require("./script"); // documents script : docs/blocs/médias
const { createNotebookStore } = require("./notebook"); // module Carnet : carnets → pages → databases
const { createNbFile } = require("./nbfile"); // partage commun .netsu du Carnet (ZIP type-routé)
const recordings = require("./recordings"); // dossier d'enregistrements voix off (module Script)
const netsu = require("./netsu"); // format de partage « .netsu » (board → conteneur SQLite type-routé)
const extract = require("./extract"); // yt-dlp / gallery-dl : extraction du vrai média d'un lien
const netsuSidecar = require("./netsu/sidecar");
const { createAeExport } = require("./aeExport");
const { createTransfer } = require("./transfer");
const { createAdobeBridge } = require("./adobe"); // pont Adobe : panneau CEP Premiere/AE ↔ core
const { createPrefs } = require("./prefs"); // réglages renderer partagés entre origines
const { createUiState } = require("./uistate"); // miroir durable du localStorage du renderer
const { createAdobeBoost } = require("./adobeBoost"); // NetsuBoost côté Premiere/AE (caches, réglages, proxies)
const { createResolveWatch } = require("./resolve-watch");
const { createOutbox } = require("./outbox"); // « cache projet » : file d'envois différés (hôte fermé)
const { createHostPower } = require("./hostPower"); // fermer/rouvrir le logiciel de montage (libérer RAM/GPU)
const { createDiscordRpc } = require("./discordRpc"); // Rich Presence Discord (client IPC maison, named pipe)
const { createProjectSnapshot } = require("./projectSnapshot"); // photo des lectures Resolve servie offline (hôte fermé)
const { createProjectRegistry } = require("./projectRegistry"); // registre projet → rushs (portée de recherche)
const { createProjectScan } = require("./projectScan"); // recensement des projets existants (portée)
const setup = require("./setup"); // provisionnement 1er lancement (venv/ffmpeg/poids)
const compatibility = require('./compatibility'); // matériel + runtimes IA/encodage réellement actifs
const optimize = require("./optimize"); // onglet Optimisation : diagnostic + arrêt de tâches + nettoyage cache
const resolvePrefs = require("./resolvePrefs"); // prefs Resolve sur disque (l'API de scripting ne les expose pas)
const { cacheIndex } = require("./cacheIndex"); // index latéral fichier de cache → rush source
const { createCacheAdmin } = require("./cacheAdmin"); // Paramètres › Stockage : mesure + purge ciblée
const { createCacheMove } = require("./cacheMove"); // changement de dossier de cache + réindexation
const { createCachePolicy } = require("./cachePolicy"); // auto-purge par type (quota LRU + âge)
const { createAgent } = require("./agent"); // Chat IA : moteur hybride CLI/BYOK + outils + MCP
const logbus = require("./logbus"); // journal centralisé (core + sidecars python) → SSE `console:log`
const bugreport = require("./bugreport"); // envoi d'un rapport de bug → webhook Discord (Console)
const bugContext = require("./bugContext"); // instantané machine joint au rapport (specs auto)
const { createSearchCatalog } = require("./searchCatalog"); // compteurs NetsuSearch sans cold-start ML
const { searchModelState, setSearchModel } = require("./searchModel"); // variante SigLIP active

const JSONH = { "Content-Type": "application/json" };

function createRpc() {
  const searchCatalog = createSearchCatalog();
  const clients = new Set(); // flux SSE ouverts

  const broadcast = (channel, payload) => {
    const line = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const res of clients) {
      try {
        res.write(line);
      } catch {}
    }
  };
  // Shim de l'event Electron : les modules appellent e.sender.send(channel, payload).
  const ev = { sender: { send: (ch, p) => broadcast(ch, p) } };
  // Branche le journal sur la diffusion SSE et capte les console.* du core (démarrage, erreurs RPC).
  logbus.attach(broadcast);

  const refStore = createReferenceStore(DATA_DIR);
  const collectionStore = createCollectionStore(DATA_DIR);
  // Sondes injectées : la bibliothèque met les métas au format Resolve (timecode/résolution/codec) pour
  // que les rushs importés se lisent comme ceux du Media Pool dans la même grille.
  const libraryStore = createLibraryStore(DATA_DIR, { probeMedia: ffmpeg.probeMedia, playInfo: ffmpeg.playInfo });
  const cutEditsStore = createCutEditsStore(DATA_DIR);
  const scriptStore = createScriptStore(DATA_DIR);
  const notebookStore = createNotebookStore(DATA_DIR);
  const nbFile = createNbFile({ notebookStore, dataDir: DATA_DIR });
  const adobeBridge = createAdobeBridge({ CONFIG, broadcast });
  // Livraison de l'export AE par le panneau CEP quand After Effects est joignable : le script est
  // déroulé dans le projet OUVERT, au lieu de relancer AfterFX.exe en espérant qu'il soit prêt.
  // Upscale pendant un transfert : les MÊMES exécutants que NetsuLab et que l'archivage d'une
  // collection. Un quatrième chemin vers les moteurs les ferait diverger.
  const growDeps = {
    runUpscale: (ev2, args) => sidecars.runUpscale(ev2, args),
    runTurbo: (ev2, args) => turbo.runTurbo(sidecars, ev2, args),
  };
  const aeExporter = createAeExport({
    getResolve: resolveMod.getResolve, run: ffmpeg.run, CONFIG, ...growDeps,
    runAeScript: (ev2, jsxPath) => adobeBridge.runScript(ev2, 'aeft', jsxPath),
    aePanelConnected: async () => {
      const state = await adobeBridge.status();
      return !!(state && state.aeft && state.aeft.panelConnected);
    },
  });
  // Transfert de timeline entre hôtes (Resolve ⇄ Premiere ⇄ After Effects).
  const transferDeps = { getResolve: resolveMod.getResolve, adobeBridge, aeExporter, runFfmpeg: ffmpeg.run, ...growDeps, ev };
  let transfer = createTransfer(transferDeps);
  // En DEV, `core/transfer/**` se recharge sans redémarrer la fenêtre : le module ne tient ni
  // socket ni daemon, seulement des fonctions et des deps injectées. Les handlers lisent la
  // variable, donc ils voient l'objet reconstruit sans qu'on retouche la table `H`.
  // `require` À NOUVEAU, et pas la fonction capturée en tête de fichier : celle-ci vient du
  // cache d'AVANT la purge, donc la reconstruire ne rechargeait rien. Le compteur tombait à
  // « 0 module(s) » aux rechargements suivants, faute d'avoir jamais repeuplé le cache.
  const reloadTransfer = () => { transfer = require("./transfer").createTransfer(transferDeps); };
  // `core/ae/` est purgé avec : la lecture de timeline Resolve y vit (`ae/timelineRead`) et les
  // modules de transfert en capturent les fonctions au chargement — purger l'un sans l'autre
  // laissait l'ancien code tourner, redémarrage compris dans la facture.
  const aeDir = path.join(__dirname, "ae");
  watchModules(path.join(__dirname, "transfer"), reloadTransfer,
    { label: "transfert de timeline", also: [aeDir] });
  watchModules(aeDir, reloadTransfer,
    { label: "lecture de timeline", also: [path.join(__dirname, "transfer")] });
  // Réglages du renderer PARTAGÉS entre origines (app Tauri / panneau CEP / fenêtres détachées).
  const prefs = createPrefs({ broadcast });
  // Miroir durable du localStorage : le profil WebView2 n'est pas un stockage sûr (recréé, nettoyé,
  // ou simplement d'une autre origine) et l'utilisateur y perdait tous ses réglages.
  const uiState = createUiState({ broadcast });
  // Le panneau CEP est une COPIE dans %APPDATA% : une mise à jour de NetsuRush ne la touche pas.
  // On la resynchronise au démarrage (différé, jamais bloquant) quand elle est en retard.
  setTimeout(() => { adobeBridge.syncPanel().catch(() => {}); }, 1500);

  // Paramètres › Stockage. L'index est un singleton (thumbs/proxy/ffmpeg y écrivent sans injection) ;
  // on réutilise la même instance ici pour que lectures et écritures partagent le tampon.
  const cacheIdx = cacheIndex();
  cacheIdx.pruneMissing(); // le boot vient de vider le cache de session : retire ses lignes fantômes
  const cacheAdmin = createCacheAdmin({ cacheIndex: cacheIdx, broadcast });
  const cacheMove = createCacheMove({ cacheIndex: cacheIdx, broadcast });
  const cachePolicy = createCachePolicy({ cacheIndex: cacheIdx, admin: cacheAdmin, broadcast });
  cachePolicy.boot();   // auto-purge + contrôle des seuils, différés et non bloquants
  // Surveillance mémoire : elle ne s'arme que pendant une tâche lourde, et ne tue jamais rien
  // toute seule (elle libère le paginable, puis propose les arrêts).
  optimize.startWatchdog(broadcast);
  let lastRotoSourceKey = null;
  let lastTestFrameKey = null;

  /** Applique un déclencheur de cache de session. Le renderer signale uniquement un événement
   * métier (« page quittée ») ; la décision reste dans la config du core, donc elle fonctionne aussi
   * avec un renderer rechargé ou une fenêtre distante. */
  async function sessionCleanup(trigger, kinds) {
    const selected = (Array.isArray(kinds) ? kinds : [])
      .filter((kind) => cachePolicy.shouldClearSession(kind, trigger));
    if (!selected.length) return { ok: true, freed: 0, files: 0, skipped: true };
    if (selected.includes('roto')) {
      roto.killRoto();
      lastRotoSourceKey = null;
    }
    if (selected.includes('upscaleTest')) lastTestFrameKey = null;
    return cacheAdmin.clear({ kinds: selected });
  }

  async function prepareTestFrame(opts) {
    // Comparer plusieurs modèles sur la MÊME source/config est un cas central de NetsuLab : le modèle
    // ne fait donc PAS partie de la clé. On purge seulement quand la source, le temps ou un réglage
    // partagé change, puis on conserve les variantes A/B jusqu'à cette frontière.
    const { model: _model, ...shared } = opts || {};
    void _model;
    const key = JSON.stringify(shared);
    if (lastTestFrameKey && lastTestFrameKey !== key) {
      await sessionCleanup('operation', ['upscaleTest']);
    }
    lastTestFrameKey = key;
  }

  // « Cache projet » : file d'attente des envois différés (hôte fermé) → rejoués à la réouverture.
  // apply rejoue une entrée buildTimeline sur le bon hôte (Resolve natif / Adobe via panneau).
  const outbox = createOutbox({
    dataDir: DATA_DIR,
    broadcast,
    apply: async (entry) => {
      if (entry.host === 'resolve') return timeline.buildTimeline(entry.opts);
      return adobeBridge.buildTimeline(ev, { app: entry.host, ...entry.opts });
    },
  });

  // « Snapshot projet » : photo des lectures Resolve prise à la fermeture, servie offline pour que
  // rushes/timelines restent visibles pendant que l'hôte est fermé (effacée à la réouverture).
  const projectSnapshot = createProjectSnapshot({ dataDir: DATA_DIR, broadcast });
  // Registre projet → rushs : alimenté par chaque listMediaPool en ligne, il donne la portée
  // « projet » de la recherche (l'index ne connaît que des chemins de fichiers).
  const projectRegistry = createProjectRegistry({ dataDir: DATA_DIR });
  // Recensement à la demande : ouvre chaque projet tour à tour pour relever ses rushs (les projets
  // indexés avant l'arrivée du registre n'y figurent pas autrement).
  const projectScan = createProjectScan({
    getResolve: resolveMod.getResolve,
    listMediaPool: resolveMod.listMediaPool,
    registry: projectRegistry,
    broadcast,
  });
  // Lectures passées à snapshot.capture() : rOp-wrappées (protège le registre de handles). rOp est
  // défini plus bas mais ces closures ne sont invoquées qu'à la fermeture → référence résolue au call.
  const captureReaders = {
    // Une seule lecture complète : projectSnapshot conserve la liste entière pour NetsuDraft et en
    // dérive sa tranche vidéo historique pour NetsuCut/les autres consommateurs hors ligne.
    listMediaPool: () => rOp(() => resolveMod.listMediaPool({ includeAudio: true }))(),
    listTimelines: () => rOp(() => timeline.listTimelines())(),
    timelineTree: () => rOp(() => timeline.timelineTree())(),
    timelineThumbs: () => rOp(() => timeline.timelineThumbs(null, {}))(),
    readTimelineCutsByName: (name) => rOp(() => timeline.readTimelineCuts({ timelineName: name }))(), // plans d'une timeline
  };

  // Fermer / rouvrir le logiciel de montage pour libérer RAM/GPU pendant une tâche lourde, puis
  // reprendre le projet. La réouverture réamorce le flush du « cache projet » (envois différés).
  const hostPower = createHostPower({
    CONFIG, resolveMod, bridge, adobeBridge, broadcast, dataDir: DATA_DIR,
    projectSnapshot, captureReaders,
  });

  // NetsuBoost sur hôte Adobe. Dépend du pont (jobs panneau) ET de l'énergie hôte : purger un media
  // cache exige l'application fermée, donc la séquence fermer → purger → rouvrir.
  const adobeBoost = createAdobeBoost({ adobeBridge, hostPower, broadcast, ev });

  // Rich Presence Discord. Le renderer pousse le contexte (module/projet) ; le module tient la
  // connexion, le throttle de 15 s et l'état persisté. Discord fermé = silence, pas une panne.
  const discordRpc = createDiscordRpc({ CONFIG, broadcast, dataDir: DATA_DIR });
  discordRpc.boot();

  // Poller de synchro Resolve→renderer (diff de signature légère → SSE `resolve:changed`).
  // onReconnect : Resolve vient de rouvrir → flush de la file « cache projet » + efface l'état « fermé »
  // de l'énergie hôte (si Resolve a été relancé à la main, l'offre « Rouvrir » ne doit plus traîner).
  const watch = createResolveWatch({
    broadcast,
    getSignature: () => resolveMod.resolveSignature(),
    onReconnect: () => { outbox.onHostOnline('resolve'); hostPower.markOnline('resolve'); },
  });
  watch.start();
  // Suspend le poll pendant une op lourde (occupe le pont Python) puis le reprend. Bracket aussi
  // l'opération (beginResolveOp/endResolveOp) → getResolve ne purge le registre de handles QUE si elle
  // est seule en vol (sinon « handle invalide » quand 2 ops Resolve se chevauchent).
  const guarded = (fn) => async (...a) => {
    watch.pause();
    beginResolveOp();
    try {
      return await fn(...a);
    } finally {
      endResolveOp();
      watch.resume();
    }
  };
  // Bracket SEUL (sans pause du poll) pour les ops Resolve légères/fréquentes (statut, listes).
  const rOp = (fn) => async (...a) => {
    beginResolveOp();
    try {
      return await fn(...a);
    } finally {
      endResolveOp();
    }
  };

  // Chat IA : moteur hybride (CLI claude/codex + BYOK Anthropic/OpenAI), registre d'outils (modules
  // existants + catalogue Resolve), permissions, serveur MCP. Les outils Resolve réutilisent les
  // brackets guarded/rOp (mêmes invariants de registre de handles que les canaux resolve:*).
  const agent = createAgent({
    broadcast, ev, dataDir: DATA_DIR,
    modules: { resolveMod, timeline, sidecars, thumbs, proxy, ffmpeg, aeExporter, refStore, guarded, rOp },
  });

  // Archivage d'une collection : exporte TOUS ses plans (remux/encode via profil d'export) vers un
  // dossier de stockage, indépendamment de la source → on peut ensuite supprimer les rushs d'origine.
  // Réutilise exportClips (mêmes profils que le bouton Télécharger). Enregistre l'état d'archivage.
  // Repli ML du sélecteur de piste audio par langue : extrait un court WAV de la piste `track` puis
  // l'identifie via le daemon Whisper. Best-effort (null si indispo) → l'export garde toutes les pistes.
  async function audioDetectLang(input, track) {
    try {
      const wav = await ffmpeg.extractAudio({ input, track, seconds: 30 });
      const r = await sidecars.detectTrackLang({ source: input, audio: wav });
      return r && r.ok ? (r.lang || null) : null;
    } catch (_) { return null; }
  }

  // Pistes sondées + `langCode` normalisé (tag ou titre libre → code langue, cf. audioLang).
  // La table des variantes reste la SEULE de core/audioLang.js : le renderer lit ce code pour dire à
  // quelle piste se résout une règle par langue, sans réimplémenter la normalisation.
  async function probeAudioTracksTagged(p) {
    const r = await ffmpeg.probeAudioTracks(p);
    const tracks = (r.tracks || []).map((t) => ({ ...t, langCode: audioLang.trackLangCode(t) }));
    return { ...r, tracks };
  }

  // Registre des sorties d'upscale : c'est lui qui empêche de régénérer un plan déjà produit, ici ou
  // dans une autre collection. Sans injection, l'archivage produirait tout à chaque passage.
  const upLedger = createUpscaleLedger();
  const collArchive = createCollectionArchive({
    collectionStore, exportMod, detectLang: audioDetectLang,
    upscaleMod: sidecars, turboMod: turbo, ledger: upLedger, encodeGate,
  });
  // File des archivages différés. « Au repos » = plus aucun encodage en vol (le portail global est la
  // seule vérité du nombre d'encodes de la machine).
  const archiveQueue = createArchiveQueue({
    dataDir: DATA_DIR, broadcast,
    isIdle: () => encodeGate.stats().active === 0,
    runArchive: (collId, opts) => collArchive.archive(ev, collId, opts || {}),
  });

  // Table de dispatch : channel -> (args[], ev) => result|Promise. Calque exact de registerIpc().
  const H = {
    // --- Resolve (opérationnel après le pont Python externe, P2) ---
    "resolve:status": rOp(() => resolveMod.resolveStatus()),
    // Media Pool + listes timelines : si l'hôte est HORS LIGNE (fermé) et qu'un snapshot existe, on
    // sert le cache (cached:true) → l'UI garde ses rushes/timelines. Sinon comportement live inchangé.
    "resolve:listMediaPool": rOp(async () => {
      const r = await resolveMod.listMediaPool();
      if (r.connected) { projectSnapshot.warm("mediaPool", r); projectRegistry.record(r.project, r.clips); return r; }
      const snap = projectSnapshot.get();
      if (snap && snap.mediaPool) {
        // Hôte fermé : le snapshot reste une photo VRAIE du projet → il alimente aussi le registre,
        // sinon la portée de recherche serait vide tant que Resolve n'est pas rouvert.
        projectRegistry.record(snap.project, snap.mediaPool.clips || []);
        return { connected: false, cached: true, project: snap.project, clips: snap.mediaPool.clips || [], error: null };
      }
      return r;
    }),
    "resolve:import": guarded(([paths]) => resolveMod.importToMediaPool(paths)),
    "resolve:importToBin": guarded(([paths, bin]) => resolveMod.importToBin(paths, bin)),
    "resolve:buildTimeline": guarded(([opts]) => timeline.buildTimeline(opts)),
    "resolve:listTimelines": rOp(async () => {
      const r = await timeline.listTimelines();
      if (r.ok) { projectSnapshot.warm("timelines", r); return r; }
      const snap = projectSnapshot.get();
      if (snap && snap.timelines) return { ...snap.timelines, cached: true };
      return r;
    }),
    "resolve:timelineTree": rOp(async () => {
      const r = await timeline.timelineTree();
      if (r.ok) { projectSnapshot.warm("tree", r); return r; }
      const snap = projectSnapshot.get();
      if (snap && snap.tree) return { ...snap.tree, cached: true };
      return r;
    }),
    "resolve:timelineThumbs": guarded(async ([opts]) => {
      const r = await timeline.timelineThumbs(ev, opts || {});
      if (r.ok) { projectSnapshot.warm("thumbs", r); return r; }
      const snap = projectSnapshot.get();
      if (snap && snap.thumbs && snap.thumbs.length) return { ok: true, cached: true, thumbs: snap.thumbs };
      return r;
    }),
    // Plans d'une timeline : snapshot-aware comme les autres lectures. En ligne → réchauffe le cache
    // (indexé par nom). Hôte fermé → sert les plans cachés de la timeline demandée (cached:true) → le
    // navigateur de timelines reste ouvrable offline. Sans nom (timeline courante) offline : rien à servir.
    "resolve:readTimelineCuts": guarded(async ([opts]) => {
      const o = opts || {};
      const r = await timeline.readTimelineCuts(o);
      if (r.ok) { projectSnapshot.warm("cuts", { timelineName: o.timelineName || r.timeline, cuts: r.cuts }); return r; }
      const snap = projectSnapshot.get();
      const name = o.timelineName;
      if (name && snap && snap.cuts && snap.cuts[name]) return { ok: true, cached: true, timeline: name, cuts: snap.cuts[name] };
      return r;
    }),
    "resolve:cutTimeline": guarded(([opts]) => timeline.cutTimeline(ev, opts)),
    // Éditeur de coupes in-app : analyse (détection, pas de build) puis build depuis la structure éditée.
    "resolve:analyzeTimelineCut": guarded(([opts]) => timeline.analyzeTimelineCut(ev, opts || {})),
    "resolve:buildCutTimeline": guarded(([opts]) => timeline.buildCutTimeline(ev, opts || {})),
    // Poll immédiat (déclenché par le renderer au focus fenêtre).
    "resolve:refreshNow": () => { void watch.refreshNow(); return { ok: true }; },

    // --- « Cache projet » : file d'attente des envois différés (hôte fermé) + auto-flush réouverture ---
    "outbox:list": () => outbox.list(),
    "outbox:enqueue": ([entry]) => outbox.enqueue(entry || {}),
    "outbox:remove": ([id]) => outbox.remove(id),
    "outbox:clear": ([which]) => outbox.clear(which),
    "outbox:settings": () => outbox.getSettings(),
    "outbox:setSettings": ([patch]) => outbox.setSettings(patch || {}),
    "outbox:flush": ([host]) => outbox.flush(host || "resolve"),

    // --- « Cache médias » (Paramètres › Stockage) : mesure, arbre projet → rush, purge ciblée,
    // dossier relocalisable, politiques par type. SSE : cache:progress / cache:warn / cache:changed. ---
    "cache:overview": () => cacheAdmin.overview(),
    "cache:tree": () => cacheAdmin.tree(),
    "cache:clear": ([opts]) => cacheAdmin.clear(opts || {}),
    "cache:purgePreviewRanges": ([ranges]) => cacheAdmin.purgePreviewRanges(ranges || []),
    "cache:missing": () => cacheAdmin.missing(),
    "cache:vacuum": () => cacheAdmin.vacuum(),
    "cache:settings": () => cachePolicy.settings(),
    "cache:setSettings": ([patch]) => cachePolicy.setSettings(patch || {}),
    "cache:check": () => cachePolicy.check(),
    "cache:sessionEvent": ([opts]) => sessionCleanup(opts && opts.trigger, opts && opts.kinds),
    "cache:setDir": ([opts]) => cacheMove.setDir(opts || {}),
    "cache:reindex": () => cacheMove.reindex(),

    // --- Langue de l'UI : copie durable dans nr.config.json (lue au prochain boot). Le renderer
    // applique le changement immédiatement via localStorage ; ici c'est la persistance de fond. ---
    "config:get": () => ({ lang: CONFIG.lang || null }),

    // --- Réglages partagés entre renderers (localStorage est par ORIGINE, cf. core/prefs.js) ---
    "prefs:get": () => prefs.get(),
    "prefs:set": ([patch]) => {
      const result = prefs.set(patch || {});
      // Un daemon python garde l'environnement de son spawn : sans cette relance des daemons libres,
      // une option de performance ne prendrait effet qu'au prochain démarrage du core.
      if (result.ok && patch && patch.searchPerf) sidecars.refreshPerfEnv();
      return result;
    },
    // --- Miroir durable du localStorage du renderer (cf. core/uistate.js) ---
    "uistate:get": () => uiState.get(),
    "uistate:set": ([patch]) => uiState.set(patch || {}),
    "config:setLang": ([lang]) => {
      const code = String(lang || "fr").toLowerCase().split(/[-_]/)[0];
      return saveConfig({ lang: ["fr", "en", "es", "de", "ja", "zh"].includes(code) ? code : "fr" });
    },

    // --- Snapshot projet : état du cache offline (badge « hors-ligne (cache) ») + effacement manuel ---
    "snapshot:state": () => projectSnapshot.state(),
    "snapshot:clear": () => projectSnapshot.clear(),
    // Lecture INSTANTANÉE d'une tranche du snapshot (zéro appel Resolve) : affichage
    // stale-while-revalidate côté renderer — on peint le cache tout de suite, la lecture live
    // (listMediaPool / readTimelineCuts…) remplace ensuite. Formes de réponse identiques aux
    // replis offline des canaux resolve:* ci-dessus (cached:true).
    "snapshot:peek": ([kind, arg]) => {
      const snap = projectSnapshot.get();
      if (!snap) return null;
      if (kind === "mediaPool") {
        if (!snap.mediaPool) return null;
        return { connected: false, cached: true, project: snap.project, clips: snap.mediaPool.clips || [], error: null };
      }
      if (kind === "timelines") return snap.timelines ? { ...snap.timelines, cached: true } : null;
      if (kind === "tree") return snap.tree ? { ...snap.tree, cached: true } : null;
      if (kind === "thumbs") return (snap.thumbs && snap.thumbs.length) ? { ok: true, cached: true, thumbs: snap.thumbs } : null;
      if (kind === "cuts") {
        const name = String(arg || "");
        if (name && snap.cuts && snap.cuts[name]) return { ok: true, cached: true, timeline: name, cuts: snap.cuts[name] };
        return null;
      }
      return projectSnapshot.state();
    },
    // Construit/rafraîchit le cache offline EN LIGNE, en arrière-plan (Paramètres › Cache projet). Rapide
    // et incrémental par défaut : ne relit que les timelines PAS encore cachées (force → tout relire).
    // Progression en SSE `snapshot:progress`. Chaque lecture est déjà rOp-bracketée en interne.
    "snapshot:build": async ([opts]) => {
      const force = !!(opts && opts.force);
      const refreshTimeline = opts && opts.refreshTimeline ? String(opts.refreshTimeline) : undefined;
      const onProg = (msg, pct) => { try { broadcast("snapshot:progress", { msg, pct: pct ?? null }); } catch (_) {} };
      // Basse priorité : avant chaque timeline, on ATTEND que les lectures live soient au repos (Media
      // Pool / vignettes / ouverture d'une timeline passent d'abord), puis un court délai pour laisser
      // une salve démarrer. Le sweep se remplit dans les creux → l'UI ne rame plus au retour dans l'app.
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const beforeEach = async () => {
        for (let i = 0; i < 300 && getOpDepth() > 0; i++) await sleep(120);
        await sleep(60);
      };
      const r = await projectSnapshot.capture(captureReaders, onProg, {
        skipExistingCuts: !force,
        project: opts && opts.project ? String(opts.project) : undefined,
        refreshTimeline,
        scanTimelineThumbs: force,
        beforeEach,
      });
      try { broadcast("snapshot:progress", { msg: null, pct: null, done: true }); } catch (_) {}
      return r;
    },

    // --- Fermer/rouvrir le logiciel de montage (libérer RAM/GPU pendant une tâche lourde) ---
    "power:state": () => hostPower.state(),
    "power:reconcile": rOp(() => hostPower.reconcile()),
    "power:close": guarded(([host]) => hostPower.close(host || "resolve")),
    "power:reopen": guarded(async () => {
      const r = await hostPower.reopen();
      // Hôte de retour en ligne → réamorce le flush différé du « cache projet ».
      const host = r && r.ok && /** @type {any} */ (r).host;
      if (host) { try { outbox.onHostOnline(host); } catch (_) {} }
      return r;
    }),
    "power:restart": guarded(async ([host]) => {
      const r = await hostPower.restart(host || "resolve");
      const back = r && r.ok && /** @type {any} */ (r).host;
      if (back) { try { outbox.onHostOnline(back); } catch (_) {} }
      return r;
    }),

    // --- Rich Presence Discord (Paramètres › Compte) ---
    "discord:state": () => discordRpc.state(),
    "discord:setPrefs": ([patch]) => discordRpc.setPrefs(patch || {}),
    "discord:setContext": ([ctx]) => discordRpc.setContext(ctx || {}),

    // --- Provisionnement 1er lancement (app packagée) : venv torch CUDA + ffmpeg + poids ---
    "setup:status": () => setup.setupStatus(),
    "setup:run": ([options]) => {
      sidecars.killSidecars();
      return setup.runSetup(ev, options || {});
    },
    "compat:status": ([opts]) => compatibility.status(opts || {}),

    // --- Console / journal (debug + bêta-test) : historique des logs, vidage, rapport de bug ---
    // Le flux temps réel arrive en SSE `console:log` (core + sidecars python).
    "console:logs": () => logbus.snapshot(),
    "console:clear": () => { logbus.clear(); return { ok: true }; },
    "bug:report": ([request]) => bugreport.submitBugReport(request),
    "bug:status": () => bugreport.status(),
    // Specs de la machine du testeur : affichées dans le formulaire, recollectées à l'envoi.
    "bug:context": () => bugContext.collectBugContext(),

    // --- Optimisation : diagnostic (lecture seule) + arrêt de tâches (API native) + nettoyage cache.
    // Aucune écriture de réglage, aucun lancement de rendu, aucune génération de cache/proxy. ---
    "optimize:diagnose": rOp(() => optimize.diagnose()),
    "optimize:renderJobs": rOp(() => optimize.renderJobs()),
    "optimize:stopRender": guarded(() => optimize.stopRender()),
    "optimize:clearRenderQueue": guarded(() => optimize.clearRenderQueue()),
    "optimize:clearFinishedJobs": guarded(() => optimize.clearFinishedJobs()),
    "optimize:deleteRenderJob": guarded(([id]) => optimize.deleteRenderJob(id)),
    "optimize:reloadProject": guarded(() => optimize.reloadProject()),
    "optimize:openPage": guarded(([page]) => optimize.openPage(page)),
    // Libère la VRAM occupée par NetsuRush (annule proxies NVENC + tue daemons CUDA) pour la rendre
    // au rendu Resolve. Ne touche PAS le pont Resolve → handler simple.
    "optimize:freeGpu": () => optimize.freeGpu(),
    "optimize:freeCpu": () => optimize.freeCpu(),
    "optimize:freeRam": () => optimize.freeRam(),
    // Gestionnaire de ressources système : liste/tue des processus du PC (hors NetsuRush). Pas de pont
    // Resolve → handlers simples. killProcess est garde-fous (critiques refusés) + confirmation UI.
    "optimize:listProcesses": () => optimize.listProcesses(),
    "optimize:killProcess": ([pid]) => optimize.killProcess(pid),
    // Nettoyage des processus figés (« Ne répond pas ») : scan + kill auto des non-critiques.
    "optimize:deadProcesses": () => optimize.deadProcesses(),
    "optimize:cleanDead": () => optimize.cleanDeadProcesses(),
    // Bruit d'arrière-plan (updaters, superpositions, synchro) : liste arrêtable + arrêt groupé.
    // Complète `cleanDead`, qui ne voit QUE les processus figés — le bruit, lui, répond très bien.
    "optimize:noiseProcesses": () => optimize.noiseProcesses(),
    "optimize:killNoise": ([pids]) => optimize.killNoise(pids),
    // Surveillance mémoire pendant les tâches lourdes. Elle libère seule (trim réversible) et
    // PROPOSE les arrêts : l'état part en SSE `optimize:watchdog`.
    "optimize:watchdog": () => optimize.watchdogState(),
    "optimize:setWatchdog": ([prefs]) => optimize.setWatchdogPrefs(prefs),
    "optimize:dismissWatchdog": () => optimize.dismissWatchdogSuggestion(),
    // Moniteur live (VRAM/RAM/disque) → pas de pont Resolve, handler simple, pollé ~2,5 s.
    "optimize:resources": ([root]) => optimize.resources(root),
    // Dérive de session : lit le ring échantillonné en fond par optimize.js (pas de pont Resolve).
    "optimize:sessionHealth": () => optimize.sessionHealth(),
    // Préférences Resolve : lecture/écriture SUR DISQUE (aucune API de scripting ne les expose). Le
    // lot est appliqué en une fois — fermer/patcher/rouvrir — d'où le bracket `guarded`.
    "optimize:prefs": () => resolvePrefs.readPrefs(),
    "optimize:prefsBackups": () => resolvePrefs.listBackups(DATA_DIR),
    "optimize:applyPrefs": guarded(([changes]) =>
      resolvePrefs.applyPrefs(
        { hostPower, dataDir: DATA_DIR, progress: (msg, pct) => broadcast("power:progress", { msg, pct }) },
        changes,
      ),
    ),
    "optimize:restorePrefs": guarded(([name]) => resolvePrefs.restoreBackup(DATA_DIR, name)),
    // Point de restauration : export .drp du projet courant (touche le pont Resolve → guarded).
    "optimize:snapshot": guarded(() => optimize.snapshotProject()),
    "optimize:listSnapshots": () => optimize.listSnapshots(),
    "optimize:scanCache": ([root]) => optimize.scanCache(root),
    "optimize:cleanCache": ([paths]) => optimize.cleanPaths(paths),

    // --- ffmpeg / probe / proxy / thumbs ---
    "ffmpeg:probe": ([p]) => ffmpeg.probeMedia(p),
    "player:info": ([p]) => ffmpeg.playInfo(p),
    "ffmpeg:audioTracks": ([p]) => probeAudioTracksTagged(p),
    "ffmpeg:detectScenes": ([p, threshold, model, options]) => sidecars.detectScenes(ev, p, threshold, model, options),
    "ffmpeg:cachedScenes": ([p, model, threshold, options]) => sidecars.getCachedScenes(p, model, threshold, options),
    "ffmpeg:detectConcurrency": () => sidecars.detectConcurrency(),
    "cut:getEdits": ([p, model, optionsKey]) => cutEditsStore.getEdits(p, model, optionsKey),
    "cut:saveEdits": ([p, model, edits, optionsKey]) => cutEditsStore.saveEdits(p, model, edits, optionsKey),
    "cut:clearEdits": ([p, model, optionsKey]) => cutEditsStore.clearEdits(p, model, optionsKey),
    "ffmpeg:proxy": ([opts]) => proxy.proxySegment(opts),
    // Lot de plans → chemins des proxies DÉJÀ en cache (aucun encode). Amorce le cache d'URL du
    // renderer à l'ouverture d'une grille : les cartes n'émettent plus un RPC chacune au défilement.
    "ffmpeg:proxyResolve": ([items, opts]) => proxy.proxyResolve(items, opts || {}),
    "ffmpeg:proxyCancel": ([token]) => {
      proxy.proxyCancel(token);
      return null;
    },
    "ffmpeg:proxyCancelMany": ([tokens]) => {
      proxy.proxyCancelMany(tokens);
      return null;
    },
    "ffmpeg:proxyCancelAll": () => proxy.proxyCancelAll(),
    "ffmpeg:thumbnail": ([request, legacyTime]) => {
      const o = request && typeof request === "object" ? request : { path: request, time: legacyTime };
      // Une carte encore hors champ demande "low" : la file de vignettes garde alors deux ouvriers
      // pour les cartes réellement visibles (cf. THUMB_LOW_MAX). Défaut "high" — un appelant qui ne
      // dit rien est un affichage immédiat.
      const priority = o.priority === "low" ? "low" : "high";
      return thumbs.thumbnail(o.path, o.time, priority, o.settings).catch((err) => ({ error: String(err) }));
    },
    "ffmpeg:thumbsBatch": ([request, legacyItems]) => {
      const o = request && typeof request === "object" && !Array.isArray(request) ? request : { path: request, items: legacyItems };
      return thumbs.thumbsBatch(o.path, o.items, o.settings).catch((err) => ({ ok: false, error: String(err) }));
    },
    "ffmpeg:thumbsResolve": ([request]) => {
      const o = Array.isArray(request) ? { items: request } : request || { items: [] };
      return thumbs.thumbsResolve(o.items, o.settings).catch(() => []);
    },
    "ffmpeg:export": ([opts]) =>
      ffmpeg
        .exportClip(opts)
        .then((o) => ({ ok: true, output: o }))
        .catch((err) => ({ ok: false, error: String(err.stderr || err) })),
    "ffmpeg:compareFrames": ([opts]) => ffmpeg.compareFrames(opts),

    // --- Export piloté par profil : remux/encode, GPU auto, per-clip ou fusion ---
    "export:clips": ([opts]) => exportMod.exportClips(ev, { ...opts, detectLang: audioDetectLang }),
    // Codecs RÉELLEMENT encodables ici (vraie sonde ffmpeg, cachée) → l'UI n'affiche pas le reste.
    "export:capabilities": ([opts]) => exportMod.exportCapabilities(opts || {}),
    // Nom que produirait le gabarit du profil (éditeur de profil). Passe par le core plutôt que par
    // une copie du résolveur côté renderer : deux implémentations finiraient par ne plus s'accorder,
    // et un aperçu qui ment sur le nom du fichier est pire que pas d'aperçu.
    "export:previewName": ([opts]) => exportMod.previewName(opts || {}),

    // --- Upscale Real-ESRGAN ---
    "upscale:run": ([opts]) => sidecars.runUpscale(ev, opts),
    "upscale:shaderRun": ([opts]) => turbo.runTurbo(sidecars, ev, opts),
    // Le test image suit le MÊME aiguillage que l'encodage (IA / shader GLSL / poids ONNX) — sinon
    // l'aperçu montrerait le rendu d'un autre moteur que celui qui produira le fichier.
    "upscale:testFrame": async ([opts]) => {
      await prepareTestFrame(opts);
      return turbo.runTurboFrame(sidecars, opts);
    },

    // --- Hub de traitements vidéo : interpolation / depth / détourage (process.py) ---
    "process:interpolate": ([opts]) => sidecars.runInterpolate(ev, opts),
    "process:depth": ([opts]) => sidecars.runDepth(ev, opts),
    "process:removeBg": ([opts]) => sidecars.runRemoveBg(ev, opts),
    "process:testFrame": async ([opts]) => {
      await prepareTestFrame(opts);
      return sidecars.runProcessFrame(opts);
    },

  // --- Gestionnaire de modèles app-wide (download à la demande / delete / statut / disque) ---
  "models:list": () => models.listModels(),
  "models:download": ([id, replace]) => models.downloadModel(id, (p) => broadcast("models:progress", p), replace === true),
  "models:import": ([id, source]) => models.importModel(id, source),
  "models:cancel": ([id]) => models.cancelDownload(id),
  "models:delete": ([id]) => models.deleteModel(id),
  "models:diskUsage": () => models.diskUsage(),
  // VRAM TOTALE de la carte → la page Modèles avertit quand un modèle ne tiendra jamais dessus.
  "models:gpu": () => scheduler.gpuInfo(),

  // --- Pipeline ordonné (chaîne de transforms upscale/interpolate → 1 sortie) ---
  "pipeline:run": ([opts]) => pipeline.runPipeline(ev, opts),

  // --- Roto Studio (segmentation interactive SAM → propagation → export / suppression d'objet) ---
  "roto:open": async ([opts]) => {
    const sourceKey = JSON.stringify([opts && opts.video, opts && opts.in, opts && opts.out]);
    if (lastRotoSourceKey && lastRotoSourceKey !== sourceKey) {
      await sessionCleanup('operation', ['roto']);
    }
    const result = await roto.rotoOpen(ev, opts);
    if (result && result.ok) lastRotoSourceKey = sourceKey;
    return result;
  },
  "roto:addPoint": ([opts]) => roto.rotoAddPoint(opts),
  "roto:clearPoints": ([opts]) => roto.rotoClearPoints(opts),
  "roto:undoPoint": () => roto.rotoUndoPoint(),
  "roto:previewPoint": ([opts]) => roto.rotoPreviewPoint(opts),
  "roto:mask": ([opts]) => roto.rotoMask(opts),
  "roto:setPost": ([opts]) => roto.rotoSetPost(opts),
  "roto:setView": ([opts]) => roto.rotoSetView(opts),
  "roto:setObjects": ([opts]) => roto.rotoSetObjects(opts),
  "roto:removePoint": ([opts]) => roto.rotoRemovePoint(opts),
  "roto:movePoint": ([opts]) => roto.rotoMovePoint(opts),
  "roto:clearTracking": () => roto.rotoClearTracking(),
  "roto:dedupe": ([opts]) => roto.rotoDedupe(ev, opts),
  "roto:propagate": ([opts]) => roto.rotoPropagate(ev, opts),
  "roto:cancel": () => roto.rotoCancel(),
  "roto:refine": ([opts]) => roto.rotoRefine(ev, opts),
  "roto:setRefined": ([opts]) => roto.rotoSetRefined(opts),
  "roto:export": ([opts]) => roto.rotoExport(ev, opts),
  "roto:objectRemove": ([opts]) => roto.rotoObjectRemove(ev, opts),

  // --- Dictée vocale (push-to-talk) : audio b64 → texte (daemon whisper chaud) ---
  "dictate:transcribe": ([opts]) => dictate.transcribeClip(opts),
  "dictate:cppStatus": () => dictate.cppStatus(),

    // --- Module voix : transcription (sous-titres + montage par texte) + silences ---
    "voice:transcribe": ([opts]) => voice.transcribe(ev, opts || {}),
    "voice:detectSilences": ([opts]) => voice.detectSilences(ev, opts || {}),
    "voice:detectFillers": ([opts]) => voice.detectFillers(ev, opts || {}),
    "voice:exportSubtitles": ([opts]) => voice.exportSubtitles(opts || {}),
    "voice:exportCut": ([opts]) => voice.exportCut(opts || {}),
    "voice:waveform": ([opts]) => voice.waveform(opts || {}),
    "voice:searchTranscripts": ([opts]) => voice.searchTranscripts(opts || {}),

    // --- Export After Effects ---
    "ae:export": guarded(([opts]) => aeExporter.aeExport(ev, opts)),

    // --- Transfert de timeline entre hôtes (Resolve ⇄ Premiere ⇄ After Effects) ---
    // Bracketé comme les autres lectures Resolve : la liste des timelines part du même registre de
    // handles que l'aperçu, et les deux se déclenchent ENSEMBLE au changement d'hôte (useTransfer).
    // Sans bracket, l'aperçu entrait à la profondeur 0 et purgeait le registre en plein parcours de
    // la liste → « handle invalide ou Resolve non connecté ».
    "transfer:sources": rOp(([opts]) => transfer.listSources(opts || {})),
    "transfer:read": guarded(([opts]) => transfer.summary(opts || {})),
    "transfer:run": guarded(([opts]) => transfer.run(ev, opts || {})),

    // --- Pont Adobe (panneau CEP Premiere/AE ↔ core) ---
    "adobe:status": () => adobeBridge.status(),
    "adobe:panelHello": ([info]) => adobeBridge.panelHello(info || {}),
    "adobe:panelLog": ([entry]) => adobeBridge.panelLog(entry || {}),
    "adobe:ingest": ([snap]) => adobeBridge.ingest(ev, snap),
    "adobe:snapshot": ([app]) => adobeBridge.snapshot(app),
    "adobe:launch": ([app]) => adobeBridge.launch(app),
    "adobe:cmd": ([app, payload]) => adobeBridge.cmd(ev, app, payload),
    "adobe:installPanel": () => adobeBridge.installPanel(),
    "adobe:setPanelAutoUpdate": ([on]) => adobeBridge.setPanelAutoUpdate(on),
    "adobe:diagnose": () => adobeBridge.diagnose(),
    "adobe:buildTimeline": ([opts]) => adobeBridge.buildTimeline(ev, opts || {}),
    "adobe:import": ([opts]) => adobeBridge.importMedia(ev, opts || {}),
    "adobe:jobResult": ([res]) => adobeBridge.jobResult(res || {}), // appelé PAR le panneau

    // --- NetsuBoost sur hôte Adobe (l'équivalent d'optimize:* pour Premiere / After Effects) ---
    "boost:diagnose": ([app]) => adobeBoost.diagnose(app),
    "boost:procs": () => adobeBoost.procs(),
    "boost:scanCache": ([app, dir]) => adobeBoost.scanCache(app, dir),
    "boost:cleanCache": ([app, targets, opts]) => adobeBoost.cleanCache(app, targets || [], opts || {}),
    "boost:purge": ([app, target]) => adobeBoost.purge(app, target),
    "boost:hygiene": ([app, op]) => adobeBoost.hygiene(app, op),
    "boost:deletePreviews": ([app]) => adobeBoost.deletePreviews(app),
    "boost:prefs": ([app]) => adobeBoost.prefs(app),
    "boost:applyPrefs": ([app, changes]) => adobeBoost.applyPrefs(app, changes || {}),
    "boost:proxyAudit": ([app]) => adobeBoost.proxyAudit(app),
    "boost:attachProxies": ([app, pairs]) => adobeBoost.attachProxies(app, pairs || []),
    "boost:setEnableProxies": ([app, on]) => adobeBoost.setEnableProxies(app, on),

    // --- Recherche SigLIP 2 ---
    "search:index": guarded(([p, force, frames, model, options]) =>
      sidecars.searchIndex(ev, "index", { path: p, force: !!force, frames: frames || undefined, model: model || undefined, options: options || {} }, "clip")),
    "search:run": ([opts]) =>
      sidecars.queryReq("search", {
        text: opts?.text || "",
        neg_text: opts?.negText || "",
        lang: opts?.lang || undefined,   // a priori de langue quand la requête est trop courte pour trancher
        refs: opts?.refs || [],
        top_k: opts?.topK || 60,
        min_score: opts?.minScore || 0,
        beta: opts?.beta ?? 0.4,
        aesthetic: !!opts?.aesthetic,
        char_ids: opts?.charIds ?? (opts?.charId != null ? [opts.charId] : undefined),
        file_paths: Array.isArray(opts?.filePaths) ? opts.filePaths : undefined,
      }),
    "search:dedup": ([opts]) =>
      sidecars.queryReq("dedup", {
        scenes: opts?.scenes || null,
        file_path: opts?.filePath || null,
        threshold: opts?.threshold ?? 0.93,
      }),
    "search:cluster": ([opts]) =>
      sidecars.queryReq("cluster", {
        scenes: opts?.scenes || null,
        file_path: opts?.filePath || null,
        k: opts?.k || null,
      }),
    "search:query": ([text, topK]) => sidecars.queryReq("query", { text: String(text), top_k: topK || 60 }),
    "search:concurrency": () => sidecars.indexConcurrency(),
    "search:warm": () => sidecars.queryReq("warm", {}),
    "search:status": ([o]) => {
      const filePaths = Array.isArray(o?.filePaths) ? o.filePaths : undefined;
      return searchCatalog.status(filePaths) || sidecars.cpuReq("status", { file_paths: filePaths });
    },
    "search:indexed": () => sidecars.cpuReq("indexed", {}),
    // Variante SigLIP active. La bascule tue les daemons de recherche : le prochain job charge la
    // nouvelle variante sans redémarrer le core. Chaque variante garde son propre index (colonne
    // `model`) → l'ancienne reste intacte, la nouvelle demande une ré-indexation complète.
    "search:modelState": () => searchModelState(searchCatalog),
    "search:setModel": ([id]) => setSearchModel(id, { restart: () => sidecars.killSearch(), catalog: searchCatalog }),
    // Arrêt IMMÉDIAT de l'indexation : tue les daemons du pool (un job dure des minutes, attendre
    // la fin du clip courant rendait le bouton « Arrêter » inopérant en pratique).
    "search:cancelIndex": () => sidecars.abortIndex(),
    "search:shots": ([p]) => sidecars.cpuReq("shots", { path: p }),

    // --- Recherche par visage ---
    "face:index": guarded(([p, force, model, options]) => sidecars.searchIndex(ev, "face-index", { path: p, force: !!force, model: model || undefined, options: options || {} }, "face")),
    "face:search": ([opts]) =>
      sidecars.queryReq("face-search", {
        path: opts?.path || "",
        file_path: opts?.filePath || null,
        scene_index: opts?.sceneIndex ?? null,
        refs: opts?.refs || null,
        top_k: opts?.topK || 60,
        min_score: opts?.minScore || 0,
        file_paths: Array.isArray(opts?.filePaths) ? opts.filePaths : undefined,
      }),
    "face:detect": ([p]) => sidecars.queryReq("face-detect", { path: p }),
    "face:status": ([o]) => {
      const filePaths = Array.isArray(o?.filePaths) ? o.filePaths : undefined;
      return searchCatalog.faceStatus(filePaths) || sidecars.cpuReq("face-status", { file_paths: filePaths });
    },
    "face:engines": () => sidecars.cpuReq("face-engines", {}),
    "face:indexed": () => sidecars.cpuReq("face-indexed", {}),
    "face:gallery": ([o]) => sidecars.queryReq("face-gallery", {
      top_k: o?.topK || 200,
      min_size: o?.minSize || 1,
      file_paths: Array.isArray(o?.filePaths) ? o.filePaths : undefined,
    }),

    // --- Registre projet → rushs (portée de recherche multi-projets) ---
    "projects:list": () => projectRegistry.list(),
    "projects:paths": ([names]) => ({ paths: projectRegistry.pathsFor(Array.isArray(names) ? names : []), error: null }),
    "projects:forget": ([name]) => ({ ok: projectRegistry.forget(String(name || "")) }),
    "projects:scan": guarded(() => projectScan.scan()),

    // --- Bibliothèque de personnages nommés ---
    // SQLite pur (roster CRUD) → CPU ; embeddings (identify/search/addSample/shots) → GPU si libre ;
    // étiquetage de tout l'index = passe longue (progression SSE) → pool GPU guardé.
    "char:list": ([o]) => {
      const filePaths = Array.isArray(o?.filePaths) ? o.filePaths : undefined;
      return searchCatalog.characters(filePaths) || sidecars.cpuReq("char-list", { file_paths: filePaths });
    },
    "char:create": ([o]) => sidecars.cpuReq("char-create", { name: o?.name, notes: o?.notes, tags: o?.tags, color: o?.color }),
    "char:update": ([o]) => sidecars.cpuReq("char-update", { id: o?.id, name: o?.name, notes: o?.notes, tags: o?.tags, color: o?.color }),
    "char:delete": ([id]) => sidecars.cpuReq("char-delete", { id }),
    "char:removeSample": ([id]) => sidecars.cpuReq("char-remove-sample", { id }),
    // CharRef renderer = snake_case (file_path…) — accepter les DEUX graphies (le camelCase seul
    // perdait la réf → « Aucun visage détecté » → zéro échantillon enregistré, silencieusement).
    "char:addSample": ([o]) =>
      sidecars.queryReq("char-add-sample", {
        char_id: o?.charId, path: o?.path || null, bbox: o?.bbox || null, domain: o?.domain || null,
        file_path: o?.file_path ?? o?.filePath ?? null,
        scene_index: o?.scene_index ?? o?.sceneIndex ?? null,
        face_index: o?.face_index ?? o?.faceIndex ?? null,
      }),
    "char:samples": ([id]) => sidecars.queryReq("char-samples", { char_id: id }),
    "char:identify": ([o]) => sidecars.queryReq("char-identify", { refs: o?.refs || [], min_score: o?.minScore ?? 0.5 }),
    "char:search": ([o]) => sidecars.queryReq("char-search", { char_id: o?.charId, top_k: o?.topK || 60, min_score: o?.minScore || 0, file_paths: Array.isArray(o?.filePaths) ? o.filePaths : undefined }),
    "char:shots": ([o]) => sidecars.queryReq("char-shots", { char_id: o?.charId, top_k: o?.topK || 200, file_paths: Array.isArray(o?.filePaths) ? o.filePaths : undefined }),
    "char:labelIndex": guarded(([o]) => sidecars.searchIndex(ev, "char-label-index", { min_score: o?.minScore ?? 0.5 }, "label")),
    "char:merge": ([o]) => sidecars.cpuReq("char-merge", { source_id: o?.sourceId, target_id: o?.targetId }),
    "char:duplicates": ([o]) => sidecars.queryReq("char-duplicates", { min_score: o?.minScore ?? 0.55 }),

    // --- Board de référence (saveAsset binaire : transport base64 à finaliser en P4) ---
    "reference:listScenes": () => refStore.listScenes(),
    "reference:storagePath": () => refStore.storagePath(),
    "reference:loadScene": ([id]) => refStore.loadScene(id),
    "reference:saveScene": ([scene]) => refStore.saveScene(scene),
    "reference:deleteScene": ([id]) => refStore.deleteScene(id),
    // bytes arrive en base64 (transport JSON) → Buffer pour refStore.
    "reference:saveAsset": ([bytes, ext]) => {
      const buf = bytes && bytes.__b64 ? Buffer.from(bytes.__b64, "base64") : bytes;
      return refStore.saveAsset(buf, ext);
    },
    // Télécharge un média distant côté core (sans CORS) puis le persiste en asset disque.
    "reference:fetchAsset": ([url, options]) => refStore.fetchAsset(url, options || {}),
    // Résout le vrai média de N'IMPORTE quel lien (fichier direct ou page via OpenGraph) → asset.
    "reference:resolveMedia": ([url, options]) => refStore.resolveMedia(url, options || {}),
    // Extrait le VRAI média d'un lien (réseaux sociaux & co) via yt-dlp / gallery-dl.
    "reference:extractMedia": ([url, options]) => extract.extractMedia(url, options || {}),
    // Décompose une vidéo locale en frames image → assets disque → liste de chemins.
    "reference:extractFrames": ([opts]) => extractBoardFrames(opts),
    "reference:push": ([payload]) => {
      broadcast("reference:push", payload);
      return null;
    },
    // Upscale d'un item média du board → nouveau fichier dans assets/ (possédé par l'app).
    // NON destructif : l'ancien fichier reste sur disque (le board garde de quoi revenir en arrière).
    "reference:upscaleItem": ([opts]) => upscaleBoardItem(ev, opts),
    // Supprime un fichier UNIQUEMENT s'il est un asset de l'app (cleanup d'un upscale annulé).
    "reference:dropAsset": ([p]) => refStore.removeAsset(p),
    // Ménage du magasin d'assets (Paramètres du board) : ce que plus aucune scène ne réclame part.
    "reference:sweepAssets": ([opts]) => refStore.sweepAssets(opts || {}),
    // Dossier déposé sur le board : médias trouvés récursivement, avec leur sous-dossier relatif
    // (l'import en fait un cadre par dossier). Plafonné, et le dit quand il tronque.
    "reference:scanFolder": ([dir, opts]) => scanFolder(dir, opts || {}),
    // Export du board (PNG/JPG en base64, SVG en texte) vers un chemin choisi par l'utilisateur.
    "reference:writeFile": ([filePath, data, encoding]) => writeExportFile(filePath, data, encoding),
    // Un cadre d'un média rendu en PNG base64, lu SUR LE DISQUE : c'est la seule source de pixels
    // relisible par le renderer (le protocole d'asset de la coquille teinte le canvas). Sert
    // l'extraction de palette, qui sans ça ne trouvait « aucune couleur exploitable ».
    "reference:sampleFrame": ([filePath, opts]) => ffmpeg.sampleFrame(filePath, opts || {}),

    // --- Fond d'écran de l'interface (Paramètres › Interface › Thème) ---
    // L'import copie la source dans la bibliothèque et cuit la variante de base ; les marches de flou
    // suivantes sont encodées à la demande. Le renderer ne reçoit que des CHEMINS, servis via /media.
    "wallpaper:import": ([srcPath, opts]) => wallpaper.importWallpaper(srcPath, opts || {}),
    "wallpaper:list": () => wallpaper.listWallpapers(),
    "wallpaper:variant": ([id, opts]) => wallpaper.variant(id, opts || {}),
    "wallpaper:remove": ([id]) => wallpaper.removeWallpaper(id),

    // --- Carnet (Notebook) : carnets multi → pages imbriquées → databases (bloc /database) ---
    "notebook:list": () => notebookStore.listNotebooks(),
    "notebook:saveNotebook": ([nb]) => notebookStore.saveNotebook(nb),
    "notebook:deleteNotebook": ([id]) => notebookStore.deleteNotebook(id),
    "notebook:forScript": ([scriptId, title]) => notebookStore.notebookForScript(scriptId, title),
    "notebook:load": ([id]) => notebookStore.loadNotebook(id),
    "notebook:loadPage": ([id]) => notebookStore.loadPage(id),
    "notebook:savePage": ([page]) => notebookStore.savePage(page),
    "notebook:deletePage": ([id]) => notebookStore.deletePage(id),
    "notebook:duplicatePage": ([id]) => notebookStore.duplicatePage(id),
    // Corbeille (soft-delete) + recherche plein-texte du carnet.
    "notebook:trashList": ([nbId]) => notebookStore.trashList(nbId),
    "notebook:restorePage": ([id]) => notebookStore.restorePage(id),
    "notebook:purgePage": ([id]) => notebookStore.purgePage(id),
    "notebook:emptyTrash": ([nbId]) => notebookStore.emptyTrash(nbId),
    "notebook:search": ([nbId, query]) => notebookStore.searchNotebook(nbId, query),
    "notebook:saveDatabase": ([db]) => notebookStore.saveDatabase(db),
    "notebook:deleteDatabase": ([id]) => notebookStore.deleteDatabase(id),
    "notebook:backlinks": ([notebookId, pageId]) => notebookStore.backlinks(notebookId, pageId),
    // Carnet-DOCUMENT : le .netsu ouvert fait foi (mêmes tables, dossier compagnon pour les médias).
    "notebook:openProject": ([filePath, url]) => notebookStore.openProject(filePath, url),
    "notebook:saveProjectAs": ([opts]) => notebookStore.saveProjectAs(opts || {}),
    "notebook:closeProject": ([filePath]) => notebookStore.closeProject(filePath),
    "notebook:projectOf": ([notebookId]) => notebookStore.projectOf(notebookId),
    // Médias uploadés/collés (uploadFile BlockNote) + preview de lien (signet).
    "notebook:saveAsset": ([bytes, ext, notebookId]) => {
      const buf = bytes && bytes.__b64 ? Buffer.from(bytes.__b64, "base64") : bytes;
      return notebookStore.saveAsset(buf, ext, notebookId);
    },
    "notebook:readAsset": ([filePath]) => notebookStore.readAsset(filePath),
    "notebook:linkMeta": ([url]) => notebookStore.linkMeta(url),
    "notebook:writeExport": ([filePath, text]) => notebookStore.writeExport(filePath, text),
    // Partage .netsu : carnet entier ou sous-arbre → archive fidèle (blocs natifs + assets), et retour.
    "notebook:exportFile": ([opts]) => nbFile.exportFile(opts),
    "notebook:importFile": ([opts]) => {
      const o = opts || {};
      return nbFile.importFile({ ...o, b64: o.bytes && o.bytes.__b64 ? o.bytes.__b64 : o.b64 });
    },
    // Push (fenêtre détachée future / sync inter-vues).
    "notebook:push": ([payload]) => {
      broadcast("notebook:push", payload);
      return null;
    },

    // --- Collections : dossiers de plans gardés (bibliothèque de rushs) ---
    "collections:list": () => collectionStore.listCollections(),
    "collections:load": ([id]) => collectionStore.loadCollection(id),
    "collections:save": ([c]) => collectionStore.saveCollection(c),
    "collections:delete": ([id]) => collectionStore.deleteCollection(id),
    "collections:addShots": ([id, shots]) => collectionStore.addShots(id, shots),
    "collections:removeShot": ([id, shotId]) => collectionStore.removeShot(id, shotId),
    "collections:updateShot": ([id, shotId, patch]) => collectionStore.updateShot(id, shotId, patch),
    // bytes arrive en base64 (transport JSON) → Buffer pour le store.
    "collections:saveIcon": ([bytes, ext]) => {
      const buf = bytes && bytes.__b64 ? Buffer.from(bytes.__b64, "base64") : bytes;
      return collectionStore.saveIcon(buf, ext);
    },
    // Dossiers de rangement (hiérarchie) + tags globaux + archivage (export indépendant de la source).
    "collections:listFolders": () => collectionStore.listFolders(),
    "collections:saveFolder": ([f]) => collectionStore.saveFolder(f),
    "collections:deleteFolder": ([id]) => collectionStore.deleteFolder(id),
    "collections:move": ([id, folderId]) => collectionStore.moveCollection(id, folderId),
    "collections:allTags": () => collectionStore.allTags(),
    "collections:archive": ([id, opts]) => collArchive.archive(ev, id, opts || {}),
    "collections:relocateArchive": ([id, opts]) => collArchive.relocate(ev, id, opts || {}),
    // Archivage DIFFÉRÉ : la même opération, mise en file au lieu de partir tout de suite (upscale =
    // GPU pris longtemps, on attend que la machine soit au repos).
    "collections:queueState": () => archiveQueue.state(),
    "collections:queueEnqueue": ([id, req]) => archiveQueue.enqueue(id, req || {}),
    "collections:queueCancel": ([entryId]) => archiveQueue.cancel(entryId),
    // Médias hors-ligne (chemins manquants) + resynchronisation (relier par fichier ou dossier).
    "collections:offline": ([id]) => collectionStore.offlineShots(id),
    "collections:relinkPath": ([id, oldPath, newPath]) => collectionStore.relinkPath(id, oldPath, newPath),
    "collections:relinkDir": ([id, dir]) => collectionStore.relinkDir(id, dir),

    // Bibliothèque de rushs importés. Aucun appel Resolve → ni guarded() ni rOp() (contrairement aux
    // canaux resolve:*) : ces lectures/écritures marchent logiciel fermé, c'est tout l'intérêt.
    "library:list": () => libraryStore.listItems(),
    "library:addPaths": ([paths, folderId]) => libraryStore.addPaths(paths, folderId),
    "library:addDir": ([dir, folderId]) => libraryStore.addDir(dir, folderId),
    "library:remove": ([id]) => libraryStore.removeItem(id),
    "library:removeMany": ([ids]) => libraryStore.removeItems(ids),
    "library:restore": ([undo]) => libraryStore.restore(undo),
    "library:move": ([id, folderId]) => libraryStore.moveItem(id, folderId),
    "library:listFolders": () => libraryStore.listFolders(),
    "library:saveFolder": ([f]) => libraryStore.saveFolder(f),
    "library:deleteFolder": ([id, withItems]) => libraryStore.deleteFolder(id, withItems),
    "library:offline": () => libraryStore.offlineItems(),
    "library:relinkPath": ([oldPath, newPath]) => libraryStore.relinkPath(oldPath, newPath),
    "library:relinkDir": ([dir]) => libraryStore.relinkDir(dir),

    // --- Partage « .netsu » : export (board courant → archive) / import (archive → scène) ---
    // L'export encode ses clips un par un : il rend compte item par item, sinon un board fourni
    // laisse l'utilisateur devant un bouton figé pendant plusieurs minutes.
    "netsu:export": ([scene, destPath, opts]) =>
      netsu.exportBoard(refStore, scene, destPath, {
        ...(opts || {}),
        onProgress: (p) => broadcast("netsu:progress", p),
      }),
    "netsu:import": ([srcPath]) => netsu.importBoard(refStore, srcPath),
    "netsu:weigh": ([scene, opts]) => netsu.weigh(scene, opts || {}),
    // Relocalisation EN LOT : un dossier, tous les médias manquants qu'on y reconnaît.
    "netsu:relocateFrom": ([dirPath, wanted]) => netsu.relocateFrom(dirPath, wanted || []),

    // --- Projet « .netsu » : le fichier EST le document (ouvert en continu, Ctrl+S incrémental) ---
    "netsu:openProject": ([srcPath]) => netsu.openProject(refStore, srcPath),
    "netsu:previewProject": ([srcPath]) => netsu.previewProject(refStore, srcPath),
    "netsu:saveProject": ([filePath, scene]) => netsu.saveProject(refStore, filePath, scene),
    "netsu:saveProjectAs": ([opts]) => netsu.saveProjectAs(refStore, opts || {}),
    "netsu:closeProject": ([filePath]) => netsu.closeProject(filePath),
    "netsu:recents": ([type]) => netsu.recentProjects(refStore, type),
    "netsu:forget": ([filePath]) => netsu.forgetProject(filePath),
    "netsu:deleteProject": ([filePath]) => netsu.deleteProject(filePath),

    // --- Module Script : documents/blocs/médias (SQLite ou JSON) + build natif ---
    "script:recordings": ([dir]) => recordings.listRecordings(dir),
    "script:mediaPool": rOp(async () => {
      const r = await resolveMod.listMediaPool({ includeAudio: true });
      if (r.connected) { projectSnapshot.warm("mediaPoolAll", r); return r; }
      const snap = projectSnapshot.get();
      const cached = snap && (snap.mediaPoolAll || snap.mediaPool);
      if (cached) return { connected: false, cached: true, project: snap.project, clips: cached.clips || [], error: null };
      return r;
    }),
    // Écrit dans le Media Pool → même bracket que resolve:import (registre de handles + poller).
    "script:importMedia": guarded(([paths]) => resolveMod.importMediaTree(paths)),
    "script:listDocs": ([proj]) => scriptStore.listDocs(proj),
    "script:loadDoc": ([id]) => scriptStore.loadDoc(id),
    "script:saveDoc": ([doc]) => scriptStore.saveDoc(doc),
    "script:deleteDoc": ([id]) => scriptStore.deleteDoc(id),
    // Historique de versions : points de contrôle manuels.
    "script:listVersions": ([docId]) => scriptStore.listVersions(docId),
    "script:saveVersion": ([docId, label, doc]) => scriptStore.saveVersion(docId, label, doc),
    "script:getVersion": ([id]) => scriptStore.getVersion(id),
    "script:deleteVersion": ([id]) => scriptStore.deleteVersion(id),
    // Build natif AppendToTimeline depuis les blocs ordonnés (multi-sources). Pont Resolve → guarded.
    "script:buildTimeline": guarded(([opts]) => timeline.buildTimelineFromBlocks(opts)),

    // --- Chat IA : moteur hybride (CLI + BYOK) + outils + permissions ---
    "chat:agents": () => agent.listAgents(),
    "chat:configure": ([cfg]) => agent.configure(cfg || {}),
    // Lance un tour ; les événements (texte/outils/approbations) arrivent en SSE `chat:event`.
    "chat:send": ([opts]) => agent.send(opts),
    "chat:cancel": ([runId]) => agent.cancel(String(runId)),
    "chat:approval:respond": ([callId, approved]) => agent.respondApproval(callId, !!approved),
    "chat:tools": () => agent.describeTools(),
    "chat:history:list": () => agent.listConversations(),
    "chat:history:load": ([id]) => agent.loadConversation(id),
    "chat:history:save": ([conv]) => agent.saveConversation(conv),
    "chat:history:delete": ([id]) => agent.deleteConversation(id),
    // Pont MCP (serveur stdio thin lancé par le CLI agent) : liste + exécution d'outils sous permission.
    "agent:toolList": () => agent.toolList(),
    "agent:toolCall": ([name, input]) => agent.toolCall(name, input),
  };

  // Décompose une vidéo locale en frames d'APERÇU (ffmpeg, basse qualité) écrites dans le cache temp
  // SEQ_DIR (purgé au boot) → liste de chemins pour bâtir un item séquence. `in/out` (s) = plage de
  // boucle. Pas de persistance durable : un aperçu ne doit pas remplir le disque (cf. SEQ_DIR).
  async function extractBoardFrames(opts) {
    const { path: src, fps, max, height, in: inSec, out: outSec, projectPath, title } = opts || {};
    if (!src) return { ok: false, error: t("sourceMissing") };
    if (/^(https?:|data:|blob:)/i.test(String(src))) return { ok: false, error: t("localMediaRequired") };
    try {
      const { frames, fps: usedFps } = await ffmpeg.extractFrames(src, { fps, max, height, start: inSec, end: outSec });
      if (!frames.length) return { ok: false, error: t("noFrames") };
      if (!projectPath) return { ok: true, frames, fps: usedFps };
      const index = netsuSidecar.indexSidecar(projectPath);
      const group = netsuSidecar.slugify(title || "sequence");
      const organized = [];
      for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
        const adopted = netsuSidecar.adopt(projectPath, frames[frameIndex], {
          place: { kind: "image", group, index: frameIndex },
          index,
        });
        if (adopted.ok && adopted.path) organized.push(adopted.path);
      }
      if (!organized.length) return { ok: false, error: t("noFrames") };
      return { ok: true, frames: organized, fps: usedFps };
    } catch (e) {
      return { ok: false, error: String(e.stderr || e) };
    }
  }

  // Image → sidecar `image` (sortie PNG) ; vidéo → sidecar `upscale` HEVC mp4 (lisible direct sur le
  // board). `in/out` (secondes) = cut local ; sinon média entier. Renvoie { ok, path }.
  async function upscaleBoardItem(event, opts) {
    const { path: src, kind, in: inSec, out: outSec, engine = "ia", model = "fallin", shader = "artcnn_c4f32", scale = 2, denoise } = opts || {};
    if (!src) return { ok: false, error: t("sourceMissing") };
    if (/^(https?:|data:|blob:)/i.test(String(src))) return { ok: false, error: t("localMediaRequired") };

    // Un upscale coûte des minutes de GPU. Le registre répond d'abord : même source, mêmes bornes,
    // mêmes réglages ⇒ le fichier existe déjà (l'archivage des collections s'en sert depuis
    // toujours ; refaire le calcul pour le board était la même dépense pour rien).
    const ledgerKey = upLedger.fingerprint({
      ...upLedger.statSource(String(src)),
      src: String(src),
      in: inSec, out: outSec,
      encode: { workflow: `board_${kind === "image" ? "image" : "video"}` },
      upscale: { enabled: true, engine, model, shader, scale, denoise },
    });
    const known = upLedger.lookup(ledgerKey);
    if (known) return { ok: true, path: known.file, cached: true };
    const remember = (out) => {
      if (out) upLedger.record(ledgerKey, out, { engine, model: engine === "turbo" ? shader : model, scale });
      return out;
    };
    const base = `up_${Date.now().toString(36)}`;

    // Moteur Turbo (shader GPU libplacebo) sur une VIDÉO : sortie HEVC mp4 (encode GPU) directement
    // lisible sur le board. L'image fixe a son propre aiguillage plus bas.
    if (engine === "turbo" && kind !== "image") {
      const segs = inSec != null && outSec != null ? [{ in: inSec, out: outSec }] : undefined;
      const r = await turbo.runTurbo(sidecars, event, {
        input: src, shader, scale, codec: "hevc_nvenc", outDir: refStore.assetsDir,
        whole: !segs, segments: segs, importBack: false, baseName: base,
      });
      if (!r || !r.ok || !r.outputs || !r.outputs.length) return { ok: false, error: (r && r.error) || "échec upscale turbo" };
      return { ok: true, path: remember(r.outputs[0]) };
    }

    if (kind === "image") {
      // GIF animé → chemin dédié (toutes les frames → GIF), sinon image fixe (1 frame → PNG).
      const isGif = /\.gif$/i.test(String(src));
      const out = refStore.assetPath(`${base}.${isGif ? "gif" : "png"}`);
      // Moteur Turbo sur une image : même shader GPU que la vidéo (une frame), et un GIF animé garde
      // ses frames et sa cadence par le chemin dédié. Une image partait jusqu'ici TOUJOURS sur le
      // moteur IA, y compris quand un shader était choisi : le choix était ignoré en silence.
      const r = engine === "turbo"
        ? await turbo.runTurboImage(sidecars, { input: src, out, shader, scale, denoise })
        : isGif
          ? await sidecars.runUpscaleGif({ input: src, out, model, scale, denoise })
          : await sidecars.runUpscaleImage({ input: src, out, model, scale, denoise });
      if (!r || !r.ok || !r.output) return { ok: false, error: (r && r.error) || "échec upscale image" };
      return { ok: true, path: remember(r.output), width: r.width, height: r.height };
    }

    const segments = inSec != null && outSec != null ? [{ in: inSec, out: outSec }] : undefined;
    const r = await sidecars.runUpscale(event, {
      input: src, model, scale, codec: "x265", denoise, audio: "aac",
      outDir: refStore.assetsDir, whole: !segments, segments, importBack: false, baseName: base,
    });
    if (!r || !r.ok || !r.outputs || !r.outputs.length) return { ok: false, error: (r && r.error) || "échec upscale vidéo" };
    return { ok: true, path: remember(r.outputs[0]) };
  }

  // Préchauffe SigLIP dès le démarrage du core, en fond : le chargement du modèle (plusieurs
  // secondes) était payé par le PREMIER usage de la recherche, pile quand l'utilisateur attend.
  // Conditions : un index non vide (sinon rien à préparer) et un délai qui laisse passer le boot.
  const PREWARM_DELAY_MS = 5000;
  const prewarmTimer = setTimeout(() => {
    const info = searchCatalog.status();
    if (!info || !info.frames) return;
    sidecars.queryReq("warm", {}).catch(() => { /* recherche indisponible : chargement paresseux */ });
  }, PREWARM_DELAY_MS);
  prewarmTimer.unref?.();

  // Ménage du magasin d'assets du board, AU DÉMARRAGE et à ce moment-là seulement : aucun board
  // n'est encore ouvert, donc aucun fichier affiché ne peut disparaître sous les yeux de personne.
  // Sans ça, sorties d'upscale, frames extraites et médias téléchargés s'empilent pour toujours.
  const ASSET_SWEEP_DELAY_MS = 20000;
  const assetSweepTimer = setTimeout(() => {
    const swept = refStore.sweepAssets({});
    if (swept.ok && swept.removed) {
      logbus.emit("core", "info", `[board] ${swept.removed} asset(s) inutilisés retirés (${Math.round(swept.bytes / 1048576)} Mo)`);
    }
  }, ASSET_SWEEP_DELAY_MS);
  assetSweepTimer.unref?.();

  function handle(req, res, u) {
    // SSE : flux d'événements de progression
    if (u.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return true;
    }

    // Invocation : POST /rpc
    if (u.pathname === "/rpc" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let msg = {};
        try {
          msg = JSON.parse(body);
        } catch {}
        if (process.env.NR_CORE_DEBUG) console.error("[rpc]", msg.channel);
        const h = H[msg.channel];
        if (!h) {
          res.writeHead(404, JSONH).end(JSON.stringify({ ok: false, error: `unknown channel: ${msg.channel}` }));
          return;
        }
        try {
          const result = await h(msg.args || [], ev);
          res.writeHead(200, JSONH).end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          const detail = String((err && err.stack) || err);
          logbus.emit("core", "error", `[rpc ${msg.channel}] ${detail.split("\n")[0]}`);
          res.writeHead(200, JSONH).end(JSON.stringify({ ok: false, error: detail }));
        }
      });
      return true;
    }

    return false;
  }

  return {
    handle, broadcast, channels: Object.keys(H), stopWatch: watch.stop, stopAgent: agent.cancelAll,
    stopDiscord: discordRpc.stop, stopCache: cachePolicy.stop, stopWatchdog: optimize.stopWatchdog,
    stopArchiveQueue: archiveQueue.stop,
    stopPrewarm: () => clearTimeout(prewarmTimer),
    closeProjects: () => { netsu.closeAllProjects(); notebookStore.closeAllProjects(); },
    // Les édits de découpe sont écrits par lots : sans ce vidage, ceux des 300 dernières ms seraient
    // perdus à la fermeture de l'app.
    flushCutEdits: cutEditsStore.flush,
  };
}

module.exports = { createRpc };
