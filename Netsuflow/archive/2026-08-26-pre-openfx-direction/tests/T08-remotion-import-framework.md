# T08 - Remotion import framework

## Decision

Can NetsuFlow import existing Remotion source, classify it conservatively, explain its decision, and route it to a proven backend without an incorrect native optimization?

The test evaluates the framework described in `research/05-remotion-import-framework.md`. It does not test a new pixel renderer.

## Preconditions

- T01 provides the official-renderer oracle.
- T02 provides an OGraf compatibility table before `live-safe` claims are enabled.
- T05 provides native IR mappings before `native-safe` claims are enabled.
- Every tested tool and runtime version is recorded.

## Analyzer fixture set

In addition to F00-F09, create source variants that preserve or alter semantics:

- direct imports and aliased imports from Remotion;
- re-exported local components;
- nested function components;
- conditions with static and props-dependent branches;
- loops and `.map()` with static and runtime-dependent lengths;
- inline styles, object spreads, helper-generated styles, and CSS classes;
- wrapper components around `Sequence`, images, and text;
- known and unknown npm components;
- dynamic imports;
- Canvas/WebGL/Three.js;
- local and remote assets/fonts;
- seeded and unseeded randomness;
- clock, network, filesystem, and environment access;
- intentionally malformed or hostile project paths.

## Expected classification oracle

Before running the analyzer, each fixture receives a reviewed expected classification:

```text
native-safe
live-safe but not native-safe
render-required
blocked by product policy
```

The oracle includes exact expected diagnostics and relevant source locations. It may cite T02/T05 capability evidence but cannot be generated from the analyzer under test.

## Procedure

1. Discover compositions and props in a minimal valid Remotion project.
2. Parse every analyzer fixture with Babel and, where selected, TypeScript symbol resolution. [S-BABEL-PARSER] [S-BABEL-TRAVERSE] [S-TS-COMPILER]
3. Compare detected imports, constructs, assets, and source locations with the oracle.
4. Run classification twice from a clean process; compare normalized output hashes.
5. Change only formatting/comments; verify semantic classification remains stable.
6. Change one supported construct to an unsupported variant; verify classification becomes more conservative.
7. Add an unknown component and verify it cannot remain native-safe.
8. Remove OGraf capability evidence and verify `live-safe` is no longer selected.
9. Remove native capability evidence and verify Native selection is impossible.
10. Run `Auto`, `Native`, and `Render` policy decisions for every fixture.
11. Verify `Native` fails closed with diagnostics instead of silently choosing approximate output.
12. Verify `Auto` falls through Native, OGraf, then official Render in that order.
13. Render all Render fallbacks and compare them with T01.
14. Modify source, props, dependencies, assets, and framework capability versions; verify analysis invalidation.
15. Attempt path traversal, package scripts, missing lockfiles, remote dependencies, and untrusted roots under the product security policy.

## Measurements

- composition-discovery and analysis latency;
- peak memory for small and stress projects;
- exact classification accuracy;
- native false-positive count;
- live false-positive count;
- conservative fallback count;
- source-location precision;
- normalized result stability;
- invalidation correctness;
- number of projects importable without source changes.

Performance is secondary to correctness. A slow conservative analyzer may be optimized; a fast false native positive invalidates the framework.

## Required evidence

- analyzer fixture repository and reviewed oracle;
- normalized `analysis.json`, `capabilities.json`, and `decision.json` outputs;
- source-location diagnostic snapshots;
- classification confusion matrix;
- repeated-run hashes;
- invalidation logs;
- fallback render comparisons;
- hostile-project/security results;
- per-version capability manifest.

## Pass gates

- Zero native false positives in the reviewed corpus.
- Zero live false positives for capabilities claimed from T02.
- Unknown constructs reduce compatibility rather than being ignored.
- `Native` never emits a graph for a composition that is not fully native-safe.
- `Auto` always selects a proven backend and records the reasons.
- Render fallback matches the T01 oracle.
- Diagnostics include actionable source locations for recognized blockers.
- Repeated analysis is deterministic under the same source and version set.
- Every pixel-affecting change invalidates the prior decision.
- Analysis does not install dependencies or escape the trusted project root.

## Interpretation

- Full pass: A7 may become the user-facing import and `Auto` framework.
- Conservative pass with many Render fallbacks: framework remains useful for import, diagnostics, and future capability growth.
- Native false positive: block all automatic native routing until fixed and the corpus is expanded.
- Unstable classification: retain explicit user-selected Render/OGraf/Native modes without an `Auto` promise.
- Security failure: block arbitrary project import from the product.

## Product decision effect

T08 decides whether NetsuFlow can honestly present itself as a Remotion import-and-translation framework. It does not change the requirement that every selected backend pass its own rendering, Fusion, packaging, and licensing gates.
