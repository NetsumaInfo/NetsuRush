// Choix du couple source → cible. Les noms complets ne tiennent pas sur une ligne (« Re… », « Pre… »,
// « Aft… ») : le logo porte l'identité, l'infobulle donne le nom.
import { useTranslation } from "react-i18next";
import { ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useApp } from "@/store";
import { HostIcon } from "@/components/HostIcon";
import { hostOfflineHint, hostLabel, hostShort } from "@/lib/host";
import type { TransferHost } from "@/lib/bridge";
import { TRANSFER_SOURCES, TRANSFER_TARGETS } from "./transferShared";

function useHostOnline(): (host: TransferHost) => boolean {
  const resolveConnected = useApp((s) => !!s.status?.connected);
  const adobeStatus = useApp((s) => s.adobeStatus);
  return (host) => (host === "resolve" ? resolveConnected : !!adobeStatus?.[host]?.panelConnected);
}

function HostGroup({
  label, value, hosts, disabled, onChange,
}: {
  label: string;
  value: TransferHost;
  hosts: TransferHost[];
  disabled: boolean;
  onChange: (host: TransferHost) => void;
}) {
  const { t } = useTranslation("transfer");
  const online = useHostOnline();
  return (
    <div className="space-y-2">
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <ToggleGroup
        value={[value]}
        onValueChange={(v) => { const next = v[0] as TransferHost | undefined; if (next) onChange(next); }}
        disabled={disabled}
      >
        {hosts.map((host) => {
          const up = online(host);
          return (
            <Tooltip key={host}>
              <TooltipTrigger
                render={
                  <ToggleGroupItem value={host} aria-label={hostLabel(host)} className="relative size-10 p-0">
                    <HostIcon host={host} className="size-5" />
                    <span
                      aria-hidden
                      className={`absolute right-1 top-1 size-1.5 rounded-full ring-2 ring-[var(--color-surface)] ${up ? "bg-[var(--color-ok)]" : "bg-muted-foreground/50"}`}
                    />
                  </ToggleGroupItem>
                }
              />
              <TooltipContent>
                {hostLabel(host)} · {t(up ? "picker.online" : "picker.hostOffline")}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </ToggleGroup>
    </div>
  );
}

export function TransferHostPicker({
  from, to, setFrom, setTo, swap, swappable, disabled,
}: {
  from: TransferHost;
  to: TransferHost;
  setFrom: (h: TransferHost) => void;
  setTo: (h: TransferHost) => void;
  swap: () => void;
  swappable: boolean;
  disabled: boolean;
}) {
  const { t } = useTranslation("transfer");
  const online = useHostOnline();
  const offline = [from, to].filter((host) => !online(host));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <HostGroup label={t("picker.source")} value={from} hosts={TRANSFER_SOURCES} disabled={disabled} onChange={setFrom} />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="outline" size="icon" onClick={swap} disabled={disabled || !swappable} className="size-10">
                <ArrowLeftRight className="size-4" />
              </Button>
            }
          />
          <TooltipContent>{t(swappable ? "picker.swap" : "picker.swapUnavailable")}</TooltipContent>
        </Tooltip>
        <HostGroup label={t("picker.target")} value={to} hosts={TRANSFER_TARGETS[from]} disabled={disabled} onChange={setTo} />
        <p className="ml-auto self-center text-sm font-medium text-foreground">
          {hostShort(from)} <span className="text-muted-foreground">→</span> {hostShort(to)}
        </p>
      </div>
      {offline.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("picker.offline", { hosts: offline.map(hostShort).join(", ") })} {hostOfflineHint(offline[0])}
        </p>
      )}
    </div>
  );
}
