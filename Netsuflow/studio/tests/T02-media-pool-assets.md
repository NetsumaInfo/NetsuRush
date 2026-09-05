# T02: Media Pool assets

## Question

Can Studio expose Resolve media with stable identity and correct availability,
including large and pathological Media Pools?

## Fixture project

Use a disposable project with:

- nested bins and duplicate names;
- same file imported into multiple bins;
- video, audio, still, sequence, Unicode, long, and network paths;
- offline item;
- generator/Fusion/compound/multicam items;
- relinked and renamed media;
- at least 10,000 synthetic/imported items for performance sampling.

## Scenarios

- enumerate and compare IDs/properties against Resolve UI;
- cancel enumeration during project switch;
- save, close, reopen, restart Resolve, and compare identities;
- create linked, copied, and managed-proxy references;
- remove/move/relink a source file and recover;
- ensure duplicate names never select the wrong item;
- verify no unsupported item is reported ready;
- serve asset through the tokenized preview origin;
- reject traversal and untrusted paths.

## Measurements

- total and per-1,000-item enumeration latency;
- Python bridge calls/round trips;
- memory/cache size;
- stable-ID survival table;
- classification correctness;
- cancellation latency;
- preview readiness for each asset mode.

## Pass

All file-backed assets are identified without name guessing; unavailable items
are classified; project switching cannot leak stale assets; and large-pool
latency remains within the budget chosen from measured current NetsuRush usage.

