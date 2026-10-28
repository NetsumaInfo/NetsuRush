import { cn } from "@/lib/utils"
import { useTranslation } from "react-i18next"
import { NetsuIcon } from "./netsu-icon"

function Spinner({ className }: { className?: string }) {
  const { t } = useTranslation("common")
  return (
    <span data-slot="spinner" role="status" aria-label={t("status.loading")} className="inline-flex shrink-0">
      <NetsuIcon name="loading" busy className={cn("size-4", className)} />
    </span>
  )
}

export { Spinner }
