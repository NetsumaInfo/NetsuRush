// Rich Presence Discord (Paramètres › Compte) : ce que les amis voient sur le profil pendant qu'on
// travaille. Les réglages vivent CÔTÉ CORE (NR_HOME/discord-rpc.json) — d'où l'état lu au montage
// plutôt que dans le store : le core est déjà la seule source de vérité, le dupliquer en localStorage
// ouvrirait la porte à deux copies divergentes.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { nr, type DiscordActivity, type DiscordPrefs, type DiscordState } from "@/lib/bridge";
import { BrandIcon } from "@/components/BrandIcon";
import { Toggle } from "@/components/ui/toggle";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const TOGGLE_CLASS = "shrink-0 aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary";

/** « 07:12 » / « 1:02:33 » — le format du chrono de Discord. */
function formatElapsed(startSec: number, nowSec: number) {
  const s = Math.max(0, nowSec - startSec);
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const rest = `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return h > 0 ? `${h}:${rest}` : rest;
}

/**
 * Cliquable quand l'activité porte une url pour cet élément, inerte sinon. L'aperçu se comporte
 * donc comme la vraie carte : on peut vérifier où mène un clic sans quitter les Paramètres.
 */
function Linked({ url, className, children }: {
  url?: string;
  className?: string;
  children: ReactNode;
}) {
  if (!url) return <div className={className}>{children}</div>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(className, "cursor-pointer text-left hover:text-foreground hover:underline")}
            onClick={() => void nr.openExternal(url)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{url}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Aperçu de la carte d'activité telle qu'elle apparaît sur un profil Discord. Le contenu vient du
 * core (`state.preview` = le rendu réel de buildActivity) : ici on ne fait que le mettre en forme.
 * Les lignes omises par le core (< 2 caractères) disparaissent donc aussi de l'aperçu — c'est le but.
 */
function PresenceCard({ activity, app, dim }: {
  activity: DiscordActivity;
  app: DiscordState["app"];
  dim: boolean;
}) {
  const { t } = useTranslation("settings");
  const start = activity.timestamps?.start;
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [imgBroken, setImgBroken] = useState(false);

  useEffect(() => {
    if (!start) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [start]);
  useEffect(() => setImgBroken(false), [app?.imageUrl]);

  const showImg = !!app?.imageUrl && !imgBroken;

  return (
    <div className={cn("rounded-lg border border-border bg-muted/40 p-4 transition-opacity", dim && "opacity-50")}>
      <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("discord.preview.heading")}
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Linked url={activity.assets?.large_url} className="shrink-0">
          {showImg ? (
            // La vignette RÉELLE : l'asset `nr_logo` s'il est publié, sinon l'icône de l'app — c'est le
            // repli que Discord fait lui-même. L'icône locale sert si le CDN ne répond pas.
            <img
              src={app.imageUrl ?? ""} alt="" referrerPolicy="no-referrer" onError={() => setImgBroken(true)}
              className="size-[3.25rem] shrink-0 rounded-lg object-cover"
            />
          ) : (
            <BrandIcon className="size-[3.25rem]" />
          )}
        </Linked>
        <div className="min-w-0 leading-tight">
          {/* Le nom vient du portail dev (« Netsubot »…), pas de notre marque : c'est celui-là que voient tes amis. */}
          <p className="truncate text-sm font-semibold">{app?.name || "NetsuRush"}</p>
          {activity.details && (
            <Linked url={activity.details_url} className="block max-w-full truncate text-xs text-muted-foreground">
              {activity.details}
            </Linked>
          )}
          {activity.state && <p className="truncate text-xs text-muted-foreground">{activity.state}</p>}
          {start && (
            <p className="text-xs tabular-nums text-muted-foreground">
              {t("discord.preview.elapsed", { time: formatElapsed(start, now) })}
            </p>
          )}
        </div>
      </div>
      {!activity.details && !activity.state && !start && (
        <p className="mt-3 text-xs text-muted-foreground">{t("discord.preview.empty")}</p>
      )}
    </div>
  );
}

/**
 * Rangée d'un groupe. `hint` est RARE et volontaire : un libellé clair se suffit, une aide qui le
 * paraphrase n'est que du bruit. On ne la sert que pour dire ce que l'écran ne montre pas.
 */
function Row({ title, hint, children }: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <span className="block text-[0.8125rem]">{title}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function DiscordSettings() {
  const { t } = useTranslation("settings");
  const [state, setState] = useState<DiscordState | null>(null);

  useEffect(() => {
    let alive = true;
    void nr.discordState?.().then((s) => { if (alive) setState(s); }).catch(() => {});
    // Le core signale les connexions/déconnexions au client Discord (lancé ou fermé pendant la session).
    const off = nr.onDiscordChanged?.((s) => setState(s));
    return () => { alive = false; off?.(); };
  }, []);

  const patch = useCallback((p: Partial<DiscordPrefs>) => {
    setState((s) => (s ? { ...s, ...p, prefs: { ...s.prefs, ...p } } : s)); // optimiste : le toggle ne doit pas attendre l'IPC
    void nr.discordSetPrefs?.(p).then((s) => setState(s)).catch(() => {});
  }, []);

  if (!state) return null;
  const { prefs } = state;
  const off = !prefs.enabled;

  const status = !state.appId
    ? t("discord.status.noAppId")
    : !prefs.enabled
      ? t("discord.status.disabled")
      : state.connected
        ? t("discord.status.connected", { user: state.user?.global_name || state.user?.username || "" })
        : t("discord.status.searching");

  return (
    <section className="mt-8 flex flex-col gap-4">
      {/* Le toggle maître vit sur la ligne du titre : c'est l'interrupteur de la section, pas un réglage
          parmi d'autres. Sous le titre, le STATUT — la seule chose ici que l'écran ne montre pas. */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">{t("discord.title")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{status}</p>
        </div>
        <Toggle
          size="sm" variant="outline" pressed={prefs.enabled} onPressedChange={(v) => patch({ enabled: v })}
          disabled={!state.appId} className={TOGGLE_CLASS}
        >
          {prefs.enabled ? t("discord.on") : t("discord.off")}
        </Toggle>
      </div>

      {state.preview && <PresenceCard activity={state.preview} app={state.app} dim={off} />}

      {/* Un seul cadre pour les trois lignes : elles règlent la MÊME chose (ce que la carte affiche).
          Quatre cartes séparées faisaient passer une famille pour quatre sujets. */}
      <div className={cn("divide-y divide-border rounded-lg border border-border transition-opacity", off && "opacity-50")}>
        <Row title={t("discord.showModule")}>
          <Toggle
            size="sm" variant="outline" pressed={prefs.showModule} onPressedChange={(v) => patch({ showModule: v })}
            disabled={off} className={TOGGLE_CLASS}
          >
            {prefs.showModule ? t("discord.on") : t("discord.off")}
          </Toggle>
        </Row>

        {/* Seule aide conservée : le risque de fuite d'un nom de client ne se déduit d'aucun libellé. */}
        <Row title={t("discord.showProject")} hint={t("discord.showProjectHint")}>
          <Toggle
            size="sm" variant="outline" pressed={prefs.showProject} onPressedChange={(v) => patch({ showProject: v })}
            disabled={off} className={TOGGLE_CLASS}
          >
            {prefs.showProject ? t("discord.on") : t("discord.off")}
          </Toggle>
        </Row>

        <Row title={t("discord.showElapsed")}>
          <Toggle
            size="sm" variant="outline" pressed={prefs.showElapsed} onPressedChange={(v) => patch({ showElapsed: v })}
            disabled={off} className={TOGGLE_CLASS}
          >
            {prefs.showElapsed ? t("discord.on") : t("discord.off")}
          </Toggle>
        </Row>

        {/* Les liens sont le SEUL moyen d'envoyer quelqu'un quelque part depuis une présence :
            les boutons de profil, eux, ne s'affichent jamais à leur propriétaire. */}
        <Row title={t("discord.showLinks")} hint={t("discord.showLinksHint")}>
          <Toggle
            size="sm" variant="outline" pressed={prefs.showLinks} onPressedChange={(v) => patch({ showLinks: v })}
            disabled={off} className={TOGGLE_CLASS}
          >
            {prefs.showLinks ? t("discord.on") : t("discord.off")}
          </Toggle>
        </Row>

        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center gap-1.5">
            <span className="text-[0.8125rem]">{t("discord.custom")}</span>
            <Tooltip>
              <TooltipTrigger
                render={<button type="button" className="text-muted-foreground transition-colors hover:text-foreground" aria-label={t("discord.customHelp")} />}
              >
                <Info className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>{t("discord.customHelp")}</TooltipContent>
            </Tooltip>
          </div>
          <Input
            value={prefs.detailsTpl} onChange={(e) => patch({ detailsTpl: e.target.value })}
            placeholder={t("discord.details")} disabled={off} aria-label={t("discord.details")}
          />
          <Input
            value={prefs.stateTpl} onChange={(e) => patch({ stateTpl: e.target.value })}
            placeholder={t("discord.state")} disabled={off} aria-label={t("discord.state")}
          />
        </div>
      </div>
    </section>
  );
}
