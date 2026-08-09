// @ts-check
// Préflight pur : inventorie les propriétés réellement présentes puis les confronte au contrat cible.

const {
  CAPABILITY_EXACT, CAPABILITY_APPROX, CAPABILITY_BAKE, CAPABILITY_UNSUPPORTED,
  capabilitiesFor,
} = require("./capabilities");

function keyframes(property) {
  return property && Array.isArray(property.keyframes) && property.keyframes.length > 0;
}

function addProperty(out, clip, property, path) {
  if (!property) return;
  out.push({ clip, property: path });
  if (keyframes(property)) out.push({ clip, property: `${path}.keyframes` });
}

function clipProperties(clip, index) {
  const out = [
    { clip: index, property: "clip.media" },
    { clip: index, property: "clip.trim", sourceExactness: clip.trimExactness },
    { clip: index, property: "clip.position" },
    { clip: index, property: "clip.track" },
  ];
  const transform = clip.video && clip.video.transform;
  if (transform) {
    addProperty(out, index, transform.position, "video.position");
    addProperty(out, index, transform.scale, "video.scale");
    addProperty(out, index, transform.anchor, "video.anchor");
    addProperty(out, index, transform.rotation, "video.rotation");
    addProperty(out, index, transform.opacity, "video.opacity");
    if (transform.flipX || transform.flipY) out.push({ clip: index, property: "video.flip" });
    if (transform.crop) out.push({ clip: index, property: "video.crop" });
  }
  const audio = clip.audio;
  if (audio) {
    addProperty(out, index, audio.gainDb, "audio.gain");
    addProperty(out, index, audio.volume, "audio.volume");
    addProperty(out, index, audio.pan, "audio.pan");
    addProperty(out, index, audio.mute, "audio.mute");
  }
  const timing = clip.timing;
  if (timing) {
    if (timing.speed && timing.speed.numerator !== timing.speed.denominator) out.push({ clip: index, property: "timing.speed" });
    if (timing.reverse) out.push({ clip: index, property: "timing.reverse" });
    if (timing.freeze) out.push({ clip: index, property: "timing.freeze" });
    if (timing.timeMap && timing.timeMap.length) out.push({ clip: index, property: "timing.timeMap" });
  }
  for (const property of clip.deferred || []) out.push({ clip: index, property });
  return out;
}

function targetStatus(capability, property) {
  // Hors socle natif SAUF si la cible sait le recréer : un titre que Resolve reçoit par Fusion est
  // approché, pas différé — le classer différé annoncerait une perte que le montage ne subit pas.
  if (property === "transition" || property === "effect") return "deferred";
  if (property === "text" && capability === CAPABILITY_UNSUPPORTED) return "deferred";
  if (capability === CAPABILITY_EXACT) return "expected";
  if (capability === CAPABILITY_APPROX) return "approximated";
  if (capability === CAPABILITY_BAKE) return "bakeAvailable";
  return "unsupported";
}

/**
 * @param {import('./types').TransferDoc} doc
 * @param {import('./types').TransferHost} target
 * @param {{ runtime?:Record<string,string>, allowBake?:boolean }} [opts]
 */
function assessTransfer(doc, target, opts = {}) {
  const capabilities = capabilitiesFor(target, opts.runtime);
  const properties = doc.clips.flatMap(clipProperties);
  // Un titre n'est pas un plan : il pèse UN axe (`text`), celui de sa recréation chez la cible.
  for (const _graphic of doc.graphics || []) properties.push({ clip: null, property: "text" });
  for (const property of doc.deferred || []) properties.push({ clip: null, property });

  const items = properties.map((item) => {
    const targetCapability = capabilities[item.property] || CAPABILITY_UNSUPPORTED;
    const sourceApprox = item.sourceExactness === "approx" || item.sourceExactness === "derived"
      || item.sourceExactness === "unknown";
    const capability = sourceApprox && targetCapability === CAPABILITY_EXACT
      ? CAPABILITY_APPROX
      : targetCapability;
    let status = targetStatus(capability, item.property);
    if (capability === CAPABILITY_BAKE && opts.allowBake) status = "baked";
    return {
      ...item,
      capability,
      status,
      reason: status === "unsupported" ? "targetCapabilityMissing"
        : sourceApprox ? "sourceValueApproximate"
          : status === "deferred" ? "outsideNativeScope"
            : status === "bakeAvailable" ? "bakeDisabled"
              : undefined,
    };
  });

  const count = (status) => items.filter((item) => item.status === status).length;
  return {
    target,
    total: items.length,
    exact: count("expected"),
    approximated: count("approximated"),
    baked: count("baked"),
    unsupported: count("unsupported"),
    deferred: count("deferred"),
    bakeAvailable: count("bakeAvailable"),
    faithful: items.every((item) => item.status === "expected"),
    items,
  };
}

module.exports = { assessTransfer, clipProperties };
