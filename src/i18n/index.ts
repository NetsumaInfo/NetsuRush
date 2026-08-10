// Cœur i18n de l'application (react-i18next). Objectifs :
//  - 6 langues : fr (source + repli) · en · es · de · ja · zh.
//  - Chargement PARESSEUX : seule la langue active est fetchée (chunks Vite par langue×namespace).
//    Le fr est embarqué en dur (repli immédiat, jamais de clé manquante).
//  - Init unique par renderer (importé au plus tôt dans main.tsx) → couvre Shell, la fenêtre
//    Référence détachée et le panneau Adobe remote, qui contournent tous les gates.
//
// Convention de clés : namespace par feature (« derush », « voice »…), clé pointée « section.name ».
// Dans un composant : useTranslation("derush") puis t("home.title"). Namespace « common » par défaut.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

export type LangCode = "fr" | "en" | "es" | "de" | "ja" | "zh";

export interface LangDef {
  code: LangCode;
  /** Nom de la langue DANS cette langue (autonyme), pour le sélecteur. */
  label: string;
}

// Ordre = ordre d'affichage dans le sélecteur. fr en tête (langue source du produit).
export const LANGUAGES: LangDef[] = [
  { code: "fr", label: "Français" },
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "de", label: "Deutsch" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
];

const SUPPORTED: LangCode[] = LANGUAGES.map((l) => l.code);
const FALLBACK_LANG: LangCode = "fr";
export const LANG_STORAGE_KEY = "nr-lang";

// Namespaces = un fichier JSON par feature et par langue (src/locales/<lang>/<ns>.json).
// « common » regroupe le vocabulaire transverse (boutons, confirmations, erreurs génériques).
export const NAMESPACES = [
  "common",
  "shell",
  "setup",
  "auth",
  "language",
  "derush",
  "collections",
  "search",
  "voice",
  "reference",
  "upscale",
  "roto",
  "notebook",
  "script",
  "adobe",
  "chat",
  "export",
  "optimize",
  "settings",
  "dictate",
  "ae",
  "transfer",
  "models",
] as const;

// --- Chargement des ressources -------------------------------------------------------------------
// Les JSON vivent dans src/locales/<lang>/<ns>.json → chemins relatifs à src/i18n/ = « ../locales ».
// fr EAGER : embarqué dans le bundle principal → repli synchrone, aucune latence, aucune clé manquante.
const frEager = import.meta.glob<{ default: Record<string, unknown> }>("../locales/fr/*.json", {
  eager: true,
});
// Autres langues LAZY : chaque (langue, namespace) est un chunk séparé, fetché à l'activation.
const lazy = import.meta.glob<{ default: Record<string, unknown> }>("../locales/*/*.json");

/** Extrait (langue, namespace) d'un chemin « ./locales/en/derush.json ». */
function parsePath(p: string): { lng: string; ns: string } | null {
  const m = /\/locales\/([^/]+)\/([^/]+)\.json$/.exec(p);
  return m ? { lng: m[1], ns: m[2] } : null;
}

// Ressources fr initiales (synchrones).
const frResources: Record<string, Record<string, unknown>> = {};
for (const [path, mod] of Object.entries(frEager)) {
  const parsed = parsePath(path);
  if (parsed) frResources[parsed.ns] = mod.default;
}

const loadedLangs = new Set<LangCode>(["fr"]);

/**
 * Charge (si besoin) tous les namespaces d'une langue puis bascule i18next dessus.
 * fr est déjà en mémoire. Idempotent : une langue déjà chargée ne re-fetch pas.
 */
export async function activateLanguage(lng: LangCode): Promise<void> {
  const target: LangCode = SUPPORTED.includes(lng) ? lng : FALLBACK_LANG;
  if (!loadedLangs.has(target)) {
    const jobs: Promise<void>[] = [];
    for (const [path, loader] of Object.entries(lazy)) {
      const parsed = parsePath(path);
      if (!parsed || parsed.lng !== target) continue;
      jobs.push(
        loader().then((mod) => {
          i18n.addResourceBundle(target, parsed.ns, mod.default, true, true);
        }),
      );
    }
    await Promise.all(jobs);
    loadedLangs.add(target);
  }
  await i18n.changeLanguage(target);
  if (typeof document !== "undefined") document.documentElement.setAttribute("lang", target);
}

/** Langue de démarrage : préférence sauvegardée, sinon locale système mappée, sinon fr. */
export function detectDefaultLang(): LangCode {
  if (typeof localStorage !== "undefined") {
    const saved = localStorage.getItem(LANG_STORAGE_KEY) as LangCode | null;
    if (saved && SUPPORTED.includes(saved)) return saved;
  }
  if (typeof navigator !== "undefined") {
    const nav = (navigator.language || "").slice(0, 2).toLowerCase() as LangCode;
    if (SUPPORTED.includes(nav)) return nav;
  }
  return FALLBACK_LANG;
}

/** true si l'utilisateur n'a jamais choisi de langue (→ afficher l'écran de premier lancement). */
export function hasChosenLang(): boolean {
  if (typeof localStorage === "undefined") return true;
  const saved = localStorage.getItem(LANG_STORAGE_KEY);
  return !!saved && SUPPORTED.includes(saved as LangCode);
}

// Init synchrone en fr (repli garanti). La vraie langue active est ensuite appliquée par
// initI18n() qui attend le chargement paresseux AVANT le premier rendu (pas de flash de repli).
i18n.use(initReactI18next).init({
  lng: FALLBACK_LANG,
  fallbackLng: FALLBACK_LANG,
  supportedLngs: SUPPORTED,
  ns: NAMESPACES as unknown as string[],
  defaultNS: "common",
  resources: { fr: frResources },
  interpolation: { escapeValue: false }, // React échappe déjà.
  returnEmptyString: false,
});

/**
 * À appeler UNE fois au boot (main.tsx), avant le rendu. Résout la langue de départ et charge
 * ses ressources. Renvoie la langue effectivement activée.
 *
 * `fallback` = préférence app-wide lue côté core (`nr.config.json`). Elle sert quand ce renderer
 * n'a AUCUN choix local : c'est le cas du panneau CEP, qui tourne sur une autre origine que l'app
 * Tauri et n'hérite donc pas de son localStorage — sans elle il retombait sur la langue du système
 * en ignorant le choix de l'utilisateur. Un choix local explicite reste prioritaire.
 * Le lookup est fait par l'appelant : `i18n` ne doit dépendre de rien (le bridge, lui, importe i18n).
 */
export async function initI18n(fallback?: LangCode): Promise<LangCode> {
  const lng = !hasChosenLang() && fallback && SUPPORTED.includes(fallback) ? fallback : detectDefaultLang();
  await activateLanguage(lng);
  return lng;
}

export default i18n;
