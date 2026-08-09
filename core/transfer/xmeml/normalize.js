// @ts-check
// Normalisation d'un FCP7 XML avant de le donner à l'importeur d'un hôte. Fonctions PURES.
//
// Pourquoi : Premiere écrit `<xmeml version="4">` avec un `<!DOCTYPE xmeml>`, quand la référence
// FCP7 publiée est la version 5. Mesuré sur Resolve Studio 21.0.3, ni la version ni le DOCTYPE ne
// gênent `ImportTimelineFromFile` — la cause des refus était ailleurs (cf. `graphics.js`). Ces
// variantes restent le filet pour un émetteur au dialecte plus exotique, essayées seulement après
// le document d'origine, qui passe en premier et doit réussir.
//
// Chaque retouche est MINIMALE et réversible : on ne réécrit pas le montage, on ajuste l'en-tête.

/** Dialecte visé par les importeurs FCP7 : c'est la version de la référence publiée. */
const TARGET_VERSION = "5";

/** Version déclarée par le document, ou `null` s'il n'est pas du xmeml. */
function declaredVersion(source) {
  const match = /<xmeml\s+version\s*=\s*"([^"]*)"/i.exec(String(source || ""));
  return match ? match[1] : null;
}

/**
 * Variantes à présenter à l'importeur, de la plus fidèle à la plus retouchée. La première est
 * TOUJOURS le document d'origine : si l'hôte l'accepte, rien ne doit être modifié.
 * @param {string} source
 * @returns {{ label: string, text: string }[]}
 */
function importVariants(source) {
  const text = String(source || "");
  const variants = [{ label: "source", text }];
  const version = declaredVersion(text);

  if (version && version !== TARGET_VERSION) {
    variants.push({
      label: `version ${TARGET_VERSION}`,
      text: text.replace(/(<xmeml\s+version\s*=\s*")[^"]*(")/i, `$1${TARGET_VERSION}$2`),
    });
  }
  // Un `<!DOCTYPE>` sans DTD accessible fait échouer certains analyseurs stricts.
  if (/<!DOCTYPE[^>]*>/i.test(text)) {
    const stripped = text.replace(/<!DOCTYPE[^>]*>\s*/i, "");
    variants.push({ label: "sans DOCTYPE", text: stripped });
    if (version && version !== TARGET_VERSION) {
      variants.push({
        label: `version ${TARGET_VERSION} sans DOCTYPE`,
        text: stripped.replace(/(<xmeml\s+version\s*=\s*")[^"]*(")/i, `$1${TARGET_VERSION}$2`),
      });
    }
  }
  // Deux variantes identiques ne valent qu'un essai : l'import est lent et l'hôte est modal.
  const seen = new Set();
  return variants.filter((variant) => {
    if (seen.has(variant.text)) return false;
    seen.add(variant.text);
    return true;
  });
}

module.exports = { importVariants, declaredVersion, TARGET_VERSION };
