// Façade thread principal du correcteur : possède le worker, les dictionnaires, les caches et le
// dictionnaire personnel. SINGLETON — les deux éditeurs (Carnet, Script) et l'infobulle de
// suggestions partagent la même instance, donc le même dictionnaire chargé une seule fois.
import { supportedSpellLang, type SpellLang, type SpellRequest, type SpellResponse } from "./spellShared";

// Les dictionnaires sont importés en URL : Vite les émet en fichiers d'asset séparés, donc rien
// n'entre dans le bundle de démarrage et le téléchargement n'a lieu qu'à la première frappe.
import frAff from "dictionary-fr/index.aff?url";
import frDic from "dictionary-fr/index.dic?url";
import enAff from "dictionary-en/index.aff?url";
import enDic from "dictionary-en/index.dic?url";

const DICT_URLS: Record<SpellLang, { aff: string; dic: string }> = {
  fr: { aff: frAff, dic: frDic },
  en: { aff: enAff, dic: enDic },
};

const PERSONAL_KEY = "nr-spell-dict";
// Au-delà, on vide le cache d'un coup : un document très long ne doit pas faire enfler la mémoire.
const CACHE_MAX = 40_000;

type Listener = () => void;
type CheckResponse = Extract<SpellResponse, { type: "check" }>;
type SuggestResponse = Extract<SpellResponse, { type: "suggest" }>;

interface LangState {
  ready: boolean;
  failed: boolean;
  loading: Promise<boolean> | null;
  verdicts: Map<string, boolean>; // mot → fautif
  suggestions: Map<string, string[]>;
}

const states = new Map<SpellLang, LangState>();
const listeners = new Set<Listener>();
const pending = new Map<number, (response: SpellResponse) => void>();
const loadWaiters = new Map<SpellLang, (ok: boolean) => void>();
const ignored = new Set<string>(); // « Ignorer » : durée de la session, toutes langues

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;

function stateOf(lang: SpellLang): LangState {
  let state = states.get(lang);
  if (!state) {
    state = { ready: false, failed: false, loading: null, verdicts: new Map(), suggestions: new Map() };
    states.set(lang, state);
  }
  return state;
}

function notify() {
  for (const listener of listeners) listener();
}

// ---- Dictionnaire personnel (persisté, partagé par toutes les fenêtres du renderer) ------------
function readPersonal(): Record<SpellLang, string[]> {
  const empty: Record<SpellLang, string[]> = { fr: [], en: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(PERSONAL_KEY) || "");
    if (!raw || typeof raw !== "object") return empty;
    return {
      fr: Array.isArray(raw.fr) ? raw.fr.filter((w: unknown) => typeof w === "string") : [],
      en: Array.isArray(raw.en) ? raw.en.filter((w: unknown) => typeof w === "string") : [],
    };
  } catch {
    return empty; // absent ou corrompu → dictionnaire personnel vide
  }
}

let personal = readPersonal();

function writePersonal() {
  try {
    localStorage.setItem(PERSONAL_KEY, JSON.stringify(personal));
  } catch (err) {
    console.warn("[spell] dictionnaire personnel non enregistré", err);
  }
}

// ---- Worker ------------------------------------------------------------------------------------
function ensureWorker(): Worker | null {
  if (worker || workerBroken) return worker;
  try {
    worker = new Worker(new URL("./spellWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<SpellResponse>) => {
      const msg = event.data;
      if (msg.type === "loaded" || msg.type === "failed") {
        const state = stateOf(msg.lang);
        state.ready = msg.type === "loaded";
        state.failed = msg.type === "failed";
        if (msg.type === "failed") console.warn(`[spell] dictionnaire ${msg.lang} illisible`, msg.error);
        loadWaiters.get(msg.lang)?.(state.ready);
        loadWaiters.delete(msg.lang);
        notify();
        return;
      }
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    };
    worker.onerror = (event) => {
      workerBroken = true;
      console.warn("[spell] worker arrêté, correcteur désactivé", event.message);
      for (const resolve of pending.values()) resolve({ type: "check", id: -1, bad: [] });
      pending.clear();
      for (const resolve of loadWaiters.values()) resolve(false);
      loadWaiters.clear();
      notify();
    };
  } catch (err) {
    workerBroken = true;
    console.warn("[spell] worker indisponible, correcteur désactivé", err);
  }
  return worker;
}

function request<T extends SpellResponse>(msg: SpellRequest & { id: number }, fallback: T): Promise<T> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    pending.set(msg.id, (response) => resolve(response as T));
    w.postMessage(msg);
  });
}

