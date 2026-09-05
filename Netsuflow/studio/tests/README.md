# Studio decision tests

These tests are evidence gates, not ordinary implementation checklists. Run
them in order after the current NetsuFlow OpenFX renderer gates pass.

| Order | Test | Decision |
|---:|---|---|
| 1 | [`T01-hyperframes-component-embedding.md`](T01-hyperframes-component-embedding.md) | reusable editor surface |
| 2 | [`T02-media-pool-assets.md`](T02-media-pool-assets.md) | reliable Resolve asset catalog |
| 3 | [`T03-resolve-publishing.md`](T03-resolve-publishing.md) | live and rendered timeline delivery |
| 4 | [`T04-agent-change-sets.md`](T04-agent-change-sets.md) | replacement agent concept |
| 5 | [`T05-cross-engine-contract.md`](T05-cross-engine-contract.md) | later Remotion without rewrite |
| 6 | [`T06-selection-inspector-fusion-overlay.md`](T06-selection-inspector-fusion-overlay.md) | shared selection, property authorability, and Fusion overlay |

## Result format

Every run creates `results/<test>-YYYY-MM-DD/` containing:

- `report.md` with environment, versions, procedure, raw result table, and
  decision;
- commands/logs without secrets or absolute private media paths;
- machine-readable measurements;
- screenshots or short captures for interaction/visual claims;
- fixture hashes;
- source/package export fingerprints where relevant.

Reports use `confirmed`, `refuted`, `constrained`, or `unknown`. A partial pass
never silently becomes a product promise.
