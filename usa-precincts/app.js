/* SAGE USA precincts — static explorer.
 *
 * Ported from local_demo/app.js, which ran against a Python server.  The
 * viewer is deliberately unchanged: same layout, same five colourings, same
 * filters, same hover and click, same year picker doubling as the coverage
 * chart.  Two things are different and both are additions:
 *
 *  A. There is no server.  `/api/unit` random-accessed one 4,096-row group of
 *     a parquet file to fill the click panel; here the same detail is baked
 *     into gzipped JSON shards of 2,048 units keyed by uid, so a click is
 *     still one small random-access fetch — about 37 kB instead of about a
 *     megabyte.  `build_static.py` documents the encoding.
 *  B. There is a grid view.  Up to nine years draw at once, side by side, on
 *     one shared viewport.
 *
 * Design notes that are load-bearing, because the FIRST build of this demo
 * crashed the renderer after about seven years were loaded:
 *
 *  1. There is no DuckDB-WASM here at all.  The leak that took 3.5 GB of WASM
 *     linear memory and never gave it back was in the in-browser database; the
 *     page downloads packed typed arrays (28 bytes a unit) and asks for one
 *     unit's strings at a time.  A whole year is 4.7 MB.
 *  2. Loading a year RELEASES the years that are leaving FIRST — every typed
 *     array and the spatial index are dropped before the next fetch starts, so
 *     nothing accumulates across a session.  The grid view keeps the years
 *     that stay on screen and releases exactly the ones that leave
 *     (`retainYears`); it does not reload what it already holds and it does
 *     not hold what it does not draw.
 *  3. Nothing is built that is not drawn.  There is one point pass per panel;
 *     there is no second collection kept "in case" a mode needs it, and the
 *     coarse-on-top ordering walks the same arrays twice.
 *  4. EMPTY is a single shared frozen constant.  Handing a renderer a fresh
 *     `{}` on every pass is what killed a year in ten seconds at a 200 MB heap
 *     — that was a re-render loop, not a memory problem — and the way to not
 *     have it is to never allocate a new empty.  This applies per panel: a
 *     panel with no year resolves to the same EMPTY as every other one.
 *  5. The pixel buffer is allocated once per canvas size, not once per frame,
 *     and the draw loop allocates nothing.  The grid does not add canvases —
 *     all panels draw into sub-rectangles of the one buffer, and the panel
 *     rectangles are recomputed on resize and on layout change, never in the
 *     draw loop.
 *  6. At most one detail dictionary and exactly one detail shard are held at a
 *     time.  A click never grows a cache.
 */

'use strict';

const EMPTY = Object.freeze({ n: 0, year: null, vis: null });

const $ = (s) => document.querySelector(s);
const fmt = (v) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : v.toLocaleString('en-US');
const pct = (v, d) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : (100 * v).toFixed(d === undefined ? 1 : d) + '%';
const DPR = () => Math.min(2, window.devicePixelRatio || 1);

// ------------------------------------------------------------------ palette

const SURFACE = [26, 26, 25];
const CAT = {                      // dark steps, validated all-pairs
  blue:   [0x39, 0x87, 0xe5],
  orange: [0xd9, 0x59, 0x26],
  aqua:   [0x19, 0x9e, 0x70],
  na:     [0x6b, 0x6b, 0x66],
};
const GRAIN_TIER = [               // index = lvl_tier
  { name: 'grain not established', rgb: CAT.na },
  { name: 'sub-county unit', rgb: CAT.blue },
  { name: 'county tier', rgb: CAT.orange },
  { name: 'coarser than county', rgb: CAT.aqua },
];
const TIER_COLOR = {
  'unmatched': CAT.na,
  'census': CAT.blue,
  'official': CAT.orange,
  "official (SWDB, California's statutorily designated database)": CAT.orange,
  'third-party': CAT.aqua,
  'census layer, third-party crosswalk': CAT.aqua,
};

// diverging, blue <-> red, neutral gray midpoint; brighter = larger margin,
// which is the right direction on a dark ground
const MID = [0x6e, 0x6e, 0x68];
const DEM_1 = [0x39, 0x87, 0xe5], DEM_2 = [0x9e, 0xc5, 0xf4];
const REP_1 = [0xe3, 0x49, 0x48], REP_2 = [0xf1, 0x9a, 0x99];
// sequential blue for magnitude
const SEQ = [[0x18, 0x4f, 0x95], [0x25, 0x6a, 0xbf], [0x39, 0x87, 0xe5], [0x6d, 0xa7, 0xec], [0x9e, 0xc5, 0xf4], [0xcd, 0xe2, 0xfb]];

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function abgr(rgb) {
  return (255 << 24) | ((rgb[2] & 255) << 16) | ((rgb[1] & 255) << 8) | (rgb[0] & 255);
}
function hex(rgb) {
  return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

// 33-step diverging LUT, built once
const MARGIN_LUT = (() => {
  const out = new Int32Array(33);
  for (let i = 0; i < 33; i++) {
    const m = (i - 16) / 16;              // -1 .. +1
    const a = Math.abs(m);
    const arm = m >= 0 ? [DEM_1, DEM_2] : [REP_1, REP_2];
    const c = a <= 0.5 ? mix(MID, arm[0], a / 0.5) : mix(arm[0], arm[1], (a - 0.5) / 0.5);
    out[i] = abgr(c);
  }
  return out;
})();
const SEQ_LUT = (() => {
  const out = new Int32Array(SEQ.length);
  for (let i = 0; i < SEQ.length; i++) out[i] = abgr(SEQ[i]);
  return out;
})();
const BG = abgr(SURFACE);

// ------------------------------------------------------------------ projection

const D2R = Math.PI / 180;
function merX(lon) { return (lon + 180) / 360; }
function merY(lat) {
  const l = Math.max(-85, Math.min(85, lat));
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + l * D2R / 2)) / (2 * Math.PI);
}

const FITS = {
  '48': [-125.2, 24.3, -66.6, 49.6],
  'ak': [-180.5, 51.0, -129.0, 71.5],
  'hi': [-160.5, 18.7, -154.5, 22.4],
  'all': [-188.0, 18.0, -66.0, 71.5],
};

// ------------------------------------------------------------------ state

let SUMMARY = null;
let STATIC = null;             // data/static.json — shard size, shard counts
const RES = new Map();         // year -> payload.  One entry in single view,
                               // one per distinct panel year in the grid.
let Y = EMPTY;                 // the primary panel's payload
let LAY = { rows: 1, cols: 1 };
let CELLS = [null];            // year per panel
let RECTS = [];                // panel rectangles, recomputed on resize/layout
let view = { cx: 0.5, cy: 0.5, scale: 1000 };
let hoverP = -1, hoverIdx = -1, selUid = -1;
let px = null, pxW = 0, pxH = 0, imgData = null, pxBuf = null;
let inflight = null;           // AbortController for the detail fetch

