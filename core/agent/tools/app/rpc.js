// @ts-check
// Escape hatch: any rpc channel of the core, for what no netsu_* action covers yet. The domain tools
// stay the documented path; this one trades guidance for reach. A channel's risk is read off its
// method name — only well-known read verbs count as reads, everything else is destructive, so the
// gate never under-rates a call it cannot know.
//
// Channels that would let an agent widen its own rights are refused outright: answering approval
// prompts, changing the external permission mode, reconfiguring the chat engine, or re-entering the
// tool gate through agent:*.

const BLOCKED = [/^agent:/, /^mcp:external:/, /^chat:approval/, /^chat:configure$/];

const READ_METHOD = new RegExp(
  '^(list|get|load|status|state|info|probe|peek|read|search|query|diagnose|capabilities|overview|tree|'
  + 'missing|indexed|shots|engines|gallery|samples|identify|duplicates|backlinks|paths|gpu|diskUsage|cached|'
  + 'audioTracks|thumbnail|thumbs|resources|sessionHealth|renderJobs|watchdog|prefs|offline|queueState|allTags|'
  + 'defaultArchiveDir|timelineTree|previewName|modelState|concurrency|sources|trashList|projectOf|history:list|'
  + 'history:load|tools|agents|models|compareFrames)',
);

/** @param {string} channel */
function channelRisk(channel) {
  const method = String(channel).split(':').slice(1).join(':');
  return READ_METHOD.test(method) ? 'read' : 'destructive';
}

/** @param {string} channel */
const blocked = (channel) => BLOCKED.some((re) => re.test(String(channel)));

/** @type {import('./domain').DomainDef} */
const domain = {
  name: 'netsu_rpc',
  summary: 'Direct access to ANY NetsuRush core channel (the ~300 calls the UI makes), for what the netsu_* tools do not cover. '
    + 'Prefer the netsu_* tools when they fit: they are documented and safer. Use list to find a channel, describe to read '
    + 'its handler (positional args), then call with args as an ARRAY. Calls on unknown verbs are treated as destructive.',
  actions: {
    list: {
      risk: 'read',
      usage: 'list(prefix?) — channel names grouped by domain, with their risk',
      run: (a, ctx) => {
        const names = (ctx.channels ? ctx.channels() : []).filter((c) => !blocked(c) && (!a.prefix || c.startsWith(a.prefix)));
        /** @type {Record<string, string[]>} */
        const groups = {};
        for (const c of names.sort()) (groups[c.split(':')[0]] ||= []).push(channelRisk(c) === 'read' ? c : `${c} (write)`);
        return { total: names.length, channels: groups };
      },
    },
    describe: {
      risk: 'read',
      usage: 'describe(channel) — source of the channel handler: shows the positional args it takes and the module it calls',
      run: (a, ctx) => {
        if (blocked(a.channel)) return { ok: false, error: `channel not available to agents: ${a.channel}` };
        const src = ctx.channelSource ? ctx.channelSource(String(a.channel || '')) : '';
        if (!src) return { ok: false, error: `unknown channel: ${a.channel}` };
        return { channel: a.channel, risk: channelRisk(a.channel), source: src.slice(0, 2000) };
      },
    },
    call: {
      // A channel can run for many minutes: past 5 the client's request gives up, while the work goes on.
      long: true,
      risk: 'destructive',
      riskFor: (a) => (blocked(a.channel) ? 'destructive' : channelRisk(a.channel)),
      usage: 'call(channel, args[]) — invoke a channel with its positional args',
      run: async (a, ctx) => {
        if (blocked(a.channel)) return { ok: false, error: `channel not available to agents: ${a.channel}` };
        return ctx.invoke(String(a.channel || ''), Array.isArray(a.args) ? a.args : (a.args === undefined ? [] : [a.args]));
      },
    },
  },
  params: {
    prefix: { type: 'string', description: 'list: e.g. "collections:"' },
    channel: { type: 'string', description: 'e.g. "collections:load"' },
    args: { type: 'array', items: {}, description: 'call: positional arguments, e.g. ["<collection id>"]' },
  },
};

module.exports = Object.assign(domain, { channelRisk, blocked });
