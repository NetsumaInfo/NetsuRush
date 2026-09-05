import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorPicker } from "@/components/ui/color-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FlowVariable } from "@/lib/bridge";
import { currentValue, declaredValue, type FlowVarValue } from "@/components/flow/useFlow";

/// Beyond this many variables the list stops being scannable and the filter
/// earns its space. Below it, a search field is one more thing to ignore.
const FILTER_THRESHOLD = 8;

type Props = {
  variables: FlowVariable[];
  overrides: Record<string, FlowVarValue>;
  onChange: (id: string, value: FlowVarValue | undefined) => void;
  disabled?: boolean;
};

/// Groups in the order the author declared them: their ordering is information,
/// and sorting alphabetically would throw it away.
function groupVariables(variables: FlowVariable[]) {
  const groups = new Map<string, FlowVariable[]>();
  for (const variable of variables) {
    const key = variable.group || "";
    const bucket = groups.get(key);
    if (bucket) bucket.push(variable);
    else groups.set(key, [variable]);
  }
  return [...groups.entries()];
}

function VariableControl({ variable, value, onChange, disabled }: {
  variable: FlowVariable;
  value: FlowVarValue;
  onChange: (value: FlowVarValue) => void;
  disabled?: boolean;
}) {
  if (variable.type === "enum" && variable.options?.length) {
    return (
      <Select
        value={String(value ?? "")}
        onValueChange={(next) => onChange(String(next ?? ""))}
        disabled={disabled}
      >
        <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {variable.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (variable.type === "boolean") {
    return (
      <Checkbox
        checked={value === true || value === "true"}
        onCheckedChange={(next) => onChange(Boolean(next))}
        disabled={disabled}
      />
    );
  }

  if (variable.type === "color") {
    // Alpha is offered only when the declaration carried one: a composition
    // that never asked for transparency should not gain a control implying it.
    return (
      <ColorPicker
        value={String(value ?? "#ffffff")}
        onChange={onChange}
        allowAlpha={typeof variable.alpha === "number" && variable.alpha < 1}
        ariaLabel={variable.label}
        className={disabled ? "pointer-events-none opacity-50" : undefined}
      />
    );
  }

  if (variable.type === "number") {
    const numeric = Number.parseFloat(String(value ?? variable.min ?? 0));
    // The suffix goes back on the way out — the composition reads "16px", not
    // 16 — and the unit is shown so the number is not a bare figure.
    const commit = (raw: string) => {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      onChange(variable.suffix ? `${parsed}${variable.suffix}` : parsed);
    };
    return (
      <div className="flex items-center gap-2">
        <Input
          type="range"
          className="h-8 flex-1 p-0"
          min={variable.min ?? 0}
          max={variable.max ?? 100}
          step={variable.step ?? 1}
          value={Number.isFinite(numeric) ? numeric : 0}
          onChange={(event) => commit(event.target.value)}
          disabled={disabled}
        />
        <Input
          type="number"
          className="h-8 w-20 text-right tabular-nums"
          min={variable.min ?? undefined}
          max={variable.max ?? undefined}
          step={variable.step ?? undefined}
          value={Number.isFinite(numeric) ? numeric : 0}
          onChange={(event) => commit(event.target.value)}
          disabled={disabled}
        />
        {variable.unit ? (
          <span className="w-6 shrink-0 text-xs text-muted-foreground">{variable.unit}</span>
        ) : null}
      </div>
    );
  }

  if (variable.multiline) {
    return (
      <Textarea
        className="min-h-16 resize-y text-sm"
        value={String(value ?? "")}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    );
  }

  return (
    <Input
      className="h-8"
      value={String(value ?? "")}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
    />
  );
}

function VariableRow({ variable, overrides, onChange, disabled }: {
  variable: FlowVariable;
  overrides: Record<string, FlowVarValue>;
  onChange: (id: string, value: FlowVarValue | undefined) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("flow");
  const value = currentValue(variable, overrides);
  const dirty = Object.prototype.hasOwnProperty.call(overrides, variable.id)
    && String(value) !== String(declaredValue(variable));

  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)_1.75rem] items-center gap-2 py-1">
      <Tooltip>
        <TooltipTrigger render={
          <Label className={`truncate text-xs ${dirty ? "text-foreground" : "text-muted-foreground"}`}>
            {variable.label || variable.id}
          </Label>
        } />
        <TooltipContent>
          {variable.description ? `${variable.description} (${variable.id})` : variable.id}
        </TooltipContent>
      </Tooltip>
      <VariableControl
        variable={variable}
        value={value}
        onChange={(next) => onChange(variable.id, next)}
        disabled={disabled}
      />
      {/* Present on every row and only inked when it would do something, so a
          value change never reflows the list. */}
      {dirty ? (
        <Tooltip>
          <TooltipTrigger render={
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => onChange(variable.id, undefined)}
              disabled={disabled}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          } />
          <TooltipContent>{t("reset")}</TooltipContent>
        </Tooltip>
      ) : <span className="size-7" />}
    </div>
  );
}

/// Memoised because live playback reports its clock about sixty times a
/// second: without this, every tick re-rendered the whole variable list, which
/// is far more work than moving a scrubber should ever cost. None of these
/// props change while the playhead runs.
export const FlowInspector = memo(function FlowInspector(
  { variables, overrides, onChange, disabled }: Props,
) {
  const { t } = useTranslation("flow");
  const [needle, setNeedle] = useState("");

  const matching = useMemo(() => {
    const query = needle.trim().toLowerCase();
    if (!query) return variables;
    return variables.filter((variable) =>
      variable.label.toLowerCase().includes(query)
      || variable.id.toLowerCase().includes(query)
      || variable.description.toLowerCase().includes(query));
  }, [variables, needle]);

  if (!variables.length) {
    return <p className="p-3 text-xs text-muted-foreground">{t("noVariables")}</p>;
  }

  const groups = groupVariables(matching);

  return (
    <div className="flex flex-col gap-1 p-3">
      {variables.length >= FILTER_THRESHOLD ? (
        <Input
          className="mb-1 h-8"
          value={needle}
          placeholder={t("filter")}
          onChange={(event) => setNeedle(event.target.value)}
        />
      ) : null}
      {groups.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">{t("noMatch")}</p>
      ) : null}
      {groups.map(([group, entries]) => (
        <section key={group || "_"}>
          {group && groups.length > 1 ? (
            <h4 className="mt-3 border-t pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {group}
            </h4>
          ) : null}
          {entries.map((variable) => (
            <VariableRow
              key={variable.id}
              variable={variable}
              overrides={overrides}
              onChange={onChange}
              disabled={disabled}
            />
          ))}
        </section>
      ))}
    </div>
  );
});
