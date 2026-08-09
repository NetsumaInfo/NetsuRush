// @ts-check
// Envoi d'un rapport de bug vers un webhook Discord (configuré HORS dépôt : env NR_BUG_WEBHOOK ou
// champ `bugWebhook` de nr.config.json). POST côté core (pas de CORS, l'URL ne fuite pas dans le
// bundle renderer). Le rapport est un EMBED trié : ce que le testeur a écrit d'un côté, ce que la
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

function maxAttachmentMB() {
  const configured = Number(CONFIG.bugAttachmentMaxMB);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_ATTACHMENT_MB;
}

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

// Discord : message multipart (payload_json + fichiers).
async function submitBugReport(request) {
  const url = webhookUrl();
  if (!url) return { ok: false, message: t('webhookMissing') };

  const r = request || {};
  const reportId = 'NR-' + Date.now().toString(36).toUpperCase();
  try {
    // Le contexte est recollecté ICI et non repris de la requête : un renderer ne doit pas pouvoir
    // décrire une machine qui n'est pas la sienne, et le formulaire peut être resté ouvert des heures.
    const ctx = await collectBugContext();
    const form = new G.FormData();
    form.append('payload_json', JSON.stringify({
      username: 'NetsuRush',
      content: r.severity === 'blocker' ? `**${reportId}** — bloquant` : '',
      embeds: [buildEmbed(r, ctx, reportId)],
      allowed_mentions: { parse: [] }, // un `<@id>` ne doit pinger personne dans le salon
    }));
    attachFiles(form, r, ctx, reportId);

    const resp = await G.fetch(url, { method: 'POST', body: form });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
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
