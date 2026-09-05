// Lets a composition authored for HyperFrames Studio render against the raw
// engine, so a page can be pasted in as-is instead of rewritten by hand.
//
// A Studio composition and an engine composition are not the same document.
// Studio's runtime does four things this project otherwise never does, and a
// pasted page fails on all four at once with no error anywhere:
//
//   1. It clones a `<template>` into the page. A Studio entry keeps its real
//      content inside `<template>`, which the parser stores in an inert
//      document fragment: nothing inside it renders, and its scripts never run.
//   2. It answers `window.__hyperframes.getVariables()`. Without it the page's
//      own setup throws on the first read, before it draws anything.
//   3. It registers the composition's GSAP timeline as the seekable clock.
//      The engine's contract is `window.__hf = { duration, seek }`; a Studio
//      page publishes `window.__timelines[id]` instead and never defines __hf.
//   4. It supplies variable values. Here the declared defaults are used, which
//      is what a preview wants.
//
// The shim is injected as a head script, so the pasted file on disk is never
// modified — same rule as the timeline shim beside it.

/// Cloned template scripts do not execute: the HTML parser marks a script that
/// was created by cloning as already-started. Re-creating each one is the only
/// way to run it, and it has to be done in document order because a Studio page
/// loads its animation library with one tag and uses it in the next.
const SHIM_SOURCE = String.raw`
(function () {
  'use strict';

  /// Long enough that a host asking for a few seconds of a still gets frames
  /// rather than a clamp, short enough that a pre-render of one does not sweep
  /// thousands of identical pictures.
  var STATIC_DURATION_SECONDS = 10;

  var log = function (message) {
    try { console.log('[studio-shim] ' + message); } catch (e) {}
  };

  // ---- 2. Variables -------------------------------------------------------
  // Defaults are read from the declaration the page carries, so a composition
  // that adds a variable keeps working without touching this shim.
  function readDeclaredVariables() {
    var host = document.querySelector('[data-composition-variables]');
    if (!host) return {};
    var declared;
    try {
      declared = JSON.parse(host.getAttribute('data-composition-variables'));
    } catch (error) {
      log('data-composition-variables is not valid JSON; using no variables');
      return {};
    }
    if (!Array.isArray(declared)) return {};
    var out = {};
    for (var i = 0; i < declared.length; i += 1) {
      var entry = declared[i];
      if (entry && typeof entry.id === 'string' && 'default' in entry) {
        out[entry.id] = entry.default;
      }
    }
    return out;
  }

  // Supplied values win over declared defaults, one key at a time, so setting
  // a single parameter does not silently drop the rest.
  var supplied = __STUDIO_VARIABLES__;
  var variables = null;
  window.__hyperframes = window.__hyperframes || {};
  if (typeof window.__hyperframes.getVariables !== 'function') {
    window.__hyperframes.getVariables = function () {
      if (variables === null) {
        variables = readDeclaredVariables();
        for (var key in supplied) {
          if (Object.prototype.hasOwnProperty.call(supplied, key)) variables[key] = supplied[key];
        }
      }
      return variables;
    };
  }

  // ---- 1. Template mounting ----------------------------------------------
  function templateWithComposition() {
    var templates = document.getElementsByTagName('template');
    for (var i = 0; i < templates.length; i += 1) {
      if (templates[i].content.querySelector('[data-composition-id]')) return templates[i];
    }
    return templates.length > 0 ? templates[0] : null;
  }

  function runScriptsInOrder(container, done) {
    var pending = container.querySelectorAll('script');
    var index = 0;
    function next() {
      if (index >= pending.length) { done(); return; }
      var original = pending[index];
      index += 1;
      var replacement = document.createElement('script');
      for (var a = 0; a < original.attributes.length; a += 1) {
        var attribute = original.attributes[a];
        replacement.setAttribute(attribute.name, attribute.value);
      }
      replacement.text = original.text;
      if (original.src) {
        // An external tag must finish before the next inline tag reads it.
        // Failing forward rather than stalling: a missing library produces a
        // page error the caller can see, where a stall produces a timeout that
        // says nothing about why.
        replacement.onload = next;
        replacement.onerror = function () {
          log('failed to load ' + original.src);
          next();
        };
      }
      original.parentNode.replaceChild(replacement, original);
      if (!original.src) next();
    }
    next();
  }

  function mount(done) {
    var template = templateWithComposition();
    if (!template) { done(); return; }
    var host = template.parentNode;
    var fragment = template.content.cloneNode(true);
    host.insertBefore(fragment, template);
    template.parentNode.removeChild(template);
    log('mounted a template');
    runScriptsInOrder(host, done);
  }

  // ---- 3. Timeline as clock ----------------------------------------------
  function firstTimeline() {
    var registry = window.__timelines;
    if (!registry) return null;
    for (var key in registry) {
      if (Object.prototype.hasOwnProperty.call(registry, key)) {
        var candidate = registry[key];
        if (candidate && typeof candidate.seek === 'function' &&
            typeof candidate.duration === 'function') {
          return { key: key, timeline: candidate };
        }
      }
    }
    return null;
  }

  function declaredDuration() {
    var host = document.querySelector('[data-composition-duration]');
    var value = host && parseFloat(host.getAttribute('data-composition-duration'));
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function publish(found, allowStatic) {
    if (window.__hf && typeof window.__hf.seek === 'function') return true;
    var timeline = found ? found.timeline : null;
    var duration = timeline ? timeline.duration() : 0;
    if (!(duration > 0)) duration = declaredDuration();
    // A composition with no animation is still a composition: an overlay, a
    // lower third, a logo. Refusing it would mean the only way to render a
    // still frame is to add a timeline that does nothing. So once the wait is
    // over, a page that never produced a clock gets a static one.
    if (!(duration > 0) && allowStatic) duration = STATIC_DURATION_SECONDS;
    if (!(duration > 0)) return false;

    if (timeline && typeof timeline.pause === 'function') timeline.pause();

    window.__hf = {
      duration: duration,
      currentTime: 0,
      currentFrame: 0,
      seek: function (seconds) {
        var clamped = Math.min(Math.max(seconds, 0), duration);
        if (timeline) timeline.seek(clamped, false);
        window.__hf.currentTime = clamped;
      }
    };
    // Two frames: a seek writes styles, and the browser applies them on the
    // next style flush. Capturing before that returns the previous position.
    window.__hfWaitForSeekCompletion = function () {
      return new Promise(function (resolve) {
        requestAnimationFrame(function () { requestAnimationFrame(resolve); });
      });
    };
    window.__hf.seek(0);
    log('published __hf from ' + (timeline ? 'timeline ' + found.key : 'the declared duration') +
        ', duration ' + duration + 's');
    return true;
  }

  // A Studio page builds its timeline inside the cloned scripts, so the wait
  // starts only after they have run, and still polls: a composition may load
  // media or fonts before it builds anything.
  function waitForTimeline(deadlineMs) {
    var startedAt = Date.now();
    (function poll() {
      if (publish(firstTimeline(), false)) return;
      if (Date.now() - startedAt > deadlineMs) {
        // Last resort rather than first: a page that builds its timeline
        // slowly must not be frozen into a still because the shim gave up
        // early, so the static clock only appears once the wait is spent.
        if (publish(null, true)) {
          log('no timeline after ' + deadlineMs + 'ms; rendering as a static composition');
        }
        return;
      }
      setTimeout(poll, 50);
    })();
  }

  function begin() { mount(function () { waitForTimeline(__STUDIO_DEADLINE_MS__); }); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', begin);
  } else {
    begin();
  }
})();
`;

