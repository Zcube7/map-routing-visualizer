'use strict';
/* =====================================================================
 *  mapapp.js —— 类 Google 地图界面：路线面板、右键菜单、算法叠加动画、
 *  引导案例（自动暂停 + 解说）、双算法并排锁步回放、指标对比、模拟导航
 * ===================================================================== */
const S = {
  g: null, A: -1, B: -1, algo: 'dijkstra', hour: 8.5,
  layers: [],                       // [主图层, 对比图层?]  每层 = { view, ov, ovCanvas, ovView, pending, algo, doneEv, h, marks }
  route: null, alts: [], route2: null, selRoute: 0, player: null,
  ch: null, chReady: false, chBusy: false, chPreMs: 0, lm: null, lmMs: 0, refKey: '', refDj: null,
  nav: null, drag: null, baseTimer: null, drawReq: false, ctxNode: -1, showSteps: false,
  autoFit: true, lite: false, case: null, callout: null, trace: null, skipping: false, perf: {},
};
const $ = id => document.getElementById(id);
const fmt = (x, d = 1) => (x === Infinity || x == null || Number.isNaN(x)) ? '∞' : Number(x).toFixed(d);
const hhmm = h => { h = ((h % 24) + 24) % 24; const H = Math.floor(h), M = Math.round((h - H) * 60) % 60; return `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`; };
const nowHour = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
const fmtDist = m => m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${Math.round(m)} 米`;
const fmtMin = m => m >= 60 ? `${Math.floor(m / 60)} 小时 ${Math.round(m % 60)} 分钟` : `${Math.max(1, Math.round(m))} 分钟`;
const SIDE_NAME = ['正向', '反向'];
const COL = { f: '#1a73e8', b: '#d93025', cur: '#fbbc04', route: '#4285f4', routeCase: '#1b5fc9', routeGlow: 'rgba(66,133,244,0.22)', alt: '#a9b4c2', altCase: '#6f7a8a', sc: '#a142f4', lm: '#7c3aed', relax: '#f29900', route2: '#188038', route2Case: '#0b5a24', mark: '#e37400' };
const BIDIR_LIKE = k => k === 'bidir' || k === 'ch';

const ALGOS = {
  dijkstra: { name: 'Dijkstra', tip: '均匀泛洪，不看终点', link: 'index.html#dijkstra',
    principle: `每次取出暂定距离最小的路口并"确定"它，再松弛它的邻居：$$d(v)\\leftarrow\\min\\big(d(v),\\,d(u)+w(u,v)\\big)$$ 边权 \\(w=\\ell/v\\) 是路段耗时（分钟）。搜索区域是以起点为中心的"耗时等值圈"，完全不知道终点在哪，所以会往反方向白白探索。复杂度 \\(O((|V|+|E|)\\log|V|)\\)。` },
  astar: { name: 'A*', tip: '直线距离 ÷ 限速 作下界', link: 'index.html#astar',
    principle: `按 \\(f=g+h\\) 排序，\\(g\\) 是已走耗时，\\(h\\) 是"至少还要多久"：$$h(v)=\\frac{\\|p_v-p_t\\|_2}{v_{\\max}}\\le\\operatorname{dist}(v,t)$$ 任何真实路径都不比直线短、不比最高限速快，所以 \\(h\\) 永远不高估（可采纳），结果仍是最优。搜索区域被"吸"向终点，变成椭圆。` },
  bidir: { name: '双向 Dijkstra', tip: '两头同时搜', link: 'index.html#bidir',
    principle: `正向从起点、反向从终点各跑一个 Dijkstra，碰到被两侧都触达的路口就得到一条完整路径，记录最好值 \\(\\mu\\)。终止条件：$$\\min_{Q_f} d_f+\\min_{Q_b} d_b\\ \\ge\\ \\mu$$ 两个半径减半的圆面积只有原来的一半，所以探索量大约减半。注意"第一次相遇"不等于可以停（见引导案例）。` },
  alt: { name: 'ALT 地标', tip: '预存到地标的真实距离', link: 'index.html#alt',
    principle: `预处理：选 8 个地标 \\(L\\)（紫色菱形），对每个地标跑一遍全图 Dijkstra 存下 \\(\\operatorname{dist}(L,v)\\)。查询时用三角不等式得到下界：$$h(v)=\\max_L\\big|\\operatorname{dist}(L,t)-\\operatorname{dist}(L,v)\\big|$$ 它来自真实路网，比"直线÷限速"紧得多，所以 A* 探索得更少。` },
  ch: { name: 'CH 收缩层次', tip: '预处理捷径，查询只向上', link: 'index.html#ch',
    principle: `预处理：按"不重要→重要"的顺序逐个收缩路口，若收缩破坏了两个邻居间的最短距离就补一条捷径：$$\\operatorname{dist}_{G\\setminus\\{v\\}}(u,w)>w(u,v)+w(v,w)\\ \\Rightarrow\\ \\text{加捷径}(u,w)$$ 查询：双向搜索，只允许走向"更重要"的路口 \\(\\pi(u)<\\pi(v)\\)，在高处相遇后把捷径（紫色虚线）展开。这是 OSRM、GraphHopper 的默认算法，大陆级路网查询不到 1 毫秒。` },
  td: { name: '时变路况', tip: '边权随出发时刻变化', link: 'index.html#traffic',
    principle: `每条路段的耗时是进入时刻的函数 \\(w_e(\\tau)=\\ell_e/v_e(\\tau)\\)，标签改为"到达时刻"：$$a(v)\\leftarrow\\min\\big(a(v),\\,a(u)+w_{uv}(a(u))\\big)$$ 只要满足 FIFO（先出发不会后到），Dijkstra 原样可用。拖动出发时刻看早晚高峰如何让路线避开主干道；路况图层按该时刻的车速着色。` },
};

/* ---------- 引导案例 ---------- */
const CASES = [
  { id: 'shortest-vs-fastest', title: '距离更短，为什么耗时更长？', algo: 'dijkstra', A: [45.48844, 9.20378], B: [45.46763, 9.21022], speed: 85,
    intro: '导航默认优化的是<b>耗时</b>而不是距离：边权 w = 路段长度 ÷ 车速。等搜索结束，会把"距离最短"的路线也画出来（绿色虚线）对比。' },
  { id: 'bidir-first-meet', title: '双向搜索：第一次相遇为什么还不能停？', algo: 'bidir', A: [45.46491, 9.18925], B: [45.47987, 9.19548], speed: 52,
    intro: '正向（蓝）和反向（红）同时扩张。两侧<b>第一次碰到同一个路口</b>时会自动暂停，看看为什么此时还不能宣布找到最短路。' },
  { id: 'ch-amortize', title: 'CH：先花时间预处理，之后为什么更快？', algo: 'ch', A: [45.46420, 9.19000], B: [45.48620, 9.20400], speed: 55,
    intro: 'CH 要先对整张路网做一次预处理（加捷径），之后每次查询都只碰几十个路口。下面会实测：预处理花了多久、单次查询省了多少、查几次就回本。' },
  { id: 'trace-path', title: '结果出来后，最优路径在哪？', algo: 'dijkstra', A: [45.46420, 9.19000], B: [45.48620, 9.20400], speed: 90,
    intro: '搜索结束时并没有"一条路"摆在那里：每个路口只记着它是<b>从哪个路口松弛来的</b>（prev 指针）。从终点沿 prev 一路回溯到起点，最优路径才显现出来——结束后会慢放这一步。' },
];

/* ---------- 工具 ---------- */
function requestDraw() { if (S.drawReq || S.noDraw) return; S.drawReq = true; requestAnimationFrame(() => { S.drawReq = false; draw(); }); }
function edgeOf(u, v) { return edgeBetween(S.g, u, v); }
function routePolyline(path) {
  const g = S.g, out = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const e = edgeOf(path[i], path[i + 1]); if (!e) continue;
    const ed = g.edges[e.eid]; const p = ed.pts;
    if (ed.u === path[i]) { for (let k = i === 0 ? 0 : 2; k < p.length; k++) out.push(p[k]); }
    else { for (let k = p.length - 2 - (i === 0 ? 0 : 2); k >= 0; k -= 2) { out.push(p[k], p[k + 1]); } }
  }
  return out;
}
function pathLenM(path) { let s = 0; for (let i = 0; i + 1 < path.length; i++) { const e = edgeOf(path[i], path[i + 1]); if (e) s += S.g.edges[e.eid].lenM; } return s; }
function viaNames(path) {
  const acc = new Map();
  for (let i = 0; i + 1 < path.length; i++) { const e = edgeOf(path[i], path[i + 1]); if (!e) continue; const ed = S.g.edges[e.eid]; if (ed.name) acc.set(ed.name, (acc.get(ed.name) || 0) + ed.lenM); }
  return [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]);
}
function localShare(path) {   // 路线里支路（residential/living_street）所占长度比例
  let loc = 0, tot = 0;
  for (let i = 0; i + 1 < path.length; i++) { const e = edgeOf(path[i], path[i + 1]); if (!e) continue; const ed = S.g.edges[e.eid]; tot += ed.lenM; if (ed.cls === 'residential' || ed.cls === 'living_street') loc += ed.lenM; }
  return tot ? loc / tot : 0;
}
function buildSteps(path) {
  const g = S.g, groups = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const e = edgeOf(path[i], path[i + 1]); if (!e) continue;
    const ed = g.edges[e.eid], name = ed.name || '无名道路';
    const p = ed.pts, fwd = ed.u === path[i];
    const sx = fwd ? p[0] : p[p.length - 2], sy = fwd ? p[1] : p[p.length - 1];
    const sx2 = fwd ? p[2] : p[p.length - 4], sy2 = fwd ? p[3] : p[p.length - 3];
    const ex = fwd ? p[p.length - 4] : p[2], ey = fwd ? p[p.length - 3] : p[3];
    const ex2 = fwd ? p[p.length - 2] : p[0], ey2 = fwd ? p[p.length - 1] : p[1];
    const inA = Math.atan2(sy2 - sy, sx2 - sx), outA = Math.atan2(ey2 - ey, ex2 - ex);
    const last = groups[groups.length - 1];
    if (last && last.name === name) { last.lenM += ed.lenM; last.outA = outA; }
    else groups.push({ name, lenM: ed.lenM, inA, outA });
  }
  const steps = [];
  groups.forEach((gp, i) => {
    let turn = '出发', arrow = '●';
    if (i > 0) {
      let d = (gp.inA - groups[i - 1].outA) * 180 / Math.PI; while (d > 180) d -= 360; while (d < -180) d += 360;
      if (Math.abs(d) < 20) { turn = '继续直行，进入'; arrow = '↑'; }
      else if (d >= 20 && d < 60) { turn = '稍向右转，进入'; arrow = '↗'; }
      else if (d >= 60 && d < 135) { turn = '右转，进入'; arrow = '↱'; }
      else if (d >= 135) { turn = '向右掉头，进入'; arrow = '↷'; }
      else if (d <= -20 && d > -60) { turn = '稍向左转，进入'; arrow = '↖'; }
      else if (d <= -60 && d > -135) { turn = '左转，进入'; arrow = '↰'; }
      else { turn = '向左掉头，进入'; arrow = '↶'; }
    }
    steps.push({ arrow, text: i === 0 ? `沿 ${gp.name} 出发` : `${turn} ${gp.name}`, dist: gp.lenM });
  });
  steps.push({ arrow: '⚑', text: '到达目的地', dist: 0, end: true });
  return steps;
}
function routeCost(path) { return S.algo === 'td' ? evalPathTD(S.g, path, S.hour) : pathCost(S.g, path); }
function makeRoute(path, cost) { return { path, cost, lenM: pathLenM(path), via: viaNames(path), pts: routePolyline(path), steps: buildSteps(path) }; }
function altRoutes(main) {
  const g = S.g, out = [], penal = new Float64Array(g.edges.length).fill(1);
  const mark = p => { for (let i = 0; i + 1 < p.length; i++) { const e = edgeOf(p[i], p[i + 1]); if (e) penal[e.eid] = 1.8; } };
  mark(main.path);
  for (let k = 0; k < 2; k++) {
    const adj2 = g.adj.map(l => l.map(e => ({ to: e.to, w: e.w * penal[e.eid], eid: e.eid })));
    const r = runGen(dijkstraGen({ nodes: g.nodes, adj: adj2 }, S.A, S.B));
    if (!r.path.length) break;
    const cost = routeCost(r.path);
    let shared = 0; const set = new Set(); for (let i = 0; i + 1 < main.path.length; i++) { const e = edgeOf(main.path[i], main.path[i + 1]); if (e) set.add(e.eid); }
    for (let i = 0; i + 1 < r.path.length; i++) { const e = edgeOf(r.path[i], r.path[i + 1]); if (e && set.has(e.eid)) shared += g.edges[e.eid].lenM; }
    const lenM = pathLenM(r.path);
    if (shared / lenM < 0.75 && cost <= main.cost * 1.4 && !out.some(o => o.path.length === r.path.length && o.cost === cost)) out.push(makeRoute(r.path, cost));
    mark(r.path);
  }
  return out;
}
function shortestDistanceRoute() {
  const g = S.g, adjD = g.adj.map(l => l.map(e => ({ to: e.to, w: g.edges[e.eid].lenM, eid: e.eid })));
  const r = runGen(dijkstraGen({ nodes: g.nodes, adj: adjD }, S.A, S.B));
  return r.path.length ? makeRoute(r.path, pathCost(g, r.path)) : null;
}

/* ---------- 图层（主图 / 对比图） ---------- */
function makeLayer(canvas) {
  const L = { view: new MapView(canvas, S.g), ov: null, ovCanvas: null, ovView: null, pending: [], algo: 'dijkstra', doneEv: null, h: null, marks: [] };
  L.view.onchange = () => { L.ovView = null; requestDraw(); };
  resetOverlay(L);
  return L;
}
function resetOverlay(L) {
  const g = S.g;
  L.ov = { sideEdge: new Uint8Array(g.edges.length), sideNode: new Uint8Array(g.nodes.length), dist: [new Float64Array(g.nodes.length).fill(Infinity), new Float64Array(g.nodes.length).fill(Infinity)],
    current: -1, hlEdge: null, sc: [], path: null, cost: Infinity, nS: 0, nU: 0, nR: 0, qsize: 0, mu: Infinity, topF: Infinity, topB: Infinity, finished: false, log: [], unpack: 0, active: false, meets: 0, firstMeet: -1, firstMu: Infinity };
  L.pending = []; L.ovView = null; L.doneEv = null; L.h = null; L.marks = [];
  if (L.ovCanvas) L.ovCanvas.getContext('2d').clearRect(0, 0, L.ovCanvas.width, L.ovCanvas.height);
}
function addLog(L, s) { const l = L.ov.log; l.push(s); if (l.length > 6) l.shift(); }
function handleEvent(L, ev) {
  const ov = L.ov, g = S.g; ov.current = -1; ov.hlEdge = null; ov.active = true;
  switch (ev.type) {
    case 'init': addLog(L, `初始化：起点 d=0，其余 ∞。`); break;
    case 'settle':
      ov.sideNode[ev.u] = ev.side + 1; ov.current = ev.u; ov.dist[ev.side][ev.u] = ev.d; ov.nS = ev.nS; ov.nU = ev.nU != null ? ev.nU : ev.nS; ov.nR = ev.nR; ov.qsize = ev.qsize;
      if (ev.mu != null) { ov.mu = ev.mu; ov.topF = ev.topF; ov.topB = ev.topB; }
      addLog(L, `${BIDIR_LIKE(L.algo) ? SIDE_NAME[ev.side] : ''}确定 ${g.describeNode(ev.u)}：d=${fmt(ev.d, 2)} min${ev.rank != null ? `，rank ${ev.rank}` : ''}`);
      break;
    case 'relax': {
      ov.current = ev.u; ov.nR = ev.nR;
      if (ev.improved) {
        ov.dist[ev.side][ev.v] = ev.nd;
        if (ev.isShortcut) { ov.sc.push([ev.u, ev.v, ev.side]); L.pending.push({ sc: [ev.u, ev.v], side: ev.side }); }
        else { const e = edgeOf(ev.u, ev.v); if (e && !ov.sideEdge[e.eid]) { ov.sideEdge[e.eid] = ev.side + 1; L.pending.push({ eid: e.eid, side: ev.side }); } }
      }
      ov.hlEdge = { u: ev.u, v: ev.v, improved: ev.improved };
      const p = logDecimals(ev.du, ev.w, ev.nd, ev.old);    // 精度自适应：加数之和要等于显示的和，比较关系要与真实一致
      addLog(L, `<span title="精确值 ${ev.du.toFixed(4)} + ${ev.w.toFixed(4)} = ${ev.nd.toFixed(4)}；原 ${ev.old === Infinity ? '∞' : ev.old.toFixed(4)}">松弛 → ${g.describeNode(ev.v)}：${fmt(ev.du, p)}+${fmt(ev.w, p)}=${fmt(ev.nd, p)} ${ev.improved ? '&lt; ' + fmt(ev.old, p) + ' 更新' : '≥ ' + fmt(ev.old, p) + ' 不更新'}${L.h && ev.improved ? `，f=${fmt(ev.key, p)}` : ''}</span>`);
      break;
    }
    case 'meet': {
      const p = logDecimals(ev.dF, ev.dB, ev.mu, ov.mu);
      if (ov.firstMeet < 0) { ov.firstMeet = ev.u; ov.firstMu = ev.mu; }
      ov.meets++; ov.mu = ev.mu;
      addLog(L, `两侧在 ${g.describeNode(ev.u)} 相遇：μ = ${fmt(ev.dF, p)} + ${fmt(ev.dB, p)} = <b>${fmt(ev.mu, p)}</b>`);
      break;
    }
    case 'stop': { ov.topF = ev.topF; ov.topB = ev.topB; const p = logDecimals(ev.topF, ev.topB, ev.topF + ev.topB, ev.mu); addLog(L, `终止：${fmt(ev.topF, p)} + ${fmt(ev.topB, p)} = ${fmt(ev.topF + ev.topB, p)} ≥ μ=${fmt(ev.mu, p)}`); break; }
    case 'stopside': addLog(L, `${SIDE_NAME[ev.side]}停止（队首 ${fmt(ev.top)} ≥ μ=${fmt(ev.mu)}）`); break;
    case 'chpath': ov.path = ev.path; ov.cost = ev.cost; addLog(L, `层次图路径 ${ev.path.length} 个节点（含捷径），开始展开…`); break;
    case 'unpack': ov.path = ev.path; ov.unpack++; addLog(L, `展开捷径 → 经 ${g.describeNode(ev.mid)}`); break;
    case 'done': ov.path = ev.path; ov.cost = ev.cost; ov.nS = ev.nS; ov.nU = ev.nU != null ? ev.nU : ev.nS; ov.nR = ev.nR; ov.finished = true; L.doneEv = ev;
      addLog(L, `完成：${fmt(ev.cost)} min，展开 ${ev.nS} 次（唯一路口 ${ov.nU}），松弛 ${ev.nR} 次。`); break;
  }
  if (L === S.layers[0] && S.case && S.case.onEvent && !S.skipping) {
    const msg = S.case.onEvent(ev, L);
    if (msg) { S.player.pause(); showCallout(msg.title, msg.html, msg.node, true); }
  }
}

/* ---------- 叠加层绘制 ---------- */
function ensureOvCanvas(L) {
  const v = L.view;
  if (!L.ovCanvas) L.ovCanvas = document.createElement('canvas');
  if (L.ovCanvas.width !== v.cv.width || L.ovCanvas.height !== v.cv.height) { L.ovCanvas.width = v.cv.width; L.ovCanvas.height = v.cv.height; L.ovView = null; }
}
function strokeEdge(ctx, v, item) {
  const g = S.g;
  if (item.sc) { const a = g.nodes[item.sc[0]], b = g.nodes[item.sc[1]]; ctx.strokeStyle = COL.sc; ctx.setLineDash([v.px(6), v.px(4)]); ctx.lineWidth = v.px(2); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]); return; }
  ctx.strokeStyle = item.side ? COL.b : COL.f; ctx.lineWidth = v.px(Math.max(2.4, Math.min(7, 5 * v.scale)));
  ctx.beginPath(); polyPath(ctx, g.edges[item.eid].pts); ctx.stroke();
}
function renderOverlayFull(L) {
  const v = L.view, ctx = L.ovCanvas.getContext('2d'), ov = L.ov, g = S.g;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, L.ovCanvas.width, L.ovCanvas.height);
  v.setWorldTransform(ctx); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = 0.75;
  for (let side = 1; side <= 2; side++) {
    ctx.strokeStyle = side === 2 ? COL.b : COL.f; ctx.lineWidth = v.px(Math.max(2.4, Math.min(7, 5 * v.scale)));
    ctx.beginPath();
    for (let i = 0; i < ov.sideEdge.length; i++) if (ov.sideEdge[i] === side && v.visible(g.edges[i].bbox)) polyPath(ctx, g.edges[i].pts);
    ctx.stroke();
  }
  for (const [a, b] of ov.sc) strokeEdge(ctx, v, { sc: [a, b] });
  ctx.globalAlpha = 1;
  L.ovView = { cx: v.cx, cy: v.cy, scale: v.scale };
  L.pending = [];
}
function flushPending(L) {
  if (!L.pending.length) return;
  const v = L.view, ctx = L.ovCanvas.getContext('2d');
  v.setWorldTransform(ctx); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = 0.75;
  for (const it of L.pending) strokeEdge(ctx, v, it);
  ctx.globalAlpha = 1; L.pending = [];
}
function sameView(L) { const a = L.ovView, v = L.view; return a && Math.abs(a.cx - v.cx) < 1e-9 && Math.abs(a.cy - v.cy) < 1e-9 && Math.abs(a.scale - v.scale) < 1e-12; }

function draw() {
  for (const L of S.layers) drawLayer(L, L === S.layers[0]);
  if (S.callout && S.callout.node >= 0) positionCallout();
  if (S.trace && performance.now() - S.trace.t0 < S.trace.dur) requestDraw();
  updateScaleBar();
}
function drawLayer(L, primary) {
  const v = L.view, g = S.g, ctx = v.cv.getContext('2d'), ov = L.ov;
  ensureOvCanvas(L);
  const exact = v.drawBase(ctx);
  if (!exact) scheduleBase();
  if (ov.active) {
    if (sameView(L)) flushPending(L);
    else if (!exact && L.ovView) { /* 视图变化中：用缓存变换着画 */ }
    else renderOverlayFull(L);
    ctx.globalAlpha = ov.finished ? 0.42 : 1;
    v.drawCached(ctx, L.ovCanvas, L.ovView);
    ctx.globalAlpha = 1;
  }
  v.setWorldTransform(ctx); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const routeDone = primary && S.route && ov.finished;
  const traceP = S.trace ? Math.min(1, (performance.now() - S.trace.t0) / S.trace.dur) : 1;
  if (routeDone) {
    if (traceP >= 1) {
      S.alts.forEach((a, i) => { if (S.selRoute === i + 1) return; drawRoute(ctx, v, a.pts, COL.altCase, COL.alt, 7, 4.5); });
      if (S.route2) drawRoute(ctx, v, S.route2.pts, COL.route2Case, COL.route2, 7, 4.5, [v.px(10), v.px(7)]);
    }
    const sel = S.selRoute === 0 ? S.route : S.alts[S.selRoute - 1];
    if (S.selRoute !== 0) drawRoute(ctx, v, S.route.pts, COL.altCase, COL.alt, 7, 4.5);
    const pts = traceP >= 1 ? sel.pts : partialPolyline(sel.pts, 1 - traceP, true);
    if (pts.length >= 4) {
      ctx.strokeStyle = COL.routeGlow; ctx.lineWidth = v.px(16); ctx.beginPath(); polyPath(ctx, pts); ctx.stroke();
      drawRoute(ctx, v, pts, COL.routeCase, COL.route, 9, 6);
    }
  } else if (ov.path && ov.path.length > 1) {
    const ch = L.algo === 'ch' && S.ch;
    ctx.strokeStyle = COL.route; ctx.lineWidth = v.px(5);
    for (let i = 0; i + 1 < ov.path.length; i++) {
      const a = ov.path[i], b = ov.path[i + 1];
      if (ch && S.ch.isShortcut(a, b)) { ctx.setLineDash([v.px(8), v.px(6)]); ctx.strokeStyle = COL.sc; ctx.beginPath(); ctx.moveTo(g.nodes[a].x, g.nodes[a].y); ctx.lineTo(g.nodes[b].x, g.nodes[b].y); ctx.stroke(); ctx.setLineDash([]); ctx.strokeStyle = COL.route; }
      else { const e = edgeOf(a, b); if (e) { ctx.beginPath(); polyPath(ctx, g.edges[e.eid].pts); ctx.stroke(); } }
    }
  }
  if (ov.hlEdge && !ov.finished) {
    const { u, v: w, improved } = ov.hlEdge; const e = edgeOf(u, w);
    ctx.strokeStyle = improved ? COL.relax : '#9aa0a6'; ctx.lineWidth = v.px(6);
    if (e) { ctx.beginPath(); polyPath(ctx, g.edges[e.eid].pts); ctx.stroke(); }
    else { ctx.beginPath(); ctx.moveTo(g.nodes[u].x, g.nodes[u].y); ctx.lineTo(g.nodes[w].x, g.nodes[w].y); ctx.stroke(); }
  }
  /* 屏幕空间元素 */
  v.setScreenTransform(ctx);
  if (ov.current >= 0 && !ov.finished) {
    const [sx, sy] = v.toScreen(g.nodes[ov.current].x, g.nodes[ov.current].y);
    ctx.fillStyle = COL.cur; ctx.strokeStyle = '#7a5a00'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  if (L.algo === 'alt' && S.lm) {
    S.lm.lms.forEach((id, i) => {
      const [sx, sy] = v.toScreen(g.nodes[id].x, g.nodes[id].y);
      ctx.fillStyle = COL.lm; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sx, sy - 12); ctx.lineTo(sx + 10, sy); ctx.lineTo(sx, sy + 12); ctx.lineTo(sx - 10, sy); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px Roboto, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('L' + (i + 1), sx, sy + 0.5);
    });
  }
  for (const m of L.marks) {
    const [sx, sy] = v.toScreen(g.nodes[m.node].x, g.nodes[m.node].y);
    ctx.strokeStyle = m.color || COL.mark; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(sx, sy, 11, 0, Math.PI * 2); ctx.stroke();
    ctx.font = 'bold 12px Roboto, "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.strokeText(m.label, sx + 15, sy); ctx.fillStyle = m.color || COL.mark; ctx.fillText(m.label, sx + 15, sy);
  }
  if (!primary) {   // 对比图层左上角标签
    ctx.font = 'bold 13px Roboto, "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const label = `对比：${ALGOS[L.algo].name}`; const w = ctx.measureText(label).width + 16;
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(10, 10, w, 26); ctx.fillStyle = '#202124'; ctx.fillText(label, 18, 16);
  } else if (S.layers.length > 1) {
    ctx.font = 'bold 13px Roboto, "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const label = `主图：${ALGOS[L.algo].name}`; const w = ctx.measureText(label).width + 16;
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(10, 10, w, 26); ctx.fillStyle = '#202124'; ctx.fillText(label, 18, 16);
  }
  if (S.A >= 0) drawOrigin(ctx, ...v.toScreen(g.nodes[S.A].x, g.nodes[S.A].y));
  if (S.B >= 0) drawPin(ctx, ...v.toScreen(g.nodes[S.B].x, g.nodes[S.B].y));
  if (S.nav && primary) drawNav(ctx, v);
}
function partialPolyline(pts, frac, fromEnd) {
  const cum = [0]; let tot = 0;
  for (let i = 2; i < pts.length; i += 2) { tot += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]); cum.push(tot); }
  const target = tot * frac, out = [];
  if (fromEnd) {   // 从终点往回画 target 长度
    const start = tot - target;
    for (let i = cum.length - 1; i >= 0; i--) {
      if (cum[i] >= start) { out.unshift(pts[2 * i], pts[2 * i + 1]); }
      else { const t = (start - cum[i]) / ((cum[i + 1] - cum[i]) || 1); out.unshift(pts[2 * i] + (pts[2 * i + 2] - pts[2 * i]) * t, pts[2 * i + 1] + (pts[2 * i + 3] - pts[2 * i + 1]) * t); break; }
    }
  }
  return out;
}
function drawRoute(ctx, v, pts, caseCol, fillCol, wCase, wFill, dash) {
  if (!pts || pts.length < 4) return;
  if (dash) ctx.setLineDash(dash);
  ctx.strokeStyle = caseCol; ctx.lineWidth = v.px(wCase); ctx.beginPath(); polyPath(ctx, pts); ctx.stroke();
  ctx.strokeStyle = fillCol; ctx.lineWidth = v.px(wFill); ctx.beginPath(); polyPath(ctx, pts); ctx.stroke();
  if (dash) ctx.setLineDash([]);
}
function drawOrigin(ctx, sx, sy) {
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#202124'; ctx.lineWidth = 3.5;
  ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
}
function drawPin(ctx, sx, sy) {
  ctx.save(); ctx.translate(sx, sy);
  ctx.fillStyle = '#ea4335'; ctx.strokeStyle = '#b3261e'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.bezierCurveTo(-3, -8, -12, -12, -12, -22); ctx.arc(0, -22, 12, Math.PI, 0); ctx.bezierCurveTo(12, -12, 3, -8, 0, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, -22, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function scheduleBase() {
  if (S.baseTimer) return;
  S.baseTimer = setTimeout(() => { S.baseTimer = null; for (const L of S.layers) { L.view.renderBase(); L.ovView = null; } requestDraw(); }, 140);
}
function updateScaleBar() { const { m, px } = S.layers[0].view.scaleBar(); $('scalebar').innerHTML = `<i style="width:${px.toFixed(0)}px"></i><span>${m >= 1000 ? m / 1000 + ' 公里' : m + ' 米'}</span>`; }
function invalidateBase() { for (const L of S.layers) { L.view.baseView = null; L.ovView = null; } requestDraw(); }
function syncViews(from) { for (const L of S.layers) if (L.view !== from) { L.view.cx = from.cx; L.view.cy = from.cy; L.view.scale = from.scale; } }

/* 把路线适配到未被面板遮挡的可见区域 */
function fitRouteToVisible(pts) {
  if (!pts || pts.length < 4) return;
  const v = S.layers[0].view;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < pts.length; i += 2) { minx = Math.min(minx, pts[i]); maxx = Math.max(maxx, pts[i]); miny = Math.min(miny, pts[i + 1]); maxy = Math.max(maxy, pts[i + 1]); }
  const panelW = document.body.classList.contains('panel-collapsed') ? 0 : $('panel').offsetWidth;
  const algoW = S.layers.length > 1 ? 0 : ($('algo').classList.contains('hidden') ? 0 : $('algo').offsetWidth + 24);
  const left = Math.min(panelW, v.w * 0.6), right = v.w - Math.min(algoW, v.w * 0.4);
  const pad = 70, availW = Math.max(100, right - left - 2 * pad), availH = Math.max(100, v.h - 2 * pad);
  const scale = Math.min(1.6, availW / Math.max(50, maxx - minx), availH / Math.max(50, maxy - miny));
  v.scale = scale;
  const cxScreen = (left + right) / 2, cyScreen = v.h / 2;
  v.cx = (minx + maxx) / 2 - (cxScreen - v.w / 2) / scale;
  v.cy = (miny + maxy) / 2 - (cyScreen - v.h / 2) / scale;
  syncViews(v); invalidateBase();
}

/* ---------- 起终点 / 搜索 ---------- */
function setPoint(which, node, fromText, opts = {}) {
  if (node < 0) return;
  if (which === 'A') { if (node === S.B) return; S.A = node; } else { if (node === S.A) return; S.B = node; }
  $(which === 'A' ? 'inA' : 'inB').value = fromText || S.g.describeNode(node);
  hideCtx(); stopNav();
  if (!opts.keepCase) endCase();
  if (S.A >= 0 && S.B >= 0) startSearch(true); else { for (const L of S.layers) resetOverlay(L); S.route = null; S.route2 = null; renderRouteCards(); requestDraw(); }
}
function swapPoints() { const a = S.A, b = S.B; S.A = b; S.B = a; $('inA').value = S.A >= 0 ? S.g.describeNode(S.A) : ''; $('inB').value = S.B >= 0 ? S.g.describeNode(S.B) : ''; stopNav(); endCase(); if (S.A >= 0 && S.B >= 0) startSearch(true); else requestDraw(); }
function bindSearch(inputId, suggId, which) {
  const inp = $(inputId), box = $(suggId); let idx = -1, list = [];
  const render = () => { box.innerHTML = list.map((n, i) => `<div role="option" class="${i === idx ? 'active' : ''}" data-n="${n.replace(/"/g, '&quot;')}"><span class="loc"></span>${n}</div>`).join(''); box.classList.toggle('hidden', !list.length);
    box.querySelectorAll('div[data-n]').forEach(d => d.onmousedown = e => { e.preventDefault(); choose(d.dataset.n); }); };
  const choose = nm => { setPoint(which, S.g.nodeForStreet(nm), nm); list = []; idx = -1; render(); inp.blur(); };
  inp.addEventListener('input', () => { list = S.g.searchStreets(inp.value, 7); idx = list.length ? 0 : -1; render(); });
  inp.addEventListener('blur', () => setTimeout(() => { list = []; render(); }, 150));
  inp.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' && list.length) { idx = (idx + 1) % list.length; render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && list.length) { idx = (idx - 1 + list.length) % list.length; render(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (!list.length) list = S.g.searchStreets(inp.value, 1); if (list.length) choose(list[Math.max(0, idx)]); e.preventDefault(); }
    else if (e.key === 'Escape') { list = []; render(); inp.blur(); }
  });
}
function refDijkstra() {
  const key = `${S.A}:${S.B}`;
  if (S.refKey !== key) { S.refDj = runGen(dijkstraGen(S.g, S.A, S.B)); S.refKey = key; }
  return S.refDj;
}
function algoGen(L) {
  const g = S.g;
  switch (L.algo) {
    case 'astar': L.h = cityHeuristic(g, S.B); return dijkstraGen(g, S.A, S.B, { h: L.h });
    case 'bidir': return bidirGen(g, S.A, S.B);
    case 'alt': ensureLandmarks(); L.h = altHeuristic(S.lm, S.B); return dijkstraGen(g, S.A, S.B, { h: L.h });
    case 'ch': return S.ch.queryGen(S.A, S.B);
    case 'td': return tdDijkstraGen(g, S.A, S.B, S.hour);
    default: return dijkstraGen(g, S.A, S.B);
  }
}
function ensureLandmarks() { if (!S.lm) { const t0 = performance.now(); S.lm = computeLandmarks(S.g, 8); S.lmMs = performance.now() - t0; } }
/* 多个生成器按"每次一个 settle"轮流推进 → 并排对比时两边展开次数相同 */
function* lockstep(gens) {
  const done = gens.map(() => false);
  while (done.some(d => !d)) {
    for (let i = 0; i < gens.length; i++) {
      if (done[i]) continue;
      for (;;) {
        const r = gens[i].next();
        if (r.done) { done[i] = true; break; }
        yield { layer: i, ev: r.value };
        if (r.value.type === 'settle') break;
        if (r.value.type === 'done') { done[i] = true; break; }
      }
    }
  }
}
function makeGen() { return lockstep(S.layers.map(L => algoGen(L))); }
function needsCH() { return S.layers.some(L => L.algo === 'ch') && !S.chReady; }
function startSearch(newQuery) {
  if (S.A < 0 || S.B < 0) return;
  stopNav(); hideCallout(); S.route = null; S.alts = []; S.route2 = null; S.selRoute = 0; S.showSteps = false; S.trace = null;
  for (const L of S.layers) resetOverlay(L);
  renderRouteCards(); renderStats();
  if (needsCH()) { preprocessCH(() => startSearch(newQuery)); requestDraw(); return; }
  if (newQuery && S.autoFit) { const r = refDijkstra(); if (r.path.length) fitRouteToVisible(routePolyline(r.path)); }
  if (S.case && S.case.beforeStart) S.case.beforeStart();
  S.player.reset(); S.player.play();
  requestDraw();
}
function finishSearch() {
  const L0 = S.layers[0], ev = L0.doneEv;
  if (!ev || !ev.path || !ev.path.length) { renderRouteCards(); renderStats(); requestDraw(); return; }
  S.route = makeRoute(ev.path, ev.cost);
  S.alts = altRoutes(S.route);
  S.trace = { t0: performance.now(), dur: S.case && S.case.id === 'trace-path' ? 3200 : 1200 };
  renderRouteCards(); renderStats(); requestDraw();
  if (S.case && S.case.onDone) { const msg = S.case.onDone(L0); if (msg) showCallout(msg.title, msg.html, msg.node, false); }
}
function preprocessCH(then) {
  if (S.chBusy) return;
  S.chBusy = true; S.ch = new CH(S.g); S.chReady = false;
  const gen = S.ch.preprocessGen(), n = S.g.nodes.length, t0 = performance.now();
  $('chprog').classList.remove('hidden');
  const chunk = () => {
    const ts = performance.now(); let last = null;
    while (performance.now() - ts < 40) { const r = gen.next(); if (r.done || r.value.type === 'preprocessed') { last = 'done'; break; } last = r.value; }
    if (last === 'done') {
      S.chReady = true; S.chBusy = false; S.chPreMs = performance.now() - t0; $('chprog').classList.add('hidden');
      $('algomsg').innerHTML = `CH 预处理完成：收缩 ${n} 个路口，加 ${S.ch.nShortcuts} 条捷径，用时 ${(S.chPreMs / 1000).toFixed(1)} s（含界面刷新）。之后每次查询都复用它。`;
      then && then(); return;
    }
    const done = last ? last.rank + 1 : 0;
    $('chprog').querySelector('i').style.width = (done / n * 100).toFixed(1) + '%';
    $('algomsg').textContent = `CH 预处理中（只做一次）：已收缩 ${done} / ${n} 个路口，捷径 ${S.ch.nShortcuts} 条…`;
    setTimeout(chunk, 0);
  };
  setTimeout(chunk, 0);
}
function preprocessCHSync() { if (!S.chReady) { const t0 = performance.now(); S.ch = new CH(S.g).preprocess(); S.chReady = true; S.chPreMs = performance.now() - t0; } }

