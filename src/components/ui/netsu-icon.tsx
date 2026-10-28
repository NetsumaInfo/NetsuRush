import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import { NETSU_ICONS, type NetsuIconEntry } from "./netsu-icons.generated";

/**
 * Action icons drawn in NetsuIcon (pack `netsurush`), as CSS-animated SVG.
 * `netsu-icons.generated.ts` is written by NetsuIcon's `bundle` script: change an icon there, never here.
 * Same rule as animated-icons.tsx: chrome only (buttons, bars, menus), never on video card grids.
 */
export type NetsuIconProps = {
  name: string;
  /** Shows `<name>-<mode>` when that icon exists: the same button, another insertion or export mode. */
  mode?: string;
  /** Shows the loop of a long task while it runs. */
  busy?: boolean;
  /** Holds a switch on or off. Without it, every press toggles. */
  on?: boolean;
  className?: string;
};

/** The press comes from the control that holds the icon, not from the icon itself. */
const PRESSABLE = "button,[role=button],[role=menuitem],[role=menuitemcheckbox],[role=tab],a";

export function iconEntry(name: string, mode?: string): NetsuIconEntry | undefined {
  return (mode && NETSU_ICONS[`${name}-${mode}`]) || NETSU_ICONS[name];
}

/** When the last animation of this clip ends, in ms: `data-play` must outlive it, or the press stops halfway. */
function clipEnd(svg: SVGSVGElement, clip: string): number {
  const prefix = `${svg.classList[0]}-${clip}-`;
  const ends = svg
    .getAnimations({ subtree: true })
    .filter((animation) => animation instanceof CSSAnimation && animation.animationName.startsWith(prefix))
    .map((animation) => Number(animation.effect?.getComputedTiming().endTime ?? 0))
    .filter(Number.isFinite);
  return Math.max(0, ...ends);
}

/** Replays the press clip from its start; reading the layout in between makes the browser restart it. */
function playPress(svg: SVGSVGElement, clip: string): void {
  svg.removeAttribute("data-play");
  svg.getBoundingClientRect();
  svg.setAttribute("data-play", clip);
  window.setTimeout(() => {
    if (svg.getAttribute("data-play") === clip) svg.removeAttribute("data-play");
  }, clipEnd(svg, clip));
}

function toggleSwitch(svg: SVGSVGElement): void {
  svg.setAttribute("data-state", svg.getAttribute("data-state") === "on" ? "off" : "on");
}

/**
 * Runs once React has drawn the next state: a press that changes the mode swaps the markup, and the clip must
 * play on the new icon, not on the one that is gone. React handles the click at its root, after this listener,
 * and commits a click's update before the event ends; a timer comes after that (an animation frame may never
 * come in a hidden window).
 */
function afterRender(run: () => void): void {
  window.setTimeout(run, 0);
}

/**
 * The whole control drives the icon: hover while the pointer is on it, a press when it is clicked.
 * An icon that is one mode of a button shows that mode on hover: its press plays, so the user sees what
 * the mode does before choosing it.
 */
function useControl(box: React.RefObject<HTMLSpanElement | null>, controlled: boolean, showsMode: boolean, markup: string | undefined) {
  useEffect(() => {
    const host = box.current?.closest(PRESSABLE) ?? box.current;
    if (!host) return;
    const svg = () => box.current?.querySelector("svg") ?? null;
    // New markup under a pointer that is already there: hovered, but quiet, so nothing replays by itself.
    if (host.matches(":hover")) svg()?.setAttribute("data-hover", "");
    const enter = () => {
      const icon = svg();
      if (!icon) return;
      icon.setAttribute("data-hover", "");
      const clip = icon.getAttribute("data-click");
      if (showsMode && clip) playPress(icon, clip);
    };
    const leave = () => {
      svg()?.removeAttribute("data-hover");
      svg()?.removeAttribute("data-quiet");
    };
    const press = () => afterRender(() => {
      const icon = svg();
      if (!icon) return;
      icon.setAttribute("data-quiet", "");
      if (icon.hasAttribute("data-switch")) {
        if (!controlled) toggleSwitch(icon);
        return;
      }
      const clip = icon.getAttribute("data-click");
      if (clip) playPress(icon, clip);
    });
    host.addEventListener("pointerenter", enter);
    host.addEventListener("pointerleave", leave);
    host.addEventListener("click", press);
    return () => {
      host.removeEventListener("pointerenter", enter);
      host.removeEventListener("pointerleave", leave);
      host.removeEventListener("click", press);
    };
  }, [box, controlled, showsMode, markup]);
}

/** A held switch follows `on`; an icon that starts off does not play its way back on the first render. */
function useHeldState(box: React.RefObject<HTMLSpanElement | null>, isSwitch: boolean, on: boolean | undefined, markup: string | undefined) {
  const touched = useRef(false);
  useEffect(() => {
    const svg = box.current?.querySelector("svg");
    if (!svg || !isSwitch || on === undefined) return;
    if (!touched.current && !on) return;
    touched.current = true;
    svg.setAttribute("data-state", on ? "on" : "off");
  }, [box, isSwitch, on, markup]);
}

export function NetsuIcon({ name, mode, busy = false, on, className }: NetsuIconProps) {
  const box = useRef<HTMLSpanElement>(null);
  const entry = iconEntry(name, mode);
  const markup = entry && (busy && entry.busy ? entry.busy : entry.rest);
  useControl(box, on !== undefined, entry?.of !== undefined, markup);
  useHeldState(box, entry?.switch === true, on, markup);

  if (!markup) return null;
  return (
    <span
      ref={box}
      aria-hidden
      className={cn("inline-flex size-4 shrink-0 [&>svg]:size-full", className)}
      // The markup comes from NetsuIcon's core, which escapes every attribute it writes.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
