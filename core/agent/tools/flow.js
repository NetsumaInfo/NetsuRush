// @ts-check
// Tools for the NetsuFlow surface: reading a web composition and proposing
// changes to it.
//
// The shape follows `Netsuflow/studio/docs/07-ai-agent-redesign.md`, which is
// explicit about the one thing that matters here: the default output is a
// PROPOSED CHANGE SET, not a mutation. Nothing in this file writes to the
// composition. `flow_propose` returns typed operations for the user to inspect
// and apply; the apply path is a deliberate act in the interface, and it is not
// reachable as a tool call.
//
// That is not caution for its own sake. The document lists "mutates before
// explicit publish intent" as a stop condition, and an agent that edits the
// composition directly is one the user cannot review before Resolve sees it.



/// Operations the editor knows how to apply. An agent that proposes anything
/// else is proposing something the interface cannot show a diff for, so the
/// list is closed rather than free-form.
const OPERATION_TYPES = Object.freeze([
  'variable.set',
  'format.set',
  'source.replace',
]);

/// A tool result that reaches a model is bounded: an unbounded composition
/// source would eat the context window and leave no room for the reasoning it
/// was fetched for.
const MAX_SOURCE_CHARS = 24_000;

/**
 * @param {{ flow: any }} deps
 * @returns {import('./registry').ToolDef[]}
 */
function createFlowTools({ flow }) {
  /// Reads once and shares, because a turn usually asks for the composition and
  /// its variables in the same breath.
  async function readState() {
    const status = flow.status();
    if (!status.running) {
      return { ok: false, error: 'the NetsuFlow engine is not running; ask the user to start it' };
    }
    return { ok: true, state: await flow.state() };
  }

  return /** @type {import('./registry').ToolDef[]} */ ([
    {
      name: 'flow_read',
      description:
        'Read the current NetsuFlow composition: its size, frame rate, duration, the variables it '
        + 'declares with their types and current values, and optionally its source. Call this before '
        + 'proposing any change.',
      risk: 'read',
      surfaces: ['flow'],
      inputSchema: {
        type: 'object',
        properties: {
          includeSource: {
            type: 'boolean',
            description: 'Include the composition HTML. Large; only ask when the change needs it.',
          },
        },
      },
      handler: async (args) => {
        const read = await readState();
        if (!read.ok) return read;
        const state = read.state;
        const out = {
          ok: true,
          width: state.width,
          height: state.height,
          fps: state.fps,
          durationFrames: state.durationFrames,
          // Normalised rather than raw: the model needs the type and the bounds
          // to propose a value that will validate, not the whole declaration.
          variables: (state.variables || []).map((v) => ({
            id: v.id,
            type: v.type,
            label: v.label,
            group: v.group || undefined,
            value: v.default,
            unit: v.unit || undefined,
            min: v.min,
            max: v.max,
            options: v.options ? v.options.map((o) => o.value) : undefined,
          })),
          requestedSizes: state.requested,
        };
        if (args.includeSource) {
          const source = String(state.html || '');
          out.source = source.slice(0, MAX_SOURCE_CHARS);
          out.sourceTruncated = source.length > MAX_SOURCE_CHARS;
        }
        return out;
      },
    },

    {
      name: 'flow_propose',
      description:
        'Propose a change to the composition as typed operations. This does NOT apply anything: the '
        + 'user reviews the proposal, sees the preview, and applies it themselves. Use variable.set '
        + 'for a declared variable rather than editing the source to hard-code the same value.',
      risk: 'read',
      surfaces: ['flow'],
      inputSchema: {
        type: 'object',
        required: ['summary', 'operations'],
        properties: {
          summary: {
            type: 'string',
            description: 'One sentence the user will read before applying. Say what changes.',
          },
          operations: {
            type: 'array',
            items: {
              type: 'object',
              required: ['type'],
              properties: {
                type: { type: 'string', enum: [...OPERATION_TYPES] },
                variableId: { type: 'string' },
                value: {},
                width: { type: 'number' },
                height: { type: 'number' },
                source: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
          previewFrames: {
            type: 'array',
            items: { type: 'number' },
            description: 'Frames worth rendering so the user can judge the change.',
          },
        },
      },
      handler: async (args) => {
        const read = await readState();
        if (!read.ok) return read;
        const declared = new Map(
          (read.state.variables || []).map((v) => [v.id, v]),
        );

        // Validated here rather than at apply time: an operation naming a
        // variable that does not exist is a hallucination, and the model has to
        // be told so while it can still correct itself.
        const operations = [];
        const rejected = [];
        for (const raw of Array.isArray(args.operations) ? args.operations : []) {
          const type = String(raw?.type || '');
          if (!OPERATION_TYPES.includes(type)) {
            rejected.push({ operation: raw, reason: `unknown operation type: ${type}` });
            continue;
          }
          if (type === 'variable.set') {
            const variable = declared.get(String(raw.variableId || ''));
            if (!variable) {
              rejected.push({
                operation: raw,
                reason: `this composition declares no variable "${raw.variableId}"`,
              });
              continue;
            }
            operations.push({
              type,
              variableId: variable.id,
              value: raw.value,
              // Carried so the interface can show what it is replacing without
              // reading the composition again.
              previous: variable.default,
              reason: raw.reason ? String(raw.reason) : undefined,
            });
            continue;
          }
          if (type === 'format.set') {
            const width = Number(raw.width);
            const height = Number(raw.height);
            if (!Number.isInteger(width) || !Number.isInteger(height)
              || width < 16 || height < 16 || width > 8192 || height > 8192) {
              rejected.push({ operation: raw, reason: 'width and height must be integers in 16..8192' });
              continue;
            }
            operations.push({ type, width, height, reason: raw.reason ? String(raw.reason) : undefined });
            continue;
          }
          if (typeof raw.source !== 'string' || raw.source.trim() === '') {
            rejected.push({ operation: raw, reason: 'source.replace needs a non-empty source' });
            continue;
          }
          operations.push({ type, source: raw.source, reason: raw.reason ? String(raw.reason) : undefined });
        }

        if (operations.length === 0) {
          return {
            ok: false,
            error: 'no valid operation in the proposal',
            rejected,
          };
        }

        return {
          ok: true,
          proposal: {
            summary: String(args.summary || ''),
            operations,
            previewFrames: Array.isArray(args.previewFrames)
              ? args.previewFrames.filter((n) => Number.isInteger(n) && n >= 0).slice(0, 8)
              : [],
            baseRevision: `${read.state.width}x${read.state.height}:${(read.state.variables || []).length}`,
          },
          rejected,
          // Said to the model, not just to the user: without it, an agent
          // reports a change as done and the user is told something false.
          note: 'Proposed only. The user applies it; nothing has changed yet.',
        };
      },
    },
  ]);
}

module.exports = { createFlowTools, OPERATION_TYPES };
