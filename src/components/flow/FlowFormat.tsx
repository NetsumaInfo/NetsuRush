import { memo } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FlowState } from "@/lib/bridge";

/// Portrait is first-class, not an afterthought: the compositions this renders
/// are as often 9:16 as 16:9, and a menu that buries vertical formats makes the
/// common case the awkward one.
const PRESETS: { group: string; sizes: [number, number][] }[] = [
  { group: "landscape", sizes: [[1920, 1080], [2560, 1440], [3840, 2160]] },
  { group: "portrait", sizes: [[1080, 1920], [720, 1280], [1440, 2560], [2160, 3840], [1080, 1350]] },
  { group: "square", sizes: [[1080, 1080], [2048, 2048]] },
];

export const FlowFormat = memo(function FlowFormat({ state, onApply, disabled }: {
  state: FlowState;
  onApply: (width: number, height: number) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("flow");
  const current = `${state.width}x${state.height}`;
  const asked = state.requested[0];

  return (
    <div className="flex flex-col gap-3 p-3">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("format")}
      </h4>

      {/* What the pasted code declares, offered rather than guessed at: a
          component authored at 1080x1920 and rendered at 1920x1080 does not
          letterbox, it lays out wrong. */}
      <div className="flex flex-wrap gap-2">
        {state.requested.map((size) => {
          const active = size.width === state.width && size.height === state.height;
          return (
            <Tooltip key={`${size.width}x${size.height}-${size.source}`}>
              <TooltipTrigger render={
                <Button
                  size="sm"
                  variant={active ? "secondary" : "outline"}
                  className="h-7 text-xs tabular-nums"
                  onClick={() => onApply(size.width, size.height)}
                  disabled={disabled || active}
                >
                  {size.width} × {size.height}
                </Button>
              } />
              <TooltipContent>{size.source}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
        <Label className="text-xs text-muted-foreground">{t("preset")}</Label>
        <Select
          value={current}
          onValueChange={(next) => {
            const [width, height] = String(next ?? "").split("x").map(Number);
            if (width && height) onApply(width, height);
          }}
          disabled={disabled}
        >
          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PRESETS.map((entry) => entry.sizes.map(([width, height]) => (
              <SelectItem key={`${width}x${height}`} value={`${width}x${height}`}>
                {width} × {height} · {t(entry.group)}
              </SelectItem>
            )))}
          </SelectContent>
        </Select>
      </div>

      {asked && (asked.width !== state.width || asked.height !== state.height) ? (
        <p className="text-xs text-muted-foreground">
          {t("codeAsks")} {asked.width} × {asked.height}
        </p>
      ) : null}
    </div>
  );
});
