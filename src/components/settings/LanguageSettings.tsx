import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { LANGUAGES, type LangCode } from "@/i18n";
import { FlagIcon } from "@/components/language/FlagIcon";
import { Select, SelectTrigger, SelectContent, SelectItem } from "@/components/ui/select";

// Page Paramètres › Interface › Langue : sélecteur de la langue de l'interface. La bascule est À CHAUD
// (setLang recharge les ressources i18next) → aucun redémarrage requis. Fermé, le sélecteur montre le
// drapeau + le code ISO ; ouvert, chaque ligne ajoute l'autonyme (« Français », « 日本語 »).
export function LanguageSettings() {
  const { t } = useTranslation("language");
  const lang = useApp((s) => s.lang);
  const setLang = useApp((s) => s.setLang);
  const active = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0];

  return (
    <section>
      <h2 className="text-sm font-medium">{t("settings.title")}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t("settings.subtitle")}</p>
      <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <span className="block text-[0.8125rem]">{t("settings.fieldLabel")}</span>
        <Select
          items={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
          value={lang}
          onValueChange={(v) => setLang(String(v) as LangCode)}
        >
          <SelectTrigger size="sm" className="w-44">
            {/* `flex!` : le déclencheur applique `[&>span]:line-clamp-1`, donc `display:-webkit-box`
                sur son span — le drapeau tombait sur sa propre ligne au-dessus du libellé. */}
            <span className="flex! min-w-0 items-center gap-2">
              <FlagIcon code={active.code} />
              <span className="truncate">{active.label}</span>
            </span>
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                <span className="flex items-center gap-2">
                  <FlagIcon code={l.code} />
                  <span className="w-5 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{l.code}</span>
                  <span>{l.label}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}
