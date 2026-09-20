// @ts-check
// Catalogue de modèles vivant.
//
// Les listes étaient écrites à la main, en double (menu de moteur + panneau de
// connexions), et elles avaient pris une génération de retard : choisir Codex
// proposait des modèles qui n'étaient plus les derniers. Une liste tapée à la
// main est une liste fausse à la version suivante — le seul remède est de ne
// plus la taper.
//
// Trois sources, de la plus autoritaire à la moins :
//
//   1. Le point d'entrée `/models` du fournisseur, quand une clé est
//      configurée. Ce sont les identifiants EXACTS que son API accepte, donc
//      les seuls dont on sache qu'ils ne feront pas échouer l'appel.
//   2. Le catalogue d'OpenRouter, qui ne demande AUCUNE clé et porte les
//      modèles courants de tous les éditeurs sous des slugs `éditeur/modèle`.
//      C'est ce qui rend la liste juste pour quelqu'un qui n'a rien configuré.
//   3. La table figée en bas de ce fichier, pour une machine sans réseau.
//
// Le niveau 2 mérite une réserve : le slug OpenRouter n'est pas toujours
// l'identifiant de l'API d'origine (`anthropic/claude-sonnet-4.5` chez l'un,
// `claude-sonnet-4-5` chez l'autre). Il sert donc à dire QUELS modèles existent
// aujourd'hui, pas à garantir qu'un identifiant passera tel quel — d'où le
// champ `source` renvoyé avec la liste, que l'UI affiche.

const TIMEOUT_MS = 6000;
const TTL_MS = 15 * 60 * 1000;

/// Dernier recours, relevé le 2026-09-07 sur le catalogue OpenRouter.
/// Volontairement court : une liste de secours longue est une liste de secours
/// qu'on finit par croire à jour.
const CURATED = Object.freeze({
  anthropic: ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  openai: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  openrouter: [
    'anthropic/claude-fable-5.1',
    'anthropic/claude-opus-5',
    'openai/gpt-6-astra',
    'openai/gpt-5.6-sol',
    'google/gemini-3.8-flash',
    'x-ai/grok-4.6',
    'moonshotai/kimi-k3',
    'z-ai/glm-5.3',
    'deepseek/deepseek-v4-pro',
  ],
  xai: ['grok-4.6', 'grok-4.5', 'grok-4.3'],
  google: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3-pro'],
});

/// Les identifiants qu'un fournisseur renvoie ne servent pas tous à converser.
/// OpenAI en particulier expose la transcription, la synthèse vocale, les
/// embeddings et l'image dans la même liste ; les proposer comme moteur de chat
/// est une erreur garantie au premier message.
///
/// `instruct` n'est PAS dans la liste : chez OpenAI il désignait un modèle de
/// complétion, mais sur OpenRouter c'est le suffixe normal des modèles ouverts
/// (llama, qwen…), et les écarter viderait la moitié du catalogue.
const NOT_A_CHAT_MODEL =
  /(^|-)(whisper|tts|dall-e|sora|embedding|moderation|davinci|babbage|curie)\b|(audio|realtime|transcribe|image|search-preview)/i;

/** @param {string} id */
function isChatModel(id) {
  // `:batch` est une API differente — asynchrone, sans streaming : la proposer
  // dans un selecteur de conversation ne peut que produire un appel qui echoue.
  // `:free` et `:thinking`, eux, passent par le meme point d'entree et restent.
  if (id && id.endsWith(':batch')) return false;
  return !!id && !NOT_A_CHAT_MODEL.test(id);
}

/// Les editeurs qu'on veut voir en tete du catalogue OpenRouter. Il porte 340
/// modeles utilisables : trie par date seule, un modele obscur sorti hier passe
/// devant Claude et GPT, et la liste devient un annuaire au lieu d'un choix.
const MAJOR_VENDORS = ['anthropic/', 'openai/', 'google/', 'x-ai/', 'deepseek/', 'moonshotai/', 'z-ai/', 'qwen/'];

