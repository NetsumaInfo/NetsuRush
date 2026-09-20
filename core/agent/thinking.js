// @ts-check
// Niveau de réflexion, traduit dans la langue de chaque fournisseur.
//
// Aucun d'eux ne l'exprime pareil : Anthropic donne un BUDGET DE JETONS,
// OpenAI et xAI un mot-clé `reasoning_effort`, OpenRouter un objet `reasoning`,
// Codex une clé de configuration en ligne de commande. Un seul réglage côté
// interface, quatre écritures ici.
//
// Le piège qui compte est chez Anthropic : quand la réflexion est activée,
// `max_tokens` doit être STRICTEMENT SUPÉRIEUR à `budget_tokens`, sinon l'API
// refuse la requête. Le budget par défaut du chat (4096) est plus petit que
// tous les paliers utiles, donc relever le plafond fait partie de la
// correspondance, pas d'un réglage séparé qu'on oublierait.

/** @typedef {'low'|'medium'|'high'|'xhigh'|'max'} ThinkingLevel */

/// L'échelle de Claude Code, relevée dans `claude --help` : c'est la plus large
/// des échelles réelles, et les autres en sont un préfixe. `xhigh` existe bel
/// et bien — je l'avais omis en supposant, à tort, que la plupart des agents
/// n'exposaient aucun réglage.
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/// Budgets Anthropic, en jetons de réflexion. Le minimum imposé par l'API est
/// 1024 : un palier en dessous serait refusé, pas simplement ignoré.
const ANTHROPIC_BUDGET = { low: 2048, medium: 8192, high: 16384, xhigh: 32000, max: 64000 };

/// Ce que chaque cible accepte VRAIMENT, relevé dans son aide. Un palier plus
/// haut que la dernière entrée est ramené dessus : Antigravity refuse `xhigh`,
/// et le lui envoyer ferait échouer le lancement — mieux vaut réfléchir un cran
/// en dessous que ne pas répondre du tout.
const ACCEPTS = {
  // `claude --help` : (low, medium, high, xhigh, max)
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  // `copilot --help` : ("none", "minimal", "low", "medium", "high", "xhigh", "max")
  copilot: ['low', 'medium', 'high', 'xhigh', 'max'],
  // `agy --help` : (low|medium|high)
  antigravity: ['low', 'medium', 'high'],
  codex: ['low', 'medium', 'high'],
  // `reasoning_effort` de l'API OpenAI, suivi par xAI et OpenRouter.
  openai: ['low', 'medium', 'high'],
  xai: ['low', 'medium', 'high'],
  openrouter: ['low', 'medium', 'high'],
};

/// Ramène un palier dans l'échelle d'une cible donnée.
/** @param {string} target @param {ThinkingLevel} level @returns {string} */
function clamp(target, level) {
  const ladder = ACCEPTS[target];
  if (!ladder) return level;
  if (ladder.includes(level)) return level;
  return ladder[ladder.length - 1];
}

/// Marge au-dessus du budget pour la réponse elle-même. Sans elle, un modèle
/// qui consomme tout son budget n'a plus de place pour répondre.
const ANSWER_HEADROOM = 8192;

/// `off` a disparu de l'échelle. Aucun de ces moteurs ne se pilote « sans
/// réflexion » depuis l'interface, et un palier qui n'envoyait rien se lisait
/// comme une panne : l'absence de réglage est le défaut du modèle, pas un cran.
const DEFAULT_LEVEL = 'medium';

/** @param {any} level @returns {ThinkingLevel} */
function normalize(level) {
  const at = String(level);
  // Un « off » enregistré par une version antérieure atterrit sur le défaut
  // plutôt que de valoir un cran qui n'existe plus.
  return LEVELS.includes(at) ? /** @type {ThinkingLevel} */ (at) : DEFAULT_LEVEL;
}

/// Ce qu'il faut ajouter au corps de la requête pour un fournisseur donné.
/// Renvoie un objet vide quand la réflexion est coupée ou non gérée : le
/// `spread` d'un objet vide ne change rien, donc l'appelant n'a pas à savoir
/// si le fournisseur sait faire.
///
/// @param {string} provider  'anthropic'|'openai'|'xai'|'openrouter'
/// @param {any} level
/// @returns {Record<string, any>}
function bodyFor(provider, level) {
  const at = normalize(level);

  if (provider === 'anthropic') {
    // Un budget est un nombre : les cinq paliers y restent distincts, là où les
    // trois mots-clés des autres en écrasent deux.
    return { thinking: { type: 'enabled', budget_tokens: ANTHROPIC_BUDGET[at] } };
  }
  // OpenRouter unifie les fournisseurs derrière `reasoning`, là où l'API
  // d'OpenAI attend le mot-clé à plat.
  if (provider === 'openrouter') return { reasoning: { effort: clamp('openrouter', at) } };
  if (provider === 'openai' || provider === 'xai') return { reasoning_effort: clamp(provider, at) };
  return {};
}

/// Plafond de jetons minimal exigé par le palier. L'appelant garde le sien s'il
/// est déjà plus grand ; c'est un plancher, pas une consigne.
/** @param {any} level @param {number} current */
function maxTokensFor(level, current) {
  return Math.max(current, ANTHROPIC_BUDGET[normalize(level)] + ANSWER_HEADROOM);
}

/// Arguments supplémentaires pour un agent CLI, relevés dans l'aide de chaque
/// binaire plutôt que supposés — c'est en la lisant qu'on découvre que Claude
/// Code, Copilot et Antigravity exposent tous `--effort`.
/** @param {string} agentId @param {any} level @returns {string[]} */
function cliArgsFor(agentId, level) {
  const at = normalize(level);
  if (agentId === 'codex') return ['-c', `model_reasoning_effort=${clamp('codex', at)}`];
  if (ACCEPTS[agentId]) return ['--effort', clamp(agentId, at)];
  return [];
}

/// Qui accepte réellement le réglage. Servir un curseur qui ne fait rien sur la
/// moitié des moteurs serait pire que ne pas l'offrir. Gemini CLI n'a aucun
/// drapeau de ce genre dans son aide, d'où son absence.
const THINKING_PROVIDERS = ['anthropic', 'openai', 'xai', 'openrouter'];
const THINKING_CLI = ['claude', 'codex', 'copilot', 'antigravity'];

module.exports = {
  LEVELS, DEFAULT_LEVEL, ANTHROPIC_BUDGET, ACCEPTS, THINKING_PROVIDERS, THINKING_CLI,
  normalize, clamp, bodyFor, maxTokensFor, cliArgsFor,
};
