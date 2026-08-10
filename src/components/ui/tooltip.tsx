"use client"

import * as React from "react"
import { Tooltip } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delay = 0,
  closeDelay,
  timeout,
  children,
}: {
  delay?: number
  closeDelay?: number
  timeout?: number
  children?: React.ReactNode
}) {
  return (
    <Tooltip.Provider
      data-slot="tooltip-provider"
      delay={delay}
      closeDelay={closeDelay}
      timeout={timeout}
    >
      {children}
    </Tooltip.Provider>
  )
}

function TooltipRoot({
  ...props
}: React.ComponentProps<typeof Tooltip.Root>) {
  return <Tooltip.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof Tooltip.Trigger>) {
  return <Tooltip.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  side = "top",
  align = "center",
  collisionPadding = 8,
  collisionAvoidance,
  children,
  ...props
}: React.ComponentProps<typeof Tooltip.Popup> & {
  sideOffset?: number
  side?: React.ComponentProps<typeof Tooltip.Positioner>["side"]
  align?: React.ComponentProps<typeof Tooltip.Positioner>["align"]
  collisionPadding?: React.ComponentProps<typeof Tooltip.Positioner>["collisionPadding"]
  collisionAvoidance?: React.ComponentProps<typeof Tooltip.Positioner>["collisionAvoidance"]
}) {
  return (
    <Tooltip.Portal>
      {/* Positioner Base UI = collision avoidance native (flip/shift) → comportement Discord :
          un élément près d'un bord bascule du côté opposé, un coin se décale. */}
      <Tooltip.Positioner
        data-slot="tooltip-positioner"
        className="isolate z-50 outline-none"
        sideOffset={sideOffset}
        side={side}
        align={align}
        collisionPadding={collisionPadding}
        {...(collisionAvoidance !== undefined && { collisionAvoidance })}
      >
        <Tooltip.Popup
          data-slot="tooltip-content"
          className={cn(
            // `break-words` : sans lui, un mot sans espace (nom de fichier, URL, identifiant) déborde
            // de la bulle — `max-w-*` borne la largeur mais ne crée aucune occasion de césure.
            "z-50 w-fit max-w-52 break-words hyphens-auto rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-98",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-98",
            "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
            "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            className
          )}
          {...props}
        >
          {children}
          {/* Flèche orientée par `data-side` : floating-ui ne centre que l'axe transverse, on pose
              le bord + la rotation pour les 4 côtés (haut/bas/gauche/droite). */}
          <Tooltip.Arrow
            className={cn(
              "data-[side=bottom]:top-[-8px]",
              "data-[side=top]:bottom-[-8px] data-[side=top]:rotate-180",
              "data-[side=left]:right-[-13px] data-[side=left]:rotate-90",
              "data-[side=right]:left-[-13px] data-[side=right]:-rotate-90",
            )}
          >
            <ArrowSvg />
          </Tooltip.Arrow>
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  )
}

// Flèche du tooltip : SVG 20×10 (pointe + liseré pour suivre la bordure du popup).
function ArrowSvg(props: React.ComponentProps<"svg">) {
  return (
    <svg width="20" height="10" viewBox="0 0 20 10" fill="none" {...props}>
      <path
        d="M9.66437 2.60207L4.80758 6.97318C4.07308 7.63423 3.11989 8 2.13172 8H0V10H20V8H18.5349C17.5468 8 16.5936 7.63423 15.8591 6.97318L11.0023 2.60207C10.622 2.2598 10.0447 2.25979 9.66437 2.60207Z"
        className="fill-popover"
      />
      <path
        d="M8.99542 1.85876C9.75604 1.17425 10.9106 1.17422 11.6713 1.85878L16.5281 6.22989C17.0789 6.72568 17.7938 7.00001 18.5349 7.00001L15.89 7L11.0023 2.60207C10.622 2.2598 10.0447 2.2598 9.66437 2.60207L4.77907 7L2.13172 7.00001C2.87268 7.00001 3.58761 6.72568 4.13844 6.22989L8.99542 1.85876Z"
        className="fill-border"
      />
    </svg>
  )
}

export {
  TooltipProvider,
  TooltipRoot as Tooltip,
  TooltipTrigger,
  TooltipContent,
}
