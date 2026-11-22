// @ts-check
// Shows a list of shots to a model: rows of frames, as many shots per image as fit, the shot's number
// written on its first frame. How many frames each shot gets is decided by core/motion.js, or fixed by
// the caller. A shot that needs more frames than a row holds carries on to the next row.

const COLS = 4;
const ROWS_PER_IMAGE = 9;

/// Splits shots into images: each starts a new row, and none is cut across two images.
/** @param {number[][]} plans frames of each shot, as times */
function packShots(plans) {
  /** @type {{ shots:number[], rows:number }[]} */
  const pages = [];
  let page = { shots: /** @type {number[]} */ ([]), rows: 0 };
  plans.forEach((times, index) => {
    const rows = Math.max(1, Math.ceil(times.length / COLS));
    if (page.rows + rows > ROWS_PER_IMAGE && page.shots.length) {
      pages.push(page);
      page = { shots: [], rows: 0 };
    }
    page.shots.push(index);
    page.rows += rows;
  });
  if (page.shots.length) pages.push(page);
  return pages;
}

/// One image of a page of shots.
/**
 * @param {{ file:string, label:any }[]} shots @param {number[][]} plans @param {{ shots:number[] }} page
 * @param {import('./domain').ActionCtx} ctx
 */
async function renderPage(shots, plans, page, ctx) {
  const items = [];
  const labels = [];
  const cells = [];
  let row = 0;
  for (const index of page.shots) {
    plans[index].forEach((time, i) => {
      items.push({ path: shots[index].file, time });
      labels.push(i === 0 ? shots[index].label : null);
      cells.push(row * COLS + i);
    });
    row += Math.max(1, Math.ceil(plans[index].length / COLS));
  }
  const r = await ctx.invoke('ffmpeg:frameGrid', [{ items, labels, cells, cols: COLS, width: 200 }]);
  return r && r.ok && r.path ? r.path : null;
}

module.exports = { packShots, renderPage, COLS, ROWS_PER_IMAGE };