const ptsCanvas = $('#pts'), overCanvas = $('#over');
const ctxP = ptsCanvas.getContext('2d', { alpha: false });
const ctxO = overCanvas.getContext('2d');

// ------------------------------------------------------------------ transport

async function gz(url, signal) {
  const r = await fetch(url, signal ? { signal: signal } : undefined);
  if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser has no DecompressionStream and the data is gzipped');
  }
  return new Response(r.body.pipeThrough(new DecompressionStream('gzip')));
}

// ------------------------------------------------------------------ loading

// 2 — a payload is released whole: every array and the spatial index.
function releasePayload(y) {
  if (!y || y === EMPTY) return;
  y.lon = y.lat = y.dem = y.rep = y.tot = y.uid = null;
  y.lvl = y.tier = y.st = y.kind = null;
  y.mx = y.my = y.lvlTier = null;
  y.cellStart = y.order = null;
  y.stateAnchor = null;
  y.vis = null;
  y.buf = null;
}

// 2 — release the years that are leaving BEFORE anything new is fetched, and
// keep the ones that stay on screen rather than reloading them.
function retainYears(keep) {
  const k = new Set(keep);
  for (const [yr, p] of RES) {
    if (!k.has(yr)) { releasePayload(p); RES.delete(yr); }
  }
  if (Y !== EMPTY && !RES.has(Y.year)) Y = EMPTY;
  if (DICT && !RES.has(DICT_YEAR)) releaseDetail();
  hoverP = -1; hoverIdx = -1; selUid = -1;
}

async function loadYear(year) {
  if (RES.has(year)) return RES.get(year);
  const meta = await (await fetch('data/us_' + year + '.meta.json')).json();
  const buf = await (await gz('data/us_' + year + '.gzb')).arrayBuffer();
  const n = meta.n;
  let o = 0;
  const take = (Ctor, w) => { const a = new Ctor(buf, o, n); o += n * w; return a; };
  const y = {
    year: year, n: n, meta: meta, buf: buf,
    lon: take(Float32Array, 4), lat: take(Float32Array, 4),
    dem: take(Int32Array, 4), rep: take(Int32Array, 4), tot: take(Int32Array, 4),
    uid: take(Int32Array, 4),
    lvl: take(Uint8Array, 1), tier: take(Uint8Array, 1),
    st: take(Uint8Array, 1), kind: take(Uint8Array, 1),
  };
  if (o !== buf.byteLength) {
    status('bin length mismatch for ' + year + ': read ' + o + ' of ' + buf.byteLength);
    throw new Error('bin length mismatch');
  }
  // Alaska's Aleutians cross the antimeridian; unwrap them west so the state
  // draws as one piece instead of splitting across the world edge
  const akIdx = meta.states.indexOf('AK');
  const mx = new Float32Array(n), my = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let lo = y.lon[i];
    if (y.st[i] === akIdx && lo > 0) lo -= 360;
    mx[i] = merX(lo);
    my[i] = merY(y.lat[i]);
  }
  y.mx = mx; y.my = my;
  y.lvlTier = new Uint8Array(n);
  for (let i = 0; i < n; i++) y.lvlTier[i] = meta.level_tier[y.lvl[i]] || 0;
  buildIndex(y);
  y.vis = new Uint8Array(n);
  RES.set(year, y);
  return y;
}

// Release everything not in `years`, then load whatever of `years` is missing.
async function ensureYears(years) {
  retainYears(years);
  for (const yr of years) {
    if (yr === null || RES.has(yr)) continue;
    status('loading ' + yr + '…');
    await loadYear(yr);
  }
  status('');
}

// uniform grid over mercator space, CSR-packed; released with the year
function buildIndex(y) {
  const G = 512;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < y.n; i++) {
    const a = y.mx[i], b = y.my[i];
    if (a < x0) x0 = a; if (a > x1) x1 = a;
    if (b < y0) y0 = b; if (b > y1) y1 = b;
  }
  const sx = G / Math.max(1e-9, x1 - x0), sy = G / Math.max(1e-9, y1 - y0);
  const cell = new Int32Array(y.n);
  const counts = new Int32Array(G * G + 1);
  for (let i = 0; i < y.n; i++) {
    const cx = Math.min(G - 1, Math.max(0, ((y.mx[i] - x0) * sx) | 0));
    const cy = Math.min(G - 1, Math.max(0, ((y.my[i] - y0) * sy) | 0));
    const c = cy * G + cx;
    cell[i] = c;
    counts[c + 1]++;
  }
  for (let c = 0; c < G * G; c++) counts[c + 1] += counts[c];
  const order = new Int32Array(y.n);
  const cursor = counts.slice(0, G * G);
  for (let i = 0; i < y.n; i++) order[cursor[cell[i]]++] = i;
  y.grid = { G: G, x0: x0, y0: y0, sx: sx, sy: sy };
  y.cellStart = counts;
  y.order = order;
}

function status(msg) {
  const el = $('#status');
  if (!msg) { el.style.display = 'none'; return; }
  el.textContent = msg;
  el.style.display = 'block';
}

// ------------------------------------------------------------------ filters

function applyFilterTo(y) {
  if (!y || y === EMPTY || !y.vis) return;
  const stSel = $('#state').value;
  const gSel = $('#grainfilter').value;
  const stIdx = stSel ? y.meta.states.indexOf(stSel) : -1;
  const g = gSel === '' ? -1 : +gSel;
  for (let i = 0; i < y.n; i++) {
    y.vis[i] = ((stIdx < 0 || y.st[i] === stIdx) && (g < 0 || y.lvlTier[i] === g)) ? 1 : 0;
  }
}

function applyFilter() {
  for (const y of RES.values()) { applyFilterTo(y); computeStateAnchors(y); }
}

// ------------------------------------------------------------------ colouring

function colorOf(y, i, mode) {
  if (mode === 'margin') {
    const t = y.tot[i];
    if (t <= 0) return abgr(CAT.na);
    const m = (y.dem[i] - y.rep[i]) / t;
    let k = Math.round(16 + m * 16 * 2.2);   // 45pp margin saturates the ramp
    if (k < 0) k = 0; else if (k > 32) k = 32;
    return MARGIN_LUT[k];
  }
  if (mode === 'grain') return abgr(GRAIN_TIER[y.lvlTier[i]].rgb);
  if (mode === 'level') return LEVEL_LUT[y.lvl[i]];
  if (mode === 'tier') return abgr(TIER_COLOR[y.meta.tiers[y.tier[i]]] || CAT.na);
  // size: log10(total votes), 0 .. 4+
  const t = y.tot[i];
  const k = t <= 0 ? 0 : Math.min(SEQ.length - 1, Math.max(0, Math.round(Math.log10(t + 1) * 1.4)));
  return SEQ_LUT[SEQ.length - 1 - k];
}

