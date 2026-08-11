// @ts-check
// Met l'export FCP7 de Resolve en état d'être importé par PREMIERE. Fonction PURE.
//
// Un seul défaut mesuré, mais visible à l'écran : Resolve écrit les retours à la ligne d'un titre en
// RÉFÉRENCE DE CARACTÈRE (`&#xd;`), ce qui est du XML parfaitement légal — et l'importeur de Premiere
// ne la décode pas. Le titre arrive alors avec « test beta&#xd;yes » écrit tel quel à l'image, la
// séquence d'échappement affichée comme du texte. On les remplace donc par le caractère lui-même,
// AVANT de donner le fichier à Premiere.
//
// Le caractère écrit est un RETOUR CHARIOT (U+000D), pas un saut de ligne : c'est ce que `&#xd;`
// désigne, et c'est la convention de fin de ligne des générateurs FCP7. Mesuré : l'échappement
// disparaît bien du titre, mais Premiere garde le texte sur une seule ligne — son importeur de
// générateur hérité ne reconstruit pas le multi-ligne. Un titre fidèle passera par un `.mogrt`.
//
// La substitution est limitée aux paramètres de TEXTE d'un générateur : appliquée au document
// entier, elle toucherait des chemins de fichiers et des noms de plans où `&#xd;` n'a rien à faire,
// et un nom de média contenant une esperluette deviendrait illisible.

/** Références de caractère des sauts de ligne, décimales comme hexadécimales. */
const NEWLINE_ENTITY = /&#(?:x0*(?:a|d)|0*(?:10|13));/gi;

/** `<parameter>` dont l'identifiant porte le texte d'un générateur FCP7. */
const TEXT_PARAMETER = /<parameter>(?:(?!<\/parameter>)[\s\S])*?<parameterid>\s*str\s*<\/parameterid>[\s\S]*?<\/parameter>/gi;

const VALUE = /(<value>)([\s\S]*?)(<\/value>)/i;

/**
 * @param {string} source contenu du fichier XML exporté par Resolve
 * @returns {{ text: string, newlines: number }} `newlines` = références remplacées (journal + tests)
 */
function prepareForPremiere(source) {
  let newlines = 0;
  const text = String(source || "").replace(TEXT_PARAMETER, (parameter) => (
    parameter.replace(VALUE, (whole, open, value, close) => {
      // Un CRLF écrit en deux références ne doit pas devenir deux sauts de ligne.
      const decoded = value
        .replace(/&#(?:x0*d|0*13);&#(?:x0*a|0*10);/gi, () => { newlines += 1; return "\n"; })
        .replace(NEWLINE_ENTITY, () => { newlines += 1; return "\n"; });
      return open + decoded + close;
    })
  ));
  return { text, newlines };
}

module.exports = { prepareForPremiere };