/* ---------- 面板渲染 ---------- */
function etaLine(r, main) {
  if (S.algo === 'td') return `<div class="rc-eta">${hhmm(S.hour)} 出发 · 预计 <b>${hhmm(S.hour + r.cost / 60)}</b> 到达 · <span class="${tdMultiplier('primary', S.hour) < 0.6 ? 'warn' : ''}">${tdMultiplier('primary', S.hour) < 0.6 ? '路况拥堵' : '路况良好'}</span></div>`;
  return `<div class="rc-eta">现在出发 · 预计 <b>${hhmm(nowHour() + r.cost / 60)}</b> 到达 · 按市区典型车速 · ${main ? '最快' : `比最快多 ${fmtMin(r.cost - S.route.cost)}`}</div>`;
}
const CAR_SVG = '<svg viewBox="0 0 24 24"><path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/></svg>';
function renderRouteCards() {
  const box = $('routes');
  if (S.A < 0 || S.B < 0) { box.innerHTML = `<div class="hint">在地图上<b>右键</b>选择"从此处出发 / 前往此处"，或在上方输入街道名（如 <b>Via Dante</b>、<b>Corso Buenos Aires</b>）。<br><br>路线算出后，右侧卡片可切换算法、回放搜索过程、并排对比，并查看公式；"引导案例"会在关键时刻自动暂停讲解。</div>`; return; }
  if (!S.route) { box.innerHTML = `<div class="calc"><div class="spinner"></div><div>正在用 <b>${ALGOS[S.algo].name}</b> 计算路线…<br><span style="font-size:12px">地图上蓝/红色为已探索的道路；右侧可调速或"直接出结果"。</span></div></div>`; return; }
  const cards = [S.route, ...S.alts].map((r, i) => {
    const main = i === 0, sel = S.selRoute === i;
    return `<div class="route-card ${main ? 'main' : 'alt'} ${sel ? 'sel' : ''}" data-i="${i}" tabindex="0">
      <div class="rc-top"><div class="rc-title">${CAR_SVG}${main ? '最快路线' : '替代路线'}</div><div class="rc-time">${fmtMin(r.cost)}</div></div>
      <div class="rc-sub">${fmtDist(r.lenM)} · 经由 ${r.via.join(' 和 ') || '市区道路'}</div>${etaLine(r, main)}
      ${sel ? `<div class="rc-actions"><button class="btn-primary" data-act="nav"><svg viewBox="0 0 24 24"><path d="M12 2L4.5 20.3l.7.7L12 18l6.8 3 .7-.7z"/></svg>开始</button><button class="btn-text" data-act="steps">${S.showSteps ? '收起详情' : '详情'}</button></div>` : ''}
    </div>`;
  }).join('');
  const r2 = S.route2 ? `<div class="route-card alt dist"><div class="rc-top"><div class="rc-title"><span class="dash"></span>距离最短的路线</div><div class="rc-time">${fmtMin(S.route2.cost)}</div></div><div class="rc-sub">${fmtDist(S.route2.lenM)} · 经由 ${S.route2.via.join(' 和 ')}</div><div class="rc-eta">比最快路线短 ${fmtDist(S.route.lenM - S.route2.lenM)}，却多花 ${fmtMin(S.route2.cost - S.route.cost)}；支路占比 ${(localShare(S.route2.path) * 100).toFixed(0)}%（最快路线 ${(localShare(S.route.path) * 100).toFixed(0)}%）</div></div>` : '';
  const sel = S.selRoute === 0 ? S.route : S.alts[S.selRoute - 1];
  const steps = S.showSteps && sel ? `<div class="steps">${sel.steps.map(s => `<div class="step ${s.end ? 'end' : ''}"><div class="arrow">${s.arrow}</div><div class="name">${s.text}</div><div class="dist">${s.dist ? fmtDist(s.dist) : ''}</div></div>`).join('')}</div>` : '';
  box.innerHTML = cards + r2 + steps;
  box.querySelectorAll('.route-card[data-i]').forEach(c => {
    const act = e => {
      if (e.target.closest('[data-act=nav]')) { startNav(); return; }
      if (e.target.closest('[data-act=steps]')) { S.showSteps = !S.showSteps; renderRouteCards(); return; }
      const i = +c.dataset.i; if (S.selRoute !== i) { S.selRoute = i; renderRouteCards(); requestDraw(); }
    };
    c.onclick = act; c.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { act(e); e.preventDefault(); } };
  });
}
function statRows(L, ref) {
  const ov = L.ov, rows = [];
  if (BIDIR_LIKE(L.algo)) {
    let nf = 0, nb = 0; for (const x of ov.sideNode) { if (x === 1) nf++; else if (x === 2) nb++; }
    rows.push(['正向已确定', nf, 'f'], ['反向已确定', nb, 'b'], ['展开次数（两侧合计）', ov.nS], ['唯一确定路口', ov.nU], ['当前 μ', fmt(ov.mu) + (ov.mu < Infinity ? ' min' : '')]);
    if (L.algo === 'bidir') rows.push(['min Q_f + min Q_b', `${fmt(ov.topF)} + ${fmt(ov.topB)}`]);
    if (L.algo === 'ch') rows.push(['捷径总数', S.ch ? S.ch.nShortcuts : '—'], ['捷径展开步数', ov.unpack]);
  } else rows.push(['展开次数 = 确定路口', ov.nS], ['队列大小', ov.qsize]);
  rows.push(['松弛次数', ov.nR]);
  if (ref) rows.push(['Dijkstra 需展开', ref.nS, 'muted'], ['相对 Dijkstra', ov.nS ? Math.round(ov.nS / ref.nS * 100) + '% 搜索量' : '—']);
  rows.push(['路线耗时', ov.finished ? fmt(ov.cost) + ' min' : '…', ov.finished ? 'ok' : '']);
  return rows;
}
function renderStats() {
  const ref = (S.A >= 0 && S.B >= 0) ? refDijkstra() : null;
  const L0 = S.layers[0], L1 = S.layers[1];
  if (!L1) {
    $('stats').innerHTML = statRows(L0, ref).map(([k, v, c]) => `<div class="stat ${c || ''}"><span>${k}</span><b>${v}</b></div>`).join('');
  } else {
    const a = statRows(L0, ref), b = statRows(L1, ref);
    const keys = [...new Set([...a.map(r => r[0]), ...b.map(r => r[0])])];
    const find = (rows, k) => { const r = rows.find(x => x[0] === k); return r ? r[1] : '—'; };
    $('stats').innerHTML = `<table class="cmp"><thead><tr><th></th><th>${ALGOS[L0.algo].name}</th><th>${ALGOS[L1.algo].name}</th></tr></thead><tbody>` + keys.map(k => `<tr><td>${k}</td><td>${find(a, k)}</td><td>${find(b, k)}</td></tr>`).join('') + '</tbody></table>';
  }
  $('summary').textContent = `${ALGOS[L0.algo].name}：展开 ${L0.ov.nS} 次${L1 ? `（对比 ${ALGOS[L1.algo].name}：${L1.ov.nS} 次）` : ''}${ref ? `，Dijkstra 需 ${ref.nS}` : ''}${L0.ov.finished ? `，路线 ${fmt(L0.ov.cost)} min` : ''}`;
  $('algolog').innerHTML = L0.ov.log.map((l, i) => `<div class="${i === L0.ov.log.length - 1 ? 'new' : ''}">${l}</div>`).join('');
}
function setAlgo(key, opts = {}) {
  S.algo = key; S.layers[0].algo = key;
  document.querySelectorAll('#chips .chip').forEach(c => { c.classList.toggle('on', c.dataset.a === key); c.setAttribute('aria-pressed', c.dataset.a === key); });
  $('hourrow').classList.toggle('hidden', key !== 'td');
  $('departchip').textContent = key === 'td' ? `${hhmm(S.hour)} 出发` : '立即出发';
  if (key === 'td') { for (const L of S.layers) { L.view.layers.traffic = true; L.view.trafficHour = S.hour; L.view.baseView = null; } $('ly-traffic').checked = true; }
  const p = $('principle'); p.innerHTML = `<p>${ALGOS[key].principle}</p><p><a href="${ALGOS[key].link}" target="_blank">完整讲解与公式推导 →</a></p>`;
  if (window.renderMathInElement) renderMathInElement(p, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\(', right: '\\)', display: false }], throwOnError: false });
  $('algomsg').textContent = key === 'ch' && !S.chReady ? '首次使用 CH 需要先预处理整张路网（一次性）。' : ALGOS[key].tip;
  if (!opts.keepCase) endCase();
  if (S.A >= 0 && S.B >= 0) startSearch(false); else { for (const L of S.layers) resetOverlay(L); renderStats(); requestDraw(); }
}
function setCompare(key) {
  const body = document.body;
  if (!key || key === 'none') {
    if (S.layers.length > 1) { S.layers.length = 1; body.classList.remove('compare'); $('map2').classList.add('hidden'); S.layers[0].view.resize(); invalidateBase(); if (S.A >= 0 && S.B >= 0) startSearch(false); else requestDraw(); }
    return;
  }
  if (S.layers.length < 2) {
    body.classList.add('compare'); $('map2').classList.remove('hidden');
    S.layers[0].view.resize();
    const L1 = makeLayer($('map2')); S.layers.push(L1); bindMap(L1);
  }
  S.layers[1].algo = key;
  syncViews(S.layers[0].view); invalidateBase();
  if (S.A >= 0 && S.B >= 0) startSearch(false); else requestDraw();
}

/* ---------- 引导案例 ---------- */
function showCallout(title, html, node, resumable) {
  S.callout = { node: node == null ? -1 : node };
  const c = $('callout');
  c.innerHTML = `<div class="co-title">${title}</div><div class="co-body">${html}</div><div class="co-actions">${resumable ? '<button class="btn-primary" id="co-resume">继续 ▶</button>' : ''}<button class="btn-text" id="co-close">关闭</button></div>`;
  c.classList.remove('hidden');
  if (resumable) $('co-resume').onclick = () => { hideCallout(); if (!S.player.done) S.player.play(); };
  $('co-close').onclick = hideCallout;
  if (window.renderMathInElement) renderMathInElement(c, { delimiters: [{ left: '\\(', right: '\\)', display: false }], throwOnError: false });
  positionCallout(); requestDraw();
}
function positionCallout() {
  const c = $('callout'); if (c.classList.contains('hidden')) return;
  const v = S.layers[0].view, node = S.callout && S.callout.node;
  if (node >= 0) {
    const [sx, sy] = v.toScreen(S.g.nodes[node].x, S.g.nodes[node].y);
    const r = v.cv.getBoundingClientRect();
    let x = r.left + sx + 18, y = r.top + sy - 20;
    x = Math.min(x, window.innerWidth - c.offsetWidth - 12); y = Math.max(12, Math.min(y, window.innerHeight - c.offsetHeight - 12));
    c.style.left = x + 'px'; c.style.top = y + 'px'; c.style.bottom = 'auto'; c.classList.add('anchored');
  } else {
    c.style.left = ''; c.style.top = ''; c.style.bottom = ''; c.classList.remove('anchored');
  }
}
function hideCallout() { S.callout = null; $('callout').classList.add('hidden'); }
function endCase() { if (!S.case) return; S.case = null; S.route2 = null; document.querySelectorAll('#cases button').forEach(b => b.classList.remove('on')); hideCallout(); }
function startCase(id) {
  const c = CASES.find(x => x.id === id); if (!c) return;
  endCase(); stopNav(); setCompare('none'); $('cmpalgo').value = 'none';
  const runtime = { ...c };
  const nA = S.g.nearestNode(...S.g.xyOf(...c.A), 500), nB = S.g.nearestNode(...S.g.xyOf(...c.B), 500);
  if (nA < 0 || nB < 0) return;
  $('speed').value = c.speed; $('speed').dispatchEvent(new Event('input'));
  if (c.id === 'bidir-first-meet') {
    runtime.onEvent = (ev, L) => {
      const ov = L.ov;
      if (ev.type === 'meet' && ov.meets === 1) {
        L.marks = [{ node: ev.u, label: '首次相遇', color: COL.mark }];
        const p = Math.max(logDecimals(ev.dF, ev.dB, ev.mu, ev.mu), logDecimals(ov.topF, ov.topB, ov.topF + ov.topB, ev.mu));
        return { title: '两侧第一次相遇，但还不能停', node: ev.u, html: `正向与反向在 <b>${S.g.describeNode(ev.u)}</b> 相遇，得到一条完整路径：μ = d_f + d_b = ${fmt(ev.dF, p)} + ${fmt(ev.dB, p)} = <b>${fmt(ev.mu, p)} min</b>。<br>但两个队列的队首还只有 min Q_f + min Q_b = ${fmt(ov.topF, p)} + ${fmt(ov.topB, p)} = ${fmt(ov.topF + ov.topB, p)} <b>&lt; μ</b>：经过某个尚未确定的路口，仍可能拼出更短的路。所以只记下 μ，继续搜。` };
      }
      if (ev.type === 'meet' && ov.meets > 1) { addLog(L, `μ 改进：${fmt(ev.mu, 2)}`); }
      if (ev.type === 'stop') {
        const p = logDecimals(ev.topF, ev.topB, ev.topF + ev.topB, ev.mu);
        return { title: '现在可以停了', node: -1, html: `min Q_f + min Q_b = ${fmt(ev.topF, p)} + ${fmt(ev.topB, p)} = ${fmt(ev.topF + ev.topB, p)} <b>≥ μ = ${fmt(ev.mu, p)}</b>。任何还没发现的路径都至少要经过两侧各一个未确定路口，总长不会小于左边，所以不可能比 μ 更短。<br>μ 从首次相遇时的 ${fmt(ov.firstMu, p)} 改进到 ${fmt(ev.mu, p)}，相遇更新了 ${ov.meets} 次。` };
      }
      return null;
    };
    runtime.onDone = L => {
      const ov = L.ov, onPath = ov.path.includes(ov.firstMeet);
      return { title: '对照最终路线', node: ov.firstMeet, html: onPath ? `这次首次相遇点恰好在最终路线上，但算法当时无法知道这一点——终止条件才是依据。` : `首次相遇点 <b>${S.g.describeNode(ov.firstMeet)}</b>（橙圈）<b>不在</b>最终路线上：如果当时就停，会给出一条长 ${(ov.firstMu / ov.cost * 100 - 100).toFixed(0)}% 的次优路线。` };
    };
  } else if (c.id === 'shortest-vs-fastest') {
    runtime.onDone = L => {
      S.route2 = shortestDistanceRoute(); renderRouteCards(); requestDraw();
      if (!S.route2) return null;
      const a = S.route, b = S.route2;
      return { title: '距离更短，为什么耗时更长？', node: -1, html: `蓝色是<b>耗时最短</b>：${fmtDist(a.lenM)}，${fmt(a.cost)} 分钟，支路占 ${(localShare(a.path) * 100).toFixed(0)}%。<br>绿色虚线是<b>距离最短</b>：${fmtDist(b.lenM)}，${fmt(b.cost)} 分钟，支路占 ${(localShare(b.path) * 100).toFixed(0)}%。<br>短的那条更多走 22 km/h 的支路，长的那条走 32～38 km/h 的主干道。边权是 \\(w=\\ell/v\\)，同一个 Dijkstra，换一个权重就换一个答案——导航优化的是时间。` };
    };
  } else if (c.id === 'ch-amortize') {
    runtime.beforeStart = () => {
      const g = S.g, rnd = mulberry32(2026), Q = [];
      while (Q.length < 30) { const a = Math.floor(rnd() * g.nodes.length), b = Math.floor(rnd() * g.nodes.length); if (a !== b) Q.push([a, b]); }
      let tD = 0, nD = 0, tC = 0, nC = 0;
      for (const [a, b] of Q) { let t0 = performance.now(); const r1 = runGen(dijkstraGen(g, a, b)); tD += performance.now() - t0; nD += r1.nS; t0 = performance.now(); const r2 = runGen(S.ch.queryGen(a, b)); tC += performance.now() - t0; nC += r2.nS; }
      const msD = tD / Q.length, msC = tC / Q.length, be = msD > msC ? Math.ceil(S.chPreMs / (msD - msC)) : Infinity;
      showCallout('预处理一次，查询无数次', `预处理：收缩 ${g.nodes.length} 个路口、加 ${S.ch.nShortcuts} 条捷径，用时 <b>${(S.chPreMs / 1000).toFixed(2)} s</b>（只做一次，起终点无关）。<br>30 组随机起终点实测（本机）：Dijkstra 平均展开 ${(nD / Q.length).toFixed(0)} 个路口、${msD.toFixed(2)} ms；CH 平均展开 ${(nC / Q.length).toFixed(0)} 个、${msC.toFixed(2)} ms。<br>每次查询省 ${(msD - msC).toFixed(2)} ms，查 <b>${be === Infinity ? '—' : be}</b> 次就把预处理赚回来；导航服务每秒要答成千上万次查询。代价：边权一变（实时路况）捷径就要重算。下面回放这一次 CH 查询。`, -1, true);
    };
  } else if (c.id === 'trace-path') {
    runtime.onDone = L => ({ title: '沿 prev 指针回溯', node: -1, html: `搜索结束时每个路口只记录了 prev（它由哪个路口松弛而来）。从终点出发，prev → prev → … 直到起点，这条链就是最优路径，共 ${L.ov.path.length} 个路口、${fmt(L.ov.cost)} 分钟。蓝色正在从终点往起点逐段"点亮"的就是这一步；灰色路线是用惩罚法另算的替代路线。` });
  }
  S.case = runtime;
  document.querySelectorAll('#cases button').forEach(b => b.classList.toggle('on', b.dataset.c === id));
  S.A = nA; S.B = nB; $('inA').value = S.g.describeNode(nA); $('inB').value = S.g.describeNode(nB);
  showCallout(c.title, c.intro, -1, false);
  setAlgo(c.algo, { keepCase: true });
  if (S.A >= 0 && S.B >= 0 && !needsCH()) { const r = refDijkstra(); if (r.path.length) fitRouteToVisible(routePolyline(r.path)); }
}

/* ---------- 指标对比表 ---------- */
function metricsTable() {
  const g = S.g, box = $('metrics');
  box.innerHTML = '<div class="muted small">正在测量（含 CH / ALT 预处理）…</div>';
  setTimeout(() => {
    const rnd = mulberry32(99), Q = [];
    if (S.A >= 0 && S.B >= 0) Q.push([S.A, S.B]);
    while (Q.length < 31) { const a = Math.floor(rnd() * g.nodes.length), b = Math.floor(rnd() * g.nodes.length); if (a !== b) Q.push([a, b]); }
    const run = fn => { const t0 = performance.now(); let nS = 0, nU = 0; for (const [a, b] of Q) { const r = runGen(fn(a, b)); nS += r.nS; nU += r.nU != null ? r.nU : r.nS; } return { ms: (performance.now() - t0) / Q.length, nS: nS / Q.length, nU: nU / Q.length }; };
    const dj = run((a, b) => dijkstraGen(g, a, b));
    const as = run((a, b) => dijkstraGen(g, a, b, { h: cityHeuristic(g, b) }));
    const bi = run((a, b) => bidirGen(g, a, b));
    ensureLandmarks(); const al = run((a, b) => dijkstraGen(g, a, b, { h: altHeuristic(S.lm, b) }));
    preprocessCHSync(); const ch = run((a, b) => S.ch.queryGen(a, b));
    const td = run((a, b) => tdDijkstraGen(g, a, b, S.hour));
    const be = (pre, ms) => dj.ms > ms ? Math.ceil(pre / (dj.ms - ms)) + ' 次' : '永不';
    const rows = [
      ['Dijkstra', dj, '—', '—', '—'], ['A*', as, '—', '—', '—'], ['双向', bi, '—', '—', '—'],
      ['ALT（8 地标）', al, `${S.lmMs.toFixed(0)} ms`, `${8 * g.nodes.length} 个距离 ≈ ${(8 * g.nodes.length * 8 / 1024).toFixed(0)} KB`, be(S.lmMs, al.ms)],
      ['CH', ch, `${(S.chPreMs / 1000).toFixed(2)} s`, `${S.ch.nShortcuts} 条捷径 ≈ ${(S.ch.nShortcuts * 24 / 1024).toFixed(0)} KB`, be(S.chPreMs, ch.ms)],
      ['时变', td, '—', '—', '—'],
    ];
    box.innerHTML = `<table class="cmp"><thead><tr><th>算法</th><th>展开次数</th><th>唯一路口</th><th>每次 ms</th><th>预处理</th><th>额外存储</th><th>回本</th></tr></thead><tbody>` +
      rows.map(r => `<tr><td>${r[0]}</td><td>${r[1].nS.toFixed(0)}</td><td>${r[1].nU.toFixed(0)}</td><td>${r[1].ms.toFixed(2)}</td><td>${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td></tr>`).join('') +
      `</tbody></table><div class="muted small">当前起终点 + 30 组随机起终点的平均值；展开次数 = 从队列弹出并确定的次数（双向/CH 同一路口两侧可各计一次），唯一路口 = 被确定过的不同路口数。"回本" = 预处理时间 ÷ 每次查询省下的时间。毫秒级计时在浏览器里噪声不小，看数量级即可。</div>`;
  }, 30);
}

/* ---------- 模拟导航 ---------- */
function startNav() {
  const r = S.selRoute === 0 ? S.route : S.alts[S.selRoute - 1]; if (!r) return;
  hideCallout();
  const pts = r.pts, cum = [0]; let tot = 0;
  for (let i = 2; i < pts.length; i += 2) { tot += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]); cum.push(tot); }
  S.nav = { r, pts, cum, tot, t0: performance.now(), dur: Math.max(8000, Math.min(30000, r.cost * 600)), follow: true, startHour: S.algo === 'td' ? S.hour : nowHour() };
  $('navbar').classList.remove('hidden');
  const tick = () => { if (!S.nav) return; requestDraw(); S.nav.raf = requestAnimationFrame(tick); };
  tick();
}
function stopNav() { if (S.nav) { cancelAnimationFrame(S.nav.raf); S.nav = null; $('navbar').classList.add('hidden'); requestDraw(); } }
function drawNav(ctx, v) {
  const nv = S.nav, p = Math.min(1, (performance.now() - nv.t0) / nv.dur), dist = p * nv.tot;
  let i = 1; while (i < nv.cum.length && nv.cum[i] < dist) i++;
  const a = Math.min(i - 1, nv.cum.length - 2), seg = nv.cum[a + 1] - nv.cum[a] || 1, t = (dist - nv.cum[a]) / seg;
  const x = nv.pts[2 * a] + (nv.pts[2 * a + 2] - nv.pts[2 * a]) * t, y = nv.pts[2 * a + 1] + (nv.pts[2 * a + 3] - nv.pts[2 * a + 1]) * t;
  const ang = Math.atan2(nv.pts[2 * a + 3] - nv.pts[2 * a + 1], nv.pts[2 * a + 2] - nv.pts[2 * a]);
  if (nv.follow) { v.cx = x; v.cy = y; syncViews(v); }
  const [sx, sy] = v.toScreen(x, y);
  ctx.save(); ctx.translate(sx, sy);
  ctx.fillStyle = 'rgba(66,133,244,0.25)'; ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2); ctx.fill();
  ctx.rotate(ang + Math.PI / 2);
  ctx.fillStyle = '#1a73e8'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(10, 11); ctx.lineTo(0, 6); ctx.lineTo(-10, 11); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
  const remainM = nv.tot * (1 - p), remainMin = nv.r.cost * (1 - p);
  let acc = 0, next = nv.r.steps[nv.r.steps.length - 1];
  for (let k = 0; k < nv.r.steps.length; k++) { acc += nv.r.steps[k].dist; if (acc > dist) { next = nv.r.steps[k + 1] || next; break; } }
  $('navbar').innerHTML = `<div class="turn">${next.arrow}</div><div><div class="big">${p >= 1 ? '已到达目的地' : next.text}</div><div class="small">剩余 ${fmtMin(remainMin)} · ${fmtDist(remainM)} · 预计 ${hhmm(nv.startHour + nv.r.cost / 60)} 到达</div></div><button id="navexit">退出</button>`;
  $('navexit').onclick = stopNav;
  if (p >= 1) { cancelAnimationFrame(nv.raf); nv.raf = null; }
}

