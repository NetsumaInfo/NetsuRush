// Submenu parts for the text context menu. The dropdown-menu wrapper has no submenu; these mirror
// the submenu styles of ui/context-menu on the same Base UI Menu primitive.

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { cn } from "@/lib/utils";

export function TextMenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot {...props} />;
}

export function TextMenuSubTrigger({ className, children, ...props }: MenuPrimitive.SubmenuTrigger.Props) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <NetsuIcon name="chevron-toggle" on={false} className="ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

export function TextMenuSubContent({ className, ...props }: MenuPrimitive.Popup.Props) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner collisionPadding={8} className="isolate z-50 outline-none" side="right" align="start" sideOffset={2}>
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-sub-content"
          className={cn(
            "z-50 max-h-(--available-height) min-w-40 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-md bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-98 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-98",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

// Right-aligned shortcut hint of a menu entry.
export function MenuHint({ children }: { children: string }) {
  return <span className="ml-auto pl-4 text-xs tracking-wide text-muted-foreground">{children}</span>;
}
