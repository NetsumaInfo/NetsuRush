"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"

function PopoverRoot({ ...props }: React.ComponentProps<typeof Popover.Root>) {
  return <Popover.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof Popover.Trigger>) {
  return <Popover.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  sideOffset = 6,
  side = "bottom",
  align = "center",
  collisionPadding = 8,
  children,
  ...props
}: React.ComponentProps<typeof Popover.Popup> & {
  sideOffset?: number
  side?: React.ComponentProps<typeof Popover.Positioner>["side"]
  align?: React.ComponentProps<typeof Popover.Positioner>["align"]
  collisionPadding?: React.ComponentProps<typeof Popover.Positioner>["collisionPadding"]
}) {
  return (
    <Popover.Portal>
      {/* Positioner Base UI = évitement de collision natif (flip/shift), comme le tooltip et le
          menu : un panneau ouvert près d'un bord bascule au lieu de sortir de la fenêtre. */}
      <Popover.Positioner
        data-slot="popover-positioner"
        className="isolate z-50 outline-none"
        sideOffset={sideOffset}
        side={side}
        align={align}
        collisionPadding={collisionPadding}
      >
        <Popover.Popup
          data-slot="popover-content"
          className={cn(
            // Même plafond que le menu déroulant et le sélecteur : sans lui un popover au contenu
            // long (liste de participants) était coupé par le bas — et `overflow-hidden` seul ne
            // laissait même pas de barre pour atteindre le reste.
            "z-50 max-h-(--available-height) w-72 overflow-x-hidden overflow-y-auto overscroll-contain scrollbar-inset rounded-lg border border-border bg-popover text-popover-foreground shadow-md outline-none",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-98",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-98",
            "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
            "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            className
          )}
          {...props}
        >
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  )
}

export { PopoverRoot as Popover, PopoverTrigger, PopoverContent }