/* ---------- 地图交互 ---------- */
function showCtx(sx, sy, wx, wy) {
  const node = S.g.nearestNode(wx, wy, 400); S.ctxNode = node;
  const [lat, lon] = S.g.latLon(wx, wy);
  const m = $('ctxmenu');
  m.innerHTML = `<div class="coord"><b>${node >= 0 ? S.g.describeNode(node) : '附近没有可行驶道路'}</b>${lat.toFixed(5)}, ${lon.toFixed(5)}</div><div class="item" role="menuitem" tabindex="0" data-a="A">从此处出发</div><div class="item" role="menuitem" tabindex="0" data-a="B">前往此处</div><div class="item" role="menuitem" tabindex="0" data-a="C">以此为中心</div>`;
  m.style.left = Math.min(sx, window.innerWidth - 210) + 'px'; m.style.top = Math.min(sy, window.innerHeight - 150) + 'px';
  m.classList.remove('hidden');
  m.querySelectorAll('.item').forEach(it => { const go = () => { const a = it.dataset.a; if (a === 'C') { for (const L of S.layers) { L.view.cx = wx; L.view.cy = wy; } hideCtx(); invalidateBase(); } else if (node >= 0) setPoint(a, node); }; it.onclick = go; it.onkeydown = e => { if (e.key === 'Enter') go(); }; });
}
function hideCtx() { $('ctxmenu').classList.add('hidden'); }
function bindMap(L) {
  const v = L.view, cv = v.cv;
  const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener('mousedown', e => { if (e.button !== 0) return; const [x, y] = pos(e); S.drag = { L, x, y, moved: false }; hideCtx(); });
  cv.addEventListener('mousemove', e => { if (S.drag) return; const [x, y] = pos(e); hover(L, x, y, e); });
  cv.addEventListener('wheel', e => { e.preventDefault(); const [x, y] = pos(e); v.zoomAt(x, y, Math.pow(2, -e.deltaY / 400)); syncViews(v); if (S.nav) S.nav.follow = false; requestDraw(); }, { passive: false });
  cv.addEventListener('dblclick', e => { const [x, y] = pos(e); v.zoomAt(x, y, 2); syncViews(v); requestDraw(); });
  cv.addEventListener('contextmenu', e => { e.preventDefault(); const [x, y] = pos(e); const [wx, wy] = v.toWorld(x, y); showCtx(e.clientX, e.clientY, wx, wy); });
  cv.addEventListener('mouseleave', hideTip);
  /* 触屏：单指平移、双指缩放、长按弹出菜单 */
  let touch = null, pressTimer = null;
  const tpos = t => { const r = cv.getBoundingClientRect(); return [t.clientX - r.left, t.clientY - r.top]; };
  cv.addEventListener('touchstart', e => {
    hideCtx(); clearTimeout(pressTimer);
    if (e.touches.length === 1) {
      const t = e.touches[0]; touch = { mode: 'pan', x: t.clientX, y: t.clientY, moved: false };
      pressTimer = setTimeout(() => { if (touch && !touch.moved) { const [x, y] = tpos(t); const [wx, wy] = v.toWorld(x, y); showCtx(t.clientX, t.clientY, wx, wy); touch = null; } }, 600);
    } else if (e.touches.length === 2) {
      const [a, b] = e.touches; touch = { mode: 'pinch', d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 };
    }
  }, { passive: true });
  cv.addEventListener('touchmove', e => {
    if (!touch) return; e.preventDefault();
    if (touch.mode === 'pan' && e.touches.length === 1) {
      const t = e.touches[0]; const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) { touch.moved = true; clearTimeout(pressTimer); }
      v.pan(dx, dy); touch.x = t.clientX; touch.y = t.clientY;
    } else if (touch.mode === 'pinch' && e.touches.length === 2) {
      const [a, b] = e.touches; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2, r = cv.getBoundingClientRect();
      v.zoomAt(cx - r.left, cy - r.top, d / touch.d); v.pan(cx - touch.cx, cy - touch.cy);
      touch.d = d; touch.cx = cx; touch.cy = cy;
    }
    syncViews(v); if (S.nav) S.nav.follow = false; requestDraw();
  }, { passive: false });
  cv.addEventListener('touchend', e => { clearTimeout(pressTimer); if (e.touches.length === 0) touch = null; else if (e.touches.length === 1) { const t = e.touches[0]; touch = { mode: 'pan', x: t.clientX, y: t.clientY, moved: true }; } });
}
function bindGlobalMouse() {
  window.addEventListener('mousemove', e => {
    if (!S.drag) return;
    const v = S.drag.L.view, r = v.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const dx = x - S.drag.x, dy = y - S.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) { S.drag.moved = true; v.cv.classList.add('dragging'); if (S.nav) S.nav.follow = false; }
    v.pan(dx, dy); syncViews(v); S.drag.x = x; S.drag.y = y; requestDraw(); hideTip();
  });
  window.addEventListener('mouseup', () => { if (S.drag) S.drag.L.view.cv.classList.remove('dragging'); S.drag = null; });
}
function hover(L, x, y, e) {
  const v = L.view, ov = L.ov;
  if (!ov.active) { hideTip(); return; }
  const [wx, wy] = v.toWorld(x, y);
  const id = S.g.nearestNode(wx, wy, 14 / v.scale);
  if (id < 0) { hideTip(); return; }
  const d0 = ov.dist[0][id], d1 = ov.dist[1][id];
  if (d0 === Infinity && d1 === Infinity) { hideTip(); return; }
  let html = `<b>${S.g.describeNode(id)}</b><br>`;
  if (BIDIR_LIKE(L.algo)) html += `d_f = ${fmt(d0, 2)} min · d_b = ${fmt(d1, 2)} min`;
  else { html += `d(v) = ${fmt(d0, 2)} min`; if (L.h) { const h = L.h(id); html += `<br>h(v) = ${fmt(h, 2)} min · f = ${fmt(d0 + h, 2)}`; } }
  if (L.algo === 'ch' && S.ch) html += `<br><span class="muted">rank ${S.ch.rank[id]}</span>`;
  html += `<br><span class="muted">${ov.sideNode[id] ? '已确定' : '已触达（在队列中）'}</span>`;
  const tip = $('tip'); tip.innerHTML = html; tip.classList.remove('hidden');
  tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 270) + 'px'; tip.style.top = (e.clientY + 14) + 'px';
}
function hideTip() { $('tip').classList.add('hidden'); }

