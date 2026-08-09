// Helpers + données statiques de l'onglet Optimisation.

// `fmtBytes` vit dans @/lib/utils (source unique côté renderer) ; réexporté ici pour les appelants
// historiques de l'onglet Optimisation.
export { fmtBytes } from "@/lib/utils";

// Conseils : uniquement ce que NetsuRush ne peut NI lire NI écrire — un réglage de menu à l'exécution,
// ou une action qui ne tient pas dans une valeur. Tout ce qui vit dans les fichiers de préférences est
// affiché à sa vraie valeur par PrefsSection : un conseil générique en plus dirait « active le décodage
// matériel » à quelqu'un qui l'a déjà activé.
// Retirés parce que faux, pas parce que redondants :
//   • « forcer CUDA » — Auto choisit déjà CUDA sur NVIDIA ; conseil d'une époque où ce n'était pas le cas.
//   • « trop de timelines » — aucun seuil publié nulle part ; le coût vient des effets et des étalonnages
//     par timeline, pas de leur nombre.
// Les libellés (title/where/body) sont résolus au rendu via i18n (clés advice.items.<id>.*).
export interface Advice {
  id: string;
}
export const ADVICE: Advice[] = [
  { id: "cachessd" },
  { id: "playproxy" },
  { id: "optimizedmedia" },
  { id: "effectsheavy" },
];

// Même règle côté Adobe : seulement ce que NetsuBoost ne peut ni lire ni écrire. Les réglages que le
// panneau CEP sait relire (gpuAccelType, profondeur, scratch disks) vivent dans BoostPrefsSection à
// leur vraie valeur — les conseiller ici les dirait à quelqu'un qui les a déjà réglés.
export const ADVICE_PPRO: Advice[] = [
  { id: "mercurygpu" },
  { id: "hwdecode" },
  { id: "previewcodec" },
  { id: "cacheotherdisk" },
];
export const ADVICE_AEFT: Advice[] = [
  { id: "diskcachessd" },
  { id: "diskcacheon" },
  { id: "mfrcpu" },
  { id: "bitdepth" },
];
