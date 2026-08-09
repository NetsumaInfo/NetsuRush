import { ArrowDown, ArrowUp, Eye, EyeOff, LockKeyhole, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { NAV } from "@/components/nav";
import { REQUIRED_MODULES, type ModuleId } from "@/lib/modules";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";

export function NavigationSettings() {
  const { t } = useTranslation(["settings", "shell"]);
  const order = useApp((state) => state.moduleOrder);
  const hidden = useApp((state) => state.hiddenModules);
  const setVisible = useApp((state) => state.setModuleVisible);
  const move = useApp((state) => state.moveModule);
  const reset = useApp((state) => state.resetModules);
  const navById = new Map(NAV.map((item) => [item.id, item]));
  const hiddenSet = new Set(hidden);
  const requiredSet = new Set<ModuleId>(REQUIRED_MODULES);

  function changeVisibility(id: ModuleId, visible: boolean) {
    // La navigation ne fait que modifier l'affichage. L'installation et la
    // vérification des dépendances appartiennent au gestionnaire de modèles/setup.
    setVisible(id, visible);
  }

  function resetAll() {
    reset();
  }

  return (
    <section className="flex flex-col gap-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">{t("settings:navigation.title")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("settings:navigation.subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={resetAll}>
          <RotateCcw className="size-3.5" /> {t("settings:navigation.reset")}
        </Button>
      </header>

      <div className="flex flex-col gap-2">
        {order.map((id, index) => {
          const item = navById.get(id);
          if (!item) return null;
          const Icon = item.icon;
          const visible = !hiddenSet.has(id);
          const required = requiredSet.has(id);
          return (
            <Card key={id} className="flex-row items-center gap-3 p-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{t(`shell:${item.labelKey}`)}</p>
                <p className="text-xs text-muted-foreground">
                  {required ? t("settings:navigation.required") : visible ? t("settings:navigation.visible") : t("settings:navigation.hidden")}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === 0}
                  onClick={() => move(id, -1)}
                  aria-label={t("settings:navigation.moveUp", { module: t(`shell:${item.labelKey}`) })}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === order.length - 1}
                  onClick={() => move(id, 1)}
                  aria-label={t("settings:navigation.moveDown", { module: t(`shell:${item.labelKey}`) })}
                >
                  <ArrowDown className="size-4" />
                </Button>
                <Toggle
                  pressed={visible}
                  disabled={required}
                  onPressedChange={(pressed) => changeVisibility(id, pressed)}
                  aria-label={required
                    ? t("settings:navigation.requiredAria", { module: t(`shell:${item.labelKey}`) })
                    : t(visible ? "settings:navigation.hideAria" : "settings:navigation.showAria", { module: t(`shell:${item.labelKey}`) })}
                  className="ml-1"
                >
                  {required ? <LockKeyhole className="size-4" /> : visible ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                </Toggle>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