/* ---------- 装配 ---------- */
function bindUI() {
  bindSearch('inA', 'sgA', 'A'); bindSearch('inB', 'sgB', 'B');
  $('swap').onclick = swapPoints;
  document.querySelectorAll('#chips .chip').forEach(c => c.onclick = () => setAlgo(c.dataset.a));
  document.querySelectorAll('#cases button').forEach(b => b.onclick = () => startCase(b.dataset.c));
  $('cmpalgo').onchange = e => { endCase(); setCompare(e.target.value); };
  const sp = $('speed'), spv = $('speedv');
  const updSpeed = () => { S.player.speed = Math.round(20 * Math.pow(1.07, +sp.value)); spv.textContent = S.player.speed + ' 步/秒'; };
  sp.oninput = updSpeed; updSpeed();
  $('b-play').onclick = () => { if (S.A < 0 || S.B < 0) return; hideCallout(); if (S.player.done) startSearch(false); else S.player.play(); };
  $('b-pause').onclick = () => S.player.pause();
  $('b-step').onclick = () => { if (S.A < 0 || S.B < 0) return; S.player.pause(); hideCallout(); S.player.step(); renderStats(); requestDraw(); };
  $('b-end').onclick = () => { if (S.A < 0 || S.B < 0 || S.player.done) return; hideCallout(); S.skipping = true; try { S.player.runToEnd(); } finally { S.skipping = false; } renderStats(); requestDraw(); };
  $('b-reset').onclick = () => { if (S.A < 0 || S.B < 0) return; startSearch(false); };
  $('b-table').onclick = () => { $('metrics-box').open = true; metricsTable(); };
  const hr = $('hour'), hrv = $('hourv');
  hr.oninput = () => { S.hour = +hr.value; hrv.textContent = hhmm(S.hour); $('departchip').textContent = `${hhmm(S.hour)} 出发`; for (const L of S.layers) L.view.trafficHour = S.hour; invalidateBase(); };
  hr.onchange = () => { if (S.algo === 'td' && S.A >= 0 && S.B >= 0) startSearch(false); };
  hrv.textContent = hhmm(S.hour);
  $('ly-traffic').onchange = e => { for (const L of S.layers) L.view.layers.traffic = e.target.checked; invalidateBase(); };
  $('ly-buildings').onchange = e => { for (const L of S.layers) L.view.layers.buildings = e.target.checked; invalidateBase(); };
  $('ly-labels').onchange = e => { for (const L of S.layers) { L.view.layers.labels = e.target.checked; L.view.layers.pois = e.target.checked; } invalidateBase(); };
  $('ly-autofit').onchange = e => { S.autoFit = e.target.checked; };
  /* 面板折叠 / 信息密度 */
  $('panel-toggle').onclick = () => { document.body.classList.toggle('panel-collapsed'); afterLayout(); };
  $('algo-collapse').onclick = () => { $('algo').classList.toggle('collapsed'); $('algo-collapse').textContent = $('algo').classList.contains('collapsed') ? '＋' : '－'; };
  $('algo-density').onclick = () => { S.lite = !S.lite; document.body.classList.toggle('lite', S.lite); $('algo-density').textContent = S.lite ? '详细推导' : '简洁观察'; };
  $('home').onclick = () => { const v = S.layers[0].view; v.fit(S.g.bounds, 20); syncViews(v); if (S.nav) S.nav.follow = false; invalidateBase(); };
  $('zin').onclick = () => { const v = S.layers[0].view; v.zoomAt(v.w / 2, v.h / 2, 1.6); syncViews(v); requestDraw(); };
  $('zout').onclick = () => { const v = S.layers[0].view; v.zoomAt(v.w / 2, v.h / 2, 1 / 1.6); syncViews(v); requestDraw(); };
  $('fitroute').onclick = () => { if (S.route) fitRouteToVisible(S.route.pts); };
  /* 键盘：空格 播放/暂停，. 单步，Esc 关闭菜单与解说 */
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (e.key === 'Escape') { hideCtx(); hideCallout(); return; }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === ' ') { e.preventDefault(); if (S.player.playing) S.player.pause(); else $('b-play').click(); }
    else if (e.key === '.') { $('b-step').click(); }
  });
}
function afterLayout() { for (const L of S.layers) L.view.resize(); invalidateBase(); }

