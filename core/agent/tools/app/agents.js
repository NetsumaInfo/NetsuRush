// @ts-check
// Sub-agents: small parallel agents working on footage (core/agent/subagents.js).

const { WAIT_PARAM } = require('./domain');

/** @type {import('./domain').DomainDef} */
module.exports = {
  name: 'netsu_agents',
  summary: 'Launch many small sub-agents in parallel on footage: search, look at thumbnails, sort, gather shots. '
    + 'ALWAYS PREFER CHEAP ONES: tier "eco" is the default and the right choice for almost everything (Haiku on Claude Code, Luna on Codex). '
    + 'Use tier "normal" only when eco answers proved insufficient for this job, or the user asks for it. '
    + 'To find every occurrence of something, send the same question to about 4 sub-agents and merge their shots: one finds about half, 4 about 70%, 8 about 80%, each adding a few false ones to check. '
    + 'Use it to cover many rushes or many angles of a question fast. Each sub-agent has netsu_search, netsu_media, netsu_library, netsu_collections, '
    + 'netsu_characters and timeline reads, and starts knowing nothing: write complete prompts. As many run at once as the user set; the rest queue. '
    + 'Each one uses the user\'s subscription quota, so split the work usefully rather than maximally. Files must be indexed to be searched.',
  actions: {
    dispatch: {
      risk: 'write', long: true, cancelChannel: 'agent:subagentsCancel',
      usage: 'dispatch(tasks[{name?, prompt}] | prompt + files[] + filesPerAgent?, access?, tier?) — run sub-agents, return each one\'s findings. '
        + 'access: read (default, they only report) | write (they may also create collections and edit shots, never delete). Results are {name, ok, answer, toolCalls, seconds}; answers hold one JSON line per shot',
      run: (a, ctx) => ctx.subagents.dispatch(a),
    },
    status: { risk: 'read', usage: 'status() — {max, running, queued, engine}', run: (_a, ctx) => ctx.subagents.status() },
    cancel: { risk: 'write', usage: 'cancel() — stop every running sub-agent', run: (_a, ctx) => ctx.subagents.cancelAll() },
  },
  params: {
    tasks: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, prompt: { type: 'string' } }, required: ['prompt'] }, description: 'One entry per sub-agent' },
    prompt: { type: 'string', description: 'With files: the same job for every file or batch' },
    files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to spread over sub-agents' },
    filesPerAgent: { type: 'number', description: 'Files per sub-agent (default 1)' },
    access: { type: 'string', enum: ['read', 'write'] },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How hard each sub-agent thinks. Keep the default, medium: on real rushes high found no more shots, for 40% more cost' },
    tier: { type: 'string', enum: ['eco', 'normal'], description: 'Sub-agent cost tier. Leave it at eco (the default) unless eco proved insufficient' },
    ...WAIT_PARAM,
  },
};
