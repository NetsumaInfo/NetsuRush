import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import NumberFlow from "@number-flow/react";

import { cn } from "@/lib/utils";

// Slider Base UI avec bulle chiffrée animée (NumberFlow) au-dessus du pouce.
// Conversion du composant Radix « number-flow slider » fourni → flavor Base UI.
export function NumberSlider({
  className,
  value,
  min = 0,
  max = 100,
  suffix = "",
  ...props
}: SliderPrimitive.Root.Props & { suffix?: string }) {
  const v = Array.isArray(value) ? value[0] : (value as number | undefined);

  return (
    <SliderPrimitive.Root
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      className={cn("data-horizontal:w-full", className)}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50">
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-foreground/25 select-none">
          <SliderPrimitive.Indicator className="h-full bg-primary select-none" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="group/thumb relative block size-3.5 shrink-0 rounded-full border-2 border-background bg-foreground shadow-sm ring-ring/50 transition-[box-shadow] select-none hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden">
          {v != null && (
            <NumberFlow
              value={v}
              suffix={suffix}
              className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 rounded-md bg-popover px-1.5 py-0.5 text-[11px] font-semibold text-popover-foreground shadow ring-1 ring-foreground/10"
            />
          )}
        </SliderPrimitive.Thumb>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
