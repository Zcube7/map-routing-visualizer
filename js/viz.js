'use strict';
/* =====================================================================
 *  viz.js —— 画布渲染（路网 / 玩具图）与动画控制器 Player
 * ===================================================================== */
const COLORS = {
  bg: '#f8fafc',
  settled: ['#3b82f6', '#ef4444'],
  frontier: ['#93c5fd', '#fca5a5'],
  current: '#facc15',
  path: '#10b981',
  start: '#16a34a',
  goal: '#dc2626',
  landmark: '#7c3aed',
  shortcut: '#a855f7',
  relaxYes: '#f97316',
  relaxNo: '#9ca3af',
  witness: '#16a34a',
  via: '#f97316',
  text: '#0f172a',
};

/* 热力图配色：0 → 黄（接近终点），1 → 深蓝 */
function heatColor(x) {
  x = Math.max(0, Math.min(1, x));
  const c0 = [253, 224, 71], c1 = [30, 64, 175];
  const c = c0.map((a, i) => Math.round(a + (c1[i] - a) * x));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function strokeArc(ctx, A, B, k = 0.18) {
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
  const dx = B.x - A.x, dy = B.y - A.y;
  const L = Math.hypot(dx, dy) || 1;
  const cx = mx - dy / L * L * k, cy = my + dx / L * L * k;
  ctx.beginPath();
  ctx.moveTo(A.x, A.y);
  ctx.quadraticCurveTo(cx, cy, B.x, B.y);
  ctx.stroke();
  return { x: 0.25 * A.x + 0.5 * cx + 0.25 * B.x, y: 0.25 * A.y + 0.5 * cy + 0.25 * B.y };
}

/* ---------- 路网画布 ---------- */
class RoadCanvas {
  constructor(canvas, g, handlers = {}) {
    this.cv = canvas;
    this.handlers = handlers;
    this.setGraph(g);
    this._bind();
  }
  setGraph(g) {
    this.g = g;
    const dpr = window.devicePixelRatio || 1;
    this.cv.width = g.W * dpr; this.cv.height = g.H * dpr;
    this.cv.style.aspectRatio = `${g.W} / ${g.H}`;
    this.ctx = this.cv.getContext('2d');
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  toXY(evt) {
    const r = this.cv.getBoundingClientRect();
    return { x: (evt.clientX - r.left) * this.g.W / r.width, y: (evt.clientY - r.top) * this.g.H / r.height };
  }
  _bind() {
    const h = this.handlers;
    this.cv.addEventListener('click', e => { const p = this.toXY(e); const v = nearestNode(this.g, p.x, p.y); if (v >= 0 && h.onStart) h.onStart(v); });
    this.cv.addEventListener('contextmenu', e => { e.preventDefault(); const p = this.toXY(e); const v = nearestNode(this.g, p.x, p.y); if (v >= 0 && h.onGoal) h.onGoal(v); });
    this.cv.addEventListener('mousemove', e => { if (!h.onHover) return; const p = this.toXY(e); h.onHover(nearestNode(this.g, p.x, p.y, 10), h.edgeHover ? nearestEdge(this.g, p.x, p.y) : -1, e); });
    this.cv.addEventListener('mouseleave', () => { if (h.onHover) h.onHover(-1, -1, null); });
  }
  draw(st = {}) {
    const g = this.g, ctx = this.ctx, N = g.nodes;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, g.W, g.H);
    const fade = st.contracted && st.fadeContracted;

    /* 边 */
    for (const e of g.edges) {
      const rc = ROAD_CLASS[e.cls];
      let color = rc.color, width = rc.width, alpha = 1;
      if (st.edgeColor) { const c = st.edgeColor(e); if (c) { color = c.color; width = c.width || width; } }
      if (fade && (st.contracted[e.u] || st.contracted[e.v])) alpha = 0.12;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(N[e.u].x, N[e.u].y); ctx.lineTo(N[e.v].x, N[e.v].y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* 捷径（弧线） */
    if (st.shortcuts && st.shortcuts.length) {
      ctx.setLineDash([5, 4]);
      for (const sc of st.shortcuts) {
        const hide = fade && (st.contracted[sc.u] || st.contracted[sc.w]);
        ctx.globalAlpha = hide ? 0.08 : (st.shortcutAlpha == null ? 0.55 : st.shortcutAlpha);
        ctx.strokeStyle = COLORS.shortcut; ctx.lineWidth = 1.4;
        strokeArc(ctx, N[sc.u], N[sc.w]);
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    if (st.newShortcuts && st.newShortcuts.length) {
      ctx.setLineDash([6, 4]); ctx.strokeStyle = COLORS.shortcut; ctx.lineWidth = 3;
      for (const sc of st.newShortcuts) strokeArc(ctx, N[sc.u], N[sc.w]);
      ctx.setLineDash([]);
    }

    /* 热力图 */
    if (st.heat) {
      for (const nd of N) {
        ctx.fillStyle = heatColor(st.heat[nd.id]);
        ctx.beginPath(); ctx.arc(nd.x, nd.y, 5.5, 0, Math.PI * 2); ctx.fill();
      }
    }

    /* 正在松弛的边 */
    if (st.hlEdge) {
      const { u, v, improved } = st.hlEdge;
      ctx.strokeStyle = improved ? COLORS.relaxYes : COLORS.relaxNo; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(N[u].x, N[u].y); ctx.lineTo(N[v].x, N[v].y); ctx.stroke();
    }

    /* 节点 */
    for (const nd of N) {
      const id = nd.id;
      if (fade && st.contracted[id]) {
        ctx.globalAlpha = 0.18; ctx.fillStyle = '#64748b';
        ctx.beginPath(); ctx.arc(nd.x, nd.y, 2, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
        continue;
      }
      let r = 2.3, fill = '#64748b', stroke = null;
      if (st.rank && st.rankSize) r = 2 + 4 * st.rank[id] / (N.length - 1);
      const sd = st.side ? st.side[id] : 0;
      const iq = st.inQ ? st.inQ[id] : 0;
      if (sd) { fill = COLORS.settled[sd - 1]; r = Math.max(r, 4); }
      else if (iq) { fill = '#fff'; stroke = COLORS.settled[iq - 1]; r = Math.max(r, 4); }
      if (st.heat && !sd && !iq) continue;
      ctx.fillStyle = fill;
      ctx.beginPath(); ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2); ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
    }

    /* 路径 */
    if (st.path && st.path.length > 1) {
      ctx.strokeStyle = st.pathColor || COLORS.path; ctx.lineWidth = 5; ctx.lineJoin = 'round';
      for (let i = 0; i + 1 < st.path.length; i++) {
        const a = N[st.path[i]], b = N[st.path[i + 1]];
        if (st.isShortcut && st.isShortcut(st.path[i], st.path[i + 1])) {
          ctx.setLineDash([7, 5]); strokeArc(ctx, a, b); ctx.setLineDash([]);
        } else {
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    if (st.path2 && st.path2.length > 1) {
      ctx.strokeStyle = st.path2Color || '#94a3b8'; ctx.lineWidth = 3; ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(N[st.path2[0]].x, N[st.path2[0]].y);
      for (let i = 1; i < st.path2.length; i++) ctx.lineTo(N[st.path2[i]].x, N[st.path2[i]].y);
      ctx.stroke(); ctx.setLineDash([]);
    }

    /* 当前节点 */
    if (st.current >= 0 && st.current != null) {
      const nd = N[st.current];
      ctx.fillStyle = COLORS.current; ctx.strokeStyle = '#854d0e'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(nd.x, nd.y, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    /* 地标 */
    if (st.landmarks) {
      st.landmarks.forEach((v, i) => {
        const nd = N[v];
        ctx.fillStyle = COLORS.landmark; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(nd.x, nd.y - 11); ctx.lineTo(nd.x + 9, nd.y); ctx.lineTo(nd.x, nd.y + 11); ctx.lineTo(nd.x - 9, nd.y); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('L' + (i + 1), nd.x, nd.y + 0.5);
      });
    }

    /* 起终点 */
    const marker = (v, color, label) => {
      if (v == null || v < 0) return;
      const nd = N[v];
      ctx.fillStyle = color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(nd.x, nd.y, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, nd.x, nd.y + 0.5);
    };
    marker(st.s, COLORS.start, '起');
    marker(st.t, COLORS.goal, '终');

    /* 高亮某节点（如 CH 正在收缩） */
    if (st.focus >= 0 && st.focus != null) {
      const nd = N[st.focus];
      ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(nd.x, nd.y, 12, 0, Math.PI * 2); ctx.stroke();
    }
  }
}

/* ---------- 玩具图画布（带标签与权重） ---------- */
class ToyCanvas {
  constructor(canvas, g) {
    this.cv = canvas; this.g = g;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = g.W * dpr; canvas.height = g.H * dpr;
    canvas.style.aspectRatio = `${g.W} / ${g.H}`;
    this.ctx = canvas.getContext('2d');
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  draw(frame, s, t) {
    const g = this.g, ctx = this.ctx, N = g.nodes;
    const snap = frame.snap, hl = frame.hl || {}, q = snap.q;
    ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, g.W, g.H);
    const isCon = v => snap.contracted[v] === 1;
    const key = (a, b) => a < b ? `${a}-${b}` : `${b}-${a}`;
    const viaSet = new Set((hl.via || []).map(([a, b]) => key(a, b)));
    const witSet = new Set();
    if (hl.witness) for (let i = 0; i + 1 < hl.witness.length; i++) witSet.add(key(hl.witness[i], hl.witness[i + 1]));
    const pathSet = new Set();
    if (q && q.path) for (let i = 0; i + 1 < q.path.length; i++) pathSet.add(key(q.path[i], q.path[i + 1]));

    /* 原始边 */
    ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const e of g.edges) {
      const k = key(e.u, e.v);
      const faded = frame.phase === 'pre' && (isCon(e.u) || isCon(e.v));
      let color = '#94a3b8', width = 2;
      if (pathSet.has(k)) { color = COLORS.path; width = 6; }
      if (witSet.has(k)) { color = COLORS.witness; width = 5; }
      if (viaSet.has(k)) { color = COLORS.via; width = 5; }
      ctx.globalAlpha = faded && !witSet.has(k) && !viaSet.has(k) ? 0.15 : 1;
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(N[e.u].x, N[e.u].y); ctx.lineTo(N[e.v].x, N[e.v].y); ctx.stroke();
      const mx = (N[e.u].x + N[e.v].x) / 2, my = (N[e.u].y + N[e.v].y) / 2;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(mx, my, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#334155'; ctx.fillText(String(e.w), mx, my + 0.5);
    }
    ctx.globalAlpha = 1;
    /* 捷径 */
    for (const sc of snap.shortcuts) {
      const k = key(sc.u, sc.w);
      const isNew = hl.newShortcut && key(hl.newShortcut[0], hl.newShortcut[1]) === k;
      const onPath = pathSet.has(k);
      const faded = frame.phase === 'pre' && (isCon(sc.u) || isCon(sc.w));
      ctx.globalAlpha = faded && !isNew ? 0.2 : 1;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = onPath ? COLORS.path : (viaSet.has(k) ? COLORS.via : witSet.has(k) ? COLORS.witness : COLORS.shortcut);
      ctx.lineWidth = isNew || onPath || viaSet.has(k) || witSet.has(k) ? 4 : 2;
      const m = strokeArc(ctx, N[sc.u], N[sc.w], 0.22);
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(m.x, m.y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS.shortcut; ctx.fillText(String(sc.wt), m.x, m.y + 0.5);
    }
    ctx.globalAlpha = 1;
    /* 节点 */
    for (const nd of N) {
      const v = nd.id;
      const con = isCon(v) && frame.phase === 'pre';
      let fill = '#fff', stroke = '#475569', lw = 2;
      if (q) {
        if (q.setF.has(v)) { fill = COLORS.settled[0]; }
        if (q.setB.has(v)) { fill = q.setF.has(v) ? '#a855f7' : COLORS.settled[1]; }
      }
      if (hl.node === v) { stroke = COLORS.current; lw = 4; }
      ctx.globalAlpha = con ? 0.25 : 1;
      ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(nd.x, nd.y, 16, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = (q && (q.setF.has(v) || q.setB.has(v))) ? '#fff' : '#0f172a';
      ctx.font = 'bold 14px sans-serif'; ctx.fillText(nd.label, nd.x, nd.y + 0.5);
      ctx.globalAlpha = 1;
      if (snap.rank[v] >= 0) {
        ctx.fillStyle = '#7c3aed'; ctx.font = 'bold 10px sans-serif';
        ctx.fillText('r' + snap.rank[v], nd.x + 17, nd.y - 14);
      }
      if (q) {
        const parts = [];
        if (q.dF.has(v)) parts.push({ c: COLORS.settled[0], t: 'f:' + q.dF.get(v) });
        if (q.dB.has(v)) parts.push({ c: COLORS.settled[1], t: 'b:' + q.dB.get(v) });
        ctx.font = 'bold 11px sans-serif';
        parts.forEach((p, i) => { ctx.fillStyle = p.c; ctx.fillText(p.t, nd.x, nd.y + 26 + i * 12); });
      }
      if (v === s || v === t) {
        ctx.fillStyle = v === s ? COLORS.start : COLORS.goal; ctx.font = 'bold 11px sans-serif';
        ctx.fillText(v === s ? '起点' : '终点', nd.x, nd.y - 24);
      }
    }
    if (q && q.mu < Infinity) {
      ctx.fillStyle = '#0f172a'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(`μ = ${q.mu}`, 12, 16);
    }
  }
}

/* ---------- 动画控制器：按“事件/秒”推进生成器 ---------- */
class Player {
  constructor({ makeGen, onEvent, onFrame, onFinish }) {
    this.makeGen = makeGen; this.onEvent = onEvent; this.onFrame = onFrame; this.onFinish = onFinish;
    this.speed = 60; this.gen = null; this.playing = false; this.done = false;
    this._acc = 0; this._last = 0; this._raf = null;
  }
  reset() { this.pause(); this.gen = null; this.done = false; }
  _ensure() { if (!this.gen) { this.gen = this.makeGen(); this.done = false; } }
  step() {
    if (this.done) return false;
    this._ensure();
    const r = this.gen.next();
    if (r.done) { this.done = true; this.pause(); if (this.onFinish) this.onFinish(null); return false; }
    this.onEvent(r.value);
    if (r.value.type === 'done' || r.value.type === 'preprocessed') { this.done = true; this.pause(); if (this.onFinish) this.onFinish(r.value); return false; }
    return true;
  }
  play() {
    if (this.playing || this.done) return;
    this.playing = true; this._last = performance.now(); this._acc = 0;
    const loop = now => {
      if (!this.playing) return;
      const dt = Math.min(0.5, (now - this._last) / 1000); this._last = now;
      this._acc += dt * this.speed;
      let k = Math.min(20000, Math.floor(this._acc)); this._acc -= k;
      while (k-- > 0) if (!this.step()) break;
      if (this.onFrame) this.onFrame();
      if (this.playing) this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }
  pause() { this.playing = false; if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }
  runToEnd() { this.pause(); this._ensure(); let guard = 5e6; while (guard-- > 0 && this.step()) { /* */ } if (this.onFrame) this.onFrame(); }
}
