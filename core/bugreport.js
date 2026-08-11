// @ts-check
// Envoi d'un rapport de bug vers Discord. DEUX voies, dans cet ordre :
//   1. relais Convex — l'app ne connaît pas le webhook, elle POSTe sur `<site>.convex.site/bug/report`
//      et le déploiement (env `BUG_WEBHOOK`) forwarde. Rotation de l'URL sans rebuild ni fichier à
//      changer chez les testeurs, et un webhook qui ne descend sur aucune machine ne peut pas fuiter.
//   2. webhook direct (env NR_BUG_WEBHOOK ou `bugWebhook` de nr.config.json) — voie de développement,
//      prioritaire quand elle est renseignée, seule voie possible sans déploiement Convex.
// POST côté core (pas de CORS, l'URL ne fuite pas dans le bundle renderer). Le rapport est un
// message à PLUSIEURS embeds, un par nature d'information — le récit du testeur, sa reproduction,
// l'instantané machine (collecté ici, jamais saisi à la main), le journal et les pièces jointes.
// Un seul embed forçait à empiler la machine dans un bloc de code illisible et à couper le récit dès
// qu'un rapport était fourni ; découpé, chaque partie se lit (ou se replie) seule. Pour le debug et
// les bêta-testeurs : « signaler » en un clic depuis Paramètres › Système › Console.

const { CONFIG } = require('./config');
const { t } = require('./i18n');
const { collectBugContext, formatBugContext } = require('./bugContext');

// Globals Node 18+ (fetch / FormData / Blob) lus via globalThis pour rester propres au check:core.
const G = /** @type {any} */ (globalThis);

// Plafonds Discord (dépassement = 400, rapport perdu) : on coupe AVANT d'envoyer. Le plafond qui
// mord vraiment est le GLOBAL : 6000 caractères pour l'ensemble des embeds d'un message, tous
// éléments confondus. Il est donc appliqué à la fin, sur le message monté (`fitEmbeds`).
const MAX_TOTAL = 6000;
const MAX_EMBEDS = 10;
const MAX_TITLE = 256;
// Le récit du testeur pourrait prendre 4096 à lui seul : plafonné plus bas, il laisse de quoi
// afficher la reproduction et la machine, qui sont ce qu'on lit en premier pour reproduire.
const MAX_DESCRIPTION = 2000;
const MAX_FIELD = 1000;
const MAX_FIELDS = 25;
// 10 pièces jointes par message, dont 2 nous appartiennent déjà (journal + instantané machine).
const MAX_ATTACHMENTS = 8;
// Taille par fichier : 10 Mo sur un serveur non boosté, 50 (niveau 2) ou 100 (niveau 3) sinon — la
// limite suit le serveur du WEBHOOK, que l'application ne peut pas interroger. D'où le réglage
// `bugAttachmentMaxMB` dans nr.config.json pour un salon boosté.
const DEFAULT_MAX_ATTACHMENT_MB = 10;

// Couleur de l'embed par sévérité : un bloquant doit se repérer dans le salon sans lire le texte.
// Seul le PREMIER embed la porte ; les suivants sont gris, sinon quatre barres de couleur vive
// annulent le repère qu'on vient de poser.
const SEVERITY_COLOR = { blocker: 0xe5484d, major: 0xf5a524, minor: 0x3b82f6, idea: 0x7c3aed };
const DEFAULT_COLOR = 0x5865f2;
const CONTEXT_COLOR = 0x4e5058;

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
    const size = attachmentBytes(a);
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

/** Valeur d'instantané absente : « non sondé » distingue une sonde muette d'une vraie valeur vide.
 * @param {unknown} value @param {string} [fallback] */
function val(value, fallback = 'non sondé') {
  return value === null || value === undefined || value === '' ? String(fallback) : String(value);
}

/** Mo → Go : personne ne lit « 28357 Mo ». @param {unknown} mb */
function gb(mb) {
  const n = Number(mb);
  return Number.isFinite(n) ? `${Math.round(n / 102.4) / 10} Go` : 'non sondé';
}

/** Octets d'une pièce jointe base64 (4 caractères ⇒ 3 octets). @param {any} a */
function attachmentBytes(a) {
  return Math.ceil(String((a && a.dataBase64) || '').length * 0.75);
}

