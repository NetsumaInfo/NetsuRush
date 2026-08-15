// « À propos » : identité de l'app, liens communautaires, mentions légales. Volontairement pauvre en
// texte — un panneau qu'on ouvre pour une version, un serveur ou une licence, jamais pour lire.
import type { MouseEvent } from "react";
import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BetaBadge } from "@/components/BetaBadge";
import { BrandIcon } from "@/components/BrandIcon";
import { DiscordIcon } from "@/components/DiscordIcon";
import { nr } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/release";
import { BUY_ME_A_COFFEE, DISCORD_INVITE, GITHUB_SPONSORS } from "@/lib/community";
import { BuyMeACoffeeIcon, GithubIcon } from "@/components/SponsorIcons";
import { LicenseNotice } from "./LicenseNotice";

interface ExternalLink {
  /** Clé de traduction de la ligne, sous `about.<group>`. */
  id: string;
  url: string;
  label: string;
  /** Couleur de marque du service — la seule couleur non fonctionnelle tolérée ici. */
  tint: string;
  icon: typeof DiscordIcon;
}

const SOCIALS: ExternalLink[] = [
  { id: "discord", url: DISCORD_INVITE, label: "Discord", tint: "text-[#5865F2]", icon: DiscordIcon },
];

// Le noir de GitHub disparaîtrait sur un thème sombre : on prend la couleur du texte à la place.
const SUPPORTS: ExternalLink[] = [
  { id: "github", url: GITHUB_SPONSORS, label: "GitHub Sponsors", tint: "text-foreground", icon: GithubIcon },
  { id: "coffee", url: BUY_ME_A_COFFEE, label: "Buy Me a Coffee", tint: "text-[#FFDD00]", icon: BuyMeACoffeeIcon },
];

function LinkRow({ link, group }: { link: ExternalLink; group: string }) {
  const { t } = useTranslation("settings");
  const Icon = link.icon;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void nr.openExternal(link.url);
  };

  return (
    <a
      href={link.url}
      onClick={open}
      className="group flex items-center gap-3 rounded-lg border border-border bg-card/60 px-3.5 py-3 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className={cn("size-5", link.tint)} />
      <span className="text-sm font-medium">{link.label}</span>
      <span className="ml-auto truncate text-xs text-muted-foreground">{t(`about.${group}.${link.id}`)}</span>
      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0 motion-reduce:group-hover:translate-y-0" />
    </a>
  );
}

export function AboutSettings() {
  const { t } = useTranslation("settings");

  return (
    <section className="flex flex-col gap-8">
      <header className="flex items-center gap-4">
        <BrandIcon className="size-16" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">NetsuRush</h2>
            <BetaBadge />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">v{APP_VERSION}</p>
        </div>
      </header>

      <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{t("about.tagline")}</p>

      <div className="flex flex-col gap-2.5">
        <h3 className="text-sm font-medium">{t("about.socialTitle")}</h3>
        {SOCIALS.map((link) => (
          <LinkRow key={link.id} link={link} group="social" />
        ))}
      </div>

      <div className="flex flex-col gap-2.5">
        <h3 className="text-sm font-medium">{t("about.supportTitle")}</h3>
        {SUPPORTS.map((link) => (
          <LinkRow key={link.id} link={link} group="support" />
        ))}
      </div>

      <LicenseNotice />
    </section>
  );
}
