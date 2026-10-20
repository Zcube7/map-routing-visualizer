'use strict';
/* =====================================================================
 *  ch.js —— Contraction Hierarchies（收缩层次）
 *  预处理：按“边差 + 已收缩邻居数”优先级逐个收缩节点，见证搜索决定是否加捷径
 *  查询：双向、只走 rank 上升的边；相遇后递归展开捷径
 *  输入图：{ nodes:[{id,x,y}], edges:[{u,v,w}] }，按无向处理
 * ===================================================================== */
class CH {
  constructor(g) {
    this.g = g;
    this.n = g.nodes.length;
    this.adj = Array.from({ length: this.n }, () => new Map());   // u -> Map(v -> {w, mid})
    for (const e of g.edges) this._setEdge(e.u, e.v, e.w, -1, false);
    this.rank = new Int32Array(this.n).fill(-1);
    this.contracted = new Uint8Array(this.n);
    this.shortcuts = [];       // {u, w, wt, mid}
    this.nShortcuts = 0;
    this.order = [];
    this.witnessLimit = 120;   // 见证搜索最多确定的节点数（超出则保守地加捷径）
  }
  _setEdge(u, v, w, mid, record = true) {
    const ex = this.adj[u].get(v);
    if (ex && ex.w <= w) return false;
    this.adj[u].set(v, { w, mid });
    this.adj[v].set(u, { w, mid });
    if (record && mid >= 0) { this.shortcuts.push({ u, w: v, wt: w, mid }); this.nShortcuts++; }
    return true;
  }
  /* 从 u 出发、绕开 excluded 与已收缩节点的局部 Dijkstra；
   * targets: Map(w -> 上限 via)。返回 Map(w -> 距离) 与前驱表（供画见证路径） */
  witness(u, excluded, targets) {
    const dist = new Map([[u, 0]]);
    const prev = new Map();
    const done = new Set();
    const H = new MinHeap();
    H.push(0, u);
    let remaining = targets.size, maxLimit = 0, cnt = 0;
    for (const lim of targets.values()) if (lim > maxLimit) maxLimit = lim;
    const res = new Map();
    while (H.size && remaining > 0) {
      const { key, val: x } = H.pop();
      if (done.has(x)) continue;
      if (key > maxLimit) break;
      done.add(x); cnt++;
      if (targets.has(x)) { res.set(x, key); remaining--; }
      if (cnt > this.witnessLimit) break;
      for (const [y, ed] of this.adj[x]) {
        if (y === excluded || this.contracted[y] || done.has(y)) continue;
        const nd = key + ed.w;
        if (nd < (dist.has(y) ? dist.get(y) : Infinity)) { dist.set(y, nd); prev.set(y, x); H.push(nd, y); }
      }
    }
    return { res, prev };
  }
  witnessPath(prev, u, w) {
    const p = [];
    for (let x = w; x !== undefined; x = prev.get(x)) { p.push(x); if (x === u) break; }
    return p.reverse();
  }
  neighbors(v) {
    return [...this.adj[v]].filter(([x]) => !this.contracted[x]);
  }
  /* 模拟（或真正执行）收缩 v，返回需要的捷径与边差 */
  contractNode(v, apply) {
    const nb = this.neighbors(v);
    const sc = [];
    for (let i = 0; i < nb.length; i++) {
      const [u, eu] = nb[i];
      const targets = new Map();
      for (let j = i + 1; j < nb.length; j++) targets.set(nb[j][0], eu.w + nb[j][1].w);
      if (!targets.size) continue;
      const { res } = this.witness(u, v, targets);
      for (const [w, via] of targets) {
        const d = res.has(w) ? res.get(w) : Infinity;
        if (d > via) sc.push({ u, w, wt: via, witness: d });
      }
    }
    if (apply) for (const s of sc) this._setEdge(s.u, s.w, s.wt, v);
    let cn = 0;
    for (const [x] of this.adj[v]) if (this.contracted[x]) cn++;
    return { shortcuts: sc, deg: nb.length, ed: sc.length - nb.length, cn, p: sc.length - nb.length + cn };
  }
  priority(v) { return this.contractNode(v, false); }

