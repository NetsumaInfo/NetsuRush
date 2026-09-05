# R03: AI agent redesign

## Decision

What agent concept measurably improves composition authoring without damaging
source, hiding changes, or making Resolve actions unpredictable?

## Starting position

User testing of the current agent experience is unsatisfactory. Existing code
proves that providers, streaming, a tool registry, and basic permissions exist;
it does not prove usefulness, trust, or editing quality. [ST-NR-AGENT]

## Research before architecture

1. Collect concrete failed/annoying sessions from the current agent when
   available: request, expectation, result, repair turns, and trust failure.
2. Observe at least five manual HyperFrames editing tasks after the manual
   Studio prototype exists.
3. Identify which steps are repetitive, semantic, visual, or dangerous.
4. Establish a no-agent timing/error baseline.
5. Compare chat-only, inline command, and change-set assistant interactions.

## Candidate concepts

### A: Chat with direct tools

Closest to the current system. Fast to extend, but makes scope and mutation
effects difficult to predict. Baseline only.

### B: Change-set assistant

The agent proposes typed edits, source diff, diagnostics, and preview frames;
the user applies them. Recommended candidate.

### C: Goal-driven autonomous session

The agent iterates on previews and validation until a quality goal passes.
Potential later mode, but only inside strict budgets and a disposable branch/
candidate session.

## Evaluation

Use the fixed corpus in `docs/07-ai-agent-redesign.md`. For each provider/model
and concept record:

- operation validity and final source validity;
- requested versus unrelated changes;
- visual acceptance at specified frames;
- first-pass success and repair turns;
- latency, tokens, monetary cost, local compute;
- cancellations, timeouts, and recovery;
- user confidence and whether diff/preview was inspected;
- whether manual editing was faster or clearer.

## Decision rule

Choose B unless evidence shows another concept is materially better without
weaker safety. Do not ship an autonomous default. Reuse current infrastructure
only where it passes focused tests; replacing it is allowed and expected.

