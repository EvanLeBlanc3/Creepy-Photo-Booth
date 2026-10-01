/* Creepy Photo Booth — haunting engine
   Procedurally paints shadow figures into a photo so they look like
   they were really there: placed in dark/flat areas, tone-matched,
   soft-focused, smoke-dissolved, with sensor grain added back in. */
window.Haunt = (() => {
  'use strict';
  const R = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };

  /* ---------- blur (native filter if supported, else mip-chain) ---------- */
  let FILTER_OK = null;
  function filterOK() {
    if (FILTER_OK !== null) return FILTER_OK;
    try {
      const c = mk(24, 24), x = c.getContext('2d');
      if (!('filter' in x)) return (FILTER_OK = false);
      x.filter = 'blur(3px)'; x.fillStyle = '#000'; x.fillRect(10, 10, 4, 4);
      FILTER_OK = x.getImageData(7, 12, 1, 1).data[3] > 0;
    } catch (e) { FILTER_OK = false; }
    return FILTER_OK;
  }
  function blur(src, r) {
    if (r < 0.6) return src;
    const w = src.width, h = src.height, out = mk(w, h), o = out.getContext('2d');
    if (filterOK()) { o.filter = `blur(${r.toFixed(1)}px)`; o.drawImage(src, 0, 0); o.filter = 'none'; return out; }
    let levels = 0; while ((1 << (levels + 1)) <= r * 1.2 && (w >> (levels + 1)) > 2 && (h >> (levels + 1)) > 2) levels++;
    let c = src; const chain = [src];
    for (let i = 0; i < levels; i++) {
      const n = mk(c.width / 2, c.height / 2), nx = n.getContext('2d');
      nx.imageSmoothingQuality = 'high'; nx.drawImage(c, 0, 0, n.width, n.height); chain.push(n); c = n;
    }
    for (let i = chain.length - 2; i >= 1; i--) {
      const t = chain[i], n = mk(t.width, t.height), nx = n.getContext('2d');
      nx.imageSmoothingQuality = 'high'; nx.drawImage(c, 0, 0, n.width, n.height); c = n;
    }
    o.imageSmoothingQuality = 'high'; o.drawImage(c, 0, 0, w, h);
    return out;
  }

  /* ---------- value noise (fbm) for smoky dissolve ---------- */
  function makeNoise() {
    const S = 128, g = new Float32Array(S * S);
    for (let i = 0; i < g.length; i++) g[i] = Math.random();
    const f = (x, y) => {
      let xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi; xi &= 127; yi &= 127;
      const x1 = (xi + 1) & 127, y1 = (yi + 1) & 127;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = g[yi * S + xi], b = g[yi * S + x1], c = g[y1 * S + xi], d = g[y1 * S + x1];
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };
    return (x, y) => f(x, y) * 0.5 + f(x * 2.1 + 17, y * 2.1 + 5) * 0.3 + f(x * 4.3 + 3, y * 4.3 + 31) * 0.2;
  }

  /* ---------- shape primitives ---------- */
  function ell(x, cx, cy, rx, ry, rot = 0) { x.beginPath(); x.ellipse(cx, cy, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, Math.PI * 2); x.fill(); }
  function limb(x, x1, y1, x2, y2, w1, w2) {
    const a = Math.atan2(y2 - y1, x2 - x1), nx = -Math.sin(a), ny = Math.cos(a);
    x.beginPath();
    x.moveTo(x1 + nx * w1 / 2, y1 + ny * w1 / 2); x.lineTo(x2 + nx * w2 / 2, y2 + ny * w2 / 2);
    x.lineTo(x2 - nx * w2 / 2, y2 - ny * w2 / 2); x.lineTo(x1 - nx * w1 / 2, y1 - ny * w1 / 2);
    x.closePath(); x.fill();
    ell(x, x1, y1, w1 / 2, w1 / 2); ell(x, x2, y2, w2 / 2, w2 / 2);
  }
  const rot = (cx, cy, dx, dy, t) => ({ x: cx + Math.cos(t) * dx - Math.sin(t) * dy, y: cy + Math.sin(t) * dx + Math.cos(t) * dy });
  function fingers(x, wx, wy, dir, u, n, len, spread) {
    for (let f = 0; f < n; f++) {
      const off = (f - (n - 1) / 2);
      const a = dir + off * spread + R(-0.06, 0.06);
      const bx = wx + Math.cos(dir + Math.PI / 2) * off * 0.055 * u, by = wy + Math.sin(dir + Math.PI / 2) * off * 0.055 * u;
      const L1 = len * u * R(0.5, 0.6), L2 = len * u * R(0.4, 0.5);
      const jx = bx + Math.cos(a) * L1, jy = by + Math.sin(a) * L1, a2 = a + R(-0.4, 0.4);
      limb(x, bx, by, jx, jy, 0.075 * u, 0.058 * u);
      limb(x, jx, jy, jx + Math.cos(a2) * L2, jy + Math.sin(a2) * L2, 0.058 * u, 0.03 * u);
    }
  }

  /* ---------- entities (drawn in black, return eye positions) ---------- */
  function drawTall(x, W, H, p) {
    const top = H * 0.03, FH = H * 0.94, u = FH / (p.heads || 8.2), cx = W * (p.cx || 0.5), t = p.tilt, sh = u * p.shoulder;
    const hx = cx + Math.sin(t) * u * 0.5, hy = top + 0.52 * u;
    x.save(); x.translate(hx, hy); x.rotate(t); ell(x, 0, 0, 0.37 * u, 0.52 * u); x.restore();
    limb(x, cx + Math.sin(t) * u * 0.18, top + 0.9 * u, cx, top + 1.45 * u, 0.3 * u, 0.38 * u);
    x.beginPath(); x.moveTo(cx - 0.2 * u, top + 1.28 * u);
    x.quadraticCurveTo(cx - 0.72 * u, top + 1.32 * u, cx - sh, top + 1.72 * u);
    x.lineTo(cx - 0.6 * u, top + 3.1 * u); x.lineTo(cx - 0.68 * u, top + 4.15 * u);
    x.lineTo(cx + 0.68 * u, top + 4.15 * u); x.lineTo(cx + 0.6 * u, top + 3.1 * u);
    x.lineTo(cx + sh, top + 1.72 * u); x.quadraticCurveTo(cx + 0.72 * u, top + 1.32 * u, cx + 0.2 * u, top + 1.28 * u);
    x.closePath(); x.fill();
    for (const s of [-1, 1]) {
      const ax = cx + s * (sh - 0.14 * u), ay = top + 1.85 * u;
      if (p.reach && s === 1) {
        const ex = ax + 1.25 * u, ey = top + 2.05 * u, wx = ex + 1.35 * u, wy = top + 2.25 * u + R(-0.2, 0.2) * u;
        limb(x, ax, ay, ex, ey, 0.4 * u, 0.3 * u); limb(x, ex, ey, wx, wy, 0.3 * u, 0.2 * u);
        ell(x, wx + 0.15 * u, wy + 0.05 * u, 0.25 * u, 0.14 * u, 0.15);
        fingers(x, wx + 0.3 * u, wy + 0.08 * u, 0.35, u, 4, p.finger * 1.5, 0.17);
        continue;
      }
      const ex = cx + s * (sh + 0.06 * u + p.armOut * u), ey = top + 3.35 * u;
      const wx = cx + s * (sh + 0.02 * u + p.armOut * u * 1.5), wy = top + p.armLen * u;
      limb(x, ax, ay, ex, ey, 0.42 * u, 0.3 * u); limb(x, ex, ey, wx, wy, 0.3 * u, 0.2 * u);
      ell(x, wx, wy + 0.2 * u, 0.13 * u, 0.24 * u);
      fingers(x, wx, wy + 0.36 * u, Math.PI / 2 - s * 0.05, u, 4, p.finger, 0.08);
    }
    for (const s of [-1, 1]) {
      const hx2 = cx + s * 0.36 * u, hy2 = top + 4.0 * u;
      const kx = cx + s * (0.38 * u + p.spread * u), ky = top + 6.0 * u;
      const ax = cx + s * (0.36 * u + p.spread * u * 1.25), ay = top + 7.85 * u;
      limb(x, hx2, hy2, kx, ky, 0.64 * u, 0.4 * u); limb(x, kx, ky, ax, ay, 0.4 * u, 0.24 * u);
      ell(x, ax + s * 0.08 * u, ay + 0.08 * u, 0.22 * u, 0.1 * u);
    }
    return [rot(hx, hy, -0.14 * u, -0.02 * u, t), rot(hx, hy, 0.14 * u, -0.02 * u, t)].map(e => ({ ...e, r: 0.032 * u }));
  }

  function drawHooded(x, W, H, p) {
    const top = H * 0.03, FH = H * 0.94, u = FH / 7.8, cx = W / 2, lean = p.tilt * 0.6 * u;
    x.beginPath(); x.moveTo(cx + lean + 0.1 * u, top);
    x.bezierCurveTo(cx + lean + 0.62 * u, top + 0.05 * u, cx + 0.78 * u, top + 0.8 * u, cx + 0.7 * u, top + 1.4 * u);
    x.quadraticCurveTo(cx + 1.15 * u, top + 1.6 * u, cx + 1.2 * u, top + 2.2 * u);
    x.bezierCurveTo(cx + 1.25 * u, top + 4 * u, cx + 1.45 * u, top + 6 * u, cx + 1.6 * u, top + 7.8 * u);
    const n = 11;
    for (let i = 1; i <= n; i++) x.lineTo(cx + 1.6 * u - 3.2 * u * i / n + R(-0.08, 0.08) * u, top + 7.8 * u + (i % 2 ? R(-0.4, -0.05) : R(0, 0.15)) * u);
    x.bezierCurveTo(cx - 1.45 * u, top + 6 * u, cx - 1.25 * u, top + 4 * u, cx - 1.2 * u, top + 2.2 * u);
    x.quadraticCurveTo(cx - 1.15 * u, top + 1.6 * u, cx - 0.7 * u, top + 1.4 * u);
    x.bezierCurveTo(cx - 0.78 * u, top + 0.8 * u, cx + lean - 0.55 * u, top + 0.05 * u, cx + lean + 0.1 * u, top);
    x.closePath(); x.fill();
    if (Math.random() < 0.5) { // a bony hand slipping from the sleeve
      const s = Math.random() < 0.5 ? -1 : 1, wx = cx + s * 1.05 * u, wy = top + 4.2 * u;
      ell(x, wx, wy, 0.12 * u, 0.22 * u); fingers(x, wx, wy + 0.18 * u, Math.PI / 2, u, 4, 0.55, 0.07);
    }
    const ex = cx + lean * 0.5, ey = top + 0.85 * u;
    return [{ x: ex - 0.16 * u, y: ey, r: 0.045 * u }, { x: ex + 0.16 * u, y: ey, r: 0.045 * u }];
  }

  function drawChild(x, W, H, p) {
    const top = H * 0.03, FH = H * 0.94, u = FH / 5.6, cx = W / 2, t = p.tilt * 0.7;
    const hx = cx + Math.sin(t) * u * 0.4, hy = top + 0.5 * u;
    x.save(); x.translate(hx, hy); x.rotate(t);
    ell(x, 0, 0, 0.42 * u, 0.5 * u);
    x.beginPath(); x.moveTo(-0.46 * u, -0.15 * u); x.quadraticCurveTo(-0.56 * u, 1.0 * u, -0.62 * u, 1.9 * u);
    for (let i = 0; i <= 10; i++) x.lineTo(-0.62 * u + 1.24 * u * i / 10, 1.9 * u + (i % 2 ? R(0.1, 0.4) : R(-0.12, 0.05)) * u);
    x.quadraticCurveTo(0.56 * u, 1.0 * u, 0.46 * u, -0.15 * u); x.closePath(); x.fill();
    x.restore();
    x.beginPath(); x.moveTo(cx - 0.15 * u, top + 0.95 * u); x.lineTo(cx - 0.6 * u, top + 1.25 * u);
    x.lineTo(cx - 0.92 * u, top + 3.6 * u);
    for (let i = 1; i <= 7; i++) x.lineTo(cx - 0.92 * u + 1.84 * u * i / 7, top + 3.6 * u + R(-0.08, 0.12) * u);
    x.lineTo(cx + 0.6 * u, top + 1.25 * u); x.lineTo(cx + 0.15 * u, top + 0.95 * u); x.closePath(); x.fill();
    for (const s of [-1, 1]) {
      limb(x, cx + s * 0.58 * u, top + 1.35 * u, cx + s * 0.74 * u, top + 2.4 * u, 0.25 * u, 0.19 * u);
      limb(x, cx + s * 0.74 * u, top + 2.4 * u, cx + s * 0.72 * u, top + 3.3 * u, 0.19 * u, 0.14 * u);
      ell(x, cx + s * 0.72 * u, top + 3.44 * u, 0.09 * u, 0.15 * u);
      limb(x, cx + s * 0.26 * u, top + 3.5 * u, cx + s * 0.28 * u, top + 5.4 * u, 0.26 * u, 0.17 * u);
      ell(x, cx + s * 0.31 * u, top + 5.48 * u, 0.16 * u, 0.07 * u);
    }
    // only one eye peeks through the hair
    const e = rot(hx, hy, (Math.random() < 0.5 ? -1 : 1) * 0.15 * u, 0.02 * u, t);
    return [{ ...e, r: 0.05 * u }];
  }

  function drawPeeker(x, W, H, p) { // emerges from the LEFT edge (mirrored later for right)
    const hh = H / 3.1, rx = 0.37 * hh, ry = 0.5 * hh, hx = rx * R(0.2, 0.55), hy = H * 0.34, t = R(0.2, 0.5);
    x.save(); x.translate(hx, hy); x.rotate(t); ell(x, 0, 0, rx, ry); x.restore();
    limb(x, hx - rx * 0.2, hy + 0.3 * hh, -0.05 * hh, hy + 0.8 * hh, 0.34 * hh, 0.42 * hh);
    ell(x, -0.3 * hh, hy + 1.02 * hh, 0.85 * hh, 0.33 * hh, 0.12);
    x.fillRect(-W, hy + 1.0 * hh, W + 0.5 * hh, H);
    if (p.grip) { // long fingers curling around the edge above the head
      const gy = hy - 0.72 * hh;
      for (let i = 0; i < 4; i++) {
        const y = gy + i * 0.11 * hh, L = hh * R(0.24, 0.34);
        limb(x, -0.05 * hh, y, L * 0.6, y - 0.015 * hh, 0.095 * hh, 0.08 * hh);
        limb(x, L * 0.6, y - 0.015 * hh, L, y + 0.07 * hh, 0.08 * hh, 0.05 * hh);
      }
    }
    return [rot(hx, hy, -0.14 * hh, -0.02 * hh, t), rot(hx, hy, 0.14 * hh, -0.02 * hh, t)]
      .filter(e => e.x > 0.04 * W).map(e => ({ ...e, r: 0.045 * hh }));
  }

  function drawHands(x, W, H, p) { // arm rises from the bottom edge
    x.save(); x.translate(W / 2, H); x.rotate(p.lean); x.translate(-W / 2, -H);
    const wx = W * 0.5, wy = H * 0.5, u = W * 0.95;
    limb(x, W * 0.5, H * 1.1, wx, wy, W * 0.24, W * 0.18);
    ell(x, wx, wy - 0.1 * W, 0.15 * W, 0.17 * W);
    fingers(x, wx, wy - 0.24 * W, -Math.PI / 2, u, 4, 0.75, 0.2);
    const tx = wx - 0.13 * W, ty = wy - 0.08 * W;
    limb(x, tx, ty, tx - 0.17 * W, ty - 0.14 * W, 0.07 * W, 0.05 * W);
    limb(x, tx - 0.17 * W, ty - 0.14 * W, tx - 0.24 * W, ty - 0.28 * W, 0.05 * W, 0.03 * W);
    x.restore();
    return [];
  }

  function drawWatcher(x, W, H) { // faint head + shoulders barely there
    const hh = H * 0.38, cx = W / 2, hy = H * 0.3;
    ell(x, cx, hy, 0.37 * hh, 0.5 * hh);
    limb(x, cx, hy + 0.4 * hh, cx, hy + 0.85 * hh, 0.32 * hh, 0.4 * hh);
    ell(x, cx, hy + 1.55 * hh, 1.0 * hh, 0.65 * hh);
    return [{ x: cx - 0.14 * hh, y: hy - 0.02 * hh, r: 0.06 * hh }, { x: cx + 0.14 * hh, y: hy - 0.02 * hh, r: 0.06 * hh }];
  }

  /* ---------- scene analysis & placement ---------- */
  function analyze(canvas) {
    const gw = 36, gh = Math.max(8, Math.round(36 * canvas.height / canvas.width));
    const c = mk(gw, gh), x = c.getContext('2d'); x.drawImage(canvas, 0, 0, gw, gh);
    const d = x.getImageData(0, 0, gw, gh).data, lum = new Float32Array(gw * gh);
    for (let i = 0; i < lum.length; i++) lum[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
    return { gw, gh, lum };
  }
  function region(an, x0, y0, x1, y1) {
    const { gw, gh, lum } = an;
    const a = clamp(Math.floor(x0 * gw), 0, gw - 1), b = clamp(Math.ceil(x1 * gw), a + 1, gw);
    const c = clamp(Math.floor(y0 * gh), 0, gh - 1), e = clamp(Math.ceil(y1 * gh), c + 1, gh);
    let s = 0, s2 = 0, n = 0;
    for (let j = c; j < e; j++) for (let i = a; i < b; i++) { const v = lum[j * gw + i]; s += v; s2 += v * v; n++; }
    const m = s / n; return { mean: m, varc: Math.max(0, s2 / n - m * m) };
  }
  function overlap(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) {
    const w = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0)), h = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
    return (w * h) / Math.max(1e-6, (ax1 - ax0) * (ay1 - ay0));
  }

  const ENTITIES = ['tall', 'hooded', 'child', 'peeker', 'hands', 'watcher', 'shadow'];
  const WEIGHTS = { tall: 3, hooded: 2, child: 2, peeker: 2.5, hands: 1.2, watcher: 1.5, shadow: 1.5 };
  function randomEntity() {
    let tot = 0; for (const k of ENTITIES) tot += WEIGHTS[k];
    let r = Math.random() * tot; for (const k of ENTITIES) { r -= WEIGHTS[k]; if (r <= 0) return k; } return 'tall';
  }

  const LEVEL = {
    subtle:     { size: 0.65, opacity: [0.42, 0.58], eyes: 0.15 },
    noticeable: { size: 1.0,  opacity: [0.62, 0.8],  eyes: 0.4 },
    obvious:    { size: 1.4,  opacity: [0.82, 0.95], eyes: 0.75 },
  };

  function plan(type, an, IW, IH, lv, selfie) {
    const aspect = IW / IH; let best = null;
    const centerW = selfie ? 1.6 : 0.12;
    const consider = (fx, fy, fw, fh, extra = 0) => {
      const core = region(an, fx + fw * 0.25, fy + fh * 0.1, fx + fw * 0.75, fy + fh * 0.85);
      const pen = overlap(fx + fw * 0.25, fy, fx + fw * 0.75, fy + fh, 0.3, 0.15, 0.7, 0.85) * centerW;
      const score = (1 - core.mean) * 2.2 - core.varc * (type === 'shadow' ? 6 : 2.5) - pen + extra + R(0, 0.2);
      if (!best || score > best.score) best = { fx, fy, fw, fh, score, mean: core.mean };
    };
    for (let i = 0; i < 70; i++) {
      if (type === 'peeker') {
        const fh = clamp(0.3 * lv.size * R(0.8, 1.2), 0.15, 0.6), fw = fh * 0.55 / aspect, left = Math.random() < 0.5;
        consider(left ? 0 : 1 - fw, R(0.02, 0.38), fw, fh);
      } else if (type === 'hands') {
        const fw = clamp(0.32 * lv.size * R(0.85, 1.15), 0.18, 0.6), fh = fw * 2.0 * aspect;
        consider(R(-0.05, 1 - fw + 0.05), 1 - fh + fh * R(0, 0.18), fw, fh);
      } else if (type === 'watcher') {
        const fh = clamp(0.16 * lv.size * R(0.8, 1.2), 0.07, 0.3), fw = fh * 0.9 / aspect;
        consider(R(0, 1 - fw), R(0, 0.75 - fh * 0.5), fw, fh, 0.3);
      } else {
        const base = type === 'child' ? 0.3 : type === 'shadow' ? 0.6 : 0.45;
        const fh = clamp(base * lv.size * R(0.75, 1.2), 0.15, 0.98);
        const ratio = type === 'hooded' ? 0.48 : type === 'child' ? 0.45 : type === 'shadow' ? 0.7 : 0.42;
        const fw = fh * ratio / aspect, bottom = R(0.55, 1.03);
        consider(R(-0.05, 1 - fw + 0.05), clamp(bottom - fh, -0.02, 1), fw, fh);
      }
    }
    return best;
  }

  /* ---------- main ---------- */
  function apply(src, opts = {}) {
    const type = opts.entity && opts.entity !== 'random' ? opts.entity : randomEntity();
    const lv = LEVEL[opts.intensity] || LEVEL.noticeable;
    const IW = src.width, IH = src.height;
    const out = mk(IW, IH), ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const an = analyze(src);
    const pl = plan(type, an, IW, IH, lv, !!opts.selfie);
    const bx = Math.round(pl.fx * IW), by = Math.round(pl.fy * IH), bw = Math.round(pl.fw * IW), bh = Math.round(pl.fh * IH);

    // 1) draw silhouette at a working resolution (blurred anyway)
    const ws = Math.min(1, 720 / Math.max(bw, bh)), WW = Math.max(8, Math.round(bw * ws)), WH = Math.max(8, Math.round(bh * ws));
    const shape = mk(WW, WH), sx = shape.getContext('2d'); sx.fillStyle = '#000';
    const p = { tilt: R(-0.3, 0.3), shoulder: R(0.8, 0.95), armOut: R(0.02, 0.15), armLen: R(4.9, 5.6),
                finger: R(0.35, 0.6), spread: R(0.0, 0.12), heads: R(7.8, 8.8), reach: false, cx: 0.5,
                grip: Math.random() < 0.55, lean: R(-0.3, 0.3) };
    let eyes = [], mirror = false;
    if (type === 'shadow') {
      p.reach = Math.random() < 0.6; p.cx = p.reach ? 0.32 : 0.5; p.heads = R(8.5, 9.5);
      const skew = R(-0.35, 0.35);
      sx.translate(WW / 2, WH); sx.transform(1, 0, skew, 1, 0, 0); sx.translate(-WW / 2, -WH);
      drawTall(sx, WW, WH, p);
    } else if (type === 'tall') { p.reach = Math.random() < 0.15; if (p.reach) p.cx = 0.36; eyes = drawTall(sx, WW, WH, p); }
    else if (type === 'hooded') eyes = drawHooded(sx, WW, WH, p);
    else if (type === 'child') eyes = drawChild(sx, WW, WH, p);
    else if (type === 'peeker') { eyes = drawPeeker(sx, WW, WH, p); mirror = pl.fx > 0.5; }
    else if (type === 'hands') eyes = drawHands(sx, WW, WH, p);
    else if (type === 'watcher') eyes = drawWatcher(sx, WW, WH);
    sx.setTransform(1, 0, 0, 1, 0, 0);
    if (Math.random() < 0.5 && type !== 'peeker') { // random mirror for variety
      const m = mk(WW, WH), mx = m.getContext('2d'); mx.translate(WW, 0); mx.scale(-1, 1); mx.drawImage(shape, 0, 0);
      sx.clearRect(0, 0, WW, WH); sx.drawImage(m, 0, 0); eyes = eyes.map(e => ({ ...e, x: WW - e.x }));
    }
    if (mirror) {
      const m = mk(WW, WH), mx = m.getContext('2d'); mx.translate(WW, 0); mx.scale(-1, 1); mx.drawImage(shape, 0, 0);
      sx.clearRect(0, 0, WW, WH); sx.drawImage(m, 0, 0); eyes = eyes.map(e => ({ ...e, x: WW - e.x }));
    }

    // 2) motion smear sometimes ("it moved during the exposure")
    let core = shape;
    if (type !== 'peeker' && type !== 'hands' && Math.random() < 0.3) {
      const sm = mk(WW, WH), smx = sm.getContext('2d'), dx = WW * R(0.04, 0.09) * (Math.random() < 0.5 ? -1 : 1);
      for (let i = 0; i <= 10; i++) { smx.globalAlpha = i === 0 ? 1 : 0.16; smx.drawImage(shape, dx * i / 10, 0); }
      core = sm;
    }

    // 3) soft focus + smoky haze aura
    const softness = type === 'shadow' ? 0.012 : type === 'watcher' ? 0.03 : 0.0045;
    const coreB = blur(core, WH * softness + 0.8), haze = blur(core, WH * 0.045);
    const mask = mk(WW, WH), mxx = mask.getContext('2d', { willReadFrequently: true });
    mxx.globalAlpha = type === 'watcher' ? 0.5 : 0.38; mxx.drawImage(haze, 0, 0);
    mxx.globalAlpha = type === 'watcher' ? 0.55 : 1; mxx.drawImage(coreB, 0, 0); mxx.globalAlpha = 1;

    // 4) smoke dissolve + feet fade
    const md = mxx.getImageData(0, 0, WW, WH), m = md.data, noise = makeNoise(), ns = 7 / WW;
    const fadeStart = type === 'hands' ? 0.9 : type === 'peeker' ? 0.85 : type === 'shadow' ? 0.85 : type === 'watcher' ? 0.55 : 0.74;
    const fadeEnd = type === 'watcher' ? 0.95 : 1.0;
    for (let y = 0; y < WH; y++) {
      const fy = y / WH;
      for (let xx = 0; xx < WW; xx++) {
        const i = (y * WW + xx) * 4 + 3; let a = m[i] / 255; if (a === 0) continue;
        const n = noise(xx * ns, y * ns * 0.55 - fy * 2);
        a *= 1 - (1 - a) * 0.75 * n;               // ragged edges
        a *= 0.86 + 0.14 * n;                       // slightly uneven density
        a *= 1 - smooth(fadeStart, fadeEnd, fy + (n - 0.5) * 0.12);
        m[i] = clamp(a * 255, 0, 255);
      }
    }
    mxx.putImageData(md, 0, 0);

    // 5) composite at full resolution with tone-matching + grain
    const x0 = clamp(bx, 0, IW), y0 = clamp(by, 0, IH), x1 = clamp(bx + bw, 0, IW), y1 = clamp(by + bh, 0, IH);
    const cw = x1 - x0, ch = y1 - y0;
    if (cw > 2 && ch > 2) {
      const full = mk(cw, ch), fx = full.getContext('2d', { willReadFrequently: true });
      fx.imageSmoothingQuality = 'high'; fx.drawImage(mask, bx - x0, by - y0, bw, bh);
      const mk2 = fx.getImageData(0, 0, cw, ch).data, ph = ctx.getImageData(x0, y0, cw, ch), d = ph.data;
      let opacity = R(lv.opacity[0], lv.opacity[1]) * (0.8 + 0.2 * (1 - pl.mean));
      if (type === 'shadow') opacity *= 0.85;
      const floor = 0.04 + pl.mean * 0.16, grain = 9 + 10 * (1 - pl.mean);
      for (let i = 0; i < d.length; i += 4) {
        const a = (mk2[i + 3] / 255) * opacity; if (a < 0.003) continue;
        let r = d[i], g = d[i + 1], b = d[i + 2];
        const k = 1 - a * (1 - floor);
        r *= k; g *= k; b *= k;
        const l = 0.299 * r + 0.587 * g + 0.114 * b, ds = a * 0.4;
        r += (l - r) * ds; g += (l - g) * ds; b += (l - b) * ds + a * 2.5;
        const n = (Math.random() - 0.5) * grain * a;
        d[i] = clamp(r + n + (Math.random() - 0.5) * 3 * a, 0, 255);
        d[i + 1] = clamp(g + n, 0, 255);
        d[i + 2] = clamp(b + n + (Math.random() - 0.5) * 3 * a, 0, 255);
      }
      ctx.putImageData(ph, x0, y0);
    }

    // 6) eyes catching the light
    const eyeChance = type === 'watcher' ? 1 : type === 'peeker' ? lv.eyes + 0.2 : type === 'shadow' || type === 'hands' ? 0 : lv.eyes;
    if (eyes.length && Math.random() < eyeChance) {
      const sc = bw / WW, alpha = (type === 'watcher' ? R(0.45, 0.7) : R(0.22, 0.45)) * (0.7 + 0.3 * (1 - pl.mean));
      const warm = Math.random() < 0.25, col = warm ? '255,205,150' : '245,242,228';
      for (const e of eyes) {
        const ex = bx + e.x * sc, ey = by + e.y * sc, er = Math.max(1.2, e.r * sc);
        ctx.save(); ctx.translate(ex, ey); ctx.scale(1.35, 0.75);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, er * 3);
        g.addColorStop(0, `rgba(${col},${alpha})`); g.addColorStop(0.22, `rgba(${col},${alpha * 0.75})`);
        g.addColorStop(0.5, `rgba(${col},${alpha * 0.12})`); g.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, er * 3, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
    }
    return { canvas: out, entity: type };
  }

  return { apply, ENTITIES };
})();
