import { useTranslation } from "react-i18next";
import { Minus, X } from "lucide-react";
import { BrandIcon } from "@/components/BrandIcon";
import { Spinner } from "@/components/ui/spinner";

// Cadre affiché AVANT le premier rendu de l'application, le temps que les réglages soient relus
// depuis le disque (cf. src/lib/uiState.ts). Il ne doit importer NI le store NI aucun module qui lit
// `localStorage` à l'évaluation : c'est justement le contenu que l'hydratation est en train de
// remettre en place. D'où ces contrôles de fenêtre réduits au strict nécessaire — la fenêtre est
// frameless, sans eux un core lent laisserait une fenêtre qu'on ne peut ni déplacer ni fermer.
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function win() {
  const m = await import("@tauri-apps/api/window");
  return m.getCurrentWindow();
}

export function BootFrame() {
  const { t } = useTranslation(["shell", "common"]);
  const btn = "inline-flex h-9 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5";
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header
        data-tauri-drag-region
        className="relative flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3 select-none"
      >
        <BrandIcon className="size-6" />
        <span className="text-xs font-semibold tracking-tight">NetsuRush</span>
        {isTauri && (
          <div className="ml-auto flex items-center" data-no-drag>
            <button type="button" aria-label={t("shell:windowControls.minimize")} className={btn} onClick={() => void win().then((w) => w.minimize()).catch(() => undefined)}>
              <Minus />
            </button>
            <button type="button" aria-label={t("common:action.close")} className={`${btn} hover:bg-destructive hover:text-primary-foreground`} onClick={() => void win().then((w) => w.close()).catch(() => undefined)}>
              <X />
            </button>
          </div>
        )}
      </header>
      <div className="grid flex-1 place-items-center bg-background">
        <Spinner className="size-5" />
      </div>
    </div>
  );
}
