// @ts-check
// Envoi d'un rapport de bug vers Discord. DEUX voies, dans cet ordre :
//   1. relais Convex — l'app ne connaît pas le webhook, elle POSTe sur `<site>.convex.site/bug/report`
//      et le déploiement (env `BUG_WEBHOOK`) forwarde. Rotation de l'URL sans rebuild ni fichier à
//      changer chez les testeurs, et un webhook qui ne descend sur aucune machine ne peut pas fuiter.
//   2. webhook direct (env NR_BUG_WEBHOOK ou `bugWebhook` de nr.config.json) — voie de développement,
//      prioritaire quand elle est renseignée, seule voie possible sans déploiement Convex.
// POST côté core (pas de CORS, l'URL ne fuite pas dans le bundle renderer). Le rapport est un EMBED trié : ce que le testeur a écrit d'un côté, ce que la
// machine sait de l'autre (instantané système collecté ici, jamais saisi à la main), plus le journal
// et les captures en pièces jointes. Pour le debug et les bêta-testeurs : « signaler » en un clic
// depuis Paramètres › Système › Console.

const { CONFIG } = require('./config');
const { t } = require('./i18n');
const { collectBugContext, formatBugContext } = require('./bugContext');

// Globals Node 18+ (fetch / FormData / Blob) lus via globalThis pour rester propres au check:core.
const G = /** @type {any} */ (globalThis);

// Plafonds Discord (dépassement = 400, rapport perdu) : on coupe AVANT d'envoyer.
const MAX_DESCRIPTION = 3800;
const MAX_FIELD = 1000;
const MAX_FIELDS = 25;
// 10 pièces jointes par message, dont 2 nous appartiennent déjà (journal + instantané machine).
const MAX_ATTACHMENTS = 8;
// Taille par fichier : 10 Mo sur un serveur non boosté, 50 (niveau 2) ou 100 (niveau 3) sinon — la
// limite suit le serveur du WEBHOOK, que l'application ne peut pas interroger. D'où le réglage
// `bugAttachmentMaxMB` dans nr.config.json pour un salon boosté.
const DEFAULT_MAX_ATTACHMENT_MB = 10;

// Couleur de l'embed par sévérité : un bloquant doit se repérer dans le salon sans lire le texte.
const SEVERITY_COLOR = { blocker: 0xe5484d, major: 0xf5a524, minor: 0x3b82f6, idea: 0x7c3aed };
const DEFAULT_COLOR = 0x5865f2;

function webhookUrl() {
  return process.env.NR_BUG_WEBHOOK || CONFIG.bugWebhook || '';
}

// Le site du relais vient du renderer (seul à porter `VITE_CONVEX_SITE_URL`, baké au build). Il est
// donc VÉRIFIÉ ici : sans ce filtre, un renderer détourné pourrait faire poster les rapports —
// journal et captures compris — sur l'hôte de son choix.
const CONVEX_SITE = /^https:\/\/[a-z0-9-]+\.convex\.site$/;

/** @param {any} relay @returns {string} */
function relayUrl(relay) {
  const site = String((relay && relay.site) || '').replace(/\/+$/, '');
  return CONVEX_SITE.test(site) ? `${site}/bug/report` : '';
}

// Une httpAction Convex plafonne la requête à 20 Mo là où Discord accepte 8 pièces de 10 Mo : sur la
// voie relais on coupe AVANT d'envoyer, sinon le rapport est refusé en bloc et le testeur le perd.
const RELAY_MAX_BYTES = 18 * 1024 * 1024;

/** @param {any} r @returns {{ attachments: any[], dropped: number }} */
function fitAttachments(r) {
  const attachments = Array.isArray(r.attachments) ? r.attachments : [];
  const kept = [];
  let total = String(r.consoleLogs || '').length;
  for (const a of attachments) {
    const size = Math.ceil(String(a.dataBase64 || '').length * 0.75);
    if (total + size > RELAY_MAX_BYTES) continue;
    total += size;
    kept.push(a);
  }
  return { attachments: kept, dropped: attachments.length - kept.length };
}

