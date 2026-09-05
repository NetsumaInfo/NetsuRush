# Risk register

| ID | Risk | Impact | Current likelihood | Mitigation / evidence gate |
|---|---|---:|---:|---|
| ST-R01 | Studio packages are too coupled to their own app state | High | High | T01 imports components individually; wrapper and SDK-only fallback |
| ST-R02 | Pre-1.0 HyperFrames API drift breaks the editor | High | High | exact pins, export/type fingerprints, upgrade gate |
| ST-R03 | HyperFrames UI cannot match NetsuRush theming/accessibility | Medium | Medium | own shell; replace resistant components |
| ST-R04 | Arbitrary source is rendered but not structurally editable | Medium | Certain | explicit capabilities; code fallback; no destructive inference |
| ST-R05 | Preview and saved/rendered output diverge | Critical | Medium | identical asset manifest/revisions; golden frames; T01/T03 |
| ST-R06 | Media Pool item has no usable local file path | Medium | High | classified unavailable/proxy workflow; T02 |
| ST-R07 | Duplicate names/paths link the wrong Resolve item | High | Medium | stable IDs + fingerprints; never name identity |
| ST-R08 | Automatic OFX insertion cannot assign binding | High | Medium | T03 host spike; manual binding fallback or rendered publish |
| ST-R09 | Flattened update replaces unrelated timeline uses | Critical | Medium | versioned artifacts by default; no implicit `ReplaceClip` |
| ST-R10 | Resolve changes project/timeline during publish | High | Medium | immutable target snapshot, recheck before mutation, partial record |
| ST-R11 | Polling causes stale or expensive synchronization | Medium | Medium | bounded fingerprints, explicit refresh, cancellation, metrics |
| ST-R12 | Code edits conflict with visual/agent patches | High | High | revisioned change sets and explicit history boundaries |
| ST-R13 | Preview iframe exposes filesystem/core credentials | Critical | Medium | tokenized isolated origin, no direct RPC, path containment |
| ST-R14 | User project code performs unwanted network/actions | Critical | High | trust gate, default-deny network, worker isolation |
| ST-R15 | Agent damages source or changes unrelated behavior | Critical | High today | full redesign, draft-only default, diff/preview/apply, T04 corpus |
| ST-R16 | Agent mutates Resolve without clear intent | Critical | Medium | separate explicit publish approval and scoped tool |
| ST-R17 | Agent quality is worse than manual editing | High | High today | task corpus, baseline comparison, stop condition |
| ST-R18 | Common abstraction becomes a premature universal IR | High | Medium | capability contract only; source stays engine-specific |
| ST-R19 | Remotion addition requires UI/Resolve rewrite | High | Medium | T05 stub adapter before HyperFrames UI hardening |
| ST-R20 | Remotion licensing blocks bundled product | Critical | Medium | separate legal/distribution gate before implementation |
| ST-R21 | Editor scope becomes a second Resolve NLE | Critical | High | first milestone limited to composition authoring/publish |
| ST-R22 | Large projects make timeline/preview unusable | High | Medium | virtualization/perf budgets in T01; representative fixtures |
| ST-R23 | Dependency/browser packaging breaks clean machines | Critical | High | current extension delivery gate first; offline packaging tests |
| ST-R24 | Studio work distracts from unfinished OpenFX foundation | High | High | phase gate: no Studio implementation until renderer checklist passes |

## Stop conditions

Pause or narrow the Studio implementation if:

- T01 cannot isolate usable HyperFrames editing behavior behind a stable adapter;
- the only viable path is embedding an uncustomizable complete `StudioApp`;
- preview cannot use the exact project revision that render/OpenFX consumes;
- Resolve cannot reliably identify published items or repair partial operations;
- clean-machine packaging exceeds the product's acceptable footprint without a
  user-controlled optional component;
- the redesigned agent cannot beat manual workflows on the agreed task corpus.

## Decision cadence

Every test report updates this register and one of four states:

```text
confirmed | refuted | constrained | still unknown
```

Unknown behavior never becomes an implied product promise.

