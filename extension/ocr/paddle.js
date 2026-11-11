// Text recognition with PaddleOCR (PP-OCRv5 mobile models) on ONNX Runtime.
// Plain JavaScript with no DOM access, so the same code runs in the extension's OCR worker and in tests.
//
// recognise(image) takes an RGBA image { data, width, height } and returns
//   { lines: [{ h, conf, words: [{ t, a: [x, y], z: [x, y] }] }] }
// in image pixels. a and z are where a word's baseline starts and ends, in reading order, so lines that are
// skewed, vertical or upside down keep their direction. h is the height of the line's letters.
//
// The steps:
//  1. detect: the detector (DBNet) marks where text is; each blob of marked pixels becomes a rotated box.
//  2. orient: boxes are read left to right unless tall and narrow; a small classifier says whether lines are
//     upside down (the whole page) or which way a vertical line runs.
//  3. read: each box is cut out, straightened to 48 pixels high and read by the recogniser (SVTR, CTC).
//  4. words: the recogniser's character positions, snapped to the gaps between words in the ink, give each
//     word its own box, so selecting part of a line works.

const DET_MEAN = [0.485, 0.456, 0.406], DET_STD = [0.229, 0.224, 0.225];   // per channel, in B, G, R order

export function createOcr({ ort, det, rec, cls, dict, detMax = 2400 }) {
  const chars = ['', ...dict, ' '];   // CTC: 0 is the blank, the last class is a space

  async function recognise(img) {
    const times = {}, t = () => performance.now();
    let t0 = t();
    const boxes = await detect(img);
    times.detect = t() - t0;
    if (!boxes.length) return { lines: [], times };
    t0 = t();
    await orient(img, boxes);
    const jobs = [];
    for (const b of boxes) {
      b.main = { box: b, crop: crop(img, b.frame) };
      jobs.push(b.main);
      if (b.alt) jobs.push(b.other = { box: b, crop: crop(img, b.alt) });
    }
    times.prepare = t() - t0;
    t0 = t();
    await read(jobs);
    times.read = t() - t0;
    const lines = [];
    for (const b of boxes) {
      // A tall, narrow box is read both ways; a vertical reading wins only when it's clearly better.
      const { main, other } = b;
      const pick = other && other.text.replace(/\s/g, '').length >= 2 && other.conf > main.conf + 0.1 ? other : main;
      if (!pick.text.trim() || pick.conf < 0.5) continue;
      const line = words(pick);
      if (line) lines.push(line);
    }
    return { lines: readingOrder(lines), times };
  }

  /* ---------- 1. detection ---------- */

  async function detect(img) {
    const { width: w, height: h } = img;
    const s = Math.min(1, detMax / Math.max(w, h));
    const W = Math.max(32, Math.round(w * s / 32) * 32), H = Math.max(32, Math.round(h * s / 32) * 32);
    const x = new Float32Array(3 * W * H);
    resample(img, W, H, (i, r, g, b) => {
      x[i] = (b / 255 - DET_MEAN[0]) / DET_STD[0];
      x[W * H + i] = (g / 255 - DET_MEAN[1]) / DET_STD[1];
      x[2 * W * H + i] = (r / 255 - DET_MEAN[2]) / DET_STD[2];
    });
    const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, H, W]) });
    const prob = out[det.outputNames[0]].data;
    return blobs(prob, W, H).map(r => frame(r, w / W, h / H)).filter(Boolean);
  }

  // The detector's probability map -> rotated rectangles around each blob of text, in map pixels.
  function blobs(prob, W, H, thresh = 0.3, boxThresh = 0.5, unclip = 1.5) {
    // Threshold, then dilate by one pixel down and right (as PaddleOCR does), then find connected runs.
    const on = new Uint8Array(W * H);
    for (let i = 0; i < on.length; i++) on[i] = prob[i] > thresh ? 1 : 0;
    const bin = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      bin[i] = on[i] | (x > 0 && on[i - 1]) | (y > 0 && on[i - W]) | (x > 0 && y > 0 && on[i - W - 1]);
    }
    const runs = [];   // [y, x0, x1] (x1 inclusive)
    const parent = [];
    const find = a => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
    let prev = [];
    for (let y = 0; y < H; y++) {
      const cur = [];
      for (let x = 0; x < W; x++) {
        if (!bin[y * W + x]) continue;
        const x0 = x;
        while (x + 1 < W && bin[y * W + x + 1]) x++;
        const id = runs.length;
        runs.push([y, x0, x]);
        parent.push(id);
        cur.push(id);
        for (const p of prev) {   // 8-connected to a run in the row above
          const [, px0, px1] = runs[p];
          if (px0 <= x + 1 && px1 >= x0 - 1) { const a = find(p), b = find(id); if (a !== b) parent[b] = a; }
        }
      }
      prev = cur;
    }
    const groups = new Map();
    runs.forEach((r, id) => { const k = find(id); (groups.get(k) ?? groups.set(k, []).get(k)).push(r); });
    const rects = [];
    for (const g of groups.values()) {
      let sum = 0, n = 0;
      const pts = [];
      for (const [y, x0, x1] of g) {
        for (let x = x0; x <= x1; x++) sum += prob[y * W + x];
        n += x1 - x0 + 1;
        pts.push([x0, y], [x1 + 1, y], [x0, y + 1], [x1 + 1, y + 1]);
      }
      if (n < 6 || sum / n < boxThresh) continue;
      const r = minRect(hull(pts));
      if (Math.min(r.w, r.h) < 3) continue;
      const d = r.w * r.h * unclip / (2 * (r.w + r.h));   // grow back to the whole text, as PaddleOCR does
      r.w += 2 * d; r.h += 2 * d;
      if (Math.min(r.w, r.h) < 5) continue;
      r.score = sum / n;
      rects.push(r);
    }
    return rects;
  }

  // A rectangle (map pixels) -> its frame in image pixels: o is the top-left corner as the text reads,
  // u runs along the text (length L), v across it towards the bottom of the letters (height T).
  function frame(r, sx, sy) {
    // Scale the rectangle's two axes into the image (the map may be scaled slightly differently in x and y).
    const ax = [r.ux * r.w * sx, r.uy * r.w * sy], bx = [-r.uy * r.h * sx, r.ux * r.h * sy];
    const c = [r.cx * sx, r.cy * sy];
    // Of the four directions along the sides, text is assumed to run along the one nearest left-to-right.
    const dirs = [ax, bx, [-ax[0], -ax[1]], [-bx[0], -bx[1]]];
    let along = dirs[0];
    for (const d of dirs) if (d[0] / Math.hypot(...d) > along[0] / Math.hypot(...along)) along = d;
    const across = along === dirs[0] || along === dirs[2] ? bx : ax;
    const L = Math.hypot(...along), T = Math.hypot(...across);
    const f = make(c, [along[0] / L, along[1] / L], L, T);
    if (L < 2 || T < 2) return null;
    const box = { frame: f, score: r.score };
    if (T >= 1.5 * L) box.alt = make(c, [f.v[0], f.v[1]].map(z => -z), T, L);   // could be a line running upwards
    return box;
  }
  function make(c, u, L, T) {
    const v = [-u[1], u[0]];   // 90° clockwise from u, in image coordinates (y points down)
    return { o: [c[0] - u[0] * L / 2 - v[0] * T / 2, c[1] - u[1] * L / 2 - v[1] * T / 2], u, v, L, T };
  }
  const flip = f => ({ o: [f.o[0] + f.u[0] * f.L + f.v[0] * f.T, f.o[1] + f.u[1] * f.L + f.v[1] * f.T], u: f.u.map(z => -z), v: f.v.map(z => -z), L: f.L, T: f.T });

  /* ---------- 2. orientation ---------- */

  // Upside-down pages: if most of the (weighted) horizontal lines read better turned round, turn them all.
  // Vertical lines: decide one by one whether they run upwards or downwards.
  async function orient(img, boxes) {
    if (!cls) return;
    const flat = boxes.filter(b => !b.alt).sort((a, b) => b.frame.L - a.frame.L).slice(0, 24);
    const tall = boxes.filter(b => b.alt);
    const items = [...flat.map(b => b.frame), ...tall.map(b => b.alt)];
    if (!items.length) return;
    const p = await classify(img, items);
    let up = 0, down = 0;
    flat.forEach((b, k) => { const w = Math.min(b.frame.L / b.frame.T, 20); if (p[k] > 0.5) down += w * p[k]; else up += w * (1 - p[k]); });
    if (down > up * 1.5) for (const b of boxes) if (!b.alt) b.frame = flip(b.frame);
    tall.forEach((b, k) => { if (p[flat.length + k] > 0.9) b.alt = flip(b.alt); });
  }

  async function classify(img, frames) {   // the chance each line is upside down, 0..1
    const H = 80, W = 160, n = frames.length;
    const x = new Float32Array(n * 3 * H * W);
    frames.forEach((f, k) => {
      const w = Math.min(W, Math.ceil(H * f.L / f.T));
      cut(img, f, w, H, (i, j, r, g, b) => {
        const o = k * 3 * H * W + j * W + i;
        x[o] = (b / 255 - 0.5) / 0.5; x[o + H * W] = (g / 255 - 0.5) / 0.5; x[o + 2 * H * W] = (r / 255 - 0.5) / 0.5;
      });
    });
    const out = await cls.run({ [cls.inputNames[0]]: new ort.Tensor('float32', x, [n, 3, H, W]) });
    const d = out[cls.outputNames[0]].data;
    return frames.map((_, k) => d[2 * k + 1]);
  }

  /* ---------- 3. reading ---------- */

  const RH = 48;   // the recogniser's input height

  function crop(img, f) {   // the box straightened to RH pixels high, as RGB bytes, plus its width
    const w = Math.max(8, Math.min(3200, Math.ceil(RH * f.L / f.T)));
    const px = new Uint8Array(w * RH * 3);
    cut(img, f, w, RH, (i, j, r, g, b) => { const o = 3 * (j * w + i); px[o] = r; px[o + 1] = g; px[o + 2] = b; });
    stretch(px);
    return { f, w, px };
  }

  async function read(jobs) {
    const order = [...jobs].sort((a, b) => a.crop.w - b.crop.w);
    for (let s = 0; s < order.length;) {
      // Batches of similar widths, up to 8 lines or about 8000 pixels of width.
      const batch = [order[s]];
      while (s + batch.length < order.length && batch.length < 8 &&
             order[s + batch.length].crop.w * (batch.length + 1) <= Math.max(8000, order[s].crop.w * 2)) batch.push(order[s + batch.length]);
      s += batch.length;
      const W = Math.max(16, Math.ceil(batch.at(-1).crop.w / 8) * 8), n = batch.length;
      const x = new Float32Array(n * 3 * RH * W);   // zero padding, as PaddleOCR pads
      batch.forEach((job, k) => {
        const { w, px } = job.crop;
        for (let j = 0; j < RH; j++) for (let i = 0; i < w; i++) {
          const q = 3 * (j * w + i), o = k * 3 * RH * W + j * W + i;
          x[o] = (px[q + 2] / 255 - 0.5) / 0.5; x[o + RH * W] = (px[q + 1] / 255 - 0.5) / 0.5; x[o + 2 * RH * W] = (px[q] / 255 - 0.5) / 0.5;
        }
      });
      const out = (await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', x, [n, 3, RH, W]) }))[rec.outputNames[0]];
      const [, T, C] = out.dims, d = out.data;
      batch.forEach((job, k) => {
        const found = [];   // { c, t0, t1, p }
        let last = 0;
        for (let t = 0; t < T; t++) {
          let best = 0, bp = -1;
          const o = (k * T + t) * C;
          for (let c = 0; c < C; c++) if (d[o + c] > bp) { bp = d[o + c]; best = c; }
          if (best && best === last) { const ch = found.at(-1); ch.t1 = t; ch.p = Math.max(ch.p, bp); }
          else if (best) found.push({ c: chars[best] ?? '', t0: t, t1: t, p: bp });
          last = best;
        }
        job.step = W / T;   // input pixels per output column
        job.chars = found;
        job.text = found.map(c => c.c).join('');
        job.conf = found.length ? found.reduce((a, c) => a + c.p, 0) / found.length : 0;
      });
    }
  }

  /* ---------- 4. words ---------- */

  function words(job) {
    const { f, w, px } = job.crop, step = job.step;
    // Ink: pixels darker than the middle of the crop's range, counted per column and per row.
    const g = new Float32Array(w * RH);
    let lo = 255, hi = 0;
    for (let i = 0; i < g.length; i++) { g[i] = (px[3 * i] * 299 + px[3 * i + 1] * 587 + px[3 * i + 2] * 114) / 1000; lo = Math.min(lo, g[i]); hi = Math.max(hi, g[i]); }
    const mid = (lo + hi) / 2, col = new Uint16Array(w), row = new Uint16Array(RH);
    if (hi - lo > 24) for (let j = 0; j < RH; j++) for (let i = 0; i < w; i++) if (g[j * w + i] < mid) { col[i]++; row[j]++; }
    const inked = a => { let s = -1, e = -1; a.forEach((n, i) => { if (n) { if (s < 0) s = i; e = i; } }); return [s, e]; };
    const [c0, c1] = inked(col), [r0, r1] = inked(row);

    // Words from the characters, at their columns in the crop.
    const ws = [];
    let cur = null;
    for (const ch of job.chars) {
      if (ch.c === ' ') { cur = null; continue; }
      if (!cur) ws.push(cur = { t: '', s: ch.t0 * step, e: (ch.t1 + 1) * step });
      cur.t += ch.c;
      cur.e = (ch.t1 + 1) * step;
    }
    if (!ws.length) return null;
    // Snap each boundary between two words to the widest gap in the ink between them.
    for (let k = 0; k + 1 < ws.length; k++) {
      const a = Math.max(0, Math.floor(ws[k].e - 2 * step)), b = Math.min(w - 1, Math.ceil(ws[k + 1].s + step));
      let best = null;
      for (let i = a; i <= b; i++) {
        if (col[i]) continue;
        let j = i;
        while (j + 1 <= b && !col[j + 1]) j++;
        if (!best || j - i > best[1] - best[0]) best = [i, j];
        i = j;
      }
      if (best) { ws[k].e = best[0]; ws[k + 1].s = best[1] + 1; }
      else { const m = (ws[k].e + ws[k + 1].s) / 2; ws[k].e = ws[k + 1].s = m; }
    }
    if (c0 >= 0) { ws[0].s = Math.min(ws[0].s, c0); ws.at(-1).e = Math.max(ws.at(-1).e, c1 + 1); }
    for (const x of ws) { x.s = Math.max(0, x.s); x.e = Math.min(w, Math.max(x.e, x.s + 1)); }

    // Back to image pixels: crop column i is f.o + u * i * k, crop row j is f.o + v * j * (T / RH).
    const k = f.L / w, top = (r0 >= 0 ? r0 : 0) * f.T / RH, bottom = (r1 >= 0 ? r1 + 1 : RH) * f.T / RH;
    const h = Math.max(1, bottom - top), base = top + 0.8 * h;
    const at = (i, j) => [f.o[0] + f.u[0] * i * k + f.v[0] * j, f.o[1] + f.u[1] * i * k + f.v[1] * j];
    return { h, conf: job.conf, words: ws.map(x => ({ t: x.t, a: at(x.s, base), z: at(x.e, base) })) };
  }

  return { recognise };
}

