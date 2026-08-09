// Mécanique de raccourcis clavier PARTAGÉE par les modules (board de référence, NetsuCut…).
// Tout ce qui est ici est agnostique du module : sérialisation d'un événement en combo canonique,
// validation, appariement combo → action, et fusion avec les défauts. Les LISTES d'actions
// (`SHORTCUT_DEFS` du board, `CUT_SHORTCUT_DEFS` de NetsuCut) restent chez chaque module — elles
// seules sont spécifiques.

// Map action → combo canonique. Persistée telle quelle par chaque module (préférences board,
// store des réglages…).
export type ShortcutMap = Record<string, string>;

const MOD_KEYS = ["Control", "Meta", "Shift", "Alt"];

// Sérialise un événement clavier en combo canonique. Ordre fixe : Ctrl → Shift → Alt → touche.
// Ctrl et ⌘ (Meta) sont unifiés sous « Ctrl ». Renvoie une chaîne SANS touche principale (ex. « Ctrl »)
// tant que seul un modificateur est enfoncé → l'appelant sait que le combo est incomplet.
export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (MOD_KEYS.includes(e.key)) return parts.join("+"); // combo incomplet (modificateur seul)
  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

// Un combo est complet s'il porte une touche principale (pas seulement des modificateurs).
export function isCompleteCombo(combo: string): boolean {
  const last = combo.split("+").pop() || "";
  return last !== "" && !["Ctrl", "Shift", "Alt"].includes(last);
}

// Le focus est-il dans une zone de saisie ? Aucun raccourci ne doit tirer pendant la frappe.
export function isTyping(el: Element | null): boolean {
  return (
    !!el &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable)
  );
}

// Action associée au combo courant, si elle existe.
export function matchAction(keys: ShortcutMap, e: KeyboardEvent): string | undefined {
  const combo = comboFromEvent(e);
  return Object.keys(keys).find((a) => keys[a] === combo);
}

// Fusionne les raccourcis enregistrés par-dessus les défauts : une action ajoutée après une
// sauvegarde n'est jamais laissée sans touche, et une clé périmée est simplement ignorée.
export function mergeKeys(defaults: ShortcutMap, saved: unknown): ShortcutMap {
  if (!saved || typeof saved !== "object") return { ...defaults };
  const out = { ...defaults };
  for (const [action, combo] of Object.entries(saved as Record<string, unknown>)) {
    if (action in defaults && typeof combo === "string" && combo) out[action] = combo;
  }
  return out;
}