/* ---------- 自检（?selftest=1，供 test/browser.js 用无头浏览器跑） ---------- */
function runSelfTest() {
  const out = [], ok = (c, m) => out.push({ ok: !!c, m });
  try {
    const duomo = S.g.nearestNode(...S.g.xyOf(45.4642, 9.1900), 400), centrale = S.g.nearestNode(...S.g.xyOf(45.4862, 9.2040), 500);
    const costs = {};
    S.skipping = true;
    for (const a of ['dijkstra', 'astar', 'bidir', 'alt', 'td']) { setAlgo(a); S.player.runToEnd(); ok(S.layers[0].ov.finished && S.route, `${a} 完成`); costs[a] = S.route ? S.route.cost : NaN; }
    preprocessCHSync(); setAlgo('ch'); S.player.runToEnd(); ok(S.layers[0].ov.finished && S.route, 'ch 完成'); costs.ch = S.route.cost;
    for (const a of ['astar', 'bidir', 'alt', 'ch']) ok(Math.abs(costs[a] - costs.dijkstra) < 1e-6, `${a} 耗时与 Dijkstra 一致 (${costs[a]} vs ${costs.dijkstra})`);
    ok(costs.td > costs.dijkstra - 1e-9, '时变耗时不小于畅通耗时');
    setAlgo('dijkstra'); startSearch(false); ok(S.layers[0].ov.nS === 0 && !S.route, '重置后叠加层清空');
    S.player.runToEnd(); ok(S.route && S.alts.length >= 1, '重置后再次完成，且有替代路线');
    const via = S.g.nodeForStreet('Corso Buenos Aires'); setPoint('B', via, 'Corso Buenos Aires'); S.player.runToEnd();
    ok(S.B === via && $('inB').value === 'Corso Buenos Aires' && S.route, '街道名设终点并重算');
    setPoint('B', centrale, 'Stazione Centrale');
    $('cmpalgo').value = 'astar'; setCompare('astar'); S.player.runToEnd();
    ok(S.layers.length === 2 && S.layers[1].ov.finished && Math.abs(S.layers[1].ov.cost - S.layers[0].ov.cost) < 1e-6, '并排对比两侧完成且耗时一致');
    setCompare('none'); $('cmpalgo').value = 'none'; ok(S.layers.length === 1, '退出对比');
    for (const c of CASES) { startCase(c.id); S.player.runToEnd(); ok(S.layers[0].ov.finished && S.route, `案例 ${c.id} 完成`); }
    endCase(); setPoint('A', duomo, 'Piazza del Duomo'); setPoint('B', centrale, 'Stazione Centrale'); S.player.runToEnd();
    S.skipping = false;
  } catch (e) { ok(false, '异常：' + (e && e.stack || e)); }
  const pass = out.every(x => x.ok);
  document.title = pass ? 'SELFTEST OK' : 'SELFTEST FAIL';
  const pre = document.createElement('pre'); pre.id = 'selftest'; pre.textContent = JSON.stringify({ pass, results: out, perf: S.perf }, null, 1); pre.style.display = 'none'; document.body.appendChild(pre);
  console.log('[selftest]', pass ? 'OK' : 'FAIL', out.filter(x => !x.ok));
}

