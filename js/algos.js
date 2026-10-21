'use strict';
/* =====================================================================
 *  algos.js —— 逐步事件生成器：Dijkstra / A* / 双向 Dijkstra / ALT / 时变
 *  每个生成器 yield 一个事件对象，动画控制器每次取一个事件来播放。
 *  side: 0 = 正向(从起点), 1 = 反向(从终点)
 * ===================================================================== */

/* ---------- Dijkstra（h 为空）或 A*（给 h 与 eps） ---------- */
function* dijkstraGen(g, s, t, opts = {}) {
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const settled = new Uint8Array(n);
  const h = opts.h || null;
  const eps = opts.eps == null ? 1 : opts.eps;
  const H = new MinHeap();
  let nS = 0, nR = 0;
  dist[s] = 0;
  H.push(h ? eps * h(s) : 0, s);
  yield { type: 'init', s, t, dist };
  while (H.size) {
    const { key, val: u } = H.pop();
    if (settled[u]) continue;           // 过期的堆项（惰性删除）
    settled[u] = 1; nS++;
    yield { type: 'settle', side: 0, u, d: dist[u], key, qsize: H.size, qtop: H.top(5), nS, nU: nS, nR };
    if (u === t) break;
    for (const e of g.adj[u]) {
      const v = e.to;
      if (settled[v]) continue;
      nR++;
      const nd = dist[u] + e.w, old = dist[v];
      const improved = nd < old;
      let k = nd, hv = 0;
      if (h) { hv = h(v); k = nd + eps * hv; }
      if (improved) { dist[v] = nd; prev[v] = u; H.push(k, v); }
      yield { type: 'relax', side: 0, u, v, du: dist[u], w: e.w, nd, old, improved, hv, key: k, eps, nS, nR };
    }
  }
  const path = buildPath(prev, s, t);
  yield { type: 'done', path, cost: dist[t], nS, nU: nS, nR, dist, settled };
}

/* 普通 Dijkstra 跑到底：返回全图距离数组（供地标预处理用） */
function dijkstraAll(g, s) {
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const settled = new Uint8Array(n);
  const H = new MinHeap();
  dist[s] = 0; H.push(0, s);
  while (H.size) {
    const { val: u } = H.pop();
    if (settled[u]) continue;
    settled[u] = 1;
    for (const e of g.adj[u]) {
      const nd = dist[u] + e.w;
      if (nd < dist[e.to]) { dist[e.to] = nd; H.push(nd, e.to); }
    }
  }
  return dist;
}

/* 把生成器跑完，返回 done 事件 */
function runGen(gen) {
  let last = null;
  for (const ev of gen) last = ev;
  return last;
}

/* ---------- 双向 Dijkstra ---------- */
function* bidirGen(g, s, t) {
  const n = g.nodes.length;
  const d = [new Float64Array(n).fill(Infinity), new Float64Array(n).fill(Infinity)];
  const prev = [new Int32Array(n).fill(-1), new Int32Array(n).fill(-1)];
  const set = [new Uint8Array(n), new Uint8Array(n)];
  const Hs = [new MinHeap(), new MinHeap()];
  d[0][s] = 0; Hs[0].push(0, s);
  d[1][t] = 0; Hs[1].push(0, t);
  const seen = new Uint8Array(n);        // 被任一方向确定过 → 唯一访问路口数
  let mu = Infinity, meet = -1, nS = 0, nU = 0, nR = 0, side = 1;
  yield { type: 'init', s, t };
  for (;;) {
    const topF = Hs[0].peekKey(), topB = Hs[1].peekKey();
    if (topF + topB >= mu) { yield { type: 'stop', topF, topB, mu, nS, nU, nR }; break; }
    side = 1 - side;
    if (!Hs[side].size) side = 1 - side;
    if (!Hs[side].size) break;
    const H = Hs[side], ds = d[side], dother = d[1 - side], pv = prev[side], st = set[side];
    const { val: u } = H.pop();
    if (st[u]) continue;
    st[u] = 1; nS++;
    if (!seen[u]) { seen[u] = 1; nU++; }
    if (dother[u] < Infinity) {           // 另一侧已触达本节点（含 s===t 的情形）
      const cand = ds[u] + dother[u];
      if (cand < mu) { mu = cand; meet = u; yield { type: 'meet', u, mu, dF: d[0][u], dB: d[1][u], nS, nU, nR, onSettle: true }; }
    }
    yield { type: 'settle', side, u, d: ds[u], qsize: H.size, qtop: H.top(5), nS, nU, nR, mu, topF: Hs[0].peekKey(), topB: Hs[1].peekKey() };
    for (const e of g.adj[u]) {
      const v = e.to;
      if (st[v]) continue;
      nR++;
      const nd = ds[u] + e.w, old = ds[v];
      const improved = nd < old;
      if (improved) { ds[v] = nd; pv[v] = u; H.push(nd, v); }
      yield { type: 'relax', side, u, v, du: ds[u], w: e.w, nd, old, improved, nS, nR };
      if (dother[v] < Infinity) {
        const cand = nd + dother[v];
        if (cand < mu) {
          mu = cand; meet = v;
          yield { type: 'meet', u: v, mu, dF: d[0][v], dB: d[1][v], nS, nU, nR };
        }
      }
    }
  }
  let path = [];
  if (meet >= 0) {
    const left = buildPath(prev[0], s, meet);
    const right = buildPath(prev[1], t, meet).reverse();
    path = left.concat(right.slice(1));
  }
  yield { type: 'done', path, cost: mu, nS, nU, nR, meet, distF: d[0], distB: d[1] };
}

