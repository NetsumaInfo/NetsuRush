# Architecture decision framework

## Rule

Do not choose one architecture by elegance alone. Record test evidence, apply mandatory gates, then score only the surviving candidates.

## Mandatory gates

Every shipping candidate must satisfy:

- deterministic frame identity;
- accepted visual fidelity against T01;
- reliable final export;
- recoverable errors and cancellation;
- clean-install packaging for its declared platform;
- explicit security and licensing acceptance;
- an official renderer fallback unless the candidate itself uses the official renderer.

A candidate that fails a mandatory gate is not rescued by a high weighted score.

## Weighted score

Score each surviving architecture from 0 to 5 using stored evidence.

| Criterion | Weight | Evidence |
|---|---:|---|
| Visual fidelity | 20 | T01/T02/T05/T06 pixel reports |
| Remotion compatibility | 15 | Fixture compatibility matrix |
| Timeline and update experience | 15 | T02/T03/T04 timing and seek results |
| Final-export reliability | 15 | Repeated export hashes and failure tests |
| Fusion editability | 10 | Native nodes, Inspector controls, manual edit report |
| Windows/macOS packaging | 10 | T07 clean-install matrix |
| Development and maintenance cost | 10 | Native components, undocumented dependencies, operational burden |
| Security and licensing | 5 | T07 review and decisions |
| **Total** | **100** | |

Do not fill the score table before protocols run. Pre-scoring would convert expectations into evidence.

## Candidate scorecard

| Candidate | Mandatory gates | Weighted score | Confidence | Decision |
|---|---|---:|---|---|
| A1 Official render/import | Not run | - | None | Pending T01/T04/T07 |
| A2 Persistent frame service | Not run | - | None | Pending T03/T04/T07 |
| A3 OGraf live | Not run | - | None | Pending T02/T07 |
| A4 Native IR compiler | Not run | - | None | Pending T05 |
| A5 Explicit hybrid | Not run | - | None | Pending T06 |
| A6 OpenFX service source | Not run | - | None | Pending T04/T07 |
| A7 Remotion import framework | Not run | - | None | Pending T01/T02/T05/T08/T07 |

## Named product questions

The final decision record must answer these separately:

### A - Easiest first prototype

Expected candidate: A1 PNG sequence and script/import. Confirmation requires T01.

### B - Best user experience

Expected candidate: A3 OGraf if T02 and T07 pass. If not, compare A2 through H3/H5 using measured cold/warm behavior.

### C - Most technically elegant

Evaluate two meanings:

- live integration elegance: A3 aligns Resolve's exact-time CEF rendering with a frame-controlled React composition;
- native compiler elegance: A4 separates source syntax, semantic IR, and Fusion backend.

Elegance never overrides a mandatory correctness or packaging gate.

### D - Most realistic product

Expected shape, subject to tests:

```text
Auto
  -> OGraf Live when compatible and passing
  -> official Render/cache otherwise

Native
  -> explicit supported subset only
```

A7 may become the user-facing `Auto` orchestrator, but it is not an independent pixel backend. Its score must include the correctness of its classification and the evidence of every backend it can select.

### E - Best Remotion compatibility

Expected candidate: A1, followed by A2 when it retains the official renderer. Confirmation requires the fixture corpus and final-export tests.

## Decision tree

```text
T01 official renderer baseline passes?
├── no  -> stop and fix baseline
└── yes
    ├── T02 OGraf passes correctness + export + package gates?
    │   ├── yes -> Live candidate = OGraf
    │   └── no  -> run T03 persistent renderer
    │            ├── usable -> choose adapter through T04
    │            └── slow   -> Render/Update workflow only
    └── T05 native subset has proven user value?
        ├── yes -> run T08 import-framework classification
        │         ├── safe -> optional Auto/Native import modes
        │         └── unsafe -> keep explicit Native authoring only
        └── no  -> do not build native compiler

Hybrid is considered only after both a native path and a rendered path pass independently.
```

## Decision record template

```markdown
# NetsuFlow architecture decision - <date>

## Decision

## Supported modes and platforms

## Evidence reviewed

## Mandatory gates

## Weighted scores

## Rejected alternatives

## Known limitations

## Packaging and licensing status

## Revisit triggers
```

## Revisit triggers

Reopen the decision only when at least one of these changes:

- Remotion introduces a supported persistent-page/frame server or NLE interchange API;
- Resolve changes OGraf/CEF behavior or platform support;
- measured user workflows require native node editability;
- a new OpenFX/Fuse host capability removes an existing blocker;
- licensing or distribution terms change;
- a failing fixture becomes supported by a new renderer version.

Remotion issue #10235 is monitored only for adjacent NLE interchange developments; it does not by itself change the Fusion rendering decision. [S-REM-ISSUE-10235]