document.addEventListener('DOMContentLoaded', () => {
  const D = window.CITY_DATA, q = new URLSearchParams(location.search);
  if (q.get('selftest')) S.noDraw = true;     // 自检只验证逻辑与 DOM，不画图（无头浏览器里省掉几千次重绘）
  const t0 = performance.now();
  S.g = buildCityGraph(D);
  S.perf.graphMs = +(performance.now() - t0).toFixed(1);
  const dataRes = performance.getEntriesByType('resource').find(r => /milan\.js/.test(r.name));
  S.perf.dataLoadMs = dataRes ? +dataRes.duration.toFixed(0) : null;
  S.layers = [makeLayer($('map'))];
  bindMap(S.layers[0]); bindGlobalMouse();
  S.player = new Player({ makeGen, onEvent: x => handleEvent(S.layers[x.layer], x.ev), onFrame: () => { renderStats(); requestDraw(); }, onFinish: () => { renderStats(); finishSearch(); } });
  bindUI();
  $('cityname').textContent = D.name;
  $('loading').classList.add('hidden');
  const duomo = S.g.nearestNode(...S.g.xyOf(45.4642, 9.1900), 400), centrale = S.g.nearestNode(...S.g.xyOf(45.4862, 9.2040), 500);
  const v = S.layers[0].view;
  v.fit(S.g.bounds, 20);
  v.zoomAt(v.w / 2, v.h / 2, +(q.get('zoom') || 1.35));
  const t1 = performance.now(); v.renderBase(); S.perf.firstBaseMs = +(performance.now() - t1).toFixed(1);
  if (q.get('hour')) { S.hour = +q.get('hour'); $('hour').value = S.hour; $('hourv').textContent = hhmm(S.hour); }
  if (q.get('zoom')) S.autoFit = false, $('ly-autofit').checked = false;
  setAlgo(ALGOS[q.get('algo')] ? q.get('algo') : 'dijkstra');
  if (duomo >= 0) setPoint('A', duomo, 'Piazza del Duomo');
  if (centrale >= 0) setPoint('B', centrale, 'Stazione Centrale');
  if (q.get('instant') && S.algo !== 'ch') { S.skipping = true; const t2 = performance.now(); S.player.runToEnd(); S.perf.queryMs = +(performance.now() - t2).toFixed(1); S.skipping = false; renderStats(); }
  if (q.get('case')) startCase(q.get('case'));
  if (q.get('perf')) console.table(S.perf);
  requestDraw();
  if (q.get('selftest')) runSelfTest();
});
