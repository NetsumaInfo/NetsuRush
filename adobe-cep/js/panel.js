/*
 * panel.js — logique du panneau CEP NetsuRush.
 * Syntaxe conservatrice (var / function / promesses, JAMAIS ?. ni ??) : doit tourner de
 * CEP 9-10 (hôtes 2020, Chromium 61-74) jusqu'à CEP 12 (Chromium 99).
 * Rôle : pont entre l'hôte Adobe (evalScript -> host.jsx) et le core
 * NetsuRush (HTTP 127.0.0.1:8730 + SSE /events), et vue « remote » (l'app
 * NetsuRush affichée DANS le panneau via iframe — c'est LE mode nominal).
 */
/* global CSInterface, EventSource */
(function () {
  "use strict";

  var CORE_PORT_FIRST = 8730;
  var CORE_PORT_SPAN = 20;
  var CORE = "http://127.0.0.1:" + CORE_PORT_FIRST;
  var DEV_URL = "http://localhost:1420"; // Vite (dev) ; en prod le core sert le build sous /app
  var cs = new CSInterface();
  var hostEnv = cs.getHostEnvironment();
  var APP = hostEnv.appName === "PPRO" ? "ppro" : "aeft";
  var coreOnline = false;
  var es = null;
  var esRetryTimer = null;
  var currentLang = "fr";

  var TEXT = {
    fr: {
      serviceTitle:"Service NetsuRush",statusLabel:"Statut",online:"connecté",offline:"hors ligne",openApp:"Ouvrir NetsuRush",appOpen:"NetsuRush est ouvert",showHere:"Afficher NetsuRush ici",serviceHint:"NetsuRush s’affiche automatiquement dans ce panneau dès que le service est en ligne (moteur Adobe ancien : le rendu peut être dégradé). Faites un clic droit pour ouvrir le menu du panneau.",projectTitle:"Projet",rushes:"Rushs",sequences:"Séquences / compos",lastScan:"Dernier scan",never:"jamais",sendProject:"Envoyer vers NetsuRush",logTitle:"Journal",chooseFiles:"Choisir des fichiers",menuHome:"Statut du panneau",menuReload:"Recharger NetsuRush",menuScan:"Envoyer le projet vers NetsuRush",menuOpen:"Ouvrir l’application NetsuRush",
      hostReady:"Hôte initialisé (scripts chargés depuis {path})",hostInitFailed:"Échec de l’initialisation de l’hôte : {error}",coreConnected:"Core NetsuRush connecté",coreUnavailable:"Core NetsuRush injoignable",scanRequested:"Scan demandé par NetsuRush",hostScriptFailed:"Échec du script hôte ({error})",hostResponseUnreadable:"Réponse hôte illisible",hostError:"Hôte : {error}",unknownError:"erreur inconnue",projectSent:"Projet envoyé ({rushes} rushs, {sequences} séquences)",sendFailed:"Envoi impossible : {error}",appUnavailable:"App injoignable (ni dev :1420, ni build /app) — ouvrez NetsuRush ou lancez npm run build",appLoadTimeout:"NetsuRush n’a pas répondu — retour à l’accueil du panneau",filePickerUnavailable:"Sélecteur de fichiers indisponible : {error}",hostScriptError:"script hôte : {error}",jobBuild:"Montage",jobPlace:"Transfert de timeline",jobScript:"Script hôte",jobImport:"Import",jobExportXml:"Lecture des animations",hostStale:"Scripts hôtes périmés ({fn}) — rechargement puis nouvelle tentative",jobBoost:"Optimisation",jobSuccess:"{label} : {timeline}{count} {items}",item:"élément",items:"éléments",jobFailed:"{label} : {error}",failed:"échec",alreadyOpen:"NetsuRush est déjà ouvert",appLaunched:"NetsuRush lancé",appNotFound:"NetsuRush introuvable — lancez l’application manuellement",
      errNoProject:"aucun projet ouvert",errMissingSource:"chemin source manquant",errImportFailed:"import échoué",errMediaMissing:"fichier introuvable sur le disque",errClipNotFound:"clip introuvable ou import échoué",errSequenceCreateFailed:"création de séquence échouée",errInsertFailed:"insertion échouée",errNoShotsInserted:"aucun plan inséré",errNoValidShots:"aucun plan valide",errNoLayersAdded:"aucun calque posé",errScriptMissing:"script introuvable",errScriptFailed:"échec du script hôte",errUnsupportedOp:"opération non supportée par cet hôte"
    },
    en: {
      serviceTitle:"NetsuRush service",statusLabel:"Status",online:"connected",offline:"offline",openApp:"Open NetsuRush",appOpen:"NetsuRush is open",showHere:"Show NetsuRush here",serviceHint:"NetsuRush appears automatically in this panel as soon as the service is online (Adobe’s older engine may affect rendering). Right-click to open the panel menu.",projectTitle:"Project",rushes:"Footage",sequences:"Sequences / comps",lastScan:"Last scan",never:"never",sendProject:"Send to NetsuRush",logTitle:"Log",chooseFiles:"Choose files",menuHome:"Panel status",menuReload:"Reload NetsuRush",menuScan:"Send project to NetsuRush",menuOpen:"Open the NetsuRush app",
      hostReady:"Host initialized (scripts loaded from {path})",hostInitFailed:"Host initialization failed: {error}",coreConnected:"NetsuRush core connected",coreUnavailable:"NetsuRush core unavailable",scanRequested:"Scan requested by NetsuRush",hostScriptFailed:"Host script failed ({error})",hostResponseUnreadable:"Unreadable host response",hostError:"Host: {error}",unknownError:"unknown error",projectSent:"Project sent ({rushes} clips, {sequences} sequences)",sendFailed:"Could not send: {error}",appUnavailable:"App unavailable (neither dev :1420 nor build /app) — open NetsuRush or run npm run build",appLoadTimeout:"NetsuRush did not respond — back to the panel home",filePickerUnavailable:"File picker unavailable: {error}",hostScriptError:"host script: {error}",jobBuild:"Edit",jobPlace:"Timeline transfer",jobScript:"Host script",jobImport:"Import",jobExportXml:"Animation read",hostStale:"Stale host scripts ({fn}) — reloading and retrying",jobBoost:"Optimization",jobSuccess:"{label}: {timeline}{count} {items}",item:"item",items:"items",jobFailed:"{label}: {error}",failed:"failed",alreadyOpen:"NetsuRush is already open",appLaunched:"NetsuRush launched",appNotFound:"NetsuRush not found — launch the app manually",
      errNoProject:"no project open",errMissingSource:"source path missing",errImportFailed:"import failed",errMediaMissing:"file not found on disk",errClipNotFound:"clip not found or import failed",errSequenceCreateFailed:"sequence creation failed",errInsertFailed:"insert failed",errNoShotsInserted:"no shots inserted",errNoValidShots:"no valid shots",errNoLayersAdded:"no layers added",errScriptMissing:"script not found",errScriptFailed:"host script failed",errUnsupportedOp:"operation not supported by this host"
    },
    es: {
      serviceTitle:"Servicio NetsuRush",statusLabel:"Estado",online:"conectado",offline:"sin conexión",openApp:"Abrir NetsuRush",appOpen:"NetsuRush está abierto",showHere:"Mostrar NetsuRush aquí",serviceHint:"NetsuRush aparece automáticamente en este panel cuando el servicio está conectado (el motor antiguo de Adobe puede afectar a la visualización). Haz clic derecho para abrir el menú del panel.",projectTitle:"Proyecto",rushes:"Material",sequences:"Secuencias / compos",lastScan:"Último análisis",never:"nunca",sendProject:"Enviar a NetsuRush",logTitle:"Registro",chooseFiles:"Elegir archivos",menuHome:"Estado del panel",menuReload:"Recargar NetsuRush",menuScan:"Enviar el proyecto a NetsuRush",menuOpen:"Abrir la aplicación NetsuRush",
      hostReady:"Host inicializado (scripts cargados desde {path})",hostInitFailed:"No se pudo inicializar el host: {error}",coreConnected:"Core de NetsuRush conectado",coreUnavailable:"Core de NetsuRush no disponible",scanRequested:"NetsuRush ha solicitado un análisis",hostScriptFailed:"Error del script del host ({error})",hostResponseUnreadable:"No se puede leer la respuesta del host",hostError:"Host: {error}",unknownError:"error desconocido",projectSent:"Proyecto enviado ({rushes} clips, {sequences} secuencias)",sendFailed:"No se pudo enviar: {error}",appUnavailable:"La aplicación no está disponible (ni dev :1420 ni build /app). Abre NetsuRush o ejecuta npm run build",appLoadTimeout:"NetsuRush no respondió: se vuelve al inicio del panel",filePickerUnavailable:"Selector de archivos no disponible: {error}",hostScriptError:"script del host: {error}",jobBuild:"Montaje",jobPlace:"Transferencia de línea de tiempo",jobScript:"Script del host",jobImport:"Importación",jobExportXml:"Lectura de animaciones",hostStale:"Scripts del host obsoletos ({fn}): se recargan y se reintenta",jobBoost:"Optimización",jobSuccess:"{label}: {timeline}{count} {items}",item:"elemento",items:"elementos",jobFailed:"{label}: {error}",failed:"error",alreadyOpen:"NetsuRush ya está abierto",appLaunched:"NetsuRush iniciado",appNotFound:"No se encuentra NetsuRush. Inicia la aplicación manualmente",
      errNoProject:"no hay ningún proyecto abierto",errMissingSource:"falta la ruta de origen",errImportFailed:"falló la importación",errMediaMissing:"no se encuentra el archivo en el disco",errClipNotFound:"no se encontró el clip o falló la importación",errSequenceCreateFailed:"no se pudo crear la secuencia",errInsertFailed:"falló la inserción",errNoShotsInserted:"no se insertó ningún plano",errNoValidShots:"no hay ningún plano válido",errNoLayersAdded:"no se añadió ninguna capa",errScriptMissing:"no se encontró el script",errScriptFailed:"falló el script del host",errUnsupportedOp:"operación no admitida por este host"
    },
    de: {
      serviceTitle:"NetsuRush-Dienst",statusLabel:"Status",online:"verbunden",offline:"offline",openApp:"NetsuRush öffnen",appOpen:"NetsuRush ist geöffnet",showHere:"NetsuRush hier anzeigen",serviceHint:"NetsuRush wird automatisch in diesem Bedienfeld angezeigt, sobald der Dienst online ist (die ältere Adobe-Engine kann die Darstellung beeinträchtigen). Mit einem Rechtsklick öffnen Sie das Bedienfeldmenü.",projectTitle:"Projekt",rushes:"Material",sequences:"Sequenzen / Kompositionen",lastScan:"Letzter Scan",never:"nie",sendProject:"An NetsuRush senden",logTitle:"Protokoll",chooseFiles:"Dateien auswählen",menuHome:"Bedienfeldstatus",menuReload:"NetsuRush neu laden",menuScan:"Projekt an NetsuRush senden",menuOpen:"NetsuRush-App öffnen",
      hostReady:"Host initialisiert (Skripte geladen aus {path})",hostInitFailed:"Host konnte nicht initialisiert werden: {error}",coreConnected:"NetsuRush-Core verbunden",coreUnavailable:"NetsuRush-Core nicht erreichbar",scanRequested:"NetsuRush hat einen Scan angefordert",hostScriptFailed:"Host-Skript fehlgeschlagen ({error})",hostResponseUnreadable:"Host-Antwort kann nicht gelesen werden",hostError:"Host: {error}",unknownError:"unbekannter Fehler",projectSent:"Projekt gesendet ({rushes} Clips, {sequences} Sequenzen)",sendFailed:"Senden fehlgeschlagen: {error}",appUnavailable:"App nicht erreichbar (weder dev :1420 noch build /app) — öffnen Sie NetsuRush oder führen Sie npm run build aus",appLoadTimeout:"NetsuRush hat nicht geantwortet — zurück zur Bedienfeld-Startseite",filePickerUnavailable:"Dateiauswahl nicht verfügbar: {error}",hostScriptError:"Host-Skript: {error}",jobBuild:"Schnitt",jobPlace:"Timeline-Übertragung",jobScript:"Host-Skript",jobImport:"Import",jobExportXml:"Animationen lesen",hostStale:"Veraltete Host-Skripte ({fn}) — werden neu geladen, dann neuer Versuch",jobBoost:"Optimierung",jobSuccess:"{label}: {timeline}{count} {items}",item:"Element",items:"Elemente",jobFailed:"{label}: {error}",failed:"fehlgeschlagen",alreadyOpen:"NetsuRush ist bereits geöffnet",appLaunched:"NetsuRush gestartet",appNotFound:"NetsuRush nicht gefunden — starten Sie die App manuell",
      errNoProject:"kein Projekt geöffnet",errMissingSource:"Quellpfad fehlt",errImportFailed:"Import fehlgeschlagen",errMediaMissing:"Datei auf dem Datenträger nicht gefunden",errClipNotFound:"Clip nicht gefunden oder Import fehlgeschlagen",errSequenceCreateFailed:"Sequenz konnte nicht erstellt werden",errInsertFailed:"Einfügen fehlgeschlagen",errNoShotsInserted:"keine Clips eingefügt",errNoValidShots:"keine gültigen Clips",errNoLayersAdded:"keine Ebenen eingefügt",errScriptMissing:"Skript nicht gefunden",errScriptFailed:"Host-Skript fehlgeschlagen",errUnsupportedOp:"Von diesem Host nicht unterstützte Operation"
    },
    ja: {
      serviceTitle:"NetsuRush サービス",statusLabel:"ステータス",online:"接続済み",offline:"オフライン",openApp:"NetsuRush を開く",appOpen:"NetsuRush は起動中です",showHere:"ここに NetsuRush を表示",serviceHint:"サービスがオンラインになると、このパネル内に NetsuRush が自動的に表示されます（Adobe の古いエンジンでは表示が崩れる場合があります）。右クリックするとパネルメニューが開きます。",projectTitle:"プロジェクト",rushes:"素材",sequences:"シーケンス / コンポジション",lastScan:"前回のスキャン",never:"未実行",sendProject:"NetsuRush に送信",logTitle:"ログ",chooseFiles:"ファイルを選択",menuHome:"パネルのステータス",menuReload:"NetsuRush を再読み込み",menuScan:"プロジェクトを NetsuRush に送信",menuOpen:"NetsuRush アプリを開く",
      hostReady:"ホストを初期化しました（{path} からスクリプトを読み込みました）",hostInitFailed:"ホストを初期化できませんでした：{error}",coreConnected:"NetsuRush コアに接続しました",coreUnavailable:"NetsuRush コアに接続できません",scanRequested:"NetsuRush からスキャンが要求されました",hostScriptFailed:"ホストスクリプトに失敗しました（{error}）",hostResponseUnreadable:"ホストの応答を読み取れません",hostError:"ホスト：{error}",unknownError:"不明なエラー",projectSent:"プロジェクトを送信しました（素材 {rushes} 件、シーケンス {sequences} 件）",sendFailed:"送信できませんでした：{error}",appUnavailable:"アプリに接続できません（dev :1420 と build /app のどちらも利用不可）。NetsuRush を開くか npm run build を実行してください",appLoadTimeout:"NetsuRush が応答しませんでした。パネルのホームに戻ります",filePickerUnavailable:"ファイル選択を利用できません：{error}",hostScriptError:"ホストスクリプト：{error}",jobBuild:"編集",jobPlace:"タイムライン転送",jobScript:"ホストスクリプト",jobImport:"読み込み",jobExportXml:"アニメーションの読み取り",hostStale:"ホストスクリプトが古いままです（{fn}）。再読み込みして再試行します",jobBoost:"最適化",jobSuccess:"{label}：{timeline}{count} {items}",item:"件",items:"件",jobFailed:"{label}：{error}",failed:"失敗",alreadyOpen:"NetsuRush はすでに開いています",appLaunched:"NetsuRush を起動しました",appNotFound:"NetsuRush が見つかりません。アプリを手動で起動してください",
      errNoProject:"プロジェクトが開かれていません",errMissingSource:"ソースパスがありません",errImportFailed:"読み込みに失敗しました",errMediaMissing:"ディスク上にファイルが見つかりません",errClipNotFound:"クリップが見つからないか、読み込みに失敗しました",errSequenceCreateFailed:"シーケンスを作成できませんでした",errInsertFailed:"挿入に失敗しました",errNoShotsInserted:"ショットを挿入できませんでした",errNoValidShots:"有効なショットがありません",errNoLayersAdded:"レイヤーを配置できませんでした",errScriptMissing:"スクリプトが見つかりません",errScriptFailed:"ホストスクリプトが失敗しました",errUnsupportedOp:"このホストでは対応していない操作です"
    },
    zh: {
      serviceTitle:"NetsuRush 服务",statusLabel:"状态",online:"已连接",offline:"离线",openApp:"打开 NetsuRush",appOpen:"NetsuRush 已打开",showHere:"在此显示 NetsuRush",serviceHint:"服务上线后，NetsuRush 会自动显示在此面板中（Adobe 的旧版引擎可能会影响显示效果）。右键单击可打开面板菜单。",projectTitle:"项目",rushes:"素材",sequences:"序列 / 合成",lastScan:"上次扫描",never:"从未",sendProject:"发送到 NetsuRush",logTitle:"日志",chooseFiles:"选择文件",menuHome:"面板状态",menuReload:"重新加载 NetsuRush",menuScan:"将项目发送到 NetsuRush",menuOpen:"打开 NetsuRush 应用",
      hostReady:"宿主已初始化（脚本加载自 {path}）",hostInitFailed:"宿主初始化失败：{error}",coreConnected:"已连接 NetsuRush 核心服务",coreUnavailable:"无法连接 NetsuRush 核心服务",scanRequested:"NetsuRush 请求扫描",hostScriptFailed:"宿主脚本执行失败（{error}）",hostResponseUnreadable:"无法读取宿主响应",hostError:"宿主：{error}",unknownError:"未知错误",projectSent:"项目已发送（{rushes} 个素材，{sequences} 个序列）",sendFailed:"无法发送：{error}",appUnavailable:"无法连接应用（dev :1420 和 build /app 均不可用）。请打开 NetsuRush 或运行 npm run build",appLoadTimeout:"NetsuRush 无响应，已返回面板首页",filePickerUnavailable:"文件选择器不可用：{error}",hostScriptError:"宿主脚本：{error}",jobBuild:"剪辑",jobPlace:"时间线传输",jobScript:"宿主脚本",jobImport:"导入",jobExportXml:"读取动画",hostStale:"宿主脚本已过期（{fn}），正在重新加载并重试",jobBoost:"优化",jobSuccess:"{label}：{timeline}{count} {items}",item:"项",items:"项",jobFailed:"{label}：{error}",failed:"失败",alreadyOpen:"NetsuRush 已打开",appLaunched:"NetsuRush 已启动",appNotFound:"找不到 NetsuRush，请手动启动应用",
      errNoProject:"没有打开的项目",errMissingSource:"缺少源路径",errImportFailed:"导入失败",errMediaMissing:"磁盘上找不到该文件",errClipNotFound:"找不到剪辑或导入失败",errSequenceCreateFailed:"无法创建序列",errInsertFailed:"插入失败",errNoShotsInserted:"未插入任何镜头",errNoValidShots:"没有有效镜头",errNoLayersAdded:"未添加任何图层",errScriptMissing:"找不到脚本",errScriptFailed:"宿主脚本执行失败",errUnsupportedOp:"该宿主不支持此操作"
    }
  };
  var HOST_ERROR_KEYS = {
    NO_PROJECT:"errNoProject",MISSING_SOURCE:"errMissingSource",IMPORT_FAILED:"errImportFailed",MEDIA_MISSING:"errMediaMissing",
    CLIP_NOT_FOUND:"errClipNotFound",SEQUENCE_CREATE_FAILED:"errSequenceCreateFailed",
    INSERT_FAILED:"errInsertFailed",NO_SHOTS_INSERTED:"errNoShotsInserted",
    NO_VALID_SHOTS:"errNoValidShots",NO_LAYERS_ADDED:"errNoLayersAdded",
    SCRIPT_MISSING:"errScriptMissing",SCRIPT_FAILED:"errScriptFailed",UNSUPPORTED_OP:"errUnsupportedOp"
  };
  function normalizeLang(value) {
    var code = String(value || "").toLowerCase().split(/[-_]/)[0];
    return TEXT[code] ? code : "fr";
  }
  function tr(key) { return (TEXT[currentLang] && TEXT[currentLang][key]) || TEXT.fr[key] || key; }
  function trf(key, values) {
    return tr(key).replace(/\{([^}]+)\}/g, function (_, name) {
      return values && values[name] !== undefined ? String(values[name]) : "";
    });
  }
  function hostResultError(result) {
    var key = result && HOST_ERROR_KEYS[result.errorCode];
    var message = key ? tr(key) : ((result && result.error) || tr("failed"));
    if (result && result.errorDetail) message += " : " + result.errorDetail;
    return message;
  }

  // Chargement fiable des sous-scripts ExtendScript : host.jsx (ScriptPath) localise mal ses
  // fichiers voisins via $.fileName sous CEP → on les évalue depuis le chemin d'extension CONNU
  // du panneau (getExtensionPath) avant toute action (sinon NRJSON/NR_*_snapshot indéfinis).
  var JSX_DIR = "";
  try { JSX_DIR = cs.getExtensionPath().replace(/\\/g, "/") + "/jsx"; } catch (e) { JSX_DIR = ""; }
  // `host.jsx` EN DERNIER, et il est bien de la partie : c'est le `ScriptPath` du manifeste, donc
  // Premiere ne le charge qu'au démarrage de l'APPLICATION. L'omettre ici laissait le dispatcher
  // périmé alors que ses voisins étaient à jour — un `NR_ppro_* is not a function` dont rien dans
  // l'interface ne disait la cause, et que seul un redémarrage de Premiere réparait.
  var JSX_FILES = ["nrjson.jsx", "host-ppro.jsx", "host-aeft.jsx", "host.jsx"];
  // Empreinte des scripts hôtes SUR DISQUE. Sans elle, une mise à jour de NetsuRush (réinstallation
  // du panneau) laissait tourner les jsx chargés à l'ouverture du panneau jusqu'au redémarrage de
  // l'hôte : le correctif était sur le disque mais pas dans Premiere/AE.
  var stampFallback = 0;
  function jsxStamp() {
    var stamp = "";
    for (var i = 0; i < JSX_FILES.length; i++) {
      var st = null;
      try { st = window.cep.fs.stat(JSX_DIR + "/" + JSX_FILES[i]); } catch (e0) {}
      var data = st && st.err === 0 ? st.data : null;
      // Empreinte ILLISIBLE : on rend une valeur toujours neuve. Un marqueur constant (« ? ») rendait
      // le stamp identique d'un appel à l'autre, donc les scripts ne se rechargeaient PLUS JAMAIS.
      stamp += JSX_FILES[i] + ":" + (data ? String(data.mtime) + "/" + String(data.size) : "?" + (++stampFallback)) + ";";
    }
    return stamp;
  }
  var hostStamp = null;
  /**
   * Recharge les scripts hôtes. `force` ignore l'empreinte : c'est le rattrapage quand l'hôte
   * répond qu'une fonction n'existe pas, seul signe fiable d'un script périmé en mémoire.
   */
  function bootHost(done, force) {
    if (!JSX_DIR) { done(); return; }
    var stamp = jsxStamp();
    if (!force && hostStamp === stamp) { done(); return; }
    var code = "";
    // Chaque fichier est évalué SÉPARÉMENT et son échec rapporté : concaténés, le premier refus
    // emportait les suivants sans dire lequel avait cassé.
    for (var i = 0; i < JSX_FILES.length; i++) {
      code += 'try{$.evalFile("' + JSX_DIR + "/" + JSX_FILES[i] + '");}catch(e){f.push("' + JSX_FILES[i] + ': "+e);}';
    }
    cs.evalScript('var f=[];' + code + 'f.length?f.join(" | "):"ok"', function (r) {
      if (r === "ok") { hostStamp = stamp; log(trf("hostReady", { path: JSX_DIR })); }
      else { hostStamp = null; log(trf("hostInitFailed", { error: String(r) }), true); }
      done();
    });
  }

  var el = {
    host: document.getElementById("host"),
    serviceTitle: document.getElementById("serviceTitle"), statusLabel: document.getElementById("statusLabel"),
    serviceHint: document.getElementById("serviceHint"), projectTitle: document.getElementById("projectTitle"),
    rushesLabel: document.getElementById("rushesLabel"), sequencesLabel: document.getElementById("sequencesLabel"),
    lastScanLabel: document.getElementById("lastScanLabel"), logTitle: document.getElementById("logTitle"),
    coreDot: document.getElementById("coreDot"),
    coreState: document.getElementById("coreState"),
    nRushes: document.getElementById("nRushes"),
    nSeqs: document.getElementById("nSeqs"),
    lastScan: document.getElementById("lastScan"),
    btnScan: document.getElementById("btnScan"),
    btnOpenApp: document.getElementById("btnOpenApp"),
    btnRemote: document.getElementById("btnRemote"),
    remoteWrap: document.getElementById("remoteWrap"),
    appFrame: document.getElementById("appFrame"),
    log: document.getElementById("log")
  };

  function applyLanguage(value) {
    currentLang = normalizeLang(value);
    document.documentElement.lang = currentLang;
    el.serviceTitle.textContent = tr("serviceTitle"); el.statusLabel.textContent = tr("statusLabel");
    el.coreDot.title = tr("serviceTitle");
    el.serviceHint.textContent = tr("serviceHint"); el.projectTitle.textContent = tr("projectTitle");
    el.rushesLabel.textContent = tr("rushes"); el.sequencesLabel.textContent = tr("sequences");
    el.lastScanLabel.textContent = tr("lastScan"); el.logTitle.textContent = tr("logTitle");
    if (el.lastScan.getAttribute("data-empty") !== "false") el.lastScan.textContent = tr("never");
    el.btnScan.textContent = tr("sendProject"); el.btnRemote.textContent = tr("showHere");
    el.coreState.textContent = coreOnline ? tr("online") : tr("offline");
    el.btnOpenApp.textContent = coreOnline ? tr("appOpen") : tr("openApp");
    installMenus();
  }
  var browserLang = (navigator.languages && navigator.languages[0]) || navigator.language || "fr";

  el.host.textContent = (APP === "ppro" ? "Premiere Pro " : "After Effects ") + hostEnv.appVersion;

  // Le journal du panneau vit DANS Premiere : un utilisateur qui rapporte un problème depuis
  // NetsuRush ne le voit pas, et c'est pourtant le seul endroit où l'échec de chargement d'un
  // script hôte est nommé. On le relaie donc au core, qui le diffuse dans la console de l'app.
  var relayingLog = false;
  function relayLog(msg, isErr) {
    if (relayingLog || !coreOnline) return;
    relayingLog = true;
    rpc("adobe:panelLog", [{ app: APP, message: String(msg), level: isErr ? "error" : "log" }])
      .catch(function () { /* core injoignable : le journal local reste la seule trace */ })
      .then(function () { relayingLog = false; }, function () { relayingLog = false; });
  }

  function log(msg, isErr) {
    var line = document.createElement("div");
    if (isErr) line.className = "err";
    line.textContent = new Date().toLocaleTimeString() + "  " + msg;
    el.log.insertBefore(line, el.log.firstChild);
    while (el.log.childNodes.length > 60) el.log.removeChild(el.log.lastChild);
    relayLog(msg, isErr);
  }

  function rpc(channel, args) {
    return fetch(CORE + "/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: channel, args: args || [] })
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " · rpc " + channel);
      return r.json();
    }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || "rpc " + channel);
      return j.result;
    });
  }

  // Sonde une URL (résout true/false, jamais de rejet). mode no-cors : Vite dev ne pose pas
  // d'en-têtes CORS — la réponse opaque suffit à prouver que le serveur répond.
  function probe(url, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(false); } }, timeoutMs || 1200);
      try {
        fetch(url, { method: "GET", mode: "no-cors", cache: "no-store" }).then(function () {
          if (!done) { done = true; clearTimeout(t); resolve(true); }
        }).catch(function () {
          if (!done) { done = true; clearTimeout(t); resolve(false); }
        });
      } catch (e) { if (!done) { done = true; clearTimeout(t); resolve(false); } }
    });
  }

  // ---- Statut core (poll léger + heartbeat panneau) ----
  function setOnline(on) {
    if (on === coreOnline) return;
    coreOnline = on;
    el.coreDot.className = on ? "dot on" : "dot";
    el.coreState.textContent = on ? tr("online") : tr("offline");
    el.btnOpenApp.textContent = on ? tr("appOpen") : tr("openApp");
    if (on) { ensureSse(); maybeAutoRemote(); } else { hideRemote(true); }
    log(on ? tr("coreConnected") : tr("coreUnavailable"), !on);
  }

  // Le service ne tient plus un port fixe : l'application en choisit un LIBRE au lancement (8730
  // peut être pris par une seconde instance ou un logiciel tiers). Le panneau vit hors de
  // l'application, il ne peut donc que balayer la plage. `app: "netsurush"` distingue notre service
  // d'un logiciel tiers qui répondrait 200 sur le même port. La recherche ne repart QUE lorsque le
  // service est injoignable : en régime normal, aucun trafic supplémentaire.
  function healthz(port) {
    return fetch("http://127.0.0.1:" + port + "/healthz")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return !!j && j.app === "netsurush"; })
      .catch(function () { return false; });
  }
  function findCore(port) {
    if (port >= CORE_PORT_FIRST + CORE_PORT_SPAN) return Promise.resolve(false);
    return healthz(port).then(function (found) {
      if (!found) return findCore(port + 1);
      var next = "http://127.0.0.1:" + port;
      if (next !== CORE) { CORE = next; appBase = null; } // l'iframe est rebâtie sur la nouvelle adresse
      return true;
    });
  }

  function heartbeat() {
    rpc("adobe:panelHello", [{ app: APP, appVersion: hostEnv.appVersion }])
      .then(function () {
        setOnline(true);
        // Langue relue à CHAQUE battement, pas une seule fois : `nr.config.json` est la préférence
        // app-wide, et l'utilisateur peut la changer dans NetsuRush pendant que le panneau est
        // ouvert. Sans ça la coquille restait figée sur la langue lue au chargement.
        rpc("config:get").then(function (cfg) {
          if (cfg && cfg.lang && normalizeLang(cfg.lang) !== currentLang) applyLanguage(cfg.lang);
        }).catch(function () {});
      })
      .catch(function () {
        setOnline(false);
        // Injoignable : soit le service est éteint, soit il a démarré ailleurs. On cherche, et le
        // battement suivant retentera sur l'adresse trouvée.
        findCore(CORE_PORT_FIRST);
      });
  }
  heartbeat();
  setInterval(heartbeat, 5000);

  // ---- SSE : commandes du core vers le panneau (reconnexion automatique) ----
  function ensureSse() {
    if (es) return;
    if (esRetryTimer) { clearTimeout(esRetryTimer); esRetryTimer = null; }
    try {
      es = new EventSource(CORE + "/events");
      es.onmessage = function (e) {
        var msg;
        try { msg = JSON.parse(e.data); } catch (e0) { return; }
        if (!msg || msg.channel !== "adobe:cmd") return;
        var p = msg.payload || {};
        if (p.app && p.app !== APP) return;
        if (p.cmd === "scan") { log(tr("scanRequested")); doScan(); }
        else if (p.cmd === "buildTimeline") { doJob(p, "NR_buildTimeline", "jobBuild"); }
        else if (p.cmd === "placeTimeline") { doJob(p, "NR_placeTimeline", "jobPlace"); }
        else if (p.cmd === "runScript") { doJob(p, "NR_runScript", "jobScript"); }
        else if (p.cmd === "exportXml") { doJob(p, "NR_exportXml", "jobExportXml"); }
        else if (p.cmd === "importTimeline") { doJob(p, "NR_importTimeline", "jobImport"); }
        else if (p.cmd === "import") { doJob(p, "NR_import", "jobImport"); }
        else if (p.cmd === "boost") { doJob(p, "NR_boost", "jobBoost"); }
      };
      es.onerror = function () {
        try { es.close(); } catch (e1) {}
        es = null;
        // Retente vite (3 s) sans attendre le prochain heartbeat : les jobs buildTimeline/import
        // arrivent par ce canal, une coupure ne doit pas laisser un trou de plusieurs secondes.
        if (coreOnline && !esRetryTimer) {
          esRetryTimer = setTimeout(function () { esRetryTimer = null; ensureSse(); }, 3000);
        }
      };
    } catch (e2) { es = null; }
  }
  window.addEventListener("beforeunload", function () {
    try { if (es) es.close(); } catch (e0) {}
  });

  // ---- Scan : ExtendScript -> JSON -> core ----
  function doScan() { bootHost(scanNow); }
  function scanNow() {
    el.btnScan.disabled = true;
    cs.evalScript("NR_getSnapshot()", function (res) {
      el.btnScan.disabled = false;
      if (!res || res === CSInterface.EVAL_ERROR) {
        log(trf("hostScriptFailed", { error: String(res) }), true);
        return;
      }
      var snap;
      try { snap = JSON.parse(res); } catch (e0) {
        log(tr("hostResponseUnreadable"), true);
        return;
      }
      if (!snap.ok) {
        log(trf("hostError", { error: (snap.errorCode || snap.error) ? hostResultError(snap) : tr("unknownError") }), true);
        return;
      }
      el.nRushes.textContent = String((snap.rushes || []).length);
      el.nSeqs.textContent = String((snap.sequences || []).length);
      el.lastScan.textContent = new Date().toLocaleTimeString();
      el.lastScan.setAttribute("data-empty", "false");
      rpc("adobe:ingest", [snap]).then(function () {
        log(trf("projectSent", { rushes: (snap.rushes || []).length, sequences: (snap.sequences || []).length }));
      }).catch(function (err) {
        log(trf("sendFailed", { error: err.message }), true);
      });
    });
  }

  el.btnScan.addEventListener("click", doScan);

  // ---- Vue remote : l'app NetsuRush DANS le panneau (iframe) — mode nominal. ----
  // URL résolue dynamiquement : Vite :1420 si le dev tourne, sinon le build servi par le core
  // sous /app (stagé au packaging) → la vue marche aussi en production, sans serveur de dev.
  // ?core = URL du service ; ?remote=1 = coquille compacte (RemotePanel) ; ?host = cet hôte Adobe.
  var appBase = null; // résolue une fois par session (remise à zéro si le port du service change)
  function resolveAppBase() {
    if (appBase) return Promise.resolve(appBase);
    return probe(DEV_URL + "/", 1000).then(function (dev) {
      if (dev) { appBase = DEV_URL + "/"; return appBase; }
      return probe(CORE + "/app/", 1500).then(function (prod) {
        if (prod) { appBase = CORE + "/app/"; return appBase; }
        return null;
      });
    });
  }
  function remoteUrl(base) {
    return base + "?core=" + encodeURIComponent(CORE) + "&remote=1&host=" + APP;
  }
  var HOME_PREF = "nr.panelHome"; // "1" = l'utilisateur a fermé la vue app → rester sur l'accueil
  function prefHome() {
    try { return window.localStorage.getItem(HOME_PREF) === "1"; } catch (e0) { return false; }
  }
  function setPrefHome(v) {
    try { window.localStorage.setItem(HOME_PREF, v ? "1" : "0"); } catch (e0) {}
  }
  // Chien de garde : sans accusé `nr:panel/ready` de l'app, un iframe resté blanc (build absent,
  // core coupé en plein chargement) laisserait un panneau vide SANS bouton pour en sortir — la
  // coquille n'a plus de barre à elle. On revient alors à l'accueil, où tout reste accessible.
  var READY_MS = 20000;
  var appReady = false;
  var readyTimer = null;
  function armReadyWatchdog() {
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = setTimeout(function () {
      readyTimer = null;
      if (appReady) return;
      hideRemote(true);
      log(tr("appLoadTimeout"), true);
    }, READY_MS);
  }
  function showRemote(fromUser) {
    if (!el.appFrame || !el.remoteWrap) return;
    if (fromUser) setPrefHome(false);
    resolveAppBase().then(function (base) {
      if (!base) {
        log(tr("appUnavailable"), true);
        return;
      }
      if (!el.appFrame.src) { armReadyWatchdog(); el.appFrame.src = remoteUrl(base); }
      el.remoteWrap.style.display = "flex";
    });
  }
  // silent=true : masque sans mémoriser (perte du core) → la vue reviendra seule à la reconnexion.
  function hideRemote(silent) {
    if (el.remoteWrap) el.remoteWrap.style.display = "none";
    if (!silent) setPrefHome(true);
  }
  // Recharge complète : on re-sonde l'URL de base (le dev Vite a pu démarrer/s'arrêter entre-temps).
  function reloadRemote() {
    if (!el.appFrame) return;
    appBase = null;
    appReady = false;
    el.appFrame.src = "";
    showRemote(true);
  }
  // Auto-affichage au retour du core, sauf si l'utilisateur a explicitement fermé la vue.
  function maybeAutoRemote() {
    if (!prefHome()) showRemote(false);
  }
  if (el.btnRemote) el.btnRemote.addEventListener("click", function () { showRemote(true); });

  // L'app (iframe) ne peut pas ouvrir un dialogue fichiers (pas de Tauri) → elle nous le demande en
  // postMessage ; on ouvre le sélecteur NATIF de CEP (chemins disque réels) et on renvoie les chemins.
  // Même canal pour les commandes de coquille (`nr:panel`) : Recharger / Fermer sont rendus par
  // l'entête de l'app, mais seule la coquille peut ré-résoudre l'URL de base et masquer l'iframe.
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d.type === "nr:panel") {
      if (d.action === "ready") {
        appReady = true;
        if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      } else if (d.action === "reload") reloadRemote();
      else if (d.action === "home") hideRemote(false);
      return;
    }
    if (!d || d.type !== "nr:files") return;
    var out = { type: "nr:files:result", id: d.id, paths: [] };
    try {
      if (window.cep && window.cep.fs && window.cep.fs.showOpenDialog) {
        var types = (d.exts && d.exts.length) ? d.exts : ["mp4", "mov", "mkv", "avi", "m4v", "mxf", "webm", "wmv", "flv", "ts", "m2ts", "mpg", "mpeg"];
        var r = window.cep.fs.showOpenDialog(!!d.multiple, false, tr("chooseFiles"), "", types);
        if (r && r.data && r.data.length) out.paths = r.data;
      }
    } catch (e0) { log(trf("filePickerUnavailable", { error: e0 }), true); }
    if (e.source) e.source.postMessage(out, "*");
  });

  // ---- Job générique : NetsuRush demande une action à l'hôte (aller-retour). ----
  // Le payload JSON est embarqué comme littéral dans le code eval → l'hôte le reçoit en objet
  // natif (ExtendScript ES3 n'a pas JSON.parse). Le résultat repart en adobe:jobResult.
  function doJob(p, fn, label) { bootHost(function () { jobNow(p, fn, label); }); }

  /**
   * « … is not a function » est le seul signe fiable d'un script hôte PÉRIMÉ en mémoire : le
   * fichier est à jour sur le disque, mais l'hôte tourne encore sur la version d'avant. On force
   * alors un rechargement et on rejoue le job UNE fois, plutôt que de renvoyer une erreur que
   * l'utilisateur ne peut lever qu'en redémarrant Premiere.
   */
  function hostStale(res) {
    // `HOST_STALE` est le refus PROPRE des dispatchers de host.jsx ; « is not a function » est la
    // forme brute quand un script a manqué le rechargement. Les deux disent la même chose, et
    // n'attraper que la seconde désarmait le rattrapage dès qu'on rendait l'erreur lisible.
    return typeof res === "string" && /HOST_STALE|is not a function|is undefined/i.test(res);
  }

  function jobNow(p, fn, label, retried) {
    var code = fn + "(" + JSON.stringify(p.payload || {}) + ")";
    cs.evalScript(code, function (res) {
      var result;
      if (!retried && hostStale(res)) {
        log(trf("hostStale", { fn: fn }));
        bootHost(function () { jobNow(p, fn, label, true); }, true);
        return;
      }
      if (!res || res === CSInterface.EVAL_ERROR) {
        result = { ok: false, error: trf("hostScriptError", { error: String(res) }) };
      } else {
        try { result = JSON.parse(res); } catch (e0) { result = { ok: false, error: tr("hostResponseUnreadable") }; }
      }
      rpc("adobe:jobResult", [{ jobId: p.jobId, result: result }]).catch(function () {});
      var count = result.count || 0;
      var translatedLabel = tr(label);
      log(result.ok
        ? trf("jobSuccess", { label: translatedLabel, timeline: result.timeline ? "« " + result.timeline + " » · " : "", count: count, items: tr(count === 1 ? "item" : "items") })
        : trf("jobFailed", { label: translatedLabel, error: hostResultError(result) }), !result.ok);
    });
  }

  // ---- Ouvrir l'app standalone (si le core ne répond pas) ----
  // %LOCALAPPDATA% n'est PAS lisible ici : Node est désactivé dans le manifeste (pas de
  // --enable-nodejs) → window.cep_node est absent. On le dérive du chemin userData que CEP
  // expose toujours (…/AppData/Roaming → …/AppData/Local).
  function localAppData() {
    var roaming = cs.getSystemPath ? cs.getSystemPath("userData") : "";
    return roaming ? roaming.replace(/[\\/]Roaming[\\/]?$/i, "/Local") : "";
  }
  // L'installeur NSIS de NetsuRush est en installMode currentUser → %LOCALAPPDATA%\NetsuRush.
  // Les deux autres couvrent une install par machine et la convention …\Programs\ d'autres bundlers.
  function appCandidates() {
    var local = localAppData();
    var list = [];
    if (local) {
      list.push(local + "/NetsuRush/NetsuRush.exe");
      list.push(local + "/Programs/NetsuRush/NetsuRush.exe");
    }
    list.push("C:/Program Files/NetsuRush/NetsuRush.exe");
    return list;
  }
  function fileExists(path) {
    try {
      var st = window.cep && window.cep.fs && window.cep.fs.stat ? window.cep.fs.stat(path) : null;
      return !!st && st.err === 0;
    } catch (e0) { return false; }
  }
  el.btnOpenApp.addEventListener("click", function () {
    if (coreOnline) { log(tr("alreadyOpen")); return; }
    // On ne lance QUE ce qui existe : createProcess sur un chemin absent peut répondre err 0 et on
    // annoncerait un lancement qui n'a pas eu lieu.
    var candidates = appCandidates();
    var launched = false;
    for (var i = 0; i < candidates.length && !launched; i++) {
      if (!fileExists(candidates[i])) continue;
      try {
        var r = window.cep.process.createProcess(candidates[i]);
        if (r && r.err === 0) launched = true;
      } catch (e0) { /* chemin refusé par l'hôte → candidat suivant */ }
    }
    log(launched ? tr("appLaunched") : tr("appNotFound"), !launched);
  });

  // ---- Menus natifs du panneau (clic droit + flyout ≡) — navigation coquille. ----
  // Le clic droit DANS l'iframe reste géré par l'app React (menu contextuel RemotePanel) ; ces
  // menus couvrent la coquille (accueil + barre remote) et le flyout du panneau, sur tout hôte.
  function xmlAttr(value) { return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function onMenu(id) {
    if (id === "nrShow") showRemote(true);
    else if (id === "nrHome") hideRemote(false);
    else if (id === "nrReload") reloadRemote();
    else if (id === "nrScan") doScan();
    else if (id === "nrOpenApp") el.btnOpenApp.click();
  }
  function installMenus() {
   try {
    var menuJson = JSON.stringify({ menu: [
      { id:"nrShow", label:tr("showHere"), enabled:true }, { id:"nrHome", label:tr("menuHome"), enabled:true }, { label:"---" },
      { id:"nrReload", label:tr("menuReload"), enabled:true }, { id:"nrScan", label:tr("menuScan"), enabled:true }, { label:"---" },
      { id:"nrOpenApp", label:tr("menuOpen"), enabled:true }
    ] });
    if (cs.setContextMenuByJSON) cs.setContextMenuByJSON(menuJson, onMenu);
    if (cs.setPanelFlyoutMenu) {
      cs.setPanelFlyoutMenu(
        '<Menu>' +
        '<MenuItem Id="nrShow" Label="' + xmlAttr(tr("showHere")) + '" Enabled="true" Checked="false"/>' +
        '<MenuItem Id="nrHome" Label="' + xmlAttr(tr("menuHome")) + '" Enabled="true" Checked="false"/>' +
        '<MenuItem Label="---"/>' +
        '<MenuItem Id="nrReload" Label="' + xmlAttr(tr("menuReload")) + '" Enabled="true" Checked="false"/>' +
        '<MenuItem Id="nrScan" Label="' + xmlAttr(tr("menuScan")) + '" Enabled="true" Checked="false"/>' +
        '<MenuItem Label="---"/>' +
        '<MenuItem Id="nrOpenApp" Label="' + xmlAttr(tr("menuOpen")) + '" Enabled="true" Checked="false"/>' +
        '</Menu>'
      );
      if (cs.addEventListener && !installMenus.listenerAdded) {
        installMenus.listenerAdded = true;
        cs.addEventListener("com.adobe.csxs.events.flyoutMenuClicked", function (evt) {
          if (evt && evt.data && evt.data.menuId) onMenu(evt.data.menuId);
        });
      }
    }
   } catch (eMenu) { /* CEP trop ancien pour les menus natifs → boutons de l'accueil */ }
  }
  installMenus.listenerAdded = false;
  applyLanguage(browserLang);

  // ---- Thème hôte : suit le fond du thème Adobe (l'app reste sombre, le panneau s'accorde). ----
  function applySkin() {
    try {
      var env = cs.getHostEnvironment();
      var c = env && env.appSkinInfo && env.appSkinInfo.panelBackgroundColor && env.appSkinInfo.panelBackgroundColor.color;
      if (c && typeof c.red === "number") {
        document.body.style.background = "rgb(" + Math.round(c.red) + "," + Math.round(c.green) + "," + Math.round(c.blue) + ")";
      }
    } catch (e0) { /* skin indisponible → tokens par défaut */ }
  }
  try {
    if (cs.addEventListener) cs.addEventListener("com.adobe.csxs.events.ThemeColorChanged", applySkin);
  } catch (e3) {}
  applySkin();

  // Scan auto au chargement (best-effort, projet peut être vide)
  setTimeout(doScan, 800);
})();