  /* 预处理（逐节点 yield） */
  *preprocessGen() {
    const H = new MinHeap();
    for (let v = 0; v < this.n; v++) H.push(this.priority(v).p, v);
    let count = 0;
    while (H.size) {
      const { val: v } = H.pop();
      if (this.contracted[v]) continue;
      const pr = this.priority(v);
      if (H.size && pr.p > H.peekKey()) { H.push(pr.p, v); continue; }   // 惰性更新
      const r = this.contractNode(v, true);
      this.contracted[v] = 1;
      this.rank[v] = count++;
      this.order.push(v);
      yield { type: 'contract', v, shortcuts: r.shortcuts, ed: r.ed, deg: r.deg, cn: r.cn, p: pr.p, rank: this.rank[v], n: this.n, nShortcuts: this.nShortcuts };
    }
    yield { type: 'preprocessed', nShortcuts: this.nShortcuts, n: this.n };
  }
  preprocess() { for (const _ of this.preprocessGen()) { /* 跑完 */ } return this; }

  isShortcut(a, b) { const e = this.adj[a].get(b); return !!(e && e.mid >= 0); }

  /* 查询（逐事件 yield）：双向、只向上 */
  *queryGen(s, t) {
    const n = this.n;
    const d = [new Float64Array(n).fill(Infinity), new Float64Array(n).fill(Infinity)];
    const prev = [new Int32Array(n).fill(-1), new Int32Array(n).fill(-1)];
    const set = [new Uint8Array(n), new Uint8Array(n)];
    const Hs = [new MinHeap(), new MinHeap()];
    d[0][s] = 0; Hs[0].push(0, s);
    d[1][t] = 0; Hs[1].push(0, t);
    let mu = Infinity, meet = -1, nS = 0, nR = 0, side = 1;
    const stopped = [false, false];
    yield { type: 'init', s, t };
    while (!(stopped[0] && stopped[1])) {
      side = 1 - side;
      if (stopped[side]) side = 1 - side;
      const H = Hs[side], ds = d[side], dother = d[1 - side], pv = prev[side], st = set[side];
      if (!H.size || H.peekKey() >= mu) {
        stopped[side] = true;
        yield { type: 'stopside', side, top: H.peekKey(), mu, nS, nR };
        continue;
      }
      const { val: u } = H.pop();
      if (st[u]) continue;
      st[u] = 1; nS++;
      if (dother[u] < Infinity) {
        const cand = ds[u] + dother[u];
        if (cand < mu) { mu = cand; meet = u; yield { type: 'meet', u, mu, dF: d[0][u], dB: d[1][u], nS, nR }; }
      }
      yield { type: 'settle', side, u, d: ds[u], rank: this.rank[u], qsize: H.size, qtop: H.top(5), nS, nR, mu, topF: Hs[0].peekKey(), topB: Hs[1].peekKey() };
      for (const [v, ed] of this.adj[u]) {
        if (this.rank[v] < this.rank[u]) continue;      // 只走向上的边
        if (st[v]) continue;
        nR++;
        const nd = ds[u] + ed.w, old = ds[v];
        const improved = nd < old;
        if (improved) { ds[v] = nd; pv[v] = u; H.push(nd, v); }
        yield { type: 'relax', side, u, v, du: ds[u], w: ed.w, nd, old, improved, isShortcut: ed.mid >= 0, nS, nR };
      }
    }
    if (meet < 0) { yield { type: 'done', path: [], cost: Infinity, nS, nR }; return; }
    const left = buildPath(prev[0], s, meet);
    const right = buildPath(prev[1], t, meet).reverse();
    const chPath = left.concat(right.slice(1));
    yield { type: 'chpath', path: chPath.slice(), cost: mu, meet, nS, nR };
    /* 逐步展开捷径：每次把第一条捷径边替换成两段 */
    const path = chPath.slice();
    for (;;) {
      let idx = -1, mid = -1;
      for (let i = 0; i + 1 < path.length; i++) {
        const ed = this.adj[path[i]].get(path[i + 1]);
        if (ed && ed.mid >= 0) { idx = i; mid = ed.mid; break; }
      }
      if (idx < 0) break;
      path.splice(idx + 1, 0, mid);
      yield { type: 'unpack', path: path.slice(), a: path[idx], b: path[idx + 2], mid, nS, nR };
    }
    yield { type: 'done', path, cost: mu, nS, nR, meet };
  }
}

