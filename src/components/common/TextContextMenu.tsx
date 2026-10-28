// App-wide right-click policy, mounted once per window.
//
// The WebView2 native menu is never appropriate here (it offers page reload, "save image as",
// devtools…), so it is suppressed everywhere. Suppressing it alone would leave text fields with no
// menu at all, so this component replaces it with an in-app edit menu:
//
//   - inside a text field (input, textarea, contenteditable) → Cut / Copy / Paste / Paste as plain
//     text (rich fields) / Select all, greyed when they cannot apply;
//   - a surface can append its own entries (notebook: formatting, block actions) through
//     textMenuExtension; a read-only one gets Copy / Select all;
//   - on a plain text selection outside any field → Copy;
//   - on a surface that carries its own <ContextMenu> (view background, cards, error badge) → that menu
//     wins, this one stays out of the way. The decision lives in textMenuPolicy.
//
// The capture-phase listener runs before every React handler, so a right-click inside a field being
// edited under a surface menu opens the edit menu instead of that menu.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { netsuIconOf, type IconComponent } from "@/components/NetsuIconOf";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { MenuHint } from "./TextMenuSub";
import { findTextMenuExtension, type TextMenuExtension } from "./textMenuExtension";
import {
  TEXT_INPUT_TYPES, TEXT_SHORTCUTS, resolveMenu, textMenuPlan, type TextAction, type TextTarget,
} from "./textMenuPolicy";

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

function editableFrom(target: EventTarget | null): Field | null {
  if (!(target instanceof HTMLElement)) return null;
  // A contenteditable="false" island inside a rich editor resolves to the editor around it.
  const el = target.closest<HTMLElement>('input, textarea, [contenteditable]:not([contenteditable="false"])');
  if (!el) return null;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type) ? el : null;
  if (el instanceof HTMLTextAreaElement) return el;
  return el.isContentEditable ? el : null;
}

const isTextField = (el: Field | null): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

type Ctx = {
  x: number;
  y: number;
  el: Field | null;            // null → selection-only menu (Copy)
  container: HTMLElement | null; // dialog content when the click happened inside one
  ext: TextMenuExtension | null; // surface that appends its own entries
  readOnly: boolean;
  secret: boolean;             // password field: its content is never exposed through the menu
  empty: boolean;
  selection: string;
  range: { start: number; end: number } | null;
  domRange: Range | null;
};

// The menu takes focus while open; the field must get its caret back before any clipboard command.
function restore(c: Ctx) {
  const el = c.el;
  if (!el) return;
  el.focus({ preventScroll: true });
  if (isTextField(el) && c.range) el.setSelectionRange(c.range.start, c.range.end);
  else if (c.domRange) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(c.domRange);
  }
}

// React tracks the last value it wrote to a field; assigning `.value` directly would make the
// synthetic change event look like a no-op. The native setter clears that tracker.
function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function copyText(c: Ctx) {
  if (c.el) {
    restore(c);
    if (document.execCommand("copy")) return;
  }
  void navigator.clipboard?.writeText(c.selection);
}

function cutText(c: Ctx) {
  restore(c);
  if (document.execCommand("cut")) return;
  void navigator.clipboard?.writeText(c.selection);
  insertText(c, "");
}

