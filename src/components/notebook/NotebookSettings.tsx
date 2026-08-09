// Paramètres du Carnet (Dialog) — appliqués IMMÉDIATEMENT (pas de bouton Enregistrer) :
// Apparence (largeur de page, échelle de police, fil d'Ariane), Éditeur (autosave, confirmation de
// suppression) et Raccourcis clavier REBINDABLES (clic sur le combo → capture de la frappe, échange si
// le combo est déjà pris — même mécanisme que le board Référence).
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useApp } from "@/store";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Toggle } from "@/components/ui/toggle";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { spell } from "@/lib/spell/spellClient";
import type { SpellLang } from "@/lib/spell/spellShared";
import { comboFromEvent, isCompleteCombo } from "@/components/reference/referenceShared";
import { NOTEBOOK_SHORTCUT_DEFS, DEFAULT_NOTEBOOK_SHORTCUT_KEYS } from "./notebookShortcuts";
import type { NbPageWidth } from "./notebookPrefs";

const PRESSED = "text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary";

// Mots appris, relus à chaque changement du dictionnaire (le client notifie ses abonnés).
function usePersonalWords(lang: SpellLang | null): readonly string[] {
  const subscribe = useCallback((onChange: () => void) => spell.subscribe(onChange), []);
  const read = useCallback(() => (lang ? spell.personalWords(lang) : EMPTY_WORDS), [lang]);
  return useSyncExternalStore(subscribe, read);
}
const EMPTY_WORDS: readonly string[] = [];

