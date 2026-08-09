# Code style

Structure first: one file, one responsibility; short functions; no monoliths. When a file or a function grows, **split** it (extract helpers, hooks, sub-components, modules) instead of stacking. Never leave large duplicated or inlined blocks.

## Splitting rules

- **Renderer**: a component past ~300 lines gets sub-components (`components/<feature>/`), with logic moved into hooks (`use…`) or helpers (`lib/`). No giant JSX, no catch-all `useEffect`.
- **`core/rpc.js`**: every entry in the handler table stays thin and delegates to a `core/` module with injected dependencies. No 100-line handler, no business logic in `rpc.js` or `server.js`.
- **Python**: one module, one responsibility; each global owned by exactly one module. The search backend is split into a package (config, db, model, query, media, store, index, catalog, faces) with a thin entry point.
- Factor repeated code (proxy/thumbnail/probe, frame mapping, gates) into one place. Shared helpers: `core/utils.js`, `src/lib/utils.ts` — the latter is the single renderer-side source, re-exported where convenient.
- `npm run build` (strict tsc) must stay green after a refactor.

## Rules applied to every change

- **Search before adding**: grep for an existing helper, hook or module before writing a new function. Never a third utility that duplicates `core/utils.js` or `src/lib/utils.ts`.
- **One function, one thing, one level of abstraction.** ~40 lines maximum. Beyond that, extract. A function mixing I/O, computation and rendering splits into three.
- **Early return over nesting**: three nested `if`/`for` levels is a signal to split. Handle error and empty cases first, keep the nominal path flat at the bottom.
- **Explicit English naming** for code, symbols and files. No in-house abbreviations. A name that needs a comment to be understood is a bad name.
- **No magic number or string in a body**: named constants at the top of the module, defined once and shared when several modules read them.
- **No boolean parameter that switches between two behaviours** → two functions, or a named options object.
- **Side effects at the boundaries**: filesystem, network, spawn and host calls live in dedicated modules. Frame math, mapping and decision logic stay pure functions, so they are reviewable and testable without a runtime.
- **Errors are never swallowed**: no silent `catch {}`. Either rethrow with context (path, channel, id) or log through the log bus while explaining the fallback. A silent fallback must be a documented choice, not an oversight.
- **Delete, do not comment out**: zero dead code, zero commented blocks, zero legacy flag kept "just in case". Git keeps the history.
- **Comment the WHY, never the WHAT**: a comment justifies an invariant, a runtime trap or an API workaround. A comment paraphrasing the next line gets deleted.
- **No import cycles**: `src/lib/*` stays pure (zero store imports); use the `@/` alias everywhere, never deep `../../..` chains.
- **File order**: types and constants → private helpers → main export. A file reads top to bottom without jumping.
- **Refactor at constant behaviour**, in a commit separate from behaviour changes — otherwise review cannot tell a move from a regression.
- **Bounded boy-scouting**: leave a touched file cleaner than you found it (local rename, obvious extraction) without refactoring outside the requested scope.
- **Every new IPC channel stays aligned in the three places** (handler table, typed client, mock). A channel added in one place only is immediate debt.
- **An invariant you document must be locked by a test**, otherwise nothing holds it.
- **Verify before concluding**: the type-checks and the tests covering the touched area. Anything that requires launching the app is reported explicitly as **not verified at runtime** — never as done.