/* =====================================================================
 *  玩具图上的逐帧讲解：收缩全过程 + 一次查询
 * ===================================================================== */
function toyGraph() {
  const nodes = [
    { id: 0, x: 60, y: 170, label: 'A' },
    { id: 1, x: 170, y: 80, label: 'B' },
    { id: 2, x: 170, y: 260, label: 'C' },
    { id: 3, x: 290, y: 170, label: 'D' },
    { id: 4, x: 410, y: 80, label: 'E' },
    { id: 5, x: 410, y: 260, label: 'F' },
    { id: 6, x: 520, y: 170, label: 'G' },
    { id: 7, x: 290, y: 40, label: 'H' },
  ];
  const E = [[0, 1, 3], [0, 2, 5], [1, 2, 6], [1, 3, 2], [2, 3, 1], [3, 4, 3], [3, 5, 2], [4, 6, 4], [5, 6, 3], [1, 7, 1], [7, 4, 1]];
  const edges = E.map(([u, v, w], id) => ({ id, u, v, w }));
  return { nodes, edges, W: 580, H: 300 };
}

function toyCHFrames(g, s, t) {
  const ch = new CH(g);
  const L = v => g.nodes[v].label;
  const frames = [];
  const snap = (extra = {}) => ({
    contracted: ch.contracted.slice(),
    rank: ch.rank.slice(),
    shortcuts: ch.shortcuts.map(x => ({ ...x })),
    ...extra,
  });
  const push = (text, hl = {}, phase = 'pre') => frames.push({ text, hl, phase, snap: snap() });

  push(`预处理开始。每个节点的优先级 = 边差 ED（需要加的捷径数 − 它连着的边数）+ 已收缩邻居数。优先级最低的先收缩。点"下一步"开始。`);
  const H = new MinHeap();
  for (let v = 0; v < ch.n; v++) H.push(ch.priority(v).p, v);
  let count = 0;
  while (H.size) {
    const { val: v } = H.pop();
    if (ch.contracted[v]) continue;
    const pr = ch.priority(v);
    if (H.size && pr.p > H.peekKey()) { H.push(pr.p, v); continue; }
    const nb = ch.neighbors(v);
    const nbStr = nb.map(([x]) => L(x)).join(', ') || '无';
    push(`选择优先级最低的节点 ${L(v)}（未收缩邻居：${nbStr}；ED = ${pr.shortcuts.length} − ${nb.length} = ${pr.ed}，已收缩邻居 ${pr.cn}，优先级 ${pr.p}）。逐对检查它的邻居。`, { node: v });
    for (let i = 0; i < nb.length; i++) {
      const [u, eu] = nb[i];
      for (let j = i + 1; j < nb.length; j++) {
        const [w, ew] = nb[j];
        const via = eu.w + ew.w;
        const { res, prev } = ch.witness(u, v, new Map([[w, via]]));
        const d = res.has(w) ? res.get(w) : Infinity;
        const wp = d < Infinity ? ch.witnessPath(prev, u, w) : [];
        push(`邻居对 (${L(u)}, ${L(w)})：经 ${L(v)} 的路长 = ${eu.w} + ${ew.w} = ${via}。在"去掉 ${L(v)}"的图里做一次局部 Dijkstra，找不经过 ${L(v)} 的最短路（见证路径）……`, { node: v, via: [[u, v], [v, w]] });
        if (d <= via) {
          push(`找到见证路径 ${wp.map(L).join('→')}，长 ${d} ≤ ${via}。说明去掉 ${L(v)} 不影响 ${L(u)}–${L(w)} 的最短距离，不加捷径。`, { node: v, via: [[u, v], [v, w]], witness: wp });
        } else {
          ch._setEdge(u, w, via, v);
          frames.push({ text: `不经 ${L(v)} 的最短路长 ${d === Infinity ? '∞（不连通）' : d} > ${via}。必须加捷径 (${L(u)}, ${L(w)})，权重 ${via}，并记住它的中间点 ${L(v)}，查询后才能还原成真实路径。`, hl: { node: v, via: [[u, v], [v, w]], witness: wp, newShortcut: [u, w] }, phase: 'pre', snap: snap() });
        }
      }
    }
    ch.contracted[v] = 1; ch.rank[v] = count++; ch.order.push(v);
    push(`${L(v)} 收缩完成，秩 rank(${L(v)}) = ${ch.rank[v]}（越早收缩越"不重要"）。它从后续的见证搜索中消失，但边和捷径保留。`, {});
  }
  push(`预处理完成。收缩顺序：${ch.order.map(L).join(' → ')}，共加 ${ch.nShortcuts} 条捷径（紫色虚线）。查询只允许走 rank 上升的边：正向从 ${L(s)} 往上爬，反向从 ${L(t)} 往上爬，在某个"高处"相遇。`, {}, 'query');

  /* 查询阶段 */
  const q = { setF: new Set(), setB: new Set(), dF: new Map(), dB: new Map(), mu: Infinity, path: null };
  const qsnap = () => ({ ...snap(), q: { setF: new Set(q.setF), setB: new Set(q.setB), dF: new Map(q.dF), dB: new Map(q.dB), mu: q.mu, path: q.path ? q.path.slice() : null, meet: q.meet } });
  for (const ev of ch.queryGen(s, t)) {
    let text = null, hl = {};
    if (ev.type === 'init') { q.dF.set(s, 0); q.dB.set(t, 0); text = `查询 ${L(s)} → ${L(t)}：正向队列 {${L(s)}:0}，反向队列 {${L(t)}:0}，μ = ∞。`; }
    else if (ev.type === 'settle') {
      (ev.side === 0 ? q.setF : q.setB).add(ev.u);
      text = `${ev.side === 0 ? '正向' : '反向'}弹出 ${L(ev.u)}（d = ${ev.d}，rank ${ev.rank}），只松弛指向更高 rank 的边。`;
      hl = { node: ev.u };
    } else if (ev.type === 'relax') {
      (ev.side === 0 ? q.dF : q.dB).set(ev.v, Math.min(ev.nd, ev.old));
      text = `${ev.side === 0 ? '正向' : '反向'}松弛 ${L(ev.u)}→${L(ev.v)}${ev.isShortcut ? '（捷径）' : ''}：${ev.du} + ${ev.w} = ${ev.nd}${ev.improved ? ` < ${ev.old === Infinity ? '∞' : ev.old}，更新并入队` : ` ≥ ${ev.old}，不更新`}。`;
      hl = { via: [[ev.u, ev.v]] };
    } else if (ev.type === 'meet') {
      q.mu = ev.mu; q.meet = ev.u;
      text = `节点 ${L(ev.u)} 被两个方向都触达：候选 μ = d_f + d_b = ${ev.dF} + ${ev.dB} = ${ev.mu}。`;
      hl = { node: ev.u };
    } else if (ev.type === 'stopside') {
      text = `${ev.side === 0 ? '正向' : '反向'}队列${ev.top === Infinity ? '已空' : `队首 key ${ev.top} ≥ μ=${ev.mu}`}，该方向停止。`;
    } else if (ev.type === 'chpath') {
      q.path = ev.path.slice();
      text = `相遇节点 ${L(ev.meet)}，层次图上的路径：${ev.path.map(L).join('→')}，长 ${ev.cost}。其中含捷径，需要展开。`;
    } else if (ev.type === 'unpack') {
      q.path = ev.path.slice();
      text = `展开捷径 (${L(ev.a)}, ${L(ev.b)}) → ${L(ev.a)}→${L(ev.mid)}→${L(ev.b)}。当前路径：${ev.path.map(L).join('→')}。`;
      hl = { node: ev.mid };
    } else if (ev.type === 'done') {
      q.path = ev.path.slice();
      text = `完成：真实最短路 ${ev.path.map(L).join('→')}，长 ${ev.cost}。这张小图看不出省了多少，关键是机制：每个方向只往"更重要"的节点爬，而捷径保证了这样爬不会漏掉最短路。下面的大路网演示能看出搜索空间的差距。`;
    }
    if (text) frames.push({ text, hl, phase: 'query', snap: qsnap() });
  }
  return { frames, ch };
}