/** Charge (une seule fois) le dictionnaire d'une langue. Résout `false` si elle n'est pas gérée. */
function ensureLang(lang: SpellLang): Promise<boolean> {
  const state = stateOf(lang);
  if (state.ready) return Promise.resolve(true);
  if (state.failed) return Promise.resolve(false);
  if (state.loading) return state.loading;

  state.loading = (async () => {
    const w = ensureWorker();
    if (!w) return false;
    try {
      const urls = DICT_URLS[lang];
      const [aff, dic] = await Promise.all([
        fetch(urls.aff).then((r) => r.arrayBuffer()),
        fetch(urls.dic).then((r) => r.arrayBuffer()),
      ]);
      return await new Promise<boolean>((resolve) => {
        loadWaiters.set(lang, resolve);
        // Transfert propriétaire des buffers : aucune copie de 1,4 Mo entre les threads.
        w.postMessage({ type: "load", lang, aff, dic, personal: personal[lang] } satisfies SpellRequest, [aff, dic]);
      });
    } catch (err) {
      state.failed = true;
      console.warn(`[spell] chargement du dictionnaire ${lang} impossible`, err);
      return false;
    } finally {
      state.loading = null;
    }
  })();
  return state.loading;
}

function trimCache(state: LangState) {
  if (state.verdicts.size > CACHE_MAX) state.verdicts.clear();
  if (state.suggestions.size > 512) state.suggestions.clear();
}

export const spell = {
  /** Langue gérée par un dictionnaire embarqué, ou `null` (l'appelant retombe sur le natif). */
  langFor: supportedSpellLang,

  /** Le dictionnaire est-il chargé et exploitable ? */
  isReady(lang: SpellLang): boolean {
    return stateOf(lang).ready;
  },

  /** Précharge un dictionnaire (appelé au montage de l'éditeur). */
  preload(lang: SpellLang): void {
    void ensureLang(lang);
  },

  /**
   * Mots fautifs parmi `words`. Les verdicts connus sortent du cache ; seuls les mots inédits
   * partent au worker — après échauffement, une frappe ne coûte plus qu'un parcours de Map.
   */
  async check(lang: SpellLang, words: readonly string[]): Promise<Set<string>> {
    const state = stateOf(lang);
    const bad = new Set<string>();
    const unknown: string[] = [];
    for (const word of words) {
      if (ignored.has(word.toLowerCase())) continue;
      const verdict = state.verdicts.get(word);
      if (verdict === undefined) unknown.push(word);
      else if (verdict) bad.add(word);
    }
    if (!unknown.length) return bad;
    if (!(await ensureLang(lang))) return bad;

    const response = await request<CheckResponse>({ type: "check", id: ++seq, lang, words: unknown }, { type: "check", id: -1, bad: [] });
    const fresh = new Set(response.bad);
    for (const word of unknown) state.verdicts.set(word, fresh.has(word));
    trimCache(state);
    for (const word of fresh) if (!ignored.has(word.toLowerCase())) bad.add(word);
    return bad;
  },

  /** Suggestions de correction, triées par pertinence Hunspell (cache par mot). */
  async suggest(lang: SpellLang, word: string): Promise<string[]> {
    const state = stateOf(lang);
    const cached = state.suggestions.get(word);
    if (cached) return cached;
    if (!(await ensureLang(lang))) return [];
    const response = await request<SuggestResponse>({ type: "suggest", id: ++seq, lang, word }, { type: "suggest", id: -1, suggestions: [] });
    // Un worker mort résout les requêtes en attente avec une réponse générique : on ne met en cache
    // que des listes réelles, pour retenter après un redémarrage du worker.
    const suggestions = response.suggestions ?? [];
    if (response.suggestions) state.suggestions.set(word, suggestions);
    trimCache(state);
    return suggestions;
  },

  /** Ajoute un mot au dictionnaire personnel (persisté, propre à la langue). */
  learn(lang: SpellLang, word: string): void {
    if (!word || personal[lang].includes(word)) return;
    personal[lang] = [...personal[lang], word].sort((a, b) => a.localeCompare(b, lang));
    writePersonal();
    stateOf(lang).verdicts.delete(word);
    ensureWorker()?.postMessage({ type: "personal", lang, words: [word] } satisfies SpellRequest);
    notify();
  },

  /** Retire un mot du dictionnaire personnel. */
  forget(lang: SpellLang, word: string): void {
    if (!personal[lang].includes(word)) return;
    personal[lang] = personal[lang].filter((w) => w !== word);
    writePersonal();
    // Le dictionnaire déjà construit contient encore le mot et nspell n'offre pas de retrait fiable
    // (les affixes dérivés resteraient) : on repart d'un worker neuf, rechargé à la demande.
    worker?.terminate();
    worker = null;
    states.clear();
    pending.clear();
    loadWaiters.clear();
    notify();
  },

  /** Ignore un mot pour la session (ni dictionnaire ni disque). */
  ignore(word: string): void {
    ignored.add(word.toLowerCase());
    notify();
  },

  personalWords(lang: SpellLang): readonly string[] {
    return personal[lang];
  },

  /** S'abonne aux changements (dictionnaire prêt, mot appris/ignoré) pour relancer un contrôle. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

export type { SpellLang };
