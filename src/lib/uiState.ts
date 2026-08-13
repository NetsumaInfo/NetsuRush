// Miroir durable des réglages d'interface.
//
// Tous les réglages de l'app (thème, fond, volumes, colonnes, raccourcis de coupe, défauts de
// NetsuCut, options des modules…) vivent dans `localStorage`. Ce stockage appartient au PROFIL
// WebView2 de l'app et à UNE origine : un profil recréé, un nettoyage de stockage ou un changement
// d'origine (app installée vs session de dev vs panneau CEP) remettait toute l'interface à ses
// valeurs par défaut, et il fallait tout re-régler.
//
// On garde donc une copie sur DISQUE, tenue par le core (`core/uistate.js`, NR_HOME/ui-state.json),
// qui survit aux mises à jour et est commune à toutes les fenêtres.
//
// Deux moitiés :
//  - `hydrateUiState()` — AVANT le premier rendu (et avant l'import du store, qui lit `localStorage`
//    à l'évaluation de son module) : le disque repeuple les clés, les clés locales inconnues du
//    disque y sont semées. On ne SUPPRIME jamais en hydratation : une clé écrite par une version
//    antérieure au miroir doit être adoptée, pas effacée.
//  - le miroir d'écriture — chaque `setItem`/`removeItem` part sur le disque (groupé), et un patch
//    venu d'une autre fenêtre est réappliqué localement.
//
// `core/prefs.js` reste à part : il couvre les réglages qui décrivent le TRAVAIL (détection, export,
// insertion) avec une forme typée, et les rediffuse À CHAUD dans le store des autres fenêtres. Le
// miroir, lui, ignore la forme des valeurs et n'agit que sur `localStorage`.

import { nr } from "@/lib/bridge";

// Toutes les clés de l'app sont préfixées `nr.` ou `nr-`. Une clé d'une bibliothèque tierce
// (BlockNote, i18next…) ne décrit pas un choix de l'utilisateur : elle n'est pas copiée.
const MIRRORED_PREFIXES = ["nr.", "nr-"];
// L'état d'authentification (grâce hors-ligne, contournement) est lié à CE poste et à cette
// installation : le recopier sur disque prolongerait une session au-delà du profil qui l'a obtenue.
const EXCLUDED = [/^nr\.auth\./];

// Une frappe dans un champ (nom de profil, seuil) écrit à chaque caractère : on groupe.
const FLUSH_DEBOUNCE_MS = 400;
// Le core peut être encore en train de démarrer au tout premier lancement. Passé ce délai on rend
// la main : l'app démarre sur son `localStorage` local, exactement comme avant le miroir.
const HYDRATE_TIMEOUT_MS = 4000;

export function isMirroredKey(key: string): boolean {
  if (!MIRRORED_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  return !EXCLUDED.some((rule) => rule.test(key));
}

// Vrai pendant l'application d'un état venu du disque : sans ce garde, chaque clé réécrite
// repartirait aussitôt en écriture vers le core (et deux fenêtres se renverraient la balle).
let applying = false;

function localSet(key: string, value: string): void {
  applying = true;
  try { localStorage.setItem(key, value); } catch { /* stockage plein/indisponible */ }
  finally { applying = false; }
}

function localRemove(key: string): void {
  applying = true;
  try { localStorage.removeItem(key); } catch { /* idem */ }
  finally { applying = false; }
}

function mirroredLocalKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && isMirroredKey(key)) keys.push(key);
  }
  return keys;
}

// ---- Écriture groupée vers le disque ----

const pending = new Map<string, string | null>();
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!pending.size) return;
  const patch = Object.fromEntries(pending);
  pending.clear();
  void nr.uiStateSet(patch).catch(() => {
    // Core injoignable : on garde le patch pour le prochain envoi, sans écraser une valeur plus
    // récente entrée entre-temps.
    for (const [key, value] of Object.entries(patch)) {
      if (!pending.has(key)) pending.set(key, value);
    }
  });
}

function queue(key: string, value: string | null): void {
  if (applying || !isMirroredKey(key)) return;
  pending.set(key, value);
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
}

let installed = false;

/**
 * Branche le miroir sur `localStorage`. On patche le PROTOTYPE (et non l'objet, dont les propriétés
 * nommées sont les clés stockées) en filtrant sur l'instance : `sessionStorage` n'est pas concerné.
 */
function installMirror(): void {
  if (installed || typeof localStorage === "undefined") return;
  installed = true;
  const store = localStorage;
  const proto = Storage.prototype;
  const setItem = proto.setItem;
  const removeItem = proto.removeItem;
  const clear = proto.clear;

  proto.setItem = function (this: Storage, key: string, value: string) {
    setItem.call(this, key, value);
    if (this === store) queue(key, String(value));
  };
  proto.removeItem = function (this: Storage, key: string) {
    removeItem.call(this, key);
    if (this === store) queue(key, null);
  };
  proto.clear = function (this: Storage) {
    const keys = this === store ? mirroredLocalKeys() : [];
    clear.call(this);
    for (const key of keys) queue(key, null);
  };

  // Fermeture de la fenêtre : les 400 ms de groupage ne doivent pas coûter le dernier réglage.
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });

  // Patch d'une autre fenêtre (fenêtre détachée, panneau CEP) : on met `localStorage` à jour pour
  // que le prochain montage lise la bonne valeur. Les réglages qui doivent s'appliquer À CHAUD
  // passent par `core/prefs.js` (useSharedPrefs), qui les rejoue dans le store.
  nr.onUiStateChanged((payload) => {
    const patch = payload?.patch;
    if (!patch) return;
    for (const [key, value] of Object.entries(patch)) {
      if (!isMirroredKey(key)) continue;
      if (value === null) localRemove(key);
      else localSet(key, value);
    }
  });
}

/**
 * Repeuple `localStorage` depuis le disque, puis y sème les clés que le disque ne connaît pas
 * encore. À appeler AVANT d'importer les modules qui lisent `localStorage` à l'évaluation.
 */
export async function hydrateUiState(): Promise<void> {
  if (typeof localStorage === "undefined") return;
  try {
    const result = await Promise.race([
      nr.uiStateGet(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), HYDRATE_TIMEOUT_MS)),
    ]);
    const state = result?.ok ? result.state : null;
    if (state) {
      for (const [key, value] of Object.entries(state)) {
        if (isMirroredKey(key) && typeof value === "string" && localStorage.getItem(key) !== value) {
          localSet(key, value);
        }
      }
      // Le disque n'est jamais autoritaire pour ce qu'il ignore : une clé locale absente du fichier
      // vient soit d'une version antérieure au miroir, soit d'un module qui n'a encore rien écrit.
      const seed: Record<string, string> = {};
      for (const key of mirroredLocalKeys()) {
        if (!(key in state)) {
          const value = localStorage.getItem(key);
          if (value !== null) seed[key] = value;
        }
      }
      if (Object.keys(seed).length) void nr.uiStateSet(seed).catch(() => {});
    }
  } catch {
    // Core injoignable : l'app démarre sur son stockage local, comme avant le miroir.
  }
  installMirror();
}
