// Lets a composition that does not use GSAP start in milliseconds instead of
// forty-five seconds, without giving up the wait for one that does.
//
// The engine will not capture until every element carrying
// `data-composition-id` has a matching entry in `window.__timelines`, which is
// something only a GSAP-driven composition registers. A composition animated by
// CSS, rAF, or its own arithmetic never will, so the engine waits out its full
// `playerReadyTimeout` — measured at 45,179 ms against 129 ms with the opt-out.
// The engine names the opt-out itself: `data-no-timeline` on the host.
//
// Lowering `playerReadyTimeout` instead would be the wrong lever: the same
// timeout also bounds the wait for `window.__hf`, and a heavy composition may
// legitimately need seconds to expose it.
//
// The shim is served as an injected head script, so a user's project file on
// disk is never modified. It is applied by the project server, which already
// rewrites only the entry point.

/// - `gsap`: the composition registers timelines. No shim; the engine's own
///   wait applies in full.
/// - `auto`: wait a short grace period, then stop waiting on any host that has
///   not registered a timeline by then. A GSAP composition registers during
///   setup and is untouched.
/// - `none`: the composition is known not to use timelines. Opt out as soon as
///   the DOM is parsed.
export const TIMELINE_MODES = Object.freeze(['auto', 'gsap', 'none']);

/// Chosen from measurement, not taste. A composition whose timeline registers
/// after the grace is captured before its animation exists, and nothing reports
/// an error, so the grace has to cover a realistically slow setup: fonts,
/// decoded media, an async data step. 3 s is still 15x better than the 45 s
/// stall it replaces, and session init happens once per binding revision rather
/// than once per frame. A project slower than this needs `gsap` mode, and the
/// adapter says so whenever the shim actually marks a host.
export const DEFAULT_GRACE_MS = 3000;
const MAX_GRACE_MS = 30_000;

/**
 * Returns the script tag to inject, or `null` for `gsap` mode.
 *
 * The generated source is deliberately plain ES5-era JavaScript: it runs before
 * anything else on the page and must not depend on what the composition's own
 * tooling does or does not provide.
 */
export function buildTimelineShim({ mode, graceMs = DEFAULT_GRACE_MS } = {}) {
  if (!TIMELINE_MODES.includes(mode)) {
    throw new Error(
      `timeline mode must be one of ${TIMELINE_MODES.join(', ')}; received ${JSON.stringify(mode)}`,
    );
  }
  if (mode === 'gsap') return null;

  const grace = mode === 'none' ? 0 : graceMs;
  if (!Number.isFinite(grace) || grace < 0 || grace > MAX_GRACE_MS) {
    throw new Error(`timeline grace must be a finite number between 0 and ${MAX_GRACE_MS} ms`);
  }

  // No interpolation reaches the script body except this integer, which is
  // range-checked above, so the tag cannot be broken out of.
  const graceLiteral = String(Math.round(grace));

  return `<script>${`
(function () {
  'use strict';
  var GRACE_MS = ${graceLiteral};
  var MODE = ${JSON.stringify(mode)};

  function markHostsWithoutTimelines() {
    var timelines = window.__timelines || {};
    var hosts = document.querySelectorAll('[data-composition-id]');
    var marked = [];
    var kept = [];
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      // Never override an explicit choice already made by the author.
      if (host.hasAttribute('data-no-timeline')) continue;
      var id = host.getAttribute('data-composition-id');
      if (!id) continue;
      if (timelines[id]) {
        kept.push(id);
      } else {
        host.setAttribute('data-no-timeline', '');
        marked.push(id);
      }
    }
    // Marking a host is a decision taken about someone else's project, so it is
    // reported rather than made silently. The adapter reads this back.
    window.__netsuflowTimelineShim = {
      mode: MODE,
      graceMs: GRACE_MS,
      marked: marked,
      kept: kept,
      ran: true
    };
  }

  function schedule() {
    if (GRACE_MS === 0) markHostsWithoutTimelines();
    else window.setTimeout(markHostsWithoutTimelines, GRACE_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }
})();
`}</script>`;
}
