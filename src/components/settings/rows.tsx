// Shared building blocks of the Settings panels. A setting reads as one line: its label, an
// optional info icon that holds the why, and the control on the right. The line under a label is
// kept for state that changes at run time (a version, a count, an error), never for an
// explanation — an explanation sits behind the info icon, where it costs no height.
import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" className="shrink-0 text-muted-foreground transition-colors hover:text-foreground" aria-label={text} />}
      >
        <Info className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{text}</TooltipContent>
    </Tooltip>
  );
}

export function SectionTitle({ title, info, icon, as: Tag = "h2" }: {
  title: ReactNode;
  info?: string;
  icon?: ReactNode;
  as?: "h2" | "h3";
}) {
  const size = Tag === "h2" ? "text-sm font-medium" : "text-xs font-medium text-muted-foreground";
  return (
    <Tag className={`flex items-center gap-1.5 ${size}`}>
      {icon}
      {title}
      {info && <InfoTip text={info} />}
    </Tag>
  );
}

export function SettingRow({ label, hint, state, children }: {
  label: string;
  hint?: string;
  state?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-5 px-4 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-[0.8125rem] font-medium">
          {label}
          {hint && <InfoTip text={hint} />}
        </p>
        {state && <p className="mt-0.5 text-xs text-muted-foreground">{state}</p>}
      </div>
      <div className="w-52 shrink-0">{children}</div>
    </div>
  );
}

export type Choice<T extends string | number> = { value: T; label: string };

export function CompactSelect<T extends string | number>({ value, choices, onChange, disabled }: {
  value: T;
  choices: Choice<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <Select items={choices} value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
      <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
      <SelectContent>
        {choices.map((choice) => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
