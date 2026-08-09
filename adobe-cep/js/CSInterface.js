/*
 * CEP panel API bridge: wrapper autour du runtime CEP (window.__adobe_cep__).
 * Implémente un sous-ensemble des fonctions de communication CEP : uniquement
 * ce que le panneau NetsuRush consomme (evalScript, host env, chemin extension,
 * bus d'événements CEP, menus contextuel/flyout). Tout est GUARDÉ : sur un hôte
 * qui n'expose pas une API, l'appel est un no-op silencieux (jamais de throw).
 * ES5 strict (CEF 61+ / hôtes 2020).
 */
(function (global) {
  "use strict";

  function cep() { return global.__adobe_cep__ || null; }

  function CSInterface() {}

  CSInterface.EVAL_ERROR = "EvalScript error.";

  /** Exécute du code ExtendScript dans l'hôte ; callback(resultString). */
  CSInterface.prototype.evalScript = function (script, callback) {
    if (!callback) callback = function () {};
    var c = cep();
    if (!c) { callback(CSInterface.EVAL_ERROR); return; }
    c.evalScript(script, callback);
  };

  /** Environnement hôte : { appName: "PPRO"|"AEFT"|…, appVersion, appSkinInfo, … } */
  CSInterface.prototype.getHostEnvironment = function () {
    var c = cep();
    if (!c) return { appName: "", appVersion: "" };
    try { return JSON.parse(c.getHostEnvironment()); } catch (e) { return { appName: "", appVersion: "" }; }
  };

  /** Chemin système CEP normalisé (sans préfixe file://) : "extension", "userData", "hostApplication"… */
  CSInterface.prototype.getSystemPath = function (type) {
    var c = cep();
    if (!c) return "";
    try {
      var p = decodeURI(c.getSystemPath(type));
      return p.replace(/^file:\/{2,3}/, "").replace(/^\/([A-Za-z]:)/, "$1");
    } catch (e) { return ""; }
  };

  /** Chemin disque de l'extension (sans préfixe file://). */
  CSInterface.prototype.getExtensionPath = function () {
    return this.getSystemPath("extension");
  };

  /** Ouvre une URL dans le navigateur système. */
  CSInterface.prototype.openURLInDefaultBrowser = function (url) {
    if (global.cep && global.cep.util && global.cep.util.openURLInDefaultBrowser) {
      global.cep.util.openURLInDefaultBrowser(url);
    }
  };

  // ---- Bus d'événements CEP (CSXS) — même signature que la lib officielle. ----

  /** Écoute un événement CSXS (ex. com.adobe.csxs.events.ThemeColorChanged / flyoutMenuClicked). */
  CSInterface.prototype.addEventListener = function (type, listener, obj) {
    var c = cep();
    if (c && c.addEventListener) c.addEventListener(type, listener, obj);
  };

  CSInterface.prototype.removeEventListener = function (type, listener, obj) {
    var c = cep();
    if (c && c.removeEventListener) c.removeEventListener(type, listener, obj);
  };

  /** Événement CSXS (pour dispatchEvent) — champs de la lib officielle. */
  function CSEvent(type, scope, appId, extensionId) {
    this.type = type;
    this.scope = scope;
    this.appId = appId;
    this.extensionId = extensionId;
    this.data = "";
  }

  CSInterface.prototype.dispatchEvent = function (event) {
    var c = cep();
    if (!c || !c.dispatchEvent) return;
    if (typeof event.data === "object") event.data = JSON.stringify(event.data);
    c.dispatchEvent(event);
  };

  // ---- Menus du panneau (clic droit + flyout ≡) — CEP 5.2+, guardés. ----

  /** Menu contextuel (clic droit) au format JSON ; callback(menuId) au clic. */
  CSInterface.prototype.setContextMenuByJSON = function (menu, callback) {
    var c = cep();
    if (c && c.invokeAsync) c.invokeAsync("setContextMenuByJSON", menu, callback || function () {});
  };

  /** Menu contextuel au format XML (variante historique) ; callback(menuId) au clic. */
  CSInterface.prototype.setContextMenu = function (menu, callback) {
    var c = cep();
    if (c && c.invokeAsync) c.invokeAsync("setContextMenu", menu, callback || function () {});
  };

  /** Met à jour un item du menu contextuel (coché/actif). */
  CSInterface.prototype.updateContextMenuItem = function (menuItemID, enabled, checked) {
    var c = cep();
    if (c && c.invokeSync) {
      c.invokeSync("updateContextMenuItem", JSON.stringify({ menuItemID: menuItemID, enabled: enabled, checked: checked }));
    }
  };

  /** Menu flyout (bouton ≡ du panneau), format XML. Clics reçus via l'événement
   *  com.adobe.csxs.events.flyoutMenuClicked (evt.data.menuId). */
  CSInterface.prototype.setPanelFlyoutMenu = function (menu) {
    var c = cep();
    if (c && c.invokeSync) c.invokeSync("setPanelFlyoutMenu", menu);
  };

  global.CSInterface = CSInterface;
  global.CSEvent = CSEvent;
})(window);
