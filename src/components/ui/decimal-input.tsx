import * as React from "react";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { fmtInputNumber, parseDecimal } from "@/lib/utils";

type DecimalInputProps = Omit<React.ComponentProps<"input">, "type" | "value" | "defaultValue" | "onChange" | "min" | "max"> & {
  value: number | null | undefined;
  /** Called on every keystroke that reads as a number, and with `null` when the field is emptied. */
  onValueChange: (value: number | null) => void;
  /** Most decimals shown once the field loses focus. */
  digits?: number;
  min?: number;
  max?: number;
  /** A plain `<input>` styled only by `className`, for compact fields that are not a form input. */
  bare?: boolean;
};

/**
 * A number field that reads "1,5" and "1.5" alike and shows its value in the interface locale.
 * A native `type="number"` does neither: WebView2 accepts only the OS locale's decimal mark and drops
 * the other one silently, so an English Windows turned "1,5" into an empty value.
 */
export function DecimalInput({
  value, onValueChange, digits = 3, min, max, bare, onBlur, onFocus, ...props
}: DecimalInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const shown = draft ?? (value == null || !Number.isFinite(value) ? "" : fmtInputNumber(value, digits));
  const inputProps: React.ComponentProps<"input"> = {
    ...props,
    type: "text",
    inputMode: "decimal",
    autoComplete: "off",
    spellCheck: false,
    value: shown,
    onFocus: (e) => { setDraft(shown); onFocus?.(e); },
    onChange: (e) => {
      setDraft(e.target.value);
      if (e.target.value.trim() === "") return onValueChange(null);
      const v = parseDecimal(e.target.value);
      if (Number.isFinite(v)) onValueChange(v);
    },
    onBlur: (e) => {
      if (draft != null && draft.trim() !== "") {
        const v = parseDecimal(draft);
        if (Number.isFinite(v) && clamp(v) !== value) onValueChange(clamp(v));
      }
      setDraft(null);
      onBlur?.(e);
    },
  };
  return bare ? <input {...inputProps} /> : <Input {...inputProps} />;
}