// unit_level gets the tier's hue, lightened per member so the 15 values stay
// distinguishable within a tier without inventing 15 categorical hues
let LEVEL_LUT = new Int32Array(0);
function buildLevelLut(meta) {
  const out = new Int32Array(meta.levels.length);
  const seen = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (let i = 0; i < meta.levels.length; i++) {
    const t = meta.level_tier[i] || 0;
    const base = GRAIN_TIER[t].rgb;
    const k = seen[t]++;
    out[i] = abgr(mix(base, [255, 255, 255], Math.min(0.6, k * 0.13)));
  }
  LEVEL_LUT = out;
}

// ------------------------------------------------------------------ layout

// 5 — recomputed here and in resize(), never in the draw loop
function computeRects() {
  const cells = LAY.rows * LAY.cols;
  const g = cells === 1 ? 0 : Math.max(1, Math.round(DPR()));
  const out = [];
  for (let r = 0; r < LAY.rows; r++) {
    for (let c = 0; c < LAY.cols; c++) {
      const x0 = Math.round(c * pxW / LAY.cols), x1 = Math.round((c + 1) * pxW / LAY.cols);
      const y0 = Math.round(r * pxH / LAY.rows), y1 = Math.round((r + 1) * pxH / LAY.rows);
      const dx = c ? g : 0, dy = r ? g : 0;
      out.push({ x: x0 + dx, y: y0 + dy, w: Math.max(1, x1 - x0 - dx), h: Math.max(1, y1 - y0 - dy) });
    }
  }
  RECTS = out;
}

function panelAt(sx, sy) {
  for (let k = 0; k < RECTS.length; k++) {
    const r = RECTS[k];
    if (sx >= r.x && sx < r.x + r.w && sy >= r.y && sy < r.y + r.h) return k;
  }
  return -1;
}

const cellW = () => (RECTS.length ? RECTS[0].w : pxW);
const cellH = () => (RECTS.length ? RECTS[0].h : pxH);

// ------------------------------------------------------------------ drawing

function resize() {
  const r = $('#map').getBoundingClientRect();
  const dpr = DPR();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (w === pxW && h === pxH) return;
  pxW = w; pxH = h;
  ptsCanvas.width = w; ptsCanvas.height = h;
  overCanvas.width = w; overCanvas.height = h;
  // 5 — one allocation per size, never per frame
  imgData = ctxP.createImageData(w, h);
  pxBuf = new Uint32Array(imgData.data.buffer);
  px = imgData;
  computeRects();
}

function fitTo(box) {
  const [w, s, e, n] = box;
  const ax = merX(w), bx = merX(e), ay = merY(n), by = merY(s);
  const sx = cellW() / (bx - ax), sy = cellH() / (by - ay);
  view.scale = Math.min(sx, sy) * 0.96;
  view.cx = (ax + bx) / 2; view.cy = (ay + by) / 2;
  draw();
}

let rafPending = false;
function schedule() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; draw(); });
}

// One panel, one pass over one set of arrays.  Allocates nothing.
function drawPanel(y, r, mode, coarseTop, rad) {
  const s = view.scale;
  const ox = r.x + r.w / 2 - view.cx * s, oy = r.y + r.h / 2 - view.cy * s;
  const xlo = r.x, xhi = r.x + r.w, ylo = r.y, yhi = r.y + r.h;
  let drawn = 0;
  // pass 1 sub-county, pass 2 the coarse tiers on top; a single pass when the
  // ordering is switched off.  There is no second collection — the same arrays
  // are walked twice.
  const passes = coarseTop ? 2 : 1;
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < y.n; i++) {
      if (!y.vis[i]) continue;
      if (coarseTop) {
        const fine = y.lvlTier[i] === 1;
        if (p === 0 ? !fine : fine) continue;
      }
      const x = (y.mx[i] * s + ox) | 0;
      if (x < xlo || x >= xhi) continue;
      const yy0 = (y.my[i] * s + oy) | 0;
      if (yy0 < ylo || yy0 >= yhi) continue;
      const c = colorOf(y, i, mode);
      if (rad === 0) {
        pxBuf[yy0 * pxW + x] = c;
      } else {
        const x0 = Math.max(xlo, x - rad), x1 = Math.min(xhi - 1, x + rad);
        const y0 = Math.max(ylo, yy0 - rad), y1 = Math.min(yhi - 1, yy0 + rad);
        for (let yy = y0; yy <= y1; yy++) {
          const row = yy * pxW;
          for (let xx = x0; xx <= x1; xx++) pxBuf[row + xx] = c;
        }
      }
      drawn++;
    }
  }
  y.drawn = drawn;
}

function draw() {
  if (!pxBuf) return;
  pxBuf.fill(BG);
  const mode = $('#mode').value;
  const coarseTop = $('#coarseTop').checked;
  const fat = $('#big').checked;
  const s = view.scale;
  const dpr = DPR();
  const rad = fat ? Math.round(1.8 * dpr) : (s > 12000 ? Math.round(1.2 * dpr) : 0);

  for (let k = 0; k < RECTS.length; k++) {
    const y = cellYear(k);
    if (y === EMPTY) continue;
    drawPanel(y, RECTS[k], mode, coarseTop, rad);
  }
  ctxP.putImageData(px, 0, 0);
  drawOverlay();
  updateHud();
}

// 4 — every panel with no year resolves to the SAME frozen EMPTY
function cellYear(k) {
  const yr = CELLS[k];
  if (yr === null || yr === undefined) return EMPTY;
  const y = RES.get(yr);
  return (y && y.vis) ? y : EMPTY;
}

function drawOverlay() {
  ctxO.setTransform(1, 0, 0, 1, 0, 0);
  ctxO.clearRect(0, 0, pxW, pxH);
  const dpr = DPR();
  const s = view.scale;
  const grid = RECTS.length > 1;
  const showLabels = $('#labels').checked;

  for (let k = 0; k < RECTS.length; k++) {
    const r = RECTS[k];
    const y = cellYear(k);
    if (grid) {
      ctxO.strokeStyle = 'rgba(255,255,255,.09)';
      ctxO.lineWidth = 1;
      ctxO.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);
    }
    if (y === EMPTY) continue;
    const ox = r.x + r.w / 2 - view.cx * s, oy = r.y + r.h / 2 - view.cy * s;
    // 51 state labels in a 300 px cell is noise, not information
    if (showLabels && y.stateAnchor && r.w >= 380) {
      ctxO.save();
      ctxO.beginPath();
      ctxO.rect(r.x, r.y, r.w, r.h);
      ctxO.clip();
      ctxO.font = (11 * dpr) + 'px ui-sans-serif, Segoe UI, sans-serif';
      ctxO.textAlign = 'center';
      ctxO.fillStyle = 'rgba(255,255,255,.42)';
      for (const a of y.stateAnchor) {
        const x = a.x * s + ox, yy = a.y * s + oy;
        if (x < r.x || x > r.x + r.w || yy < r.y || yy > r.y + r.h) continue;
        ctxO.fillText(a.st, x, yy);
      }
      ctxO.restore();
    }
    if (grid) {
      // bottom-left, so the HUD in the top-left corner never sits on top of
      // the first row's labels
      const row = SUMMARY.years.find((q) => q.year === y.year) || {};
      ctxO.textAlign = 'left';
      ctxO.font = '600 ' + (14 * dpr) + 'px ui-sans-serif, Segoe UI, sans-serif';
      ctxO.fillStyle = 'rgba(255,255,255,.92)';
      ctxO.fillText(String(y.year), r.x + 10 * dpr, r.y + r.h - 22 * dpr);
      ctxO.font = (10 * dpr) + 'px ui-sans-serif, Segoe UI, sans-serif';
      ctxO.fillStyle = 'rgba(255,255,255,.5)';
      ctxO.fillText(pct(row.sub_county_share, 0) + ' of votes sub-county',
        r.x + 10 * dpr, r.y + r.h - 8 * dpr);
    }
  }

  if (hoverP >= 0 && hoverP < RECTS.length && hoverIdx >= 0) {
    const y = cellYear(hoverP);
    if (y !== EMPTY && hoverIdx < y.n) {
      const r = RECTS[hoverP];
      const ox = r.x + r.w / 2 - view.cx * s, oy = r.y + r.h / 2 - view.cy * s;
      ctxO.strokeStyle = '#ffffff';
      ctxO.lineWidth = 1.5 * dpr;
      ctxO.beginPath();
      ctxO.arc(y.mx[hoverIdx] * s + ox, y.my[hoverIdx] * s + oy, 6 * dpr, 0, Math.PI * 2);
      ctxO.stroke();
    }
  }
}