/// Plafond de la liste rendue. Le champ libre du menu reste la porte de sortie
/// pour un identifiant qui n'y figure pas.
const MAX_MODELS = 60;

/** @param {string[]} ids */
function majorsFirst(ids) {
  const rank = (id) => {
    const at = MAJOR_VENDORS.findIndex((v) => id.startsWith(v));
    return at === -1 ? MAJOR_VENDORS.length : at;
  };
  // Tri STABLE (garanti par la spec) : l'ordre par date etabli en amont
  // survit a l'interieur de chaque editeur.
  return [...ids].sort((a, b) => rank(a) - rank(b));
}

/// Un `fetch` qui abandonne au lieu de faire attendre le menu. Une liste de
/// modèles est un confort : elle n'a pas le droit de bloquer l'interface, donc
/// tout échec se résout en `null` et le niveau suivant prend la main.
/** @param {string} url @param {Record<string,string>} headers @returns {Promise<any>} */
async function getJson(url, headers) {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/// Normalise une réponse « OpenAI-compatible » (`{data:[{id, created}]}`), qui
/// est aussi la forme d'Anthropic, d'OpenRouter et de xAI. Le tri par date de
/// création met les nouveautés en tête, ce qui est le seul ordre utile : c'est
/// le modèle sorti hier qu'on cherche dans la liste, pas celui de l'an dernier.
/** @param {any} payload @returns {string[]|null} */
function idsFromOpenAiShape(payload) {
  const rows = payload && Array.isArray(payload.data) ? payload.data : null;
  if (!rows) return null;
  return rows
    .map((row) => ({
      id: String((row && (row.id || row.name)) || ''),
      at: Number(row && (row.created || row.created_at)) || 0,
    }))
    .filter((row) => isChatModel(row.id))
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .map((row) => row.id);
}

/** @param {string} base */
const trimSlash = (base) => String(base || '').replace(/\/+$/, '');

/// Le catalogue d'OpenRouter, sans clé. Un seul appel donne les modèles
/// courants de tous les éditeurs, ce qui répond aussi pour les fournisseurs
/// dont l'utilisateur n'a pas de clé.
/** @returns {Promise<string[]|null>} */
async function fetchOpenRouterCatalog() {
  const payload = await getJson('https://openrouter.ai/api/v1/models', {});
  return idsFromOpenAiShape(payload);
}

/// Extrait d'un catalogue OpenRouter les modèles d'un éditeur, préfixe retiré.
/// xAI s'y publie sous `x-ai/`, pas sous `xai` : le préfixe du slug et le nom
/// du fournisseur chez nous ne coïncident pas partout.
const OPENROUTER_PREFIX = { anthropic: 'anthropic/', openai: 'openai/', xai: 'x-ai/', google: 'google/' };

/// Anthropic numérote ses modèles avec des POINTS chez OpenRouter et des TIRETS
/// dans sa propre API : `claude-fable-5.1` d'un côté, `claude-fable-5-1` de
/// l'autre. Retirer le préfixe sans convertir donnerait un identifiant que
/// l'API refuse — le seul cas, vérifié, où le slug ne se transpose pas tel quel
/// (OpenAI, xAI et Google gardent leurs points des deux côtés).
/** @param {string} id */
const dotsToDashes = (id) => id.replace(/(\d)\.(\d)/g, '$1-$2');

/** @param {string} provider @param {string[]} catalog */
function fromCatalog(provider, catalog) {
  const prefix = OPENROUTER_PREFIX[provider];
  if (!prefix) return [];
  return catalog
    .filter((id) => id.startsWith(prefix))
    // `:batch`, `:free`, `:thinking` sont des variantes de routage propres à
    // OpenRouter ; l'API d'origine ne les connaît pas. Elles font un tiers du
    // catalogue, donc les garder doublerait la liste sans rien ajouter.
    .filter((id) => !id.includes(':'))
    .map((id) => id.slice(prefix.length))
    .map((id) => (provider === 'anthropic' ? dotsToDashes(id) : id));
}

/// Interroge le fournisseur lui-même. C'est la seule source qui garantisse que
/// l'identifiant sera accepté par l'appel qui suit.
/** @param {string} provider @param {{key?:string, baseUrl?:string}} creds @returns {Promise<string[]|null>} */
async function fetchFromVendor(provider, creds) {
  const key = String(creds.key || '');
  if (!key) return null;

  if (provider === 'anthropic') {
    const base = trimSlash(creds.baseUrl || 'https://api.anthropic.com');
    const payload = await getJson(`${base}/v1/models?limit=100`, {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    });
    return idsFromOpenAiShape(payload);
  }

  if (provider === 'openai' || provider === 'xai' || provider === 'openrouter') {
    const fallback = provider === 'openai' ? 'https://api.openai.com/v1'
      : provider === 'xai' ? 'https://api.x.ai/v1'
        : 'https://openrouter.ai/api/v1';
    const base = trimSlash(creds.baseUrl || fallback);
    const payload = await getJson(`${base}/models`, { Authorization: `Bearer ${key}` });
    return idsFromOpenAiShape(payload);
  }

  if (provider === 'google') {
    // Google ne suit pas la forme OpenAI : `{models:[{name:'models/gemini-…'}]}`.
    const payload = await getJson(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      {},
    );
    const rows = payload && Array.isArray(payload.models) ? payload.models : null;
    if (!rows) return null;
    return rows
      .map((row) => String((row && row.name) || '').replace(/^models\//, ''))
      .filter(isChatModel);
  }

  return null;
}

function createModelCatalog() {
  /** @type {Map<string,{at:number, models:string[], source:string}>} */
  const cache = new Map();
  /** @type {{at:number, models:string[]}|null} */
  let catalog = null;

  async function openRouterCatalog() {
    if (catalog && Date.now() - catalog.at < TTL_MS) return catalog.models;
    const models = await fetchOpenRouterCatalog();
    if (!models) return catalog ? catalog.models : null;
    catalog = { at: Date.now(), models };
    return models;
  }

  /// Renvoie les modèles d'un fournisseur, et D'OÙ ils viennent. La provenance
  /// n'est pas un détail de journal : « liste de secours » et « votre clé dit
  /// ceci » n'appellent pas la même confiance de la part de l'utilisateur.
  ///
  /// @param {string} provider  'anthropic'|'openai'|'openrouter'|'xai'|'google'
  /// @param {{key?:string, baseUrl?:string, refresh?:boolean}} [opts]
  /// @returns {Promise<{provider:string, models:string[], source:'vendor'|'openrouter'|'curated'}>}
  async function list(provider, opts = {}) {
    const id = String(provider || '');
    const key = String(opts.key || '');
    // La clé entre dans l'empreinte du cache : en configurer une doit faire
    // passer de la liste approximative à la liste exacte sans attendre le TTL.
    const stamp = `${id}:${key ? 'keyed' : 'anon'}:${opts.baseUrl || ''}`;
    const hit = cache.get(stamp);
    if (hit && !opts.refresh && Date.now() - hit.at < TTL_MS) {
      return { provider: id, models: hit.models, source: /** @type {any} */ (hit.source) };
    }

    const vendor = await fetchFromVendor(id, opts);
    if (vendor && vendor.length) {
      cache.set(stamp, { at: Date.now(), models: vendor, source: 'vendor' });
      return { provider: id, models: vendor, source: 'vendor' };
    }

    const all = await openRouterCatalog();
    if (all && all.length) {
      const found = id === 'openrouter' ? majorsFirst(all) : fromCatalog(id, all);
      const models = found.slice(0, MAX_MODELS);
      if (models.length) {
        cache.set(stamp, { at: Date.now(), models, source: 'openrouter' });
        return { provider: id, models, source: 'openrouter' };
      }
    }

    const curated = CURATED[id] || [];
    return { provider: id, models: [...curated], source: 'curated' };
  }

  function clear() { cache.clear(); catalog = null; }

  return { list, clear };
}

module.exports = {
  createModelCatalog, CURATED, MAX_MODELS,
  isChatModel, idsFromOpenAiShape, fromCatalog, majorsFirst,
};