/* ---------- reading order ---------- */

// Lines in the order they're read: the page is cut recursively along clear gaps (a recursive X-Y cut), columns
// left to right and blocks top to bottom, in the page's own frame (turned by the lines' typical angle, so skewed
// and upside-down pages work too). Selecting across lines, finding phrases and copying then follow the text.
function readingOrder(lines) {
  if (lines.length < 2) return lines;
  let sx = 0, sy = 0;
  for (const l of lines) for (const w of l.words) { sx += w.z[0] - w.a[0]; sy += w.z[1] - w.a[1]; }
  const ang = Math.atan2(sy, sx), c = Math.cos(-ang), s = Math.sin(-ang);
  const rot = ([x, y]) => [x * c - y * s, x * s + y * c];
  const boxes = lines.map(l => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const w of l.words) for (const p of [w.a, w.z]) {
      const [x, y] = rot(p);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y - l.h * 0.8); y1 = Math.max(y1, y + l.h * 0.2);
    }
    return { l, x0, x1, y0, y1 };
  });
  const hs = lines.map(l => l.h).sort((a, b) => a - b), h = hs[hs.length >> 1];
  // The widest gap in the boxes' projection on one axis, if it's at least min wide: the coordinate to cut at.
  const gap = (set, lo, hi, min) => {
    const iv = set.map(b => [b[lo], b[hi]]).sort((a, b) => a[0] - b[0]);
    let end = iv[0][1], best = null;
    for (const [a, z] of iv.slice(1)) {
      if (a - end >= min && (!best || a - end > best.w)) best = { at: (a + end) / 2, w: a - end };
      end = Math.max(end, z);
    }
    return best;
  };
  const cut = set => {
    if (set.length < 2) return set;
    // A gutter between columns comes first, unless something spans it (a heading across both columns).
    const col = gap(set, 'x0', 'x1', Math.max(1.2 * h, 6));
    const row = gap(set, 'y0', 'y1', 0.2 * h);
    // Narrow pieces either side of a gutter are table cells, read row by row; wide ones are columns of text.
    const thin = side => { const ws = side.map(b => b.x1 - b.x0).sort((a, b) => a - b); return ws[ws.length >> 1] < 8 * h; };
    const narrow = col && thin(set.filter(b => (b.x0 + b.x1) / 2 < col.at)) && thin(set.filter(b => (b.x0 + b.x1) / 2 >= col.at));
    if (row && (!col || narrow || row.w > 1.5 * h)) { const top = set.filter(b => (b.y0 + b.y1) / 2 < row.at); return [...cut(top), ...cut(set.filter(b => !top.includes(b)))]; }
    if (col) { const left = set.filter(b => (b.x0 + b.x1) / 2 < col.at); return [...cut(left), ...cut(set.filter(b => !left.includes(b)))]; }
    if (row) { const top = set.filter(b => (b.y0 + b.y1) / 2 < row.at); return [...cut(top), ...cut(set.filter(b => !top.includes(b)))]; }
    return [...set].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0);
  };
  return cut(boxes).map(b => b.l);
}