function computeStateAnchors(y) {
  if (!y || y === EMPTY || !y.vis) return;
  const acc = new Map();
  for (let i = 0; i < y.n; i++) {
    if (!y.vis[i]) continue;
    const k = y.st[i];
    let a = acc.get(k);
    if (!a) { a = { sx: 0, sy: 0, n: 0 }; acc.set(k, a); }
    a.sx += y.mx[i]; a.sy += y.my[i]; a.n++;
  }
  const out = [];
  for (const [k, a] of acc) {
    if (a.n < 5) continue;
    out.push({ st: y.meta.states[k] || '??', x: a.sx / a.n, y: a.sy / a.n });
  }
  y.stateAnchor = out;
}

// ------------------------------------------------------------------ hud + legend

function updateHud() {
  if (Y === EMPTY) { $('#hud').innerHTML = ''; return; }
  const s = SUMMARY.years.find((r) => r.year === Y.year) || {};
  const cells = RECTS.length;
  let drawn = 0, seen = 0;
  for (let k = 0; k < cells; k++) {
    const y = cellYear(k);
    if (y !== EMPTY) { drawn += y.drawn || 0; seen += y.n; }
  }
  if (cells > 1) {
    // the per-year figures live on each panel; the HUD only totals the grid,
    // and stays narrow enough not to cover a panel next to it
    $('#hud').innerHTML =
      '<b>' + cells + ' years</b> &nbsp;<span class="m">' + fmt(drawn) + ' of ' +
      fmt(seen) + ' mapped units drawn</span>';
    return;
  }
  $('#hud').innerHTML =
    '<b>' + Y.year + '</b> &nbsp;<span class="m">' + fmt(Y.drawn || 0) + ' of ' + fmt(Y.n) +
    ' mapped units drawn · ' + fmt(s.units - s.mapped_units) + ' units carry no centroid and cannot be shown</span><br>' +
    '<span class="m">sub-county share of votes <b style="font-size:13px">' + pct(s.sub_county_share) +
    '</b> · polygon on ' + pct(s.polygon_rate_geographic, 2) + ' of geographic units · ' +
    fmt(s.units) + ' units, ' + fmt(s.rows) + ' vote rows</span>';
}

function legendRow(color, name, count) {
  return '<div class="row"><span class="sw" style="background:' + color + '"></span>' +
    '<span class="nm">' + name + '</span><span class="ct">' + (count === undefined ? '' : fmt(count)) + '</span></div>';
}

