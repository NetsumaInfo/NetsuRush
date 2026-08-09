// @ts-check
// Propriétés simples que le lecteur AE historique ne consomme pas. Une clé absente reste absente :
// aucun défaut inventé ne doit masquer une capacité manquante selon la version de Resolve.

/** @returns {import('./types').TransferPropertySource} */
function propertySource(key) {
  return { host: "resolve", api: `TimelineItem.GetProperty(${key})`, exactness: "exact" };
}

async function rawProperty(item, key) {
  try {
    const value = await item.GetProperty(key);
    return value === null || value === undefined || value === "" ? undefined : value;
  } catch (_) {
    return undefined;
  }
}

async function numericProperty(item, key) {
  const raw = await rawProperty(item, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? { value, source: propertySource(key) } : undefined;
}

async function booleanProperty(item, key) {
  const raw = await rawProperty(item, key);
  if (raw === undefined) return undefined;
  const value = raw === true || raw === 1 || raw === "1" || String(raw).toLowerCase() === "true";
  return { value, source: propertySource(key) };
}

async function readAudio(item) {
  const gainDb = await numericProperty(item, "AudioGain");
  const volume = await numericProperty(item, "Volume");
  const pan = await numericProperty(item, "Pan");
  const mute = await booleanProperty(item, "Mute");
  if (!gainDb && !volume && !pan && !mute) return undefined;
  return { gainDb, volume, pan, mute };
}

async function readResolveProperties(item, kind) {
  let nativeId;
  try {
    const value = await item.GetUniqueId();
    if (value !== null && value !== undefined && value !== "") nativeId = String(value);
  } catch (_) {}
  return {
    nativeId,
    audio: kind === "audio" ? await readAudio(item) : undefined,
  };
}

module.exports = { readResolveProperties };
