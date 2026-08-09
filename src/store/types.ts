// Types partagés du store (onglets, vue derush).
export type TabId = "derush" | "search" | "reference" | "notebook" | "script" | "upscale" | "voice" | "chat" | "optimisation" | "transfer" | "adobe" | "settings";
// Hôte cible actif : NLE piloté par NetsuRush. Sélecteur en pied de sidebar. Resolve = flux natif
// (pont Python) ; ppro/aeft = via le panneau CEP. Persisté (localStorage nr.activeHost).
export type HostId = "resolve" | "ppro" | "aeft";
export type DerushView = "home" | "browser";
// Sous-onglet de l'onglet Derush : découpage (flux existant), collections (bibliothèque), timeline live.
export type DerushSection = "decoupage" | "collections" | "timeline";

// Thèmes commutables (cf. blocs [data-theme] dans src/index.css). Les libellés/descriptions ici sont
// le repli hors i18n : l'UI lit d'abord `settings:appearance.theme.<id>`.
export type ThemeId =
  | "dark" | "midnight" | "blue" | "graphite" | "forest" | "ember" | "plum" | "contrast"
  | "light" | "soft-light" | "paper";
export type ThemeMode = "dark" | "light";
export const THEMES: { id: ThemeId; mode: ThemeMode; label: string; hint: string }[] = [
  { id: "dark", mode: "dark", label: "Sombre", hint: "Neutre et contrasté" },
  { id: "midnight", mode: "dark", label: "Minuit", hint: "Noir profond, surfaces discrètes" },
  { id: "blue", mode: "dark", label: "Bleu nuit", hint: "Bleu profond façon Netsucord" },
  { id: "graphite", mode: "dark", label: "Graphite", hint: "Gris neutre, sans teinte" },
  { id: "forest", mode: "dark", label: "Forêt", hint: "Vert profond, accent émeraude" },
  { id: "ember", mode: "dark", label: "Braise", hint: "Charbon chaud, accent ambre" },
  { id: "plum", mode: "dark", label: "Prune", hint: "Violet sourd, accent mauve" },
  { id: "contrast", mode: "dark", label: "Contraste élevé", hint: "Noir pur, bordures franches" },
  { id: "light", mode: "light", label: "Clair", hint: "Blanc net et lisible" },
  { id: "soft-light", mode: "light", label: "Clair doux", hint: "Gris bleuté, contraste apaisé" },
  { id: "paper", mode: "light", label: "Papier", hint: "Sépia doux, accent terracotta" },
];

export { basename } from "@/lib/utils";