function renderLegend() {
  const el = $('#legend');
  if (Y === EMPTY) { el.innerHTML = ''; return; }
  const mode = $('#mode').value;
  // counts are for one year; in the grid that is the first panel, and the
  // legend says so rather than silently pooling years
  const caption = RECTS.length > 1 ? '<div class="ct" style="margin-bottom:5px">counts for ' + Y.year + '</div>' : '';
  if (mode === 'margin') {
    const stops = [];
    for (let i = 0; i <= 32; i += 2) {
      const c = MARGIN_LUT[i];
      stops.push('rgb(' + (c & 255) + ',' + ((c >> 8) & 255) + ',' + ((c >> 16) & 255) + ') ' + (i / 32 * 100).toFixed(0) + '%');
    }
    el.innerHTML = '<div class="rampbar" style="background:linear-gradient(90deg,' + stops.join(',') + ')"></div>' +
      '<div class="rampends"><span>R +45pp</span><span>tied</span><span>D +45pp</span></div>' +
      '<div class="ct" style="margin-top:6px">grey = no votes recorded</div>';
    return;
  }
  if (mode === 'size') {
    const stops = SEQ.map((c, i) => hex(c) + ' ' + (i / (SEQ.length - 1) * 100).toFixed(0) + '%');
    el.innerHTML = '<div class="rampbar" style="background:linear-gradient(90deg,' + stops.reverse().join(',') + ')"></div>' +
      '<div class="rampends"><span>1 vote</span><span>10k+</span></div>';
    return;
  }
  if (mode === 'grain' || mode === 'level') {
    const counts = [0, 0, 0, 0];
    const lvlCounts = new Int32Array(Y.meta.levels.length);
    for (let i = 0; i < Y.n; i++) {
      if (!Y.vis[i]) continue;
      counts[Y.lvlTier[i]]++;
      lvlCounts[Y.lvl[i]]++;
    }
    if (mode === 'grain') {
      el.innerHTML = caption + [1, 2, 3, 0].map((t) =>
        legendRow(hex(GRAIN_TIER[t].rgb), GRAIN_TIER[t].name, counts[t])).join('');
    } else {
      const rows = [];
      for (let i = 0; i < Y.meta.levels.length; i++) {
        if (!lvlCounts[i]) continue;
        const c = LEVEL_LUT[i];
        rows.push([lvlCounts[i], legendRow('rgb(' + (c & 255) + ',' + ((c >> 8) & 255) + ',' + ((c >> 16) & 255) + ')',
          Y.meta.levels[i], lvlCounts[i])]);
      }
      rows.sort((a, b) => b[0] - a[0]);
      el.innerHTML = caption + rows.map((r) => r[1]).join('');
    }
    return;
  }
  // boundary tier
  const c = new Map();
  for (let i = 0; i < Y.n; i++) {
    if (!Y.vis[i]) continue;
    const t = Y.meta.tiers[Y.tier[i]];
    c.set(t, (c.get(t) || 0) + 1);
  }
  const rows = [...c.entries()].sort((a, b) => b[1] - a[1]);
  el.innerHTML = caption + rows.map(([t, n]) =>
    legendRow(hex(TIER_COLOR[t] || CAT.na), t.replace(/^official \(SWDB.*/, 'official (SWDB, California)'), n)).join('');
}

// ------------------------------------------------------------------ picking

// writes into pickP / pickI so the hover path allocates nothing
let pickP = -1, pickI = -1;
function pickAt(sx, sy) {
  pickP = -1; pickI = -1;
  const k = panelAt(sx, sy);
  if (k < 0) return;
  const y = cellYear(k);
  if (y === EMPTY || !y.grid) return;
  const r = RECTS[k];
  const s = view.scale;
  const ox = r.x + r.w / 2 - view.cx * s, oy = r.y + r.h / 2 - view.cy * s;
  const g = y.grid;
  const mxq = (sx - ox) / s, myq = (sy - oy) / s;
  const tol = 7 * DPR();
  const cx = Math.min(g.G - 1, Math.max(0, ((mxq - g.x0) * g.sx) | 0));
  const cy = Math.min(g.G - 1, Math.max(0, ((myq - g.y0) * g.sy) | 0));
  let best = -1, bestD = tol * tol;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = cy + dy;
    if (yy < 0 || yy >= g.G) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = cx + dx;
      if (xx < 0 || xx >= g.G) continue;
      const c = yy * g.G + xx;
      for (let q = y.cellStart[c]; q < y.cellStart[c + 1]; q++) {
        const i = y.order[q];
        if (!y.vis[i]) continue;
        const px2 = y.mx[i] * s + ox - sx, py2 = y.my[i] * s + oy - sy;
        const d = px2 * px2 + py2 * py2;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
  }
  if (best >= 0) { pickP = k; pickI = best; }
}

// ------------------------------------------------------------------ detail

// 6 — one dictionary and one shard, never a growing cache
let DICT = null, DICT_YEAR = null;
let SHARD = null, SHARD_KEY = '';

function releaseDetail() {
  DICT = null; DICT_YEAR = null; SHARD = null; SHARD_KEY = '';
}

async function getDict(year, signal) {
  if (DICT && DICT_YEAR === year) return DICT;
  DICT = null; DICT_YEAR = null; SHARD = null; SHARD_KEY = '';
  const d = await (await gz('data/detail/' + year + '/dict.gzj', signal)).json();
  DICT = d; DICT_YEAR = year;
  return d;
}

async function getShard(year, s, signal) {
  const key = year + ':' + s;
  if (SHARD && SHARD_KEY === key) return SHARD;
  SHARD = null; SHARD_KEY = '';            // drop before fetching the next
  const recs = await (await gz('data/detail/' + year + '/' + s + '.gzj', signal)).json();
  SHARD = recs; SHARD_KEY = key;
  return recs;
}

function decodeUnit(rec, d) {
  const D = d.dicts;
  const votes = [];
  const v = rec[23];
  for (let i = 0; i < v.length; i += 2) {
    const c = d.cand[v[i]] || ['', ''];
    votes.push([c[0], c[1], v[i + 1]]);
  }
  return {
    uid: rec[0],
    NAME3: rec[1],
    NAME3_b: rec[2] === 0 ? rec[1] : rec[2],
    NAME1_b: D.NAME1_b[rec[3]], NAME2: D.NAME2[rec[4]], NAME2_b: D.NAME2_b[rec[5]],
    tidy_county: D.tidy_county[rec[6]],
    lvl: D.lvl[rec[7]], lvl_tier: rec[8], unit_kind: D.unit_kind[rec[9]],
    geom_source: D.geom_source[rec[10]], geom_vintage: D.geom_vintage[rec[11]],
    geom_method: D.geom_method[rec[12]],
    geom_matched: rec[13] === 1 ? true : (rec[13] === 0 ? false : null),
    boundary_tier: D.boundary_tier[rec[14]],
    geometry_type: D.geometry_type[rec[15]], geometry_type_b: D.geometry_type_b[rec[16]],
    source_class: D.source_class[rec[17]], source_url: D.source_url[rec[18]],
    dem: rec[19], rep: rec[20], oth: rec[21], tot: rec[22],
    votes: votes,
  };
}

function grainChip(tier, label) {
  return '<span class="chip"><span class="sw" style="background:' + hex(GRAIN_TIER[tier].rgb) + '"></span>' +
    (label || GRAIN_TIER[tier].name) + '</span>';
}

function renderDetailPlaceholder() {
  const s = Y === EMPTY ? null : SUMMARY.years.find((r) => r.year === Y.year);
  let h = '<h2>Unit</h2><p class="empty">Click a point to inspect a unit.</p>';
  if (s) {
    h += '<h2>Year ' + s.year + '</h2><dl class="kv">' +
      '<dt>vote rows</dt><dd>' + fmt(s.rows) + '</dd>' +
      '<dt>units</dt><dd>' + fmt(s.units) + '</dd>' +
      '<dt>mappable</dt><dd>' + fmt(s.mapped_units) + ' <span class="ct">(' + fmt(s.units - s.mapped_units) + ' carry no coordinate)</span></dd>' +
      '<dt>geographic</dt><dd>' + fmt(s.geographic_units) + '</dd>' +
      '<dt>with polygon</dt><dd class="hi">' + fmt(s.units_with_polygon) + ' · ' + pct(s.polygon_rate_geographic, 2) + '</dd>' +
      '<dt>sub-county</dt><dd class="hi">' + pct(s.sub_county_share) + ' of votes</dd>' +
      '<dt>county tier</dt><dd>' + pct(s.votes_county_tier / s.votes_total) + ' of votes</dd>' +
      '<dt>coarser</dt><dd>' + pct(s.votes_coarser / s.votes_total) + ' of votes</dd>' +
      '</dl>';
    if (s.states_all_county_tier.length) {
      h += '<p class="ct" style="margin-top:8px">entirely county tier: ' + s.states_all_county_tier.join(' ') + '</p>';
    }
  }
  $('#detail').innerHTML = h;
}

async function showUnit(y, idx) {
  const uid = y.uid[idx];
  const year = y.year;
  selUid = uid;
  if (inflight) inflight.abort();
  inflight = new AbortController();
  const sig = inflight.signal;
  let u;
  try {
    const d = await getDict(year, sig);
    const s = Math.floor(uid / d.shard);
    const recs = await getShard(year, s, sig);
    const rec = recs[uid - s * d.shard];
    if (!rec || rec[0] !== uid) {
      // shards are uniform by construction; if that ever stops being true,
      // say so rather than show the wrong unit
      $('#detail').innerHTML = '<h2>Unit</h2><p class="empty">shard offset missed: asked ' +
        uid + ', got ' + (rec ? rec[0] : 'nothing') + '</p>';
      return;
    }
    u = decodeUnit(rec, d);
    u.lat = y.lat[idx]; u.lon = y.lon[idx];
  } catch (e) {
    if (e.name === 'AbortError') return;
    $('#detail').innerHTML = '<h2>Unit</h2><p class="empty">could not load unit: ' + esc(e.message) + '</p>';
    return;
  }

  const tot = u.tot || 0;
  const rows = (u.votes || []).map((v) => {
    const isD = v[1] === 'Democratic Party', isR = v[1] === 'Republican Party';
    return '<tr class="' + (isD ? 'd' : isR ? 'r' : '') + '"><td class="c">' + esc(v[0] || '(unnamed)') +
      '<br><span class="ct" style="color:var(--text-muted)">' + esc(v[1] || '') + '</span></td>' +
      '<td class="n">' + fmt(v[2]) + '</td>' +
      '<td class="p">' + (tot ? (100 * v[2] / tot).toFixed(1) + '%' : '—') + '</td></tr>';
  }).join('');

  const tier = u.lvl_tier || 0;
  const h = [
    '<h2>Unit' + (RECTS.length > 1 ? ' · ' + year : '') + '</h2>',
    '<p class="unitname">' + esc(u.NAME3 || '(no NAME3)') + '</p>',
    '<p class="unitwhere">' + esc(u.NAME2_b || u.tidy_county || '(no county)') +
      (u.NAME2 ? ' · FIPS ' + esc(u.NAME2) : '') + ' · ' + esc(u.NAME1_b) + '</p>',
    '<div style="margin-bottom:12px">' + grainChip(tier, esc(u.lvl || 'unknown')) + '</div>',
    '<h2>Reporting grain</h2>',
    '<dl class="kv">',
    '<dt>unit_level</dt><dd class="hi">' + esc(u.lvl || '—') + '</dd>',
    '<dt>tier</dt><dd>' + GRAIN_TIER[tier].name + '</dd>',
    '<dt>unit_kind</dt><dd>' + esc(u.unit_kind || '—') + '</dd>',
    '</dl>',
    '<h2>Votes</h2>',
    '<table class="votes"><thead><tr><th>candidate</th><th style="text-align:right">votes</th><th></th></tr></thead><tbody>',
    rows || '<tr><td class="c empty">no rows</td><td></td><td></td></tr>',
    '</tbody></table>',
    '<dl class="kv" style="margin-top:8px"><dt>total_votes</dt><dd class="hi">' + fmt(tot) + '</dd>',
    '<dt>margin</dt><dd>' + (tot ? ((u.dem - u.rep) >= 0 ? 'D +' : 'R +') + (Math.abs(100 * (u.dem - u.rep) / tot)).toFixed(1) + 'pp' : '—') + '</dd></dl>',
    '<h2>Geometry</h2>',
    '<dl class="kv">',
    '<dt>geometry_type</dt><dd class="hi">' + esc(u.geometry_type || '—') + '</dd>',
    '<dt>type_b</dt><dd>' + esc(u.geometry_type_b || '—') + '</dd>',
    '<dt>matched</dt><dd>' + (u.geom_matched === true ? 'yes' : u.geom_matched === false ? 'no' : '—') + '</dd>',
    '<dt>boundary key</dt><dd><code>' + esc(u.NAME3_b || '—') + '</code></dd>',
    '<dt>source</dt><dd>' + esc(u.geom_source || '—') + '</dd>',
    '<dt>vintage</dt><dd>' + esc(u.geom_vintage || '—') + '</dd>',
    '<dt>method</dt><dd>' + esc(u.geom_method || '—') + '</dd>',
    '<dt>tier</dt><dd>' + esc(u.boundary_tier || '—') + '</dd>',
    '<dt>centroid</dt><dd>' + (u.lat === null || u.lat === undefined ? '—' : (+u.lat).toFixed(4) + ', ' + (+u.lon).toFixed(4)) + '</dd>',
    '</dl>',
    '<h2>Vote source</h2>',
    '<dl class="kv">',
    '<dt>class</dt><dd class="hi">' + esc(u.source_class || '—') + '</dd>',
    '<dt>document</dt><dd>' + (u.source_url ? '<a href="' + esc(u.source_url) + '" target="_blank" rel="noopener">' + esc(u.source_url) + '</a>' : '—') + '</dd>',
    '<dt>uid</dt><dd><code>' + u.uid + '</code></dd>',
    '</dl>',
  ].join('');
  $('#detail').innerHTML = h;
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ------------------------------------------------------------------ download

const DL_COLS = ['year', 'uid', 'state', 'county_fips', 'county_name',
  'tidy_county', 'unit_name', 'unit_level', 'grain_tier', 'unit_kind',
  'boundary_key', 'boundary_tier', 'geom_source', 'geom_vintage',
  'geom_method', 'geom_matched', 'geometry_type', 'source_class',
  'source_url', 'dem_votes', 'rep_votes', 'other_votes', 'total_votes',
  'latitude', 'longitude'];

function csvq(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function dlSize(year) {
  const r = STATIC && STATIC.years ? STATIC.years.find((q) => q.year === year) : null;
  return r && r.csv_bytes ? r.csv_bytes : 0;
}

function dlLabel() {
  const b = $('#download');
  if (Y === EMPTY) { b.textContent = 'Download (CSV)'; return; }
  const n = dlSize(Y.year);
  b.textContent = 'Download ' + Y.year + ' units (CSV' +
    (n ? ' — ' + Math.round(n / 1048576) + ' MB' : '') + ')';
}

// Built here rather than shipped as a file: the shards already hold every
// field, and a pre-built CSV for nine years would add about 25 MB of gzipped
// duplicate to the repository.  One shard is turned into bytes and released
// before the next is fetched, so the JS heap does not grow with the file.
async function downloadYear() {
  if (Y === EMPTY) return;
  const y = Y, year = y.year;
  const btn = $('#download');
  btn.disabled = true;
  const note = $('#dlnote');
  try {
    const d = await (await gz('data/detail/' + year + '/dict.gzj')).json();
    const enc = new TextEncoder();
    const parts = [enc.encode(DL_COLS.join(',') + '\n')];
    let bytes = parts[0].length;
    let k = 0;                       // cursor into y.uid, which ascends
    for (let s = 0; s < d.shards; s++) {
      btn.textContent = 'building CSV… ' + Math.round(100 * s / d.shards) + '%';
      const recs = await (await gz('data/detail/' + year + '/' + s + '.gzj')).json();
      const out = [];
      for (let q = 0; q < recs.length; q++) {
        const r = recs[q];
        const uid = r[0];
        while (k < y.n && y.uid[k] < uid) k++;
        const hit = (k < y.n && y.uid[k] === uid);
        const D = d.dicts;
        out.push([
          year, uid, D.NAME1_b[r[3]], D.NAME2[r[4]], D.NAME2_b[r[5]],
          D.tidy_county[r[6]], r[1], D.lvl[r[7]], GRAIN_TIER[r[8]].name,
          D.unit_kind[r[9]], (r[2] === 0 ? r[1] : r[2]), D.boundary_tier[r[14]],
          D.geom_source[r[10]], D.geom_vintage[r[11]], D.geom_method[r[12]],
          r[13] === 1 ? 'true' : (r[13] === 0 ? 'false' : ''),
          D.geometry_type[r[15]], D.source_class[r[17]], D.source_url[r[18]],
          r[19], r[20], r[21], r[22],
          hit ? y.lat[k].toFixed(5) : '', hit ? y.lon[k].toFixed(5) : '',
        ].map(csvq).join(',') + '\n');
      }
      const chunk = enc.encode(out.join(''));
      bytes += chunk.length;
      parts.push(chunk);
    }
    const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' });
    parts.length = 0;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'usa_precincts_' + year + '_units.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    note.innerHTML = '<b>' + year + '</b> · ' + (bytes / 1048576).toFixed(1) + ' MB, ' +
      fmt(y.meta.n_units) + ' rows. ' + DL_NOTE;
    window.__download = { year: year, bytes: bytes, rows: y.meta.n_units };
  } catch (e) {
    note.innerHTML = 'could not build the CSV: ' + esc(e.message);
  } finally {
    btn.disabled = false;
    dlLabel();
  }
}

const DL_NOTE =
  'One row per vote-reporting unit for the selected year: identifiers, ' +
  'reporting grain, boundary provenance, vote source, and Democratic / ' +
  'Republican / other / total votes. Built in the browser out of the files ' +
  'this page already holds, so it takes a few seconds and the size on the ' +
  'button is the size of the file. ' +
  'This is <b>not</b> the SAGE deposit: centroids rather than polygons, the ' +
  'presidential contest only, and the per-candidate lines appear in the click ' +
  'panel rather than in the file.';

// ------------------------------------------------------------------ chrome

function renderYears() {
  const el = $('#years');
  const max = Math.max(...SUMMARY.years.map((r) => r.sub_county_share || 0));
  el.innerHTML = SUMMARY.years.map((r) =>
    '<button class="yearrow" data-year="' + r.year + '" aria-current="false">' +
    '<span class="ylab">' + r.year + '</span>' +
    '<span class="ybar"><i style="width:' + (100 * (r.sub_county_share || 0) / max).toFixed(1) + '%"></i></span>' +
    '<span class="yval">' + pct(r.sub_county_share, 0) + '</span></button>').join('');
  el.querySelectorAll('.yearrow').forEach((b) => {
    b.addEventListener('click', () => selectYear(+b.dataset.year));
  });
}

function markYears() {
  const on = new Set(CELLS.filter((v) => v !== null));
  document.querySelectorAll('.yearrow').forEach((b) => {
    b.setAttribute('aria-current', on.has(+b.dataset.year) ? 'true' : 'false');
  });
}

function fillStateSelect(y) {
  const sel = $('#state');
  const cur = sel.value;
  const present = new Set();
  for (let i = 0; i < y.n; i++) present.add(y.st[i]);
  const opts = ['<option value="">All states</option>'];
  y.meta.states.forEach((s, i) => { if (present.has(i)) opts.push('<option value="' + s + '">' + s + '</option>'); });
  sel.innerHTML = opts.join('');
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

// ------------------------------------------------------------------ grid

const LAYOUTS = {
  '1x1': { rows: 1, cols: 1, def: null },
  '1x2': { rows: 1, cols: 2, def: [1992, 2024] },
  '2x2': { rows: 2, cols: 2, def: [1992, 2004, 2012, 2024] },
  '2x3': { rows: 2, cols: 3, def: [1992, 2000, 2008, 2012, 2016, 2024] },
  '3x3': { rows: 3, cols: 3, def: null },
};

function renderCellPickers() {
  const el = $('#cells');
  const cells = LAY.rows * LAY.cols;
  $('#gridnote').style.display = cells === 1 ? 'none' : 'block';
  if (cells === 1) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = 'grid';
  el.style.gridTemplateColumns = 'repeat(' + LAY.cols + ',1fr)';
  const years = SUMMARY.years.map((r) => r.year);
  el.innerHTML = CELLS.map((yr, k) =>
    '<select class="cellsel" data-cell="' + k + '">' +
    years.map((y) => '<option value="' + y + '"' + (y === yr ? ' selected' : '') + '>' + y + '</option>').join('') +
    '</select>').join('');
  el.querySelectorAll('.cellsel').forEach((s) => {
    s.addEventListener('change', () => {
      CELLS[+s.dataset.cell] = +s.value;
      applyCells();
    });
  });
}

// Release what leaves, load what arrives, redraw.  Never reloads a year that
// is already on screen.
async function applyCells() {
  const t0 = performance.now();
  const want = [...new Set(CELLS.filter((v) => v !== null))];
  await ensureYears(want);
  Y = CELLS[0] !== null && RES.has(CELLS[0]) ? RES.get(CELLS[0]) : EMPTY;
  if (Y !== EMPTY) {
    buildLevelLut(Y.meta);
    fillStateSelect(Y);
  }
  applyFilter();
  draw();
  renderLegend();
  renderDetailPlaceholder();
  markYears();
  dlLabel();
  window.__demo = {
    year: Y === EMPTY ? null : Y.year, cells: CELLS.slice(),
    n: Y === EMPTY ? 0 : Y.n, resident: RES.size,
    ms: Math.round(performance.now() - t0),
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
  };
  return window.__demo;
}

async function setLayout(name) {
  const L = LAYOUTS[name] || LAYOUTS['1x1'];
  const cells = L.rows * L.cols;
  const all = SUMMARY.years.map((r) => r.year);
  const prev = CELLS.filter((v) => v !== null);
  let next;
  if (cells === 1) {
    next = [prev.length ? prev[0] : all[all.length - 1]];
  } else if (L.def && L.def.every((y) => all.includes(y))) {
    next = L.def.slice(0, cells);
  } else {
    // a spread across whatever years exist
    next = [];
    for (let i = 0; i < cells; i++) {
      next.push(all[Math.min(all.length - 1, Math.round(i * (all.length - 1) / Math.max(1, cells - 1)))]);
    }
  }
  LAY = { rows: L.rows, cols: L.cols };
  CELLS = next;
  computeRects();
  renderCellPickers();
  const d = await applyCells();
  fitTo(FITS['48']);
  return d;
}

async function selectYear(year) {
  if (LAY.rows * LAY.cols === 1) {
    CELLS = [year];
  } else {
    CELLS[0] = year;
    const s = document.querySelector('.cellsel[data-cell="0"]');
    if (s) s.value = String(year);
  }
  return applyCells();
}

// stress: the exact failure mode the first build had -- every year loaded in
// one session -- with the heap read after each, then the grid layouts, which
// hold two, four and nine years resident at once
async function stress() {
  const log = $('#stresslog');
  const out = [];
  log.textContent = 'stepping…\n';
  const before = $('#layout').value;
  if (before !== '1x1') { $('#layout').value = '1x1'; await setLayout('1x1'); }
  for (const r of SUMMARY.years) {
    const d = await selectYear(r.year);
    await new Promise((res) => setTimeout(res, 120));
    out.push(r.year + '  n=' + String(d.n).padStart(7) +
      '  ' + String(d.ms).padStart(5) + ' ms' +
      (d.heapMB === null ? '  heap n/a' : '  heap ' + d.heapMB.toFixed(1) + ' MB'));
    log.textContent = out.join('\n');
    log.scrollTop = log.scrollHeight;
  }
  for (const g of ['1x2', '2x2', '3x3']) {
    $('#layout').value = g;
    const d = await setLayout(g);
    await new Promise((res) => setTimeout(res, 260));
    const hm = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
    out.push(g + '  ' + String(d.resident).padStart(2) + ' years' +
      '  ' + String(d.ms).padStart(5) + ' ms' +
      (hm === null ? '  heap n/a' : '  heap ' + hm.toFixed(1) + ' MB'));
    log.textContent = out.join('\n');
    log.scrollTop = log.scrollHeight;
  }
  $('#layout').value = before;
  await setLayout(before);
  window.__stress = out;
  log.textContent = out.join('\n') + '\n— done, ' + out.length + ' loads in one session —';
}

// ------------------------------------------------------------------ events

function wire() {
  window.addEventListener('resize', () => { resize(); schedule(); });

  $('#mode').addEventListener('change', () => { renderLegend(); schedule(); });
  $('#coarseTop').addEventListener('change', schedule);
  $('#big').addEventListener('change', schedule);
  $('#labels').addEventListener('change', () => { drawOverlay(); });
  $('#layout').addEventListener('change', () => { setLayout($('#layout').value); });
  $('#download').addEventListener('click', downloadYear);
  $('#state').addEventListener('change', () => {
    applyFilter(); renderLegend();
    const v = $('#state').value;
    if (v && Y !== EMPTY) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < Y.n; i++) {
        if (!Y.vis[i]) continue;
        if (Y.mx[i] < x0) x0 = Y.mx[i]; if (Y.mx[i] > x1) x1 = Y.mx[i];
        if (Y.my[i] < y0) y0 = Y.my[i]; if (Y.my[i] > y1) y1 = Y.my[i];
      }
      if (x0 < x1) {
        view.scale = Math.min(cellW() / (x1 - x0), cellH() / (y1 - y0)) * 0.9;
        view.cx = (x0 + x1) / 2; view.cy = (y0 + y1) / 2;
      }
    }
    draw();
  });
  $('#grainfilter').addEventListener('change', () => {
    applyFilter(); renderLegend(); draw();
  });
  $('#stress').addEventListener('click', stress);
  document.querySelectorAll('#zoombar button').forEach((b) => {
    b.addEventListener('click', () => fitTo(FITS[b.dataset.fit]));
  });

  let dragging = false, lx = 0, ly = 0, moved = 0;
  overCanvas.addEventListener('mousedown', (e) => { dragging = true; moved = 0; lx = e.clientX; ly = e.clientY; });
  window.addEventListener('mouseup', () => { dragging = false; });
  overCanvas.addEventListener('mousemove', (e) => {
    const dpr = DPR();
    if (dragging) {
      // one shared viewport: panning moves every panel together
      const dx = (e.clientX - lx) * dpr, dy = (e.clientY - ly) * dpr;
      moved += Math.abs(dx) + Math.abs(dy);
      lx = e.clientX; ly = e.clientY;
      view.cx -= dx / view.scale; view.cy -= dy / view.scale;
      schedule();
      return;
    }
    const r = overCanvas.getBoundingClientRect();
    const sx = (e.clientX - r.left) * dpr, sy = (e.clientY - r.top) * dpr;
    pickAt(sx, sy);
    if (pickP !== hoverP || pickI !== hoverIdx) {
      hoverP = pickP; hoverIdx = pickI;
      drawOverlay();
      const tip = $('#tip');
      const y = hoverP < 0 ? EMPTY : cellYear(hoverP);
      if (hoverIdx < 0 || y === EMPTY) { tip.style.display = 'none'; }
      else {
        const i = hoverIdx;
        const t = y.tot[i], m = t ? (y.dem[i] - y.rep[i]) / t : 0;
        tip.innerHTML = '<b>' + y.meta.states[y.st[i]] + '</b> · ' + esc(y.meta.levels[y.lvl[i]]) +
          (RECTS.length > 1 ? ' · ' + y.year : '') +
          '<br><span class="t">' + fmt(t) + ' votes · ' +
          (t ? ((m >= 0 ? 'D +' : 'R +') + Math.abs(100 * m).toFixed(1) + 'pp') : 'no votes') +
          '<br>click to inspect</span>';
        tip.style.display = 'block';
        tip.style.left = Math.min(r.width - 290, e.clientX - r.left + 14) + 'px';
        tip.style.top = (e.clientY - r.top + 14) + 'px';
      }
    }
  });
  overCanvas.addEventListener('mouseleave', () => {
    hoverP = -1; hoverIdx = -1; $('#tip').style.display = 'none'; drawOverlay();
  });
  overCanvas.addEventListener('click', (e) => {
    if (moved > 6) return;
    const dpr = DPR();
    const r = overCanvas.getBoundingClientRect();
    pickAt((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
    if (pickI >= 0) {
      const y = cellYear(pickP);
      if (y !== EMPTY) showUnit(y, pickI);
    }
  });
  overCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dpr = DPR();
    const r = overCanvas.getBoundingClientRect();
    const sx = (e.clientX - r.left) * dpr, sy = (e.clientY - r.top) * dpr;
    // zoom about the cursor within its own panel; the scale is shared, so
    // every panel keeps the same extent
    const k = panelAt(sx, sy);
    const rect = k >= 0 ? RECTS[k] : { x: 0, y: 0, w: pxW, h: pxH };
    const cxp = rect.x + rect.w / 2, cyp = rect.y + rect.h / 2;
    const before = { x: (sx - (cxp - view.cx * view.scale)) / view.scale,
                     y: (sy - (cyp - view.cy * view.scale)) / view.scale };
    const kk = Math.exp(-e.deltaY * 0.0016);
    view.scale = Math.max(200, Math.min(4e6, view.scale * kk));
    const ox = cxp - view.cx * view.scale, oy = cyp - view.cy * view.scale;
    const after = { x: (sx - ox) / view.scale, y: (sy - oy) / view.scale };
    view.cx += before.x - after.x; view.cy += before.y - after.y;
    schedule();
  }, { passive: false });
}

// ------------------------------------------------------------------ boot

(async function boot() {
  resize();
  wire();
  $('#dlnote').innerHTML = DL_NOTE;
  status('loading summary…');
  SUMMARY = await (await fetch('data/summary.json')).json();
  STATIC = await (await fetch('data/static.json')).json();
  renderYears();
  const last = SUMMARY.years[SUMMARY.years.length - 1].year;
  CELLS = [last];
  await applyCells();
  fitTo(FITS['48']);
  window.__ready = true;
})();