/** @param {number} bytes */
function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} Mo`;
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

// 1. LE RAPPORT — ce que le testeur signale, et les six repères qui servent à trier dans le salon.
/** @param {any} r @param {any} ctx @param {string} reportId */
function reportEmbed(r, ctx, reportId) {
  const fields = [];
  // Six champs alignés, avec un tiret plutôt qu'un trou : Discord place les champs en ligne par
  // trois, une valeur manquante décalerait toute la grille.
  addField(fields, 'Sévérité', r.severityLabel || r.severity || '—');
  addField(fields, 'Fréquence', r.frequencyLabel || r.frequency || '—');
  addField(fields, 'Module', r.moduleLabel || r.module || '—');
  addField(fields, 'Version', `v${(ctx && ctx.app && ctx.app.version) || '?'} · ${r.locale || '?'}`);
  addField(fields, 'Hôte', `${r.activeHost || '—'} · ${r.hostConnected ? 'connecté' : 'hors ligne'}`);
  addField(fields, 'Testeur', reporterLine(r) || 'anonyme');

  // « Autre » ne dit rien dans une liste de rapports : le sujet nommé par le testeur passe en titre.
  const subject = r.categoryDetail ? `${r.categoryLabel || r.category} — ${r.categoryDetail}` : (r.categoryLabel || r.category || 'bug');
  return {
    title: clip(`${reportId} · ${subject}`, MAX_TITLE),
    description: clip(r.issueText, MAX_DESCRIPTION) || '(aucune description)',
    color: SEVERITY_COLOR[r.severity] ?? DEFAULT_COLOR,
    fields,
    timestamp: new Date().toISOString(),
  };
}

// 2. LA REPRODUCTION — texte long, en pleine largeur, séparé du récit pour rester lisible. Absent du
// message quand le testeur n'a rien rempli, plutôt qu'un embed de titres vides.
/** @param {any} r */
function reproEmbed(r) {
  const fields = [];
  addField(fields, 'Étapes', r.stepsText, false);
  addField(fields, 'Résultat attendu', r.expectedText, false);
  addField(fields, 'Source vidéo', r.videoReference, false);
  // Le service n'a pas pu lire la machine : ce que le testeur en a dit remplace l'instantané.
  addField(fields, 'Machine (saisie du testeur)', r.manualSpecs, false);
  return fields.length ? { title: 'Reproduction', color: CONTEXT_COLOR, fields } : null;
}

// 3. LA MACHINE — un champ par mesure au lieu d'un pavé de code : Discord aligne, replie sur mobile,
// et une valeur se copie seule. Le pavé complet reste en pièce jointe pour la lecture exhaustive.
/** @param {any} ctx */
function machineEmbed(ctx) {
  if (!ctx || !ctx.ok) {
    return { title: 'Machine', color: CONTEXT_COLOR, description: 'Instantané système indisponible.' };
  }
  const fields = [];
  addField(fields, 'OS', `${val(ctx.os && ctx.os.label)} · ${val(ctx.os && ctx.os.arch, '?')}`);
  addField(fields, 'CPU', `${val(ctx.cpu && ctx.cpu.name)}\n${val(ctx.cpu && ctx.cpu.threads, '?')} threads`);
  addField(fields, 'RAM', `${gb(ctx.memory && ctx.memory.totalMB)} total\n${gb(ctx.memory && ctx.memory.freeMB)} libres`);

  const vram = ctx.gpu && ctx.gpu.vram;
  addField(fields, 'GPU', val(ctx.gpu && ctx.gpu.label));
  addField(fields, 'VRAM', vram ? `${gb(vram.freeMB)} libres\nsur ${gb(vram.totalMB)}` : 'non sondée');
  const backends = (ctx.runtime && ctx.runtime.backends) || {};
  addField(fields, 'Backends', `torch ${val(backends.ml, '?')}\nonnx ${val(backends.onnx, '?')}\nasr ${val(backends.transcribe, '?')}`);

  // Les pilotes expliquent à eux seuls une part des plantages GPU : une ligne par carte, en pleine
  // largeur, sinon un nom de carte long casse la grille.
  const devices = (ctx.gpu && ctx.gpu.devices) || [];
  if (devices.length) {
    addField(fields, 'Pilotes', devices.map((d) => `• ${d.name} · pilote ${val(d.driverVersion, '?')} · ${d.vendor}/${d.role}`).join('\n'), false);
  }

  const enc = ctx.encoding;
  addField(fields, 'Encodeurs', enc ? `h264 ${val(enc.h264, 'aucun')} · h265 ${val(enc.h265, 'aucun')} · av1 ${val(enc.av1, 'aucun')}` : 'non sondés', false);
  addField(fields, 'ffmpeg', val(ctx.runtime && ctx.runtime.ffmpeg, 'introuvable'), false);
  addField(fields, 'Node', val(ctx.runtime && ctx.runtime.node, '?'));
  addField(fields, 'Python', val(ctx.runtime && ctx.runtime.python, 'introuvable'));

  const disk = ctx.storage && ctx.storage.disk;
  addField(fields, 'Stockage', disk ? `${disk.freeGB} Go libres\nsur ${disk.totalGB} Go` : 'non sondé');

  const setup = ctx.setup || {};
  const setupLine = [
    setup.completedAt ? new Date(setup.completedAt).toISOString().slice(0, 10) : 'jamais lancé',
    `python ${setup.pythonFound ? 'ok' : 'absent'}`,
    `ffmpeg ${setup.ffmpegFound ? 'ok' : 'absent'}`,
  ].join(' · ');
  addField(fields, 'Setup', setupLine, false);
  if (setup.modules && setup.modules.length) addField(fields, 'Modules', setup.modules.join(', '), false);

  return { title: 'Machine', color: CONTEXT_COLOR, fields };
}

// 4. JOURNAL ET PIÈCES — ce qu'il y a à ouvrir. Le décompte d'erreurs dit d'emblée si le fichier
// joint vaut la lecture, la liste des pièces dit ce qui a été reçu (et ce qui a été écarté).
/** @param {any} r @param {any} ctx */
function evidenceEmbed(r, ctx) {
  const fields = [];
  addField(fields, 'Journal', logLine(r), false);

  const attachments = Array.isArray(r.attachments) ? r.attachments.slice(0, MAX_ATTACHMENTS) : [];
  if (attachments.length) {
    addField(fields, `Captures (${attachments.length})`, attachments
      .map((a, i) => `• ${a.name || `piece_${i + 1}`} · ${humanSize(attachmentBytes(a))}`)
      .join('\n'), false);
  }
  if (r.attachmentsDropped) {
    addField(fields, 'Écartées', `${r.attachmentsDropped} pièce(s) non envoyée(s) : rapport trop lourd pour le relais`, false);
  }
  return {
    title: 'Journal et pièces jointes',
    color: CONTEXT_COLOR,
    fields,
    footer: { text: clip(`${val((ctx && ctx.os && ctx.os.label), '?')} · ${val((ctx && ctx.gpu && ctx.gpu.label), '?')}`, 2048) },
  };
}

/** Coût d'un embed au sens du plafond global de Discord (tout le texte visible compte).
 * @param {any} e */
function embedSize(e) {
  let n = String(e.title || '').length + String(e.description || '').length;
  n += String((e.footer && e.footer.text) || '').length;
  for (const f of e.fields || []) n += f.name.length + f.value.length;
  return n;
}

// Le plafond global (6000) est le seul que quatre embeds bien remplis peuvent atteindre. On coupe par
// la FIN — les embeds sont rangés du plus décisif au plus accessoire, et chacun garde au moins son
// titre — plutôt que de laisser Discord refuser le message entier et perdre le rapport.
/** @param {any[]} embeds */
function fitEmbeds(embeds) {
  const kept = [];
  let total = 0;
  for (const e of embeds.slice(0, MAX_EMBEDS)) {
    const head = { ...e, fields: [] };
    const headSize = embedSize(head);
    if (total + headSize > MAX_TOTAL) break;
    total += headSize;
    for (const f of e.fields || []) {
      const cost = f.name.length + f.value.length;
      if (total + cost > MAX_TOTAL) break;
      total += cost;
      head.fields.push(f);
    }
    // Un embed réduit à son seul titre n'apprend rien : on s'arrête là plutôt que d'en aligner des
    // vides, sauf s'il porte une description (l'embed de tête).
    if (!head.fields.length && !head.description) break;
    kept.push(head);
  }
  return kept;
}

/** Message complet : un embed par nature d'information, taillé pour les plafonds Discord.
 * @param {any} r @param {any} ctx @param {string} reportId @returns {any[]} */
function buildEmbeds(r, ctx, reportId) {
  return fitEmbeds([
    reportEmbed(r, ctx, reportId),
    reproEmbed(r),
    machineEmbed(ctx),
    evidenceEmbed(r, ctx),
  ].filter(Boolean));
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
    const payload = { ...r, attachments: fitted.attachments, attachmentsDropped: fitted.dropped };
    const form = new G.FormData();
    form.append('payload_json', JSON.stringify({
      username: 'NetsuRush',
      content: r.severity === 'blocker' ? `**${reportId}** — bloquant` : '',
      embeds: buildEmbeds(payload, ctx, reportId),
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

// `buildEmbeds` est exporté pour le test : un dépassement des plafonds Discord se solde par un 400 et
// le rapport est PERDU (le testeur croit l'avoir envoyé), c'est donc la partie à vérifier hors ligne.
module.exports = { submitBugReport, status, buildEmbeds };
