// Une politique PAR TYPE de cache : quota (Go, appliqué en LRU) et âge (jours sans usage), chacun
// activable seul. Un quota sur les aperçus n'a rien à voir avec un quota sur l'index de recherche —
// d'où le réglage séparé plutôt qu'un seuil global qui arbitrerait à la place de l'utilisateur.
import { useTranslation } from "react-i18next";
import { Toggle } from "@/components/ui/toggle";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HelpCircle, Images } from "lucide-react";
import type { CacheSettings, CacheKindPolicy, SessionCleanupTrigger } from "@/lib/bridge";
import { CACHE_KIND_LIST, KIND_ICON, isDbKind, isSessionKind, type CacheKind } from "./storageShared";

interface Props {
  settings: CacheSettings;
  onChange: (patch: Partial<CacheSettings>) => void;
}

// Champ numérique optionnel : vide = règle inactive. On ne force jamais une valeur par défaut au
// premier caractère saisi, sinon taper « 1 » pour « 10 » déclencherait une purge à 1 Go.
function NumField({ value, onCommit, suffix, disabled }: {
  value: number | null;
  onCommit: (v: number | null) => void;
  suffix: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <Input
        type="number"
        min={1}
        inputMode="numeric"
        disabled={disabled}
        value={value ?? ""}
        placeholder="—"
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (!raw) return onCommit(null);
          const n = Number(raw);
          onCommit(Number.isFinite(n) && n > 0 ? n : null);
        }}
        className="h-7 w-16 text-xs tabular-nums"
      />
      <span className="text-[11px] text-muted-foreground">{suffix}</span>
    </div>
  );
}

function KindRow({ kind, policy, onChange }: { kind: CacheKind; policy: CacheKindPolicy; onChange: (p: Partial<CacheKindPolicy>) => void }) {
  const { t } = useTranslation("settings");
  const Icon = KIND_ICON[kind];
  // Les caches en base n'ont pas de suivi d'usage par entrée → impossible de trier par LRU ou par âge.
  // On le DIT plutôt que d'afficher des champs qui ne feraient rien.
  const manualOnly = isDbKind(kind);

  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 border-b border-border py-2 last:border-0">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs text-foreground">{t(`storage.kind.${kind}`)}</span>
        <Tooltip>
          <TooltipTrigger render={<span className="shrink-0 text-muted-foreground" />}>
            <HelpCircle className="size-3" />
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{t(`storage.kindHint.${kind}`)}</TooltipContent>
        </Tooltip>
      </div>
      {manualOnly ? (
        <Tooltip>
          <TooltipTrigger render={<span className="col-span-3 justify-self-end text-[11px] text-muted-foreground" />}>
            {t("storage.policy.manualOnly")}
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{t("storage.policy.manualOnlyHint")}</TooltipContent>
        </Tooltip>
      ) : (
        <>
          <NumField value={policy.maxGb} suffix={t("storage.policy.gb")} disabled={!policy.auto} onCommit={(maxGb) => onChange({ maxGb })} />
          <NumField value={policy.maxDays} suffix={t("storage.policy.days")} disabled={!policy.auto} onCommit={(maxDays) => onChange({ maxDays })} />
          <Toggle pressed={policy.auto} onPressedChange={(auto) => onChange({ auto })} size="sm" aria-label={t("storage.policy.auto")}>
            {t("storage.policy.auto")}
          </Toggle>
        </>
      )}
    </div>
  );
}

