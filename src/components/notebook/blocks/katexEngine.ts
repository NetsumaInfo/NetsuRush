// Moteur KaTeX du bloc « Équation » — chargé PARESSEUSEMENT (~280 ko + sa feuille de style).
// Le spec de bloc doit rester importé statiquement (il définit le schéma de l'éditeur), mais un
// carnet sans équation n'a aucune raison de payer le moteur à l'ouverture de l'onglet.
//
// mhchem (\ce{H2O}) est une EXTENSION qui patche l'instance KaTeX : elle doit être importée après
// le noyau, jamais en parallèle.
import type Katex from "katex";
import { createLazyModule } from "@/lib/lazyModule";

const engine = createLazyModule("moteur KaTeX", async (): Promise<typeof Katex> => {
  const [katex] = await Promise.all([
    import("katex").then((m) => m.default),
    import("katex/dist/katex.min.css"),
  ]);
  await import("katex/contrib/mhchem");
  return katex;
});

/** Hook : charge le moteur au montage, `null` tant qu'il n'est pas là. */
export function useKatex(): typeof Katex | null {
  return engine.use();
}

/**
 * Rend `tex` en HTML. Un 1er essai strict CAPTE le message d'erreur exact (affiché à l'édition),
 * puis un rendu tolérant montre le meilleur aperçu possible.
 */
export function renderTex(katex: typeof Katex, tex: string): { html: string; error: string | null } {
  let error: string | null = null;
  try {
    return { html: katex.renderToString(tex, { displayMode: true, throwOnError: true }), error: null };
  } catch (e) {
    error = e instanceof Error ? e.message.replace(/^KaTeX parse error:\s*/, "") : String(e);
  }
  try {
    return { html: katex.renderToString(tex, { displayMode: true, throwOnError: false, strict: false }), error };
  } catch {
    return { html: "", error };
  }
}
