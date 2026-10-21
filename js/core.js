'use strict';
/* =====================================================================
 *  core.js —— 可复现随机数、二叉堆、模拟路网的生成与几何工具
 * ===================================================================== */

/* ---------- 可复现随机数 (mulberry32) ---------- */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- 二叉最小堆：按 key 升序，key 相同按 val 升序 ---------- */
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  _less(i, j) {
    const x = this.a[i], y = this.a[j];
    return x.key < y.key || (x.key === y.key && x.val < y.val);
  }
  push(key, val) {
    const a = this.a;
    a.push({ key, val });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._less(i, p)) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this._less(l, m)) m = l;
        if (r < a.length && this._less(r, m)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
  peekKey() { return this.a.length ? this.a[0].key : Infinity; }
  /* 仅用于界面展示：取 key 最小的前 k 项 */
  top(k) {
    return this.a.slice().sort((x, y) => x.key - y.key || x.val - y.val).slice(0, k);
  }
}

/* ---------- 道路等级 ---------- */
const ROAD_CLASS = {
  highway:  { name: '快速路', speed: 90, color: '#f59e0b', width: 4.0 },
  arterial: { name: '主干道', speed: 50, color: '#94a3b8', width: 2.4 },
  local:    { name: '支路',   speed: 30, color: '#d6dde6', width: 1.4 },
};
const KM_PER_PX = 0.02;   // 1 像素 = 20 米
const V_MAX = 90;         // 全图最高限速 km/h，A* 的欧氏启发式用它做除数

/* ---------- 生成模拟路网 ----------
 * 22×13 的扰动网格；一条横向快速路 + 一条纵向快速路；若干主干道；
 * 其余为支路；随机删掉约 1/3 的普通路段但始终保持连通；少量斜向支路。
 * 边权 w = 路段长度 / 限速，单位：分钟。图按无向处理（双向通行）。
 */
function buildRoadNetwork(seed) {
  const cols = 22, rows = 13, W = 880, H = 520, mx = 34, my = 32;
  const rnd = mulberry32(seed);
  const cw = (W - 2 * mx) / (cols - 1), ch = (H - 2 * my) / (rows - 1);
  const hwRow = 5 + Math.floor(rnd() * 3);
  const hwCol = 8 + Math.floor(rnd() * 5);
  const artRows = new Set([1 + Math.floor(rnd() * 2), 9 + Math.floor(rnd() * 3)]);
  const artCols = new Set([2 + Math.floor(rnd() * 3), 16 + Math.floor(rnd() * 4)]);

  const nodes = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = r * cols + c;
      const jx = c === hwCol ? 0.08 : 0.42;
      const jy = r === hwRow ? 0.08 : 0.42;
      nodes.push({
        id, r, c,
        x: mx + c * cw + (rnd() - 0.5) * cw * jx,
        y: my + r * ch + (rnd() - 0.5) * ch * jy,
      });
    }
  }

  const raw = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = r * cols + c;
      if (c + 1 < cols) raw.push({ u: id, v: id + 1, cls: r === hwRow ? 'highway' : artRows.has(r) ? 'arterial' : 'local' });
      if (r + 1 < rows) raw.push({ u: id, v: id + cols, cls: c === hwCol ? 'highway' : artCols.has(c) ? 'arterial' : 'local' });
      if (r + 1 < rows && c + 1 < cols && r !== hwRow && c !== hwCol) {
        const p = rnd();
        if (p < 0.06) raw.push({ u: id, v: id + cols + 1, cls: 'local' });
        else if (p < 0.12) raw.push({ u: id + 1, v: id + cols, cls: 'local' });
      }
    }
  }

  /* 随机删边但保持连通 */
  const alive = raw.map(() => true);
  const cand = raw.map((_, i) => i).filter(i => raw[i].cls !== 'highway');
  for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
  const n = nodes.length;
  function connected() {
    const adj = Array.from({ length: n }, () => []);
    raw.forEach((e, i) => { if (alive[i]) { adj[e.u].push(e.v); adj[e.v].push(e.u); } });
    const seen = new Uint8Array(n); const st = [0]; seen[0] = 1; let cnt = 1;
    while (st.length) { const u = st.pop(); for (const v of adj[u]) if (!seen[v]) { seen[v] = 1; cnt++; st.push(v); } }
    return cnt === n;
  }
  for (const i of cand) {
    if (rnd() < 0.36) { alive[i] = false; if (!connected()) alive[i] = true; }
  }

  const edges = [];
  const adj = Array.from({ length: n }, () => []);
  raw.forEach((e, i) => {
    if (!alive[i]) return;
    const a = nodes[e.u], b = nodes[e.v];
    const px = Math.hypot(a.x - b.x, a.y - b.y);
    const len = px * KM_PER_PX;
    const speed = ROAD_CLASS[e.cls].speed;
    const w = len / speed * 60;
    const id = edges.length;
    edges.push({ id, u: e.u, v: e.v, cls: e.cls, len, speed, w });
    adj[e.u].push({ to: e.v, w, eid: id });
    adj[e.v].push({ to: e.u, w, eid: id });
  });
  return { nodes, edges, adj, cols, rows, W, H, hwRow, hwCol, seed };
}