function maxAttachmentMB() {
  const configured = Number(CONFIG.bugAttachmentMaxMB);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_ATTACHMENT_MB;
}

// `configured` ne juge que la voie DIRECTE : le relais dépend d'une valeur que seul le renderer
// connaît, c'est donc lui qui complète l'état (il sait s'il a un déploiement Convex).
function status() {
  return { ok: true, configured: !!webhookUrl(), maxAttachments: MAX_ATTACHMENTS, maxAttachmentMB: maxAttachmentMB() };
}

/** @param {unknown} value @param {number} max */
function clip(value, max) {
  const s = String(value == null ? '' : value).trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Champ d'embed, ignoré si vide (Discord refuse une `value` vide).
 * @param {any[]} fields @param {string} name @param {unknown} value @param {boolean} [inline] */
function addField(fields, name, value, inline = true) {
  const v = clip(value, MAX_FIELD);
  if (!v || fields.length >= MAX_FIELDS) return;
  fields.push({ name, value: v, inline });
}

/** Identité du testeur : le compte Discord connecté prime, la saisie libre sert de repli. @param {any} r */
function reporterLine(r) {
  const c = r.contact || {};
  if (c.discordId) return `<@${c.discordId}>${c.discordName ? ` (${c.discordName})` : ''}`;
  return c.discordName || c.text || '';
}

/** Résumé du journal : le nombre d'erreurs dit d'emblée si le fichier joint vaut la lecture. @param {any} r */
function logLine(r) {
  const parts = [`${r.consoleLogCount || 0} entrées`];
  if (r.errorCount) parts.push(`${r.errorCount} erreurs`);
  if (r.warnCount) parts.push(`${r.warnCount} avertissements`);
  if (r.redactionApplied) parts.push('chemins masqués');
  return parts.join(' · ');
}

/** @param {any} r @param {any} ctx @param {string} reportId */
function buildEmbed(r, ctx, reportId) {
  const fields = [];
  addField(fields, 'Sévérité', r.severityLabel || r.severity);
  addField(fields, 'Fréquence', r.frequencyLabel || r.frequency);
  addField(fields, 'Module', r.moduleLabel || r.module);
  addField(fields, 'Version', `v${(ctx.app && ctx.app.version) || '?'} · ${r.locale || '?'}`);
  addField(fields, 'Hôte', `${r.activeHost || '?'} · ${r.hostConnected ? 'connecté' : 'hors ligne'}`);
  addField(fields, 'Testeur', reporterLine(r));
  addField(fields, 'Journal', logLine(r));
  addField(fields, 'Source vidéo', r.videoReference);
  // Le service n'a pas pu lire la machine : ce que le testeur en a dit remplace l'instantané.
  addField(fields, 'Machine (saisie)', r.manualSpecs, false);
  addField(fields, 'Reproduction', r.stepsText, false);
  addField(fields, 'Attendu', r.expectedText, false);
  addField(fields, 'Machine', `\`\`\`\n${clip(formatBugContext(ctx), MAX_FIELD - 10)}\n\`\`\``, false);

  // « Autre » ne dit rien dans une liste de rapports : le sujet nommé par le testeur passe en titre.
  const subject = r.categoryDetail ? `${r.categoryLabel || r.category} — ${r.categoryDetail}` : (r.categoryLabel || r.category || 'bug');
  return {
    title: clip(`${reportId} · ${subject}`, 240),
    description: clip(r.issueText, MAX_DESCRIPTION) || '(aucune description)',
    color: SEVERITY_COLOR[r.severity] ?? DEFAULT_COLOR,
    fields,
    footer: { text: clip(`${(ctx.os && ctx.os.label) || '?'} · ${(ctx.gpu && ctx.gpu.label) || '?'}`, 2000) },
    timestamp: new Date().toISOString(),
  };
}

/** Pièces jointes : journal complet + instantané machine + captures. @param {any} form @param {any} r @param {any} ctx @param {string} reportId */
function attachFiles(form, r, ctx, reportId) {
  let index = 0;
  const push = (data, name, type) => {
    form.append(`files[${index++}]`, new G.Blob([data], { type }), name);
  };
  if (r.consoleLogs) push(String(r.consoleLogs), `logs_${reportId}.txt`, 'text/plain');
  // Le texte formaté rend le contexte lisible dans Discord ; le JSON garde les valeurs exploitables.
  push(`${formatBugContext(ctx)}\n\n${JSON.stringify(ctx, null, 2)}`, `machine_${reportId}.txt`, 'text/plain');

  const attachments = Array.isArray(r.attachments) ? r.attachments.slice(0, MAX_ATTACHMENTS) : [];
  attachments.forEach((a, i) => {
    try {
      push(Buffer.from(String(a.dataBase64 || ''), 'base64'), a.name || `piece_${i + 1}`, a.mimeType || 'application/octet-stream');
    } catch (e) {
      console.warn('rapport de bug : pièce jointe ignorée (base64 illisible)', String((e && e.message) || e));
    }
  });
}

// Réponse du relais : un code HTTP nu n'apprend rien au testeur, chacun a sa cause et son geste.
function relayError(code, detail) {
  if (code === 401) return t('reportSignInRequired');
  if (code === 429) return t('reportRateLimited');
  if (code === 503) return t('webhookMissing');
  return `${t('reportSendFailed')} (HTTP ${code}). ${String(detail).slice(0, 200)}`;
}

// Discord : message multipart (payload_json + fichiers). Même corps sur les deux voies — le relais
// Convex le retransmet tel quel, il n'y a donc qu'un seul format de rapport à maintenir.
async function submitBugReport(request) {
  const r = request || {};
  const direct = webhookUrl();
  const relay = direct ? '' : relayUrl(r.relay);
  if (!direct && !relay) return { ok: false, message: t('webhookMissing') };

  const reportId = 'NR-' + Date.now().toString(36).toUpperCase();
  try {
    // Le contexte est recollecté ICI et non repris de la requête : un renderer ne doit pas pouvoir
    // décrire une machine qui n'est pas la sienne, et le formulaire peut être resté ouvert des heures.
    const ctx = await collectBugContext();
    const fitted = relay ? fitAttachments(r) : { attachments: r.attachments, dropped: 0 };
    const payload = { ...r, attachments: fitted.attachments };
    const embed = buildEmbed(payload, ctx, reportId);
    if (fitted.dropped) addField(embed.fields, 'Pièces jointes', `${fitted.dropped} écartée(s) : rapport trop lourd`, false);
    const form = new G.FormData();
    form.append('payload_json', JSON.stringify({
      username: 'NetsuRush',
      content: r.severity === 'blocker' ? `**${reportId}** — bloquant` : '',
      embeds: [embed],
      allowed_mentions: { parse: [] }, // un `<@id>` ne doit pinger personne dans le salon
    }));
    attachFiles(form, payload, ctx, reportId);

    const headers = relay ? {
      // Le corps est un multipart opaque pour le relais : ce qu'il enregistre passe par les en-têtes.
      'x-nr-report-id': reportId,
      'x-nr-severity': String(r.severity || ''),
      'x-nr-category': String(r.category || ''),
      'x-nr-module': String(r.module || ''),
      'x-nr-app-version': String((ctx.app && ctx.app.version) || ''),
      // Session du plugin crossDomain : la webview desktop n'a pas de cookie sur le domaine Convex.
      'Better-Auth-Cookie': String((r.relay && r.relay.cookie) || ''),
    } : undefined;
    const resp = await G.fetch(relay || direct, { method: 'POST', body: form, headers });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      if (relay) return { ok: false, message: relayError(resp.status, txt) };
      return { ok: false, message: `Discord a refusé (HTTP ${resp.status}). ${String(txt).slice(0, 200)}` };
    }
    return { ok: true, message: t('reportSent'), reportId };
  } catch (e) {
    return { ok: false, message: t('reportSendFailed') + ' : ' + String((e && e.message) || e) };
  }
}

// `buildEmbed` est exporté pour le test : un dépassement des plafonds Discord se solde par un 400 et
// le rapport est PERDU (le testeur croit l'avoir envoyé), c'est donc la partie à vérifier hors ligne.
module.exports = { submitBugReport, status, buildEmbed };
