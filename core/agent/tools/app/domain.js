// @ts-check
// Builds one compound tool per app domain from a declarative action table. Every action is a thin
// mapping onto an EXISTING rpc channel (core/rpc.js): the agent reaches exactly the code the UI runs,
// with no second implementation to drift. The table carries what the model needs (a one-line usage
// per action, the union of parameters) and what the permission gate needs (a risk per action).
//
// An action marked `long` runs through the job registry: it answers inline when it finishes within
// the wait window, and otherwise hands back a job id, because an MCP client gives up on a call long
// before an index or an export of a whole collection is done.

/**
 * @typedef {'read'|'write'|'destructive'} Risk
 * @typedef {Object} ActionDef
 * @property {Risk} risk
 * @property {(a:any)=>Risk} [riskFor]  per-call risk when the action's effect depends on its input
 * @property {string} usage           one line shown to the model: `name(param, param?) — what it does`
 * @property {string} [channel]       rpc channel the action maps onto
 * @property {(a:any)=>any[]} [args]  turns the named input into the channel's positional args
 * @property {(a:any, ctx:ActionCtx)=>Promise<any>|any} [run]  custom body when no single channel fits
 * @property {boolean} [long]         may outlive an MCP call: run as a job
 * @property {string} [cancelChannel] rpc channel that aborts the long action
 * @property {(result:any, a:any)=>any} [map]  reshapes the channel result for the model (may be async)
 *
 * @typedef {Object} DomainDef
 * @property {string} name
 * @property {string} summary
 * @property {Record<string, ActionDef>} actions
 * @property {Record<string, object>} params  JSON Schema of every parameter any action reads
 *
 * @typedef {Object} ActionCtx
 * @property {(channel:string, args?:any[])=>Promise<any>} invoke
 * @property {any} jobs
 * @property {any} [subagents]              parallel sub-agents (netsu_agents)
 * @property {()=>string[]} [channels]          every rpc channel name (netsu_rpc)
 * @property {(channel:string)=>string} [channelSource]  handler source of one channel (netsu_rpc)
 */

/** @param {any} result */
function wrap(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return 'ok' in result ? result : { ok: true, ...result };
  }
  return { ok: true, value: result };
}

/**
 * @param {DomainDef} def
 * @param {ActionCtx} ctx
 * @returns {import('../registry').ToolDef}
 */
function buildDomainTool(def, ctx) {
  const names = Object.keys(def.actions);
  const usage = names.map((n) => `- ${def.actions[n].usage}`).join('\n');
  return {
    name: def.name,
    description: `${def.summary}\nactions:\n${usage}`,
    risk: 'write',
    // An action this table does not know is treated as destructive: the gate must never wave
    // through a call it cannot classify.
    riskFor: (/** @type {any} */ a) => {
      const action = def.actions[a && a.action];
      if (!action) return 'destructive';
      return action.riskFor ? action.riskFor(a) : action.risk;
    },
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: names }, ...def.params },
      required: ['action'],
    },
    handler: async (/** @type {any} */ a) => {
      const action = def.actions[a.action];
      if (!action) return { ok: false, error: `unknown action "${a.action}" for ${def.name}; expected one of ${names.join(', ')}` };
      const exec = async () => {
        let result;
        if (action.run) result = await action.run(a, ctx);
        else if (action.channel) result = await ctx.invoke(action.channel, action.args ? action.args(a) : []);
        else throw new Error(`action ${a.action} has neither channel nor body`);
        return wrap(action.map ? await action.map(result, a) : result);
      };
      if (!action.long) return exec();
      return ctx.jobs.run(`${def.name}.${a.action}`, exec, {
        cancel: action.cancelChannel ? () => ctx.invoke(/** @type {string} */ (action.cancelChannel), []) : undefined,
        waitMs: typeof a.waitSeconds === 'number' ? Math.max(0, Math.min(a.waitSeconds, 50)) * 1000 : undefined,
      });
    },
  };
}

/// Parameters shared by every long action.
const WAIT_PARAM = {
  waitSeconds: {
    type: 'number',
    description: 'Long actions only: how long to wait inline before returning a jobId (0-50, default 20). Poll with netsu_jobs.',
  },
};

module.exports = { buildDomainTool, WAIT_PARAM, wrap };