/* ---------- geometry and pixels ---------- */

// Spread a line's tones over the full range (its darkest 1% to black, its lightest 1% to white), so text on
// dark, grey or faded paper reaches the recogniser with good contrast. Lines that are already crisp barely change.
function stretch(px) {
  const hist = new Uint32Array(256), n = px.length / 3;
  for (let i = 0; i < px.length; i += 3) hist[(px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8]++;
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < n * 0.01) lo++;
  acc = 0;
  while (hi > 0 && (acc += hist[hi]) < n * 0.01) hi--;
  if (hi - lo < 16 || (lo < 8 && hi > 247)) return;
  const k = 255 / (hi - lo);
  for (let i = 0; i < px.length; i++) px[i] = Math.max(0, Math.min(255, (px[i] - lo) * k));
}

function hull(pts) {   // convex hull (monotone chain), counter-clockwise
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function minRect(h) {   // smallest rotated rectangle around a convex polygon (one side lies on a polygon edge)
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const p = h[i], q = h[(i + 1) % h.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!len) continue;
    const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of h) {
      const a = x * ux + y * uy, b = -x * uy + y * ux;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) {
      const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
      best = { area, ux, uy, w: a1 - a0, h: b1 - b0, cx: ca * ux - cb * uy, cy: ca * uy + cb * ux };
    }
  }
  return best ?? { ux: 1, uy: 0, w: 0, h: 0, cx: 0, cy: 0 };
}

