import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { THEMES, type ThemeId, type ThemeMode } from "@/store/types";
import { cn } from "@/lib/utils";
import { CustomThemesCard } from "./appearance/CustomThemesCard";
import { ThemeColorsCard } from "./appearance/ThemeColorsCard";
import { WallpaperCard } from "./appearance/WallpaperCard";

const MODES: ThemeMode[] = ["dark", "light"];

// Aperçu d'un thème : palette forcée via data-theme local pour montrer ses vraies couleurs.
function Swatch({ theme }: { theme: ThemeId }) {
  return (
    <div
      data-theme={theme}
      className="flex h-14 overflow-hidden rounded-md"
      style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
    >
      <span className="w-3 shrink-0" style={{ background: "var(--color-primary)" }} />
      <span className="flex flex-1 flex-col gap-1.5 p-2" style={{ background: "var(--color-surface)" }}>
        <span className="h-2 w-3/5 rounded-full" style={{ background: "var(--color-fg)" }} />
        <span className="h-2 w-full rounded-full" style={{ background: "var(--color-surface-2)" }} />
        <span className="h-2 w-4/5 rounded-full" style={{ background: "var(--color-border)" }} />
      </span>
    </div>
  );
}

function ThemeCard({ id, label, hint }: { id: ThemeId; label: string; hint: string }) {
  const { t } = useTranslation("settings");
  // `customThemeId` compte : un thème personnalisé s'appuie sur une palette livrée, qui ne doit pas
  // pour autant s'afficher comme sélectionnée — deux cartes cochées à la fois.
  const active = useApp((s) => s.theme === id && !s.customThemeId);
  const setTheme = useApp((s) => s.setTheme);
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => setTheme(id)}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border p-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-primary bg-accent" : "border-border hover:bg-accent/60",
      )}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{t(`appearance.theme.${id}.label`, { defaultValue: label })}</span>
        {active && <Check className="size-4 shrink-0 text-primary" />}
      </div>
      <Swatch theme={id} />
      <span className="text-xs leading-snug text-muted-foreground">
        {t(`appearance.theme.${id}.hint`, { defaultValue: hint })}
      </span>
    </button>
  );
}

export function AppearanceSettings() {
  const { t } = useTranslation("settings");
  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-sm font-medium">{t("appearance.title")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("appearance.subtitle")}</p>
      </header>
      {MODES.map((mode) => (
        <div key={mode} className="flex flex-col gap-2.5">
          <h3 className="text-xs font-medium text-muted-foreground">{t(`appearance.group.${mode}`)}</h3>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2.5">
            {THEMES.filter((theme) => theme.mode === mode).map((theme) => (
              <ThemeCard key={theme.id} id={theme.id} label={theme.label} hint={theme.hint} />
            ))}
          </div>
        </div>
      ))}
      <CustomThemesCard />
      <ThemeColorsCard />
      <WallpaperCard />
    </section>
  );
}
