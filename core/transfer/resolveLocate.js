// @ts-check
// Réconciliation document → TimelineItem. Jamais d'application au hasard : zéro ou plusieurs
// candidats avec la même empreinte sont signalés au writer.

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

/**
 * Identité STABLE d'un TimelineItem. Le proxy du pont Python fabrique un objet NEUF à chaque
 * décodage : deux proxies du même item Resolve ne sont jamais `===`, donc comparer l'objet rendu
 * par `AppendToTimeline` à ceux relus sur la timeline ne matchait JAMAIS — les plans étaient posés
 * puis déclarés introuvables, et aucune propriété ne leur était appliquée.
 */
async function uniqueIdOf(item) {
  if (!item) return "";
  try {
    const value = await item.GetUniqueId();
    return value === null || value === undefined ? "" : String(value);
  } catch (_) {
    return "";
  }
}

async function snapshot(item, kind, track) {
  let media = null;
  let path = "";
  let start = NaN;
  let end = NaN;
  let sourceStart = NaN;
  let sourceEnd = NaN;
  try { media = await item.GetMediaPoolItem(); } catch (_) {}
  try { path = media ? await media.GetClipProperty("File Path") : ""; } catch (_) {}
  try { start = Number(await item.GetStart()); } catch (_) {}
  try { end = Number(await item.GetEnd()); } catch (_) {}
  try { sourceStart = Number(await item.GetSourceStartFrame()); } catch (_) {}
  try { sourceEnd = Number(await item.GetSourceEndFrame()); } catch (_) {}
  return {
    item, kind, track, start, end, sourceStart, sourceEnd,
    path: normalizePath(path),
    id: await uniqueIdOf(item),
  };
}

async function timelineSnapshots(timeline, counts) {
  const out = [];
  for (const kind of ["video", "audio"]) {
    const count = counts[kind] || 0;
    for (let track = 1; track <= count; track++) {
      let items = [];
      try { items = (await timeline.GetItemListInTrack(kind, track)) || []; } catch (_) {}
      for (const item of items) out.push(await snapshot(item, kind, track));
    }
  }
  return out;
}

// `GetSourceEndFrame` est INCLUSIF (cf. `core/ae/timelineRead`), donc du même bord que `srcOut`.
function sourceMatches(candidate, clip) {
  if (!Number.isFinite(candidate.sourceStart) || !Number.isFinite(candidate.sourceEnd)) return true;
  if (clip.timing && clip.timing.reverse) {
    return candidate.sourceStart === clip.srcOut && candidate.sourceEnd === clip.srcIn;
  }
  if (clip.timing && clip.timing.freeze) return candidate.sourceStart === candidate.sourceEnd;
  return candidate.sourceStart === clip.srcIn && candidate.sourceEnd === clip.srcOut;
}

/** Média, piste et position : ce qu'une pose ne peut pas avoir changé. */
function baseMatches(candidate, clip, placement) {
  const duration = clip.tlEnd - clip.tlStart;
  return candidate.kind === clip.kind
    && candidate.track === placement.trackIndex
    && candidate.path === normalizePath(clip.path)
    && candidate.start === placement.recordFrame
    && (!Number.isFinite(candidate.end) || candidate.end === placement.recordFrame + duration);
}

function candidatesFor(snapshots, clip, placement) {
  return snapshots.filter((candidate) => baseMatches(candidate, clip, placement) && sourceMatches(candidate, clip));
}

/**
 * @param {any[]} snapshots
 * @param {import('./types').TransferClip} clip
 * @param {import('./types').ResolvePlacement} placement
 * @param {string} [nativeId] identité rendue par `AppendToTimeline`, quand elle est lisible
 */
function locateResolveClip(snapshots, clip, placement, nativeId) {
  if (nativeId) {
    const direct = snapshots.find((candidate) => candidate.id && candidate.id === nativeId);
    if (direct) return { ok: true, item: direct.item, snapshot: direct, via: "appendReturn" };
  }
  const strict = candidatesFor(snapshots, clip, placement);
  if (strict.length === 1) return { ok: true, item: strict[0].item, snapshot: strict[0], via: "fingerprint" };
  if (strict.length > 1) return { ok: false, reason: "ambiguousTimelineItem", matches: strict.length };

  // Les bornes SOURCE relues peuvent être ancrées sur le Start TC du média, donc différer de celles
  // demandées sans que le plan soit le mauvais. Média, piste et position suffisent alors à lever le
  // doute — à condition qu'il n'y ait qu'un seul candidat.
  const loose = snapshots.filter((candidate) => baseMatches(candidate, clip, placement));
  if (loose.length === 1) return { ok: true, item: loose[0].item, snapshot: loose[0], via: "position" };
  return {
    ok: false,
    reason: loose.length ? "ambiguousTimelineItem" : "timelineItemNotFound",
    matches: loose.length,
  };
}

module.exports = { normalizePath, timelineSnapshots, candidatesFor, locateResolveClip, uniqueIdOf };
