// @ts-check
// Normalise résultats déclarés par writers et readback propriété par propriété.

function countValue(value) {
  if (Array.isArray(value)) return value.length;
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

function statusCounts(items) {
  const counts = { applied: 0, approximated: 0, baked: 0, unsupported: 0, deferred: 0, readbackMismatch: 0 };
  for (const item of items || []) {
    if (Object.prototype.hasOwnProperty.call(counts, item.status)) counts[item.status] += 1;
  }
  return counts;
}

/**
 * @param {ReturnType<import('./equivalence').assessTransfer>} assessment
 * @param {any} result
 */
function transferReport(assessment, result) {
  const writerItems = Array.isArray(result && result.report && result.report.items)
    ? result.report.items
    : [];
  const counts = statusCounts(writerItems);
  const declaredIssues = countValue(result && result.failed) + countValue(result && result.skipped)
    + countValue(result && result.missing) + (result && result.tracksClamped ? 1 : 0);
  const expectedProperties = assessment.items.filter((item) => item.status === "expected").length;
  const expectedCounts = new Map();
  const readbackCounts = new Map();
  for (const item of assessment.items.filter((entry) => entry.status === "expected")) {
    const key = `${item.clip}:${item.property}`;
    expectedCounts.set(key, (expectedCounts.get(key) || 0) + 1);
  }
  for (const item of writerItems.filter((entry) => entry.status === "applied" && entry.readback === true)) {
    const key = `${item.clip == null ? null : item.clip}:${item.property}`;
    readbackCounts.set(key, (readbackCounts.get(key) || 0) + 1);
  }
  let readbackCovered = 0;
  for (const [key, count] of expectedCounts) readbackCovered += Math.min(count, readbackCounts.get(key) || 0);
  const writerLosses = counts.approximated + counts.baked + counts.unsupported
    + counts.deferred + counts.readbackMismatch;
  const coherent = !!(result && result.ok) && declaredIssues === 0 && writerLosses === 0;
  const verified = coherent && expectedProperties > 0 && readbackCovered >= expectedProperties;

  return {
    expected: assessment,
    actual: { ...counts, declaredIssues, readbackCovered },
    verified,
    coherent,
    reason: verified ? undefined : (readbackCovered < expectedProperties ? "readbackIncomplete" : "writerReportedLoss"),
    items: writerItems,
  };
}

module.exports = { transferReport, countValue, statusCounts };
