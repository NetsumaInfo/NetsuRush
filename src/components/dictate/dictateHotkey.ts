// Raccourci push-to-talk de la dictée globale. Un raccourci = modificateurs requis
// (Ctrl/Maj/Alt/Meta) + une touche principale FACULTATIVE (`code` clavier, ex. "Space"/"F8"), ou
// modificateurs seuls (maintien Ctrl+Maj). Le maintien enregistre, le relâchement transcrit.
import i18n from "@/i18n";

export interface DictateHotkey {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** `code` de la touche principale (non-modificateur), ou null = combo de modificateurs seuls. */
  key: string | null;
}

// Défaut : maintien Ctrl+Maj (modificateurs seuls, une main, peu de conflit avec la frappe).
export const DEFAULT_DICTATE_HOTKEY: DictateHotkey = { ctrl: true, shift: true, alt: false, meta: false, key: null };

const MOD_CODES = new Set([
  "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
  "AltLeft", "AltRight", "MetaLeft", "MetaRight",
]);

export function isModifierCode(code: string): boolean {
  return MOD_CODES.has(code);
}

export function parseHotkey(raw: string | null | undefined): DictateHotkey | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object") {
      return {
        ctrl: !!o.ctrl, shift: !!o.shift, alt: !!o.alt, meta: !!o.meta,
        key: typeof o.key === "string" ? o.key : null,
      };
    }
  } catch { /* noop */ }
  return null;
}

// Vrai si le raccourci a au moins un déclencheur (sinon il se déclencherait en permanence).
export function isValidHotkey(h: DictateHotkey): boolean {
  return !!(h.ctrl || h.shift || h.alt || h.meta || h.key);
}

// Le raccourci est-il SATISFAIT par l'état clavier courant ? Modificateurs = correspondance EXACTE
// (Ctrl+Maj ne se déclenche pas si Alt est aussi enfoncé) ; touche principale = présente parmi les
// codes enfoncés.
export function hotkeySatisfied(h: DictateHotkey, e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }, pressed: Set<string>): boolean {
  if (!isValidHotkey(h)) return false;
  if (e.ctrlKey !== h.ctrl || e.shiftKey !== h.shift || e.altKey !== h.alt || e.metaKey !== h.meta) return false;
  if (h.key && !pressed.has(h.key)) return false;
  return true;
}

// Codes clavier (identifiants techniques) → clé i18n du libellé d'affichage. Les symboles bruts (`)
// restent littéraux.
const CODE_LABEL_KEYS: Record<string, string> = {
  Space: "hotkey.code.space", Escape: "hotkey.code.escape", Enter: "hotkey.code.enter", Tab: "hotkey.code.tab",
};

function keyLabel(code: string): string {
  if (code === "Backquote") return "`";
  if (CODE_LABEL_KEYS[code]) return i18n.t(`dictate:${CODE_LABEL_KEYS[code]}`);
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

// Libellé lisible : « Ctrl + Maj », « Ctrl + Espace », « F8 ».
export function hotkeyLabel(h: DictateHotkey): string {
  const parts: string[] = [];
  if (h.ctrl) parts.push(i18n.t("dictate:hotkey.mod.ctrl"));
  if (h.shift) parts.push(i18n.t("dictate:hotkey.mod.shift"));
  if (h.alt) parts.push(i18n.t("dictate:hotkey.mod.alt"));
  if (h.meta) parts.push(i18n.t("dictate:hotkey.mod.meta"));
  if (h.key) parts.push(keyLabel(h.key));
  return parts.length ? parts.join(" + ") : "—";
}

// Construit un raccourci depuis un keydown (pour la capture dans les paramètres). Une touche
// non-modificateur devient la touche principale ; sinon = combo de modificateurs seuls.
export function hotkeyFromEvent(e: KeyboardEvent): DictateHotkey {
  const key = isModifierCode(e.code) ? null : e.code;
  return { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, key };
}
