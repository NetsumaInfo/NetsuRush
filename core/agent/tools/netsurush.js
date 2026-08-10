// @ts-check
// Outils « NetsuRush » : exposent les modules core EXISTANTS (Resolve, détection, recherche, timeline,
// proxy, vignettes, export AE) à l'agent IA. Réutilise les mêmes fonctions que core/rpc.js — zéro
// logique métier dupliquée. Les ops Resolve passent par les brackets `guarded`/`rOp` (mêmes invariants
// que rpc.js : reset sûr du registre de handles, pause du poll).

const os = require('os');
const path = require('path');

/**
 * @param {{
 *   resolveMod:any, timeline:any, sidecars:any, thumbs:any, ffmpeg:any,
 *   aeExporter:any, ev:any, guarded:(fn:any)=>any, rOp:(fn:any)=>any
 * }} deps
 */
function createNetsuRushTools(deps) {
  const { resolveMod, timeline, sidecars, thumbs, ffmpeg, aeExporter, ev, guarded, rOp } = deps;

  /** @type {import('./registry').ToolDef[]} */
  const tools = [
    {
      name: 'resolve_status',
      description: 'État de DaVinci Resolve : connexion au pont, projet et timeline ouverts, version. '
        + 'Appeler en premier pour savoir si les actions projet sont possibles.',
      risk: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler: rOp(() => resolveMod.resolveStatus()),
    },
    {
      name: 'list_media_pool',
      description: 'Liste les clips du Media Pool du projet Resolve courant (nom, chemin, durée, fps, résolution).',
      risk: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler: rOp(() => resolveMod.listMediaPool()),
    },
    {
      name: 'import_media',
      description: 'Importe des fichiers dans le Media Pool du projet Resolve courant.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Chemins absolus des fichiers à importer' } },
        required: ['paths'],
      },
      handler: guarded((/** @type {{paths:string[]}} */ a) => resolveMod.importToMediaPool(a.paths || [])),
    },
    {
      name: 'detect_scenes',
      description: 'Détecte les plans d’une vidéo et met en cache. Modèles: transnetv2, omnishotcut, autoshot.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Chemin de la vidéo' },
          threshold: { type: 'number' },
          model: { type: 'string', enum: ['transnetv2', 'omnishotcut', 'autoshot'] },
          options: { type: 'object', description: 'Paramètres avancés propres au modèle.' },
        },
        required: ['path'],
      },
      handler: (/** @type {any} */ a) => sidecars.detectScenes(ev, a.path, a.threshold ?? 0.5, a.model || 'transnetv2', a.options || {}),
    },
    {
      name: 'cached_scenes',
      description: 'Lit les plans déjà détectés en cache pour une vidéo (instantané, sans recalcul).',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, model: { type: 'string', enum: ['transnetv2', 'omnishotcut', 'autoshot'] }, options: { type: 'object' } },
        required: ['path'],
      },
      handler: (/** @type {any} */ a) => sidecars.getCachedScenes(a.path, a.model || 'transnetv2', a.threshold, a.options),
    },
    {
      name: 'search_clips',
      description: 'Recherche SÉMANTIQUE (SigLIP 2) du CONTENU VISUEL des plans (ex. "mer", "voiture de '
        + 'nuit", "gros plan visage") — PAS le nom de fichier. C’est l’outil à utiliser pour "trouve les '
        + 'rushs/plans de <sujet>". Renvoie les plans les plus proches {file_path, frames in/out, score 0..1}. '
        + 'Cherche dans les plans DÉJÀ INDEXÉS : si 0 résultat, indexer d’abord les rushs avec index_clip.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Requête en langage naturel' },
          topK: { type: 'number' },
          minScore: { type: 'number' },
        },
        required: ['text'],
      },
      handler: async (/** @type {any} */ a) => {
        const raw = await sidecars.queryReq('search', { text: String(a.text || ''), neg_text: '', refs: [], top_k: a.topK || 30, min_score: a.minScore || 0, beta: 0.4, aesthetic: false });
        // Normalise en tableau propre, trié, champs explicites (prêts pour build_timeline).
        const arr = Array.isArray(raw) ? raw : (raw && (raw.hits || raw.results)) || [];
        const hits = arr.map((/** @type {any} */ h) => ({
          file: h.file_path || h.file || h.path,
          inFrame: h.in ?? h.inFrame ?? null,
          outFrame: h.out ?? h.outFrame ?? null,
          score: Number(h.score ?? h.similarity ?? 0),
        })).filter((/** @type {any} */ h) => h.file).sort((/** @type {any} */ x, /** @type {any} */ y) => y.score - x.score);
        const top = hits[0] ? hits[0].score : 0;
        // SigLIP : un vrai match dépasse ~0.05. En dessous = aucun plan ne correspond OU index vide/pauvre.
        const note = hits.length === 0
          ? 'Aucun résultat : les rushs ne sont probablement pas indexés. Lance index_clip sur chaque rush puis relance.'
          : top < 0.05
            ? 'Scores très faibles : aucun plan ne correspond vraiment au sujet (ou l’index est pauvre). Ne monte PAS une timeline avec ça ; dis-le à l’utilisateur.'
            : undefined;
        return { ok: true, query: String(a.text || ''), count: hits.length, topScore: top, hits, ...(note ? { note } : {}) };
      },
    },
    {
      name: 'index_clip',
      description: 'Indexe une vidéo pour la recherche sémantique (détecte les plans puis calcule les embeddings).',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, precise: { type: 'boolean' } },
        required: ['path'],
      },
      handler: guarded((/** @type {any} */ a) => sidecars.searchIndex(ev, 'index', { path: a.path, force: false, precise: !!a.precise })),
    },
    {
      name: 'list_timelines',
      description: 'Liste les timelines du projet Resolve (et laquelle est courante).',
      risk: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler: rOp(() => timeline.listTimelines()),
    },
    {
      name: 'read_timeline',
      description: 'Lit les plans montés d’une timeline Resolve existante (source + in/out frames). '
        + 'timelineName omis = timeline ouverte.',
      risk: 'read',
      inputSchema: { type: 'object', properties: { timelineName: { type: 'string' } } },
      handler: guarded((/** @type {any} */ a) => timeline.readTimelineCuts({ timelineName: a.timelineName })),
    },
    {
      name: 'build_timeline',
      description: 'Crée une timeline frame-accurate à partir de segments d’une vidéo (référence le '
        + 'MediaPoolItem d’origine, out INCLUSIF). mode "new" (défaut) crée, "append" ajoute à la courante.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          input: { type: 'string', description: 'Chemin de la vidéo source' },
          mode: { type: 'string', enum: ['new', 'append'] },
          whole: { type: 'boolean' },
          srcFrames: { type: 'number' },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: { in: { type: 'number' }, out: { type: 'number' }, inFrame: { type: 'number' }, outFrame: { type: 'number' } },
            },
          },
        },
        required: ['name', 'input'],
      },
      handler: guarded((/** @type {any} */ a) => timeline.buildTimeline(a)),
    },
    {
      name: 'cut_timeline',
      description: 'Détecte les plans des rushs d’une timeline puis crée une nouvelle timeline découpée '
        + '(lossless, frame-accurate). timelineName omis = timeline ouverte.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          timelineName: { type: 'string' },
          model: { type: 'string', enum: ['transnetv2', 'omnishotcut', 'autoshot'] },
          threshold: { type: 'number' },
          detectionOptions: { type: 'object' },
          name: { type: 'string' },
        },
      },
      handler: guarded((/** @type {any} */ a) => timeline.cutTimeline(ev, a)),
    },
    {
      name: 'probe_media',
      description: 'Métadonnées d’un fichier vidéo : durée et dimensions.',
      risk: 'read',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: (/** @type {any} */ a) => ffmpeg.probeMedia(a.path),
    },
    {
      name: 'make_thumbnail',
      description: 'Génère (ou lit en cache) une vignette d’une vidéo à un temps donné. Renvoie le chemin du JPEG.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, time: { type: 'number' } },
        required: ['path'],
      },
      handler: (/** @type {any} */ a) => thumbs.thumbnail(a.path, a.time || 0).catch((/** @type {any} */ e) => ({ error: String(e) })),
    },
    {
      name: 'export_to_after_effects',
      description: 'Exporte une timeline Resolve vers After Effects (.jsx + médias). Voir les options de '
        + 'mode vidéo/audio. timelineName omis = timeline ouverte.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          timelineName: { type: 'string' },
          videoMode: { type: 'string', enum: ['copy', 'remux', 'reencode'] },
          audio: { type: 'string', enum: ['copy', 'remux', 'aac', 'pcm', 'none'] },
        },
      },
      handler: guarded((/** @type {any} */ a) =>
        aeExporter.aeExport(ev, { videoMode: a.videoMode || 'copy', audio: a.audio || 'copy', timelineName: a.timelineName ?? null })),
    },
    {
      name: 'upscale_media',
      description: 'Upscale une vidéo (ou un segment) avec Real-ESRGAN. model: anime | general | light. '
        + 'scale 2 ou 4. whole=true pour tout le fichier, sinon segments [{in,out}] (secondes). '
        + 'outDir omis = dossier temporaire. importBack=true réimporte le résultat dans le Media Pool.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Chemin de la vidéo source' },
          model: { type: 'string', enum: ['anime', 'general', 'light'] },
          scale: { type: 'number', enum: [2, 4] },
          whole: { type: 'boolean' },
          segments: { type: 'array', items: { type: 'object', properties: { in: { type: 'number' }, out: { type: 'number' } } } },
          outDir: { type: 'string' },
          importBack: { type: 'boolean' },
        },
        required: ['input'],
      },
      handler: (/** @type {any} */ a) => sidecars.runUpscale(ev, {
        input: a.input,
        model: a.model || 'light',
        scale: a.scale || 4,
        whole: a.whole ?? (!Array.isArray(a.segments) || !a.segments.length),
        segments: a.segments,
        outDir: a.outDir || path.join(os.tmpdir(), 'netsurush-upscale'),
        importBack: !!a.importBack,
      }),
    },
  ];

  return tools;
}

module.exports = { createNetsuRushTools };