export const DEFAULT_STUDIO_DEADLINE_MS = 10_000;
const MAX_STUDIO_DEADLINE_MS = 60_000;

/// The values are caller data, so they are the one thing here that could carry
/// a closing tag. Escaping the three sequences that end a script element, plus
/// the two line separators JSON leaves raw and JavaScript treats as newlines,
/// makes the literal inert whatever it contains.
function embedJson(value) {
  return JSON.stringify(value ?? {})
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

/**
 * Returns the script tag to inject for Studio-authored compositions.
 *
 * `variables` overrides the page's own declared defaults, key by key. This is
 * the parameter surface a catalog component publishes in
 * `data-composition-variables`, which is what makes one authored component
 * reusable rather than a fixed picture.
 */
export function buildStudioShim({
  deadlineMs = DEFAULT_STUDIO_DEADLINE_MS,
  variables = null,
} = {}) {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_STUDIO_DEADLINE_MS) {
    throw new Error(
      `studio deadline must be a finite number between 1 and ${MAX_STUDIO_DEADLINE_MS} ms`,
    );
  }
  if (variables !== null && (typeof variables !== 'object' || Array.isArray(variables))) {
    throw new Error('studio variables must be a plain object of id -> value');
  }
  const body = SHIM_SOURCE.replace('__STUDIO_DEADLINE_MS__', String(Math.round(deadlineMs)))
    .replace('__STUDIO_VARIABLES__', embedJson(variables));
  return `<script>${body}</script>`;
}
