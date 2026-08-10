// Nature de la fenêtre courante, lue sur le hash. Toutes les fenêtres partagent le MÊME renderer :
// c'est le hash qui distingue le shell d'une fenêtre détachée (board de référence, carnet).
//
// Module PUR, sans import : `App.tsx` détermine déjà ces cas pour choisir quoi rendre, mais des
// modules plus bas dans la pile en ont besoin sans pouvoir remonter jusqu'à lui.
const hash = typeof window === "undefined" ? "" : window.location.hash.replace(/^#\/?/, "");

const IS_REFERENCE_WINDOW = hash.startsWith("reference");
const IS_NOTEBOOK_WINDOW = hash.startsWith("notebook");
/** Fenêtre secondaire flottant par-dessus un autre logiciel, sans le shell de l'application. */
export const IS_DETACHED_WINDOW = IS_REFERENCE_WINDOW || IS_NOTEBOOK_WINDOW;
