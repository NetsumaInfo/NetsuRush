// Two title bar shortcuts sitting left of the window controls: the public repository, and support.
// They live HERE and not in `WindowControls` because that component is also drawn by the login and
// setup frames (`GateFrame`), where the settings page is not mounted — the support button would
// open nothing.
//
// Support points at Settings ▸ About rather than straight at a donation page: that section already
// holds the two funding links (GitHub Sponsors, Buy Me a Coffee) and lets the reader pick.

import { useTranslation } from "react-i18next";
import { HandHeart } from "lucide-react";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import { GITHUB_REPO } from "@/lib/community";
import { GithubIcon } from "@/components/SponsorIcons";
import { TITLEBAR_BTN } from "@/components/WindowControls";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

export function HeaderLinks() {
  const { t } = useTranslation("shell");
  const openSettings = useApp((s) => s.openSettings);

  return (
    <div className="flex items-center" data-no-drag>
      <Tooltip>
        <TooltipTrigger render={
          <button
            type="button"
            aria-label={t("windowControls.github")}
            className={TITLEBAR_BTN}
            onClick={() => void nr.openExternal(GITHUB_REPO)}
          >
            <GithubIcon />
          </button>
        } />
        <TooltipContent>{t("windowControls.github")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={
          <button
            type="button"
            aria-label={t("windowControls.support")}
            className={TITLEBAR_BTN}
            onClick={() => openSettings("about")}
          >
            <HandHeart />
          </button>
        } />
        <TooltipContent>{t("windowControls.support")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