/* 比较两个数时需要显示的小数位数：避免四舍五入后出现 "3.1 < 3.1" 这类看起来矛盾的日志 */
function cmpDecimals(a, b, min = 1, max = 4) {
  if (!isFinite(a) || !isFinite(b)) return min;
  for (let d = min; d < max; d++) if (a.toFixed(d) !== b.toFixed(d) || Math.abs(a - b) < 1e-9) return d;
  return max;
}
/* 显示 "a + b = c" 时需要的小数位数：保证显示出来的两个加数相加确实等于显示出来的和（避免 3.7 + 1.7 = 5.5） */
function sumDecimals(a, b, min = 1, max = 4) {
  if (!isFinite(a) || !isFinite(b)) return min;
  for (let d = min; d < max; d++) if ((Number(a.toFixed(d)) + Number(b.toFixed(d))).toFixed(d) === (a + b).toFixed(d)) return d;
  return max;
}
/* 同一条日志里既有加法又有比较：取两者需要的最大位数 */
function logDecimals(sumA, sumB, cmpA, cmpB) { return Math.max(sumDecimals(sumA, sumB), cmpDecimals(cmpA, cmpB)); }

/* ---------- 几何 / 工具 ---------- */
function nodeDistPx(g, a, b) {
  const A = g.nodes[a], B = g.nodes[b];
  return Math.hypot(A.x - B.x, A.y - B.y);
}
/* 欧氏启发式（分钟）：直线距离 / 最高限速 —— 可采纳且一致 */
function euclidTimeHeuristic(g, t) {
  const T = g.nodes[t];
  return v => Math.hypot(g.nodes[v].x - T.x, g.nodes[v].y - T.y) * KM_PER_PX / V_MAX * 60;
}
function nearestNode(g, x, y, maxD = 14) {
  let best = -1, bd = maxD * maxD;
  for (const nd of g.nodes) {
    const d = (nd.x - x) ** 2 + (nd.y - y) ** 2;
    if (d < bd) { bd = d; best = nd.id; }
  }
  return best;
}
function nearestEdge(g, x, y, maxD = 7) {
  let best = -1, bd = maxD;
  for (const e of g.edges) {
    const A = g.nodes[e.u], B = g.nodes[e.v];
    const dx = B.x - A.x, dy = B.y - A.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((x - A.x) * dx + (y - A.y) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(A.x + t * dx - x, A.y + t * dy - y);
    if (d < bd) { bd = d; best = e.id; }
  }
  return best;
}
function buildPath(prev, s, t) {
  if (t !== s && prev[t] < 0) return [];
  const p = [];
  for (let v = t; v !== -1; v = prev[v]) { p.push(v); if (v === s) break; }
  return p.reverse();
}
function edgeBetween(g, a, b) {
  let best = null;
  for (const e of g.adj[a]) if (e.to === b && (!best || e.w < best.w)) best = e;
  return best;
}
function pathCost(g, path) {
  let c = 0;
  for (let i = 0; i + 1 < path.length; i++) { const e = edgeBetween(g, path[i], path[i + 1]); if (!e) return Infinity; c += e.w; }
  return c;
}
/* 球面距离（km）：Haversine 公式 */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dphi = (lat2 - lat1) * rad, dl = (lon2 - lon1) * rad;
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