// Bilinear sample of an RGBA image at (x, y) in pixel-centre coordinates; white outside the image.
function sample(img, x, y, out) {
  const { data, width: W, height: H } = img;
  x -= 0.5; y -= 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  out[0] = out[1] = out[2] = 0;
  for (let k = 0; k < 4; k++) {
    const xi = x0 + (k & 1), yi = y0 + (k >> 1), wgt = (k & 1 ? fx : 1 - fx) * (k >> 1 ? fy : 1 - fy);
    if (!wgt) continue;
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) { out[0] += 255 * wgt; out[1] += 255 * wgt; out[2] += 255 * wgt; continue; }
    const o = 4 * (yi * W + xi);
    out[0] += data[o] * wgt; out[1] += data[o + 1] * wgt; out[2] += data[o + 2] * wgt;
  }
}

// The image scaled to W x H; each target pixel averages a small grid of samples when shrinking.
function resample(img, W, H, put) {
  const sx = img.width / W, sy = img.height / H;
  const nx = Math.min(3, Math.ceil(sx - 0.01)), ny = Math.min(3, Math.ceil(sy - 0.01)), m = nx * ny;
  const s = [0, 0, 0];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let r = 0, g = 0, b = 0;
    for (let a = 0; a < ny; a++) for (let c = 0; c < nx; c++) {
      sample(img, (i + (c + 0.5) / nx) * sx, (j + (a + 0.5) / ny) * sy, s);
      r += s[0]; g += s[1]; b += s[2];
    }
    put(j * W + i, r / m, g / m, b / m);
  }
}

// The part of the image inside frame f, straightened to w x h pixels (supersampled when shrinking).
function cut(img, f, w, h, put) {
  const ku = f.L / w, kv = f.T / h;
  const n = Math.min(3, Math.max(1, Math.ceil(Math.max(ku, kv) - 0.01))), m = n * n;
  const s = [0, 0, 0];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let r = 0, g = 0, b = 0;
    for (let a = 0; a < n; a++) for (let c = 0; c < n; c++) {
      const di = (i + (c + 0.5) / n) * ku, dj = (j + (a + 0.5) / n) * kv;
      sample(img, f.o[0] + f.u[0] * di + f.v[0] * dj, f.o[1] + f.u[1] * di + f.v[1] * dj, s);
      r += s[0]; g += s[1]; b += s[2];
    }
    put(i, j, r / m, g / m, b / m);
  }
}