/* ---------- ALT：地标选择（最远点法）与三角不等式下界 ---------- */
function computeLandmarks(g, k) {
  const n = g.nodes.length;
  const lms = [], dists = [];
  let d0 = dijkstraAll(g, 0);
  let first = 0;
  for (let v = 0; v < n; v++) if (d0[v] > d0[first]) first = v;
  lms.push(first); dists.push(dijkstraAll(g, first));
  const minD = Float64Array.from(dists[0]);
  while (lms.length < k) {
    let best = 0;
    for (let v = 0; v < n; v++) if (minD[v] > minD[best]) best = v;
    lms.push(best);
    const dl = dijkstraAll(g, best);
    dists.push(dl);
    for (let v = 0; v < n; v++) if (dl[v] < minD[v]) minD[v] = dl[v];
  }
  return { lms, dists };
}
/* h(v) = max_L | d(L,t) − d(L,v) |   （无向图上两种三角不等式合并为绝对值） */
function altHeuristic(alt, t) {
  const { dists } = alt;
  return v => {
    let h = 0;
    for (const dl of dists) {
      const x = Math.abs(dl[t] - dl[v]);
      if (x > h && isFinite(x)) h = x;      // 不连通的地标给 ∞−∞=NaN，视为无信息
    }
    return h;
  };
}

/* ---------- 时变权重：速度随一天中的时刻变化 ----------
 * m(t) 为速度倍率（1 = 畅通），早晚高峰下降；高等级道路受影响更大。
 * 该曲线变化平缓，满足 FIFO（先出发不会后到）。
 */
function gaussBump(t, mu, sig) { const x = (t - mu) / sig; return Math.exp(-x * x); }
const TD_PROFILE = {
  highway:  t => 1 - 0.80 * gaussBump(t, 8.6, 0.8) - 0.75 * gaussBump(t, 18.0, 1.0),
  arterial: t => 1 - 0.60 * gaussBump(t, 8.6, 0.9) - 0.55 * gaussBump(t, 18.0, 1.1),
  local:    t => 1 - 0.25 * gaussBump(t, 8.6, 1.0) - 0.25 * gaussBump(t, 18.0, 1.2),
};
function tdMultiplier(cls, tauHour) {
  const t = ((tauHour % 24) + 24) % 24;
  const f = TD_PROFILE[cls] || TD_PROFILE[(typeof TD_CLASS_ALIAS !== 'undefined' && TD_CLASS_ALIAS[cls]) || 'local'];
  return f(t);
}
/* 在时刻 tau（小时）进入路段 e，所需分钟数；e.tf 为该路段的固有拥堵系数（真实路网用） */
function tdEdgeTime(e, tauHour) {
  return e.len / (e.speed * tdMultiplier(e.cls, tauHour)) * 60 * (e.tf || 1);
}
/* 时变 Dijkstra 的逐步版本（动画用） */
function* tdDijkstraGen(g, s, t, departHour) {
  const n = g.nodes.length;
  const arr = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const settled = new Uint8Array(n);
  const H = new MinHeap();
  arr[s] = 0; H.push(0, s);
  let nS = 0, nR = 0;
  yield { type: 'init', s, t };
  while (H.size) {
    const { val: u } = H.pop();
    if (settled[u]) continue;
    settled[u] = 1; nS++;
    yield { type: 'settle', side: 0, u, d: arr[u], qsize: H.size, qtop: H.top(5), nS, nU: nS, nR };
    if (u === t) break;
    const tau = departHour + arr[u] / 60;
    for (const e of g.adj[u]) {
      const v = e.to;
      if (settled[v]) continue;
      nR++;
      const w = tdEdgeTime(g.edges[e.eid], tau), nd = arr[u] + w, old = arr[v];
      const improved = nd < old;
      if (improved) { arr[v] = nd; prev[v] = u; H.push(nd, v); }
      yield { type: 'relax', side: 0, u, v, du: arr[u], w, nd, old, improved, tau, nS, nR };
    }
  }
  yield { type: 'done', path: buildPath(prev, s, t), cost: arr[t], nS, nU: nS, nR };
}
/* 时变 Dijkstra：标签是“到达时刻”，权重在松弛时按到达 u 的时刻取值 */
function tdDijkstra(g, s, t, departHour) {
  const n = g.nodes.length;
  const arr = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const settled = new Uint8Array(n);
  const H = new MinHeap();
  arr[s] = 0; H.push(0, s);
  let nS = 0;
  while (H.size) {
    const { val: u } = H.pop();
    if (settled[u]) continue;
    settled[u] = 1; nS++;
    if (u === t) break;
    const tau = departHour + arr[u] / 60;
    for (const e of g.adj[u]) {
      const nd = arr[u] + tdEdgeTime(g.edges[e.eid], tau);
      if (nd < arr[e.to]) { arr[e.to] = nd; prev[e.to] = u; H.push(nd, e.to); }
    }
  }
  return { path: buildPath(prev, s, t), minutes: arr[t], nS };
}
/* 给定路径与出发时刻，按时变权重逐段累加 */
function evalPathTD(g, path, departHour) {
  let m = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const e = edgeBetween(g, path[i], path[i + 1]);
    if (!e) return Infinity;
    m += tdEdgeTime(g.edges[e.eid], departHour + m / 60);
  }
  return m;
}
