import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { ComboKeys } from "@/components/ui/kbd";
import { comboFromEvent, isCompleteCombo, type ShortcutMap } from "@/lib/shortcuts";

export interface ShortcutDef {
  action: string;
  labelKey: string;
  combo: string;
}

// Liste ÉDITABLE de raccourcis-commandes, partagée par les modules (Paramètres du board, accueil
// NetsuCut). Clic sur un combo → capture la prochaine combinaison ; si elle appartient déjà à une
// autre action, les deux s'échangent (jamais deux actions sur le même combo). Échap annule la
// capture. Le stockage est la responsabilité de l'appelant (onChange reçoit la map complète).
export function ShortcutEditor({
  defs,
  keys,
  onChange,
  onReset,
  title,
  onCapturingChange,
}: {
  defs: readonly ShortcutDef[];
  keys: ShortcutMap;
  onChange: (next: ShortcutMap) => void;
  onReset: () => void;
  title: string;
  // Remonte l'état « capture en cours » : un parent qui ferme sur Échap doit s'effacer pendant la
  // capture, sinon Échap annulerait la capture ET fermerait le panneau d'un coup.
  onCapturingChange?: (active: boolean) => void;
}) {
  const { t } = useTranslation(["derush", "reference", "common"]);
  const [capturing, setCapturing] = useState<string | null>(null);
  const setCaptureState = (next: string | null) => {
    setCapturing(next);
    onCapturingChange?.(next !== null);
  };

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      // Modificateur seul (Ctrl/Shift/…) → on attend le reste du combo, sans consommer la frappe.
      if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") { setCaptureState(null); return; }
      const combo = comboFromEvent(e);
      if (!isCompleteCombo(combo)) return; // besoin d'une touche principale (pas juste des modificateurs)
      const next = { ...keys, [capturing]: combo };
      const owner = Object.keys(keys).find((a) => keys[a] === combo && a !== capturing);
      if (owner) next[owner] = keys[capturing]; // échange → jamais deux actions sur le même combo
      onChange(next);
      setCaptureState(null);
    };
    // Phase capture : on prend la frappe avant tout raccourci global du module en cours d'édition.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, keys, onChange, onCapturingChange]);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        <button
          type="button"
          onClick={() => { setCaptureState(null); onReset(); }}
          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("common:action.reset")}
        </button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {defs.map((d) => {
          const active = capturing === d.action;
          return (
            <li key={d.action} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">{t(d.labelKey)}</span>
              <button
                type="button"
                aria-label={t("reference:settings.editShortcut", { label: t(d.labelKey) })}
                onClick={() => setCaptureState(capturing === d.action ? null : d.action)}
                className={cn(
                  "inline-flex h-6 min-w-[2rem] items-center gap-1 rounded border px-2 transition-colors",
                  active ? "border-primary bg-primary/15" : "border-border bg-muted hover:border-primary/60",
                )}
              >
                {active ? <span className="text-[11px] font-semibold text-primary">…</span> : <ComboKeys combo={keys[d.action] || "—"} />}
              </button>
            </li>
          );
        })}
      </ul>
      {capturing && <p className="text-[11px] text-muted-foreground">{t("reference:settings.pressCombo")}</p>}
    </section>
  );
}