function SessionPolicyRow({ kind, value, onChange }: {
  kind: "roto" | "upscaleTest" | "voice";
  value: SessionCleanupTrigger;
  onChange: (value: SessionCleanupTrigger) => void;
}) {
  const { t } = useTranslation("settings");
  const Icon = KIND_ICON[kind];
  const choices: SessionCleanupTrigger[] = kind === "voice" ? ["page", "app"] : ["operation", "page", "app"];
  const items = choices.map((trigger) => ({
    value: trigger,
    label: trigger === "operation"
      ? t(`storage.policy.trigger.${kind}`)
      : t(`storage.policy.trigger.${trigger}`),
  }));
  const current = items.find((item) => item.value === value)?.label;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-foreground">{t(`storage.kind.${kind}`)}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t(`storage.kindHint.${kind}`)}</p>
      </div>
      <Select items={items} value={value} onValueChange={(next) => onChange(String(next) as SessionCleanupTrigger)}>
        <SelectTrigger size="sm" className="w-56 max-w-full shrink-0"><SelectValue>{current}</SelectValue></SelectTrigger>
        <SelectContent>
          {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function SessionPolicies({ settings, onChange }: Props) {
  const { t } = useTranslation("settings");
  const setSession = (kind: keyof CacheSettings["session"], trigger: SessionCleanupTrigger) =>
    onChange({ session: { ...settings.session, [kind]: trigger } });
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t("storage.policy.sessionTitle")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("storage.policy.sessionDesc")}</p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <SessionPolicyRow kind="roto" value={settings.session.roto} onChange={(v) => setSession("roto", v)} />
        <SessionPolicyRow kind="upscaleTest" value={settings.session.upscaleTest} onChange={(v) => setSession("upscaleTest", v)} />
        <SessionPolicyRow kind="voice" value={settings.session.voice} onChange={(v) => setSession("voice", v)} />
        <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          <Images className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-foreground">{t("storage.policy.sequenceTitle")}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{t("storage.policy.sequenceHint")}</p>
          </div>
          <span className="shrink-0 text-[11px] font-medium text-foreground">{t("storage.policy.trigger.immediate")}</span>
        </div>
      </div>
    </div>
  );
}

export function CachePolicies({ settings, onChange }: Props) {
  const { t } = useTranslation("settings");
  const setKind = (kind: CacheKind, p: Partial<CacheKindPolicy>) =>
    onChange({ kinds: { [kind]: { ...settings.kinds[kind], ...p } } as CacheSettings["kinds"] });

  return (
    <section className="space-y-7">
      <SessionPolicies settings={settings} onChange={onChange} />

      <div>
        <h3 className="text-sm font-medium text-foreground">{t("storage.policy.title")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("storage.policy.desc")}</p>
      </div>

      <div className="rounded-lg border border-border px-3">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 border-b border-border py-1.5 text-[11px] text-muted-foreground">
          <span />
          <Tooltip>
            <TooltipTrigger render={<span className="w-[76px] cursor-default" />}>{t("storage.policy.quota")}</TooltipTrigger>
            <TooltipContent className="max-w-64">{t("storage.policy.quotaHint")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<span className="w-[76px] cursor-default" />}>{t("storage.policy.age")}</TooltipTrigger>
            <TooltipContent className="max-w-64">{t("storage.policy.ageHint")}</TooltipContent>
          </Tooltip>
          <span className="w-[86px]" />
        </div>
        {CACHE_KIND_LIST.filter((kind) => !isSessionKind(kind)).map((k) => (
          <KindRow key={k} kind={k} policy={settings.kinds[k]} onChange={(p) => setKind(k, p)} />
        ))}
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium text-foreground">{t("storage.policy.warnTitle")}</h4>
          <span className="text-[11px] text-muted-foreground">{t("storage.policy.warnNever")}</span>
        </div>
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <Toggle
              pressed={settings.warn.enabled}
              onPressedChange={(enabled) => onChange({ warn: { ...settings.warn, enabled } })}
              size="sm"
            >
              {t("storage.policy.warnCache")}
            </Toggle>
            <NumField
              value={settings.warn.gb}
              suffix={t("storage.policy.gb")}
              disabled={!settings.warn.enabled}
              onCommit={(gb) => onChange({ warn: { ...settings.warn, gb: gb ?? settings.warn.gb } })}
            />
          </div>
          <div className="flex items-center gap-2">
            <Toggle
              pressed={settings.disk.enabled}
              onPressedChange={(enabled) => onChange({ disk: { ...settings.disk, enabled } })}
              size="sm"
            >
              {t("storage.policy.warnDisk")}
            </Toggle>
            <NumField
              value={settings.disk.freeGb}
              suffix={t("storage.policy.gb")}
              disabled={!settings.disk.enabled}
              onCommit={(freeGb) => onChange({ disk: { ...settings.disk, freeGb: freeGb ?? settings.disk.freeGb } })}
            />
            <span className="text-[11px] text-muted-foreground">{t("storage.policy.warnDiskSuffix")}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
