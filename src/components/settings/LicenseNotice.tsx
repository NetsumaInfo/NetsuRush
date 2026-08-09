import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { nr } from "@/lib/bridge";

const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";
const SOURCE_URL = "https://github.com/NetsumaInfo/NetsuRush";

function openExternal(event: MouseEvent<HTMLAnchorElement>, url: string) {
  event.preventDefault();
  void nr.openExternal(url);
}

/** Avis légal visible dans l'interface interactive, conformément à l'AGPLv3. */
export function LicenseNotice() {
  const { t } = useTranslation("settings");
  return (
    <footer className="border-t border-border pt-4 text-[11px] leading-relaxed text-muted-foreground">
      <p>{t("about.legal")}</p>
      <p>
        <a href={LICENSE_URL} onClick={(event) => openExternal(event, LICENSE_URL)} className="underline underline-offset-2 hover:text-foreground">
          {t("about.licenseLink")}
        </a>
        {" · "}
        <a href={SOURCE_URL} onClick={(event) => openExternal(event, SOURCE_URL)} className="underline underline-offset-2 hover:text-foreground">
          {t("about.sourceLink")}
        </a>
      </p>
    </footer>
  );
}
