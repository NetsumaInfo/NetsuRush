"use client"

import { Toast as ToastPrimitive } from "@base-ui/react/toast"
import { CheckIcon, CircleAlertIcon, InfoIcon, XIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"

// Gestionnaire GLOBAL, hors React : les messages naissent dans des hooks et des callbacks asynchrones
// (fin d'un encode, retour d'un export) qui n'ont pas de contexte sous la main.
const manager = ToastPrimitive.createToastManager()

type Tone = "ok" | "error" | "info"

// Un retour de fin de tâche se lit en passant : 4 s suffisent. Une erreur demande d'agir, elle reste
// deux fois plus longtemps et s'annonce en priorité haute aux lecteurs d'écran.
const TIMEOUT: Record<Tone, number> = { ok: 4000, info: 4000, error: 8000 }

function push(tone: Tone, text: string) {
  return manager.add({ title: text, type: tone, timeout: TIMEOUT[tone], priority: tone === "error" ? "high" : "low" })
}

export const toast = {
  ok: (text: string) => push("ok", text),
  info: (text: string) => push("info", text),
  error: (text: string) => push("error", text),
  close: (id?: string) => manager.close(id),
}

const ICON: Record<Tone, typeof CheckIcon> = { ok: CheckIcon, error: CircleAlertIcon, info: InfoIcon }
const TONE_CLASS: Record<Tone, string> = {
  ok: "text-[var(--color-ok)]",
  error: "text-destructive",
  info: "text-primary",
}

/**
 * Pile de pastilles d'état. Ne se positionne PAS elle-même : elle se monte dans la colonne flottante
 * du coin bas-droit, au-dessus de l'indicateur d'erreur (cf. `App` et `RemotePanel`).
 */
export function Toaster() {
  return (
    <ToastPrimitive.Provider toastManager={manager} limit={3}>
      <ToastList />
    </ToastPrimitive.Provider>
  )
}

function ToastList() {
  const { t } = useTranslation("common")
  const { toasts } = ToastPrimitive.useToastManager()

  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className="pointer-events-none flex w-[min(22rem,calc(100vw-2rem))] flex-col items-end gap-2"
    >
      {toasts.map((item) => {
        const tone: Tone = item.type === "error" || item.type === "info" ? item.type : "ok"
        const Icon = ICON[tone]
        return (
          <ToastPrimitive.Root
            key={item.id}
            toast={item}
            data-slot="toast"
            // Le glissé suit le doigt via les variables de Base UI ; `translate` reste libre pour
            // l'entrée et la sortie, que Tailwind anime sur la propriété `translate` (et non `transform`).
            style={{ transform: "translate(var(--toast-swipe-movement-x, 0px), var(--toast-swipe-movement-y, 0px))" }}
            className={cn(
              "pointer-events-auto flex max-w-full origin-right items-start gap-2 rounded-2xl border border-border bg-card py-1.5 pl-3 pr-1.5 text-xs shadow-lg shadow-black/30",
              "transition-all duration-200 ease-out",
              "data-starting-style:translate-x-6 data-starting-style:opacity-0",
              "data-ending-style:translate-x-6 data-ending-style:scale-95 data-ending-style:opacity-0",
              "data-limited:opacity-0 data-swiping:transition-none",
              "motion-reduce:transition-none",
            )}
          >
            <Icon className={cn("mt-0.5 size-3.5 shrink-0", TONE_CLASS[tone])} />
            <ToastPrimitive.Title className="min-w-0 flex-1 break-words py-0.5 leading-snug text-foreground" />
            <ToastPrimitive.Close
              aria-label={t("action.close")}
              className="mt-px shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <XIcon className="size-3" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        )
      })}
    </ToastPrimitive.Viewport>
  )
}