// Correcteur : interrupteur, repli natif annoncé pour les langues sans dictionnaire, et gestion du
// dictionnaire personnel (les mots appris depuis l'infobulle de correction atterrissent ici).
function SpellSection({ language }: { language: string }) {
  const { t } = useTranslation("notebook");
  const enabled = useApp((s) => s.nbPrefs.spellcheck);
  const setPrefs = useApp((s) => s.nbSetPrefs);
  const lang = spell.langFor(language);
  const words = usePersonalWords(lang);

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[0.8125rem] font-medium">{t("settings.spellcheck")}</h3>
      <div className="rounded-lg border border-border p-3">
        <label className="flex items-center justify-between gap-3">
          <span className="text-[0.8125rem]">{t("settings.spellcheck")}</span>
          <Toggle pressed={enabled} onPressedChange={(p) => setPrefs({ spellcheck: p })} variant="outline" size="sm">
            {enabled ? t("settings.spellOn") : t("settings.spellOff")}
          </Toggle>
        </label>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {enabled && !lang ? t("settings.spellUnsupported") : t("settings.spellcheckHint")}
        </p>
      </div>

      {enabled && lang && (
        <div className="rounded-lg border border-border p-3">
          <span className="block text-[0.8125rem]">{t("settings.personalDictionary")}</span>
          {words.length === 0 ? (
            <p className="mt-1.5 text-[11px] text-muted-foreground">{t("settings.personalEmpty")}</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1">
              {words.map((word) => (
                <button
                  key={word}
                  type="button"
                  onClick={() => spell.forget(lang, word)}
                  aria-label={`${t("settings.personalRemove")} — ${word}`}
                  className="group flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary hover:border-destructive/50 hover:text-foreground"
                >
                  {word}
                  <X className="h-3 w-3 opacity-50 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function NotebookSettings({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation("notebook");
  const prefs = useApp((s) => s.nbPrefs);
  const setPrefs = useApp((s) => s.nbSetPrefs);
  const language = useApp((s) => s.nbList.find((notebook) => notebook.id === s.nbActiveId)?.language ?? "fr");

  // Capture d'un nouveau combo pour l'action `capturing`. Phase CAPTURE : la frappe ne déclenche ni
  // les raccourcis du carnet ni la fermeture du Dialog ; Échap annule la capture seule.
  const [capturing, setCapturing] = useState<string | null>(null);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return; // attend le combo complet
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") { setCapturing(null); return; }
      const combo = comboFromEvent(e);
      if (!isCompleteCombo(combo)) return;
      const cur = prefs.shortcutKeys;
      const next = { ...cur, [capturing]: combo };
      const owner = Object.keys(cur).find((a) => cur[a] === combo && a !== capturing);
      if (owner) next[owner] = cur[capturing]; // échange → jamais deux actions sur le même combo
      setPrefs({ shortcutKeys: next });
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, prefs.shortcutKeys, setPrefs]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("settings.title")}</DialogTitle>
          <DialogDescription>{t("settings.description")}</DialogDescription>
        </DialogHeader>

        {/* --- Apparence ------------------------------------------------------------------ */}
        <section className="flex flex-col gap-3">
          <h3 className="text-[0.8125rem] font-medium">{t("settings.appearance")}</h3>
          <div className="rounded-lg border border-border p-3">
            <span className="block text-[0.8125rem]">{t("settings.pageWidth")}</span>
            <ToggleGroup
              value={[prefs.pageWidth]}
              onValueChange={(v) => { const w = v[0] as NbPageWidth | undefined; if (w) setPrefs({ pageWidth: w }); }}
              spacing={0} variant="outline" className="mt-2 grid grid-cols-4"
            >
              {(["narrow", "medium", "wide", "full"] as NbPageWidth[]).map((w) => (
                <ToggleGroupItem key={w} value={w} className={PRESSED}>{t(`settings.width.${w}`)}</ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-[0.8125rem]">{t("settings.fontScale")}</span>
              <span className="text-xs text-muted-foreground">{Math.round(prefs.fontScale * 100)} %</span>
            </div>
            <Slider
              value={[prefs.fontScale]}
              min={0.85} max={1.3} step={0.05}
              onValueChange={(v) => setPrefs({ fontScale: (Array.isArray(v) ? v[0] : v) ?? 1 })}
              className="mt-3"
            />
          </div>
          <label className="flex items-center justify-between rounded-lg border border-border p-3">
            <span className="text-[0.8125rem]">{t("settings.breadcrumb")}</span>
            <Toggle pressed={prefs.showBreadcrumb} onPressedChange={(p) => setPrefs({ showBreadcrumb: p })} variant="outline" size="sm">
              {prefs.showBreadcrumb ? t("settings.visible") : t("settings.hidden")}
            </Toggle>
          </label>
        </section>

        {/* --- Éditeur -------------------------------------------------------------------- */}
        <section className="flex flex-col gap-3">
          <h3 className="text-[0.8125rem] font-medium">{t("settings.editor")}</h3>
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-[0.8125rem]">{t("settings.autosaveDelay")}</span>
              <span className="text-xs text-muted-foreground">{prefs.autosaveMs} ms</span>
            </div>
            <Slider
              value={[prefs.autosaveMs]}
              min={300} max={3000} step={100}
              onValueChange={(v) => setPrefs({ autosaveMs: (Array.isArray(v) ? v[0] : v) ?? 700 })}
              className="mt-3"
            />
          </div>
          <label className="flex items-center justify-between rounded-lg border border-border p-3">
            <span className="text-[0.8125rem]">{t("settings.confirmTrash")}</span>
            <Toggle pressed={prefs.confirmDelete} onPressedChange={(p) => setPrefs({ confirmDelete: p })} variant="outline" size="sm">
              {prefs.confirmDelete ? t("settings.yes") : t("settings.no")}
            </Toggle>
          </label>
        </section>

        {/* --- Correcteur ------------------------------------------------------------------ */}
        <SpellSection language={language} />

        {/* --- Raccourcis ------------------------------------------------------------------ */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[0.8125rem] font-medium">{t("settings.shortcuts")}</h3>
            <Button size="sm" variant="ghost" onClick={() => setPrefs({ shortcutKeys: { ...DEFAULT_NOTEBOOK_SHORTCUT_KEYS } })}>
              {t("settings.reset")}
            </Button>
          </div>
          <div className="overflow-hidden rounded-lg border border-border">
            {NOTEBOOK_SHORTCUT_DEFS.map((d, i) => (
              <div key={d.action} className={`flex items-center justify-between px-3 py-2 ${i > 0 ? "border-t border-border" : ""}`}>
                <span className="text-[0.8125rem]">{t(`settings.shortcut.${d.action}`)}</span>
                <Tooltip>
                  <TooltipTrigger render={
                    <button
                      type="button"
                      onClick={() => setCapturing(capturing === d.action ? null : d.action)}
                      className={`rounded border px-2 py-0.5 font-mono text-xs ${
                        capturing === d.action
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-border bg-muted text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {capturing === d.action ? t("settings.press") : prefs.shortcutKeys[d.action] || d.combo}
                    </button>
                  } />
                  <TooltipContent>{t("settings.shortcutHint")}</TooltipContent>
                </Tooltip>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("settings.shortcutConflict")}
          </p>
        </section>
      </DialogContent>
    </Dialog>
  );
}