// Clipboard content for a paste. `read()` carries the rich flavours; `readText()` is the fallback.
// Null = the clipboard cannot be read from here.
async function readClipboard(): Promise<{ text: string; html: string; files: File[] } | null> {
  try {
    let text = "";
    let html = "";
    const files: File[] = [];
    for (const item of await navigator.clipboard.read()) {
      if (item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
      if (item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
      const img = item.types.find((ty) => ty.startsWith("image/"));
      if (img) files.push(new File([await item.getType(img)], `image.${img.split("/")[1] || "png"}`, { type: img }));
    }
    if (text || html || files.length) return { text, html, files };
  } catch { /* fall through to the text-only read */ }
  try {
    return { text: await navigator.clipboard.readText(), html: "", files: [] };
  } catch {
    return null;
  }
}

// Paste. A plain field takes the text through `insertText` (keeps its undo stack). A rich field gets
// a paste event carrying the clipboard, so its own handler (ProseMirror, BlockNote) runs exactly as
// for Ctrl+V; only when nothing handled it does the text go in directly.
async function pasteInto(c: Ctx, plainOnly: boolean) {
  const clip = await readClipboard();
  if (!clip) { toast.info(TEXT_SHORTCUTS.paste); return; }
  if (!clip.text && !clip.html && !clip.files.length) return;
  restore(c);
  const el = c.el;
  if (!el) return;
  if (isTextField(el)) { if (clip.text) insertText(c, clip.text); return; }
  const dt = new DataTransfer();
  if (clip.text) dt.setData("text/plain", clip.text);
  if (!plainOnly) {
    if (clip.html) dt.setData("text/html", clip.html);
    for (const f of clip.files) dt.items.add(f);
  }
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  if (!ev.defaultPrevented && clip.text) insertText(c, clip.text);
}

function insertText(c: Ctx, text: string) {
  restore(c);
  // `insertText` keeps the field's own undo stack and fires a proper input event.
  if (document.execCommand("insertText", false, text)) return;
  const el = c.el;
  if (!isTextField(el)) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  setFieldValue(el, el.value.slice(0, start) + text + el.value.slice(end));
  el.setSelectionRange(start + text.length, start + text.length);
}

function selectAll(c: Ctx) {
  if (!c.el) { c.ext?.selectAll?.(); return; }
  restore(c);
  if (isTextField(c.el)) c.el.select();
  else document.execCommand("selectAll");
}

const ICONS: Record<TextAction, IconComponent> = {
  cut: netsuIconOf("scissors"), copy: netsuIconOf("copy"), paste: netsuIconOf("paste"),
  pastePlain: netsuIconOf("paste-plain"), selectAll: netsuIconOf("text-select"),
};
const LABELS: Record<TextAction, string> = {
  cut: "action.cut", copy: "action.copy", paste: "action.paste", pastePlain: "action.pastePlain", selectAll: "action.selectAll",
};

function run(action: TextAction, c: Ctx) {
  if (action === "cut") cutText(c);
  else if (action === "copy") copyText(c);
  else if (action === "paste") void pasteInto(c, false);
  else if (action === "pastePlain") void pasteInto(c, true);
  else selectAll(c);
}

export function TextContextMenu() {
  const { t } = useTranslation("common");
  const [ctx, setCtx] = useState<Ctx | null>(null);
  // Focus goes back to the field the menu was opened from, not to the document body.
  const fieldRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onCapture = (e: MouseEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const el = editableFrom(target);
      const ext = findTextMenuExtension(target);
      // The surface answers this click itself (spelling panel on a misspelled word).
      if (ext?.claims?.(e)) return;
      // A surface may move the caret under the pointer first, so the selection read below is the
      // one the menu acts on.
      if (ext && !ext.readOnly) ext.prepare?.(e);
      const sel = window.getSelection();
      const selection = sel?.toString() ?? "";

      const owner = resolveMenu({
        editable: !!el,
        inOwnMenu: !!target?.closest('[data-slot="context-menu-trigger"]'),
        extension: !!ext,
        selectionHere: !!selection.trim() && !!sel?.anchorNode && !!target?.contains(sel.anchorNode),
      });
      // "own": that surface's menu opens. "none": nothing to offer; the native menu is still
      // suppressed by the bubble listener below.
      if (owner === "own" || owner === "none") return;

      const input = isTextField(el) ? el : null;
      const readOnly = !!input && (input.readOnly || input.disabled);
      e.preventDefault();
      e.stopPropagation();
      fieldRef.current = el;
      setCtx({
        x: e.clientX,
        y: e.clientY,
        el,
        ext,
        container: target?.closest<HTMLElement>('[data-slot="dialog-content"], [role="dialog"], [role="alertdialog"]') ?? null,
        readOnly,
        secret: input?.type === "password",
        empty: input ? input.value === "" : !(el ?? ext?.root)?.textContent,
        selection: input ? input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0) : selection,
        range: input ? { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 } : null,
        domRange: !input && sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null,
      });
    };
    // Bubble phase, after every in-app menu has had the event: the native menu never shows.
    const suppressNative = (e: MouseEvent) => e.preventDefault();

    document.addEventListener("contextmenu", onCapture, true);
    document.addEventListener("contextmenu", suppressNative);
    return () => {
      document.removeEventListener("contextmenu", onCapture, true);
      document.removeEventListener("contextmenu", suppressNative);
    };
  }, []);

  const anchor = useMemo(
    () => (ctx ? { getBoundingClientRect: () => new DOMRect(ctx.x, ctx.y, 0, 0) } : undefined),
    [ctx],
  );

  if (!ctx) return null;

  const target: TextTarget = {
    field: !ctx.el ? "none" : isTextField(ctx.el) ? "input" : "editable",
    readOnly: ctx.readOnly,
    secret: ctx.secret,
    empty: ctx.empty,
    hasSelection: !!ctx.selection,
    canPaste: typeof navigator.clipboard?.readText === "function",
    selectable: !!ctx.ext?.selectAll,
  };
  const plan = textMenuPlan(target);
  // Block-level entries of the surface: only where the text can be edited.
  const extra = ctx.ext && !ctx.ext.readOnly && ctx.el && !ctx.readOnly ? ctx.ext.render() : null;

  return (
    <DropdownMenu open onOpenChange={(open) => { if (!open) setCtx(null); }} modal={false}>
      <DropdownMenuContent
        anchor={anchor}
        container={ctx.container ?? undefined}
        sideOffset={0}
        finalFocus={fieldRef}
        className="min-w-48"
      >
        {plan.map(({ action, disabled }) => {
          const Icon = ICONS[action];
          return (
            <Fragment key={action}>
              {action === "selectAll" && <DropdownMenuSeparator />}
              <DropdownMenuItem disabled={disabled} onClick={() => run(action, ctx)}>
                <Icon /> {t(LABELS[action])}
                <MenuHint>{TEXT_SHORTCUTS[action]}</MenuHint>
              </DropdownMenuItem>
            </Fragment>
          );
        })}
        {extra && (
          <>
            <DropdownMenuSeparator />
            {extra}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
