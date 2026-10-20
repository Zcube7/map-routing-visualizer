'use strict';
/* =====================================================================
 *  mapapp.js —— 类 Google 地图界面：路线面板、右键菜单、算法叠加动画
 * ===================================================================== */
const S = {
  g: null, view: null, A: -1, B: -1, algo: 'dijkstra', hour: 8.5,
  route: null, alts: [], selRoute: 0, player: null, ov: null, ovCanvas: null, ovView: null, pending: [],
  ch: null, chReady: false, chBusy: false, lm: null, refKey: '', refDj: null,
  nav: null, drag: null, baseTimer: null, drawReq: false, hover: -1, ctxNode: -1, follow: true, showSteps: false,
};
const $ = id => document.getElementById(id);
const fmt = (x, d = 1) => (x === Infinity || x == null || Number.isNaN(x)) ? '∞' : Number(x).toFixed(d);
const hhmm = h => { h = ((h % 24) + 24) % 24; const H = Math.floor(h), M = Math.round((h - H) * 60) % 60; return `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`; };
const nowHour = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
const fmtDist = m => m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${Math.round(m)} 米`;
const fmtMin = m => m >= 60 ? `${Math.floor(m / 60)} 小时 ${Math.round(m % 60)} 分钟` : `${Math.max(1, Math.round(m))} 分钟`;
const SIDE_NAME = ['正向', '反向'];
const COL = { f: '#1a73e8', b: '#d93025', cur: '#fbbc04', route: '#4285f4', routeCase: '#1b5fc9', alt: '#a9b4c2', altCase: '#6f7a8a', sc: '#a142f4', lm: '#7c3aed', relax: '#f29900' };

const ALGOS = {
  dijkstra: { name: 'Dijkstra', tip: '均匀泛洪，不看终点', link: 'index.html#dijkstra',
    principle: `每次取出暂定距离最小的路口并"确定"它，再松弛它的邻居：$$d(v)\\leftarrow\\min\\big(d(v),\\,d(u)+w(u,v)\\big)$$ 边权 \\(w=\\ell/v\\) 是路段耗时（分钟）。搜索区域是以起点为中心的"耗时等值圈"，完全不知道终点在哪，所以会往反方向白白探索。复杂度 \\(O((|V|+|E|)\\log|V|)\\)。` },
  astar: { name: 'A*', tip: '直线距离 ÷ 限速 作下界', link: 'index.html#astar',
    principle: `按 \\(f=g+h\\) 排序，\\(g\\) 是已走耗时，\\(h\\) 是"至少还要多久"：$$h(v)=\\frac{\\|p_v-p_t\\|_2}{v_{\\max}}\\le\\operatorname{dist}(v,t)$$ 任何真实路径都不比直线短、不比最高限速快，所以 \\(h\\) 永远不高估（可采纳），结果仍是最优。搜索区域被"吸"向终点，变成椭圆。` },
  bidir: { name: '双向 Dijkstra', tip: '两头同时搜', link: 'index.html#bidir',
    principle: `正向从起点、反向从终点各跑一个 Dijkstra，碰到被两侧都触达的路口就得到一条完整路径，记录最好值 \\(\\mu\\)。终止条件：$$\\min_{Q_f} d_f+\\min_{Q_b} d_b\\ \\ge\\ \\mu$$ 两个半径减半的圆面积只有原来的一半，所以探索量大约减半。注意"第一次相遇"不等于可以停。` },
  alt: { name: 'ALT 地标', tip: '预存到地标的真实距离', link: 'index.html#alt',
    principle: `预处理：选 8 个地标 \\(L\\)（紫色菱形），对每个地标跑一遍全图 Dijkstra 存下 \\(\\operatorname{dist}(L,v)\\)。查询时用三角不等式得到下界：$$h(v)=\\max_L\\big|\\operatorname{dist}(L,t)-\\operatorname{dist}(L,v)\\big|$$ 它来自真实路网，比"直线÷限速"紧得多，所以 A* 探索得更少。` },
  ch: { name: 'CH 收缩层次', tip: '预处理捷径，查询只向上', link: 'index.html#ch',
    principle: `预处理：按"不重要→重要"的顺序逐个收缩路口，若收缩破坏了两个邻居间的最短距离就补一条捷径：$$\\operatorname{dist}_{G\\setminus\\{v\\}}(u,w)>w(u,v)+w(v,w)\\ \\Rightarrow\\ \\text{加捷径}(u,w)$$ 查询：双向搜索，只允许走向"更重要"的路口 \\(\\pi(u)<\\pi(v)\\)，在高处相遇后把捷径（紫色虚线）展开。这是 OSRM、GraphHopper 的默认算法，大陆级路网查询不到 1 毫秒。` },
  td: { name: '时变路况', tip: '边权随出发时刻变化', link: 'index.html#traffic',
    principle: `每条路段的耗时是进入时刻的函数 \\(w_e(\\tau)=\\ell_e/v_e(\\tau)\\)，标签改为"到达时刻"：$$a(v)\\leftarrow\\min\\big(a(v),\\,a(u)+w_{uv}(a(u))\\big)$$ 只要满足 FIFO（先出发不会后到），Dijkstra 原样可用。拖动出发时刻看早晚高峰如何让路线避开主干道；路况图层按该时刻的车速着色。` },
};

/* ---------- 工具 ---------- */
function requestDraw() { if (S.drawReq) return; S.drawReq = true; requestAnimationFrame(() => { S.drawReq = false; draw(); }); }
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
    if (shared / lenM < 0.75 && cost <= main.cost * 1.4 && !out.some(o => o.path.length === r.path.length && o.cost === cost)) {
      out.push({ path: r.path, cost, lenM, via: viaNames(r.path), pts: routePolyline(r.path) });
    }
    mark(r.path);
  }
  return out;
}

/* ---------- 叠加层状态 ---------- */
function resetOverlay() {
  const g = S.g;
  S.ov = { sideEdge: new Uint8Array(g.edges.length), sideNode: new Uint8Array(g.nodes.length), dist: [new Float64Array(g.nodes.length).fill(Infinity), new Float64Array(g.nodes.length).fill(Infinity)],
    current: -1, hlEdge: null, sc: [], path: null, cost: Infinity, nS: 0, nR: 0, qsize: 0, mu: Infinity, topF: Infinity, topB: Infinity, finished: false, log: [], unpack: 0, h: null, eps: 1, active: false };
  S.pending = []; S.ovView = null;
  if (S.ovCanvas) S.ovCanvas.getContext('2d').clearRect(0, 0, S.ovCanvas.width, S.ovCanvas.height);
}
function addLog(s) { const l = S.ov.log; l.push(s); if (l.length > 6) l.shift(); }
function handleEvent(ev) {
  const ov = S.ov; ov.current = -1; ov.hlEdge = null; ov.active = true;
  switch (ev.type) {
    case 'init': addLog(`初始化：起点 d=0，其余 ∞。`); break;
    case 'settle':
      ov.sideNode[ev.u] = ev.side + 1; ov.current = ev.u; ov.dist[ev.side][ev.u] = ev.d; ov.nS = ev.nS; ov.nR = ev.nR; ov.qsize = ev.qsize;
      if (ev.mu != null) { ov.mu = ev.mu; ov.topF = ev.topF; ov.topB = ev.topB; }
      addLog(`${ev.side != null && S.algo !== 'dijkstra' && S.algo !== 'astar' && S.algo !== 'alt' && S.algo !== 'td' ? SIDE_NAME[ev.side] : ''}确定 ${S.g.describeNode(ev.u)}：d=${fmt(ev.d)} min${ev.rank != null ? `，rank ${ev.rank}` : ''}`);
      break;
    case 'relax': {
      ov.current = ev.u; ov.nR = ev.nR;
      if (ev.improved) {
        ov.dist[ev.side][ev.v] = ev.nd;
        if (ev.isShortcut) { ov.sc.push([ev.u, ev.v, ev.side]); S.pending.push({ sc: [ev.u, ev.v], side: ev.side }); }
        else { const e = edgeOf(ev.u, ev.v); if (e && !ov.sideEdge[e.eid]) { ov.sideEdge[e.eid] = ev.side + 1; S.pending.push({ eid: e.eid, side: ev.side }); } }
      }
      ov.hlEdge = { u: ev.u, v: ev.v, improved: ev.improved };
      addLog(`松弛 → ${S.g.describeNode(ev.v)}：${fmt(ev.du)}+${fmt(ev.w)}=${fmt(ev.nd)} ${ev.improved ? '< ' + fmt(ev.old) + ' 更新' : '≥ ' + fmt(ev.old) + ' 不更新'}${ov.h && ev.improved ? `，f=${fmt(ev.key)}` : ''}`);
      break;
    }
    case 'meet': ov.mu = ev.mu; addLog(`两侧在 ${S.g.describeNode(ev.u)} 相遇：μ = ${fmt(ev.dF)} + ${fmt(ev.dB)} = ${fmt(ev.mu)}`); break;
    case 'stop': ov.topF = ev.topF; ov.topB = ev.topB; addLog(`终止：${fmt(ev.topF)} + ${fmt(ev.topB)} ≥ μ=${fmt(ev.mu)}`); break;
    case 'stopside': addLog(`${SIDE_NAME[ev.side]}停止（队首 ${fmt(ev.top)} ≥ μ=${fmt(ev.mu)}）`); break;
    case 'chpath': ov.path = ev.path; ov.cost = ev.cost; addLog(`层次图路径 ${ev.path.length} 个节点（含捷径），开始展开…`); break;
    case 'unpack': ov.path = ev.path; ov.unpack++; addLog(`展开捷径 → 经 ${S.g.describeNode(ev.mid)}`); break;
    case 'done': ov.path = ev.path; ov.cost = ev.cost; ov.nS = ev.nS; ov.nR = ev.nR; ov.finished = true; addLog(`完成：${fmt(ev.cost)} min，确定 ${ev.nS} 个路口，松弛 ${ev.nR} 次。`); break;
  }
}

/* ---------- 绘制 ---------- */
function ensureOvCanvas() {
  const v = S.view;
  if (!S.ovCanvas) S.ovCanvas = document.createElement('canvas');
  if (S.ovCanvas.width !== v.cv.width || S.ovCanvas.height !== v.cv.height) { S.ovCanvas.width = v.cv.width; S.ovCanvas.height = v.cv.height; S.ovView = null; }
}
function strokeEdge(ctx, item) {
  const g = S.g, v = S.view;
  if (item.sc) { const a = g.nodes[item.sc[0]], b = g.nodes[item.sc[1]]; ctx.strokeStyle = COL.sc; ctx.setLineDash([v.px(6), v.px(4)]); ctx.lineWidth = v.px(2); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]); return; }
  ctx.strokeStyle = item.side ? COL.b : COL.f; ctx.lineWidth = v.px(Math.max(2.4, Math.min(7, 5 * v.scale)));
  ctx.beginPath(); polyPath(ctx, g.edges[item.eid].pts); ctx.stroke();
}
function renderOverlayFull() {
  const v = S.view, ctx = S.ovCanvas.getContext('2d'), ov = S.ov;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, S.ovCanvas.width, S.ovCanvas.height);
  v.setWorldTransform(ctx); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = 0.75;
  const g = S.g;
  for (let side = 1; side <= 2; side++) {
    ctx.strokeStyle = side === 2 ? COL.b : COL.f; ctx.lineWidth = v.px(Math.max(2.4, Math.min(7, 5 * v.scale)));
    ctx.beginPath();
    for (let i = 0; i < ov.sideEdge.length; i++) if (ov.sideEdge[i] === side && v.visible(g.edges[i].bbox)) polyPath(ctx, g.edges[i].pts);
    ctx.stroke();
  }
  for (const [a, b] of ov.sc) strokeEdge(ctx, { sc: [a, b] });
  ctx.globalAlpha = 1;
  S.ovView = { cx: v.cx, cy: v.cy, scale: v.scale };
  S.pending = [];
}
function flushPending() {
  if (!S.pending.length) return;
  const v = S.view, ctx = S.ovCanvas.getContext('2d');
  v.setWorldTransform(ctx); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = 0.75;
  for (const it of S.pending) strokeEdge(ctx, it);
  ctx.globalAlpha = 1; S.pending = [];
}
function sameView(a) { const v = S.view; return a && Math.abs(a.cx - v.cx) < 1e-9 && Math.abs(a.cy - v.cy) < 1e-9 && Math.abs(a.scale - v.scale) < 1e-12; }
function draw() {
  const v = S.view, g = S.g, ctx = v.cv.getContext('2d');
  ensureOvCanvas();
  const exact = v.drawBase(ctx);
  if (!exact) scheduleBase();
  /* 叠加层 */
  if (S.ov.active) {
    if (sameView(S.ovView)) flushPending();
    else if (!exact && S.ovView) { /* 视图变化中：先用缓存变换着画 */ }
    else renderOverlayFull();
    ctx.globalAlpha = S.ov.finished ? 0.42 : 1;
    v.drawCached(ctx, S.ovCanvas, S.ovView);
    ctx.globalAlpha = 1;
  }
  /* 动态元素 */
  v.setWorldTransform(ctx); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const routeDone = S.route && S.ov.finished;
  if (routeDone) {
    S.alts.forEach((a, i) => { if (S.selRoute === i + 1) return; drawRoute(ctx, a.pts, COL.altCase, COL.alt, 7, 4.5); });
    const sel = S.selRoute === 0 ? S.route : S.alts[S.selRoute - 1];
    if (S.selRoute !== 0) drawRoute(ctx, S.route.pts, COL.altCase, COL.alt, 7, 4.5);
    drawRoute(ctx, sel.pts, COL.routeCase, COL.route, 9, 6);
  } else if (S.ov.path && S.ov.path.length > 1) {
    const ch = S.algo === 'ch' && S.ch;
    ctx.strokeStyle = COL.route; ctx.lineWidth = v.px(5);
    for (let i = 0; i + 1 < S.ov.path.length; i++) {
      const a = S.ov.path[i], b = S.ov.path[i + 1];
      if (ch && S.ch.isShortcut(a, b)) { ctx.setLineDash([v.px(8), v.px(6)]); ctx.strokeStyle = COL.sc; ctx.beginPath(); ctx.moveTo(g.nodes[a].x, g.nodes[a].y); ctx.lineTo(g.nodes[b].x, g.nodes[b].y); ctx.stroke(); ctx.setLineDash([]); ctx.strokeStyle = COL.route; }
      else { const e = edgeOf(a, b); if (e) { ctx.beginPath(); polyPath(ctx, g.edges[e.eid].pts); ctx.stroke(); } }
    }
  }
  if (S.ov.hlEdge && !S.ov.finished) {
    const { u, v: w, improved } = S.ov.hlEdge; const e = edgeOf(u, w);
    ctx.strokeStyle = improved ? COL.relax : '#9aa0a6'; ctx.lineWidth = v.px(6);
    if (e) { ctx.beginPath(); polyPath(ctx, g.edges[e.eid].pts); ctx.stroke(); }
    else { ctx.beginPath(); ctx.moveTo(g.nodes[u].x, g.nodes[u].y); ctx.lineTo(g.nodes[w].x, g.nodes[w].y); ctx.stroke(); }
  }
  /* 屏幕空间元素 */
  v.setScreenTransform(ctx);
  if (S.ov.current >= 0 && !S.ov.finished) {
    const [sx, sy] = v.toScreen(g.nodes[S.ov.current].x, g.nodes[S.ov.current].y);
    ctx.fillStyle = COL.cur; ctx.strokeStyle = '#7a5a00'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  if (S.algo === 'alt' && S.lm) {
    S.lm.lms.forEach((id, i) => {
      const [sx, sy] = v.toScreen(g.nodes[id].x, g.nodes[id].y);
      ctx.fillStyle = COL.lm; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sx, sy - 12); ctx.lineTo(sx + 10, sy); ctx.lineTo(sx, sy + 12); ctx.lineTo(sx - 10, sy); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px Roboto, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('L' + (i + 1), sx, sy + 0.5);
    });
  }
  if (S.A >= 0) drawOrigin(ctx, ...v.toScreen(g.nodes[S.A].x, g.nodes[S.A].y));
  if (S.B >= 0) drawPin(ctx, ...v.toScreen(g.nodes[S.B].x, g.nodes[S.B].y));
  if (S.nav) drawNav(ctx);
  updateScaleBar();
}
function drawRoute(ctx, pts, caseCol, fillCol, wCase, wFill) {
  if (!pts || pts.length < 4) return; const v = S.view;
  ctx.strokeStyle = caseCol; ctx.lineWidth = v.px(wCase); ctx.beginPath(); polyPath(ctx, pts); ctx.stroke();
  ctx.strokeStyle = fillCol; ctx.lineWidth = v.px(wFill); ctx.beginPath(); polyPath(ctx, pts); ctx.stroke();
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
  S.baseTimer = setTimeout(() => { S.baseTimer = null; S.view.renderBase(); S.ovView = null; requestDraw(); }, 140);
}
function updateScaleBar() { const { m, px } = S.view.scaleBar(); $('scalebar').innerHTML = `<i style="width:${px.toFixed(0)}px"></i><span>${m >= 1000 ? m / 1000 + ' 公里' : m + ' 米'}</span>`; }

/* ---------- 起终点 / 搜索 ---------- */
function setPoint(which, node, fromText) {
  if (node < 0) return;
  if (which === 'A') { if (node === S.B) return; S.A = node; } else { if (node === S.A) return; S.B = node; }
  $(which === 'A' ? 'inA' : 'inB').value = fromText || S.g.describeNode(node);
  hideCtx(); stopNav();
  if (S.A >= 0 && S.B >= 0) startSearch(); else { resetOverlay(); S.route = null; renderRouteCards(); requestDraw(); }
}
function swapPoints() { const a = S.A, b = S.B; S.A = b; S.B = a; $('inA').value = S.A >= 0 ? S.g.describeNode(S.A) : ''; $('inB').value = S.B >= 0 ? S.g.describeNode(S.B) : ''; stopNav(); if (S.A >= 0 && S.B >= 0) startSearch(); else requestDraw(); }
function bindSearch(inputId, suggId, which) {
  const inp = $(inputId), box = $(suggId);
  inp.addEventListener('input', () => {
    const list = S.g.searchStreets(inp.value, 7);
    if (!list.length) { box.classList.add('hidden'); return; }
    box.innerHTML = list.map(n => `<div data-n="${n.replace(/"/g, '&quot;')}"><span class="loc"></span>${n}</div>`).join('');
    box.classList.remove('hidden');
    box.querySelectorAll('div[data-n]').forEach(d => d.onmousedown = e => { e.preventDefault(); const nm = d.dataset.n; setPoint(which, S.g.nodeForStreet(nm), nm); box.classList.add('hidden'); });
  });
  inp.addEventListener('blur', () => setTimeout(() => box.classList.add('hidden'), 150));
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { const list = S.g.searchStreets(inp.value, 1); if (list.length) { setPoint(which, S.g.nodeForStreet(list[0]), list[0]); box.classList.add('hidden'); inp.blur(); } } });
}

/* ---------- 搜索（动画） ---------- */
function refDijkstra() {
  const key = `${S.A}:${S.B}`;
  if (S.refKey !== key) { S.refDj = runGen(dijkstraGen(S.g, S.A, S.B)); S.refKey = key; }
  return S.refDj;
}
function makeGen() {
  const g = S.g, ov = S.ov;
  switch (S.algo) {
    case 'astar': ov.h = cityHeuristic(g, S.B); return dijkstraGen(g, S.A, S.B, { h: ov.h });
    case 'bidir': return bidirGen(g, S.A, S.B);
    case 'alt': if (!S.lm) S.lm = computeLandmarks(g, 8); ov.h = altHeuristic(S.lm, S.B); return dijkstraGen(g, S.A, S.B, { h: ov.h });
    case 'ch': return S.ch.queryGen(S.A, S.B);
    case 'td': return tdDijkstraGen(g, S.A, S.B, S.hour);
    default: return dijkstraGen(g, S.A, S.B);
  }
}
function startSearch() {
  if (S.A < 0 || S.B < 0) return;
  stopNav(); S.route = null; S.alts = []; S.selRoute = 0; S.showSteps = false;
  resetOverlay(); renderRouteCards(); renderStats();
  if (S.algo === 'ch' && !S.chReady) { preprocessCH(() => startSearch()); requestDraw(); return; }
  S.player.reset(); S.player.play();
  requestDraw();
}
function onSearchDone(ev) {
  if (!ev || !ev.path || !ev.path.length) { renderRouteCards(); requestDraw(); return; }
  const path = ev.path, cost = ev.cost;
  S.route = { path, cost, lenM: pathLenM(path), via: viaNames(path), pts: routePolyline(path), steps: buildSteps(path) };
  S.alts = altRoutes(S.route);
  renderRouteCards(); renderStats(); requestDraw();
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
      S.chReady = true; S.chBusy = false; $('chprog').classList.add('hidden');
      $('algomsg').innerHTML = `CH 预处理完成：收缩 ${n} 个路口，加 ${S.ch.nShortcuts} 条捷径，用时 ${((performance.now() - t0) / 1000).toFixed(1)} s。之后每次查询都复用它。`;
      then && then(); return;
    }
    const done = last ? last.rank + 1 : 0;
    $('chprog').querySelector('i').style.width = (done / n * 100).toFixed(1) + '%';
    $('algomsg').textContent = `CH 预处理中（只做一次）：已收缩 ${done} / ${n} 个路口，捷径 ${S.ch.nShortcuts} 条…`;
    setTimeout(chunk, 0);
  };
  setTimeout(chunk, 0);
}

/* ---------- 面板渲染 ---------- */
function renderRouteCards() {
  const box = $('routes');
  if (S.A < 0 || S.B < 0) { box.innerHTML = `<div class="hint">在地图上<b>右键</b>选择"从此处出发 / 前往此处"，或在上方输入街道名（如 <b>Via Dante</b>、<b>Corso Buenos Aires</b>）。<br><br>路线算出后，右侧卡片可切换算法、回放搜索过程并查看公式。</div>`; return; }
  if (!S.route) { box.innerHTML = `<div class="calc"><div class="spinner"></div><div>正在用 <b>${ALGOS[S.algo].name}</b> 计算路线…<br><span style="font-size:12px">地图上蓝/红色为已探索的道路；右侧可调速或"直接出结果"。</span></div></div>`; return; }
  const cards = [S.route, ...S.alts].map((r, i) => {
    const main = i === 0, sel = S.selRoute === i;
    const eta = S.algo === 'td' ? `<div class="rc-eta">${hhmm(S.hour)} 出发 · 预计 <b>${hhmm(S.hour + r.cost / 60)}</b> 到达 · <span class="${tdMultiplier('primary', S.hour) < 0.6 ? 'warn' : ''}">${tdMultiplier('primary', S.hour) < 0.6 ? '路况拥堵' : '路况良好'}</span></div>` : `<div class="rc-eta">现在出发 · 预计 <b>${hhmm(nowHour() + r.cost / 60)}</b> 到达 · 按市区典型车速 · ${main ? '最快' : `比最快多 ${fmtMin(r.cost - S.route.cost)}`}</div>`;
    return `<div class="route-card ${main ? 'main' : 'alt'} ${sel ? 'sel' : ''}" data-i="${i}">
      <div class="rc-top"><div class="rc-title"><svg viewBox="0 0 24 24"><path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/></svg>${main ? '最快路线' : '替代路线'}</div><div class="rc-time">${fmtMin(r.cost)}</div></div>
      <div class="rc-sub">${fmtDist(r.lenM)} · 经由 ${r.via.join(' 和 ') || '市区道路'}</div>${eta}
      ${sel ? `<div class="rc-actions"><button class="btn-primary" data-act="nav"><svg viewBox="0 0 24 24"><path d="M12 2L4.5 20.3l.7.7L12 18l6.8 3 .7-.7z"/></svg>开始</button><button class="btn-text" data-act="steps">${S.showSteps ? '收起详情' : '详情'}</button></div>` : ''}
    </div>`;
  }).join('');
  const sel = S.selRoute === 0 ? S.route : S.alts[S.selRoute - 1];
  const steps = S.showSteps && sel ? `<div class="steps">${sel.steps.map(s => `<div class="step ${s.end ? 'end' : ''}"><div class="arrow">${s.arrow}</div><div class="name">${s.text}</div><div class="dist">${s.dist ? fmtDist(s.dist) : ''}</div></div>`).join('')}</div>` : '';
  box.innerHTML = cards + steps;
  box.querySelectorAll('.route-card').forEach(c => c.onclick = e => {
    if (e.target.closest('[data-act=nav]')) { startNav(); return; }
    if (e.target.closest('[data-act=steps]')) { S.showSteps = !S.showSteps; renderRouteCards(); return; }
    const i = +c.dataset.i; if (S.selRoute !== i) { S.selRoute = i; const r = i === 0 ? S.route : S.alts[i - 1]; if (!r.steps) r.steps = buildSteps(r.path); renderRouteCards(); requestDraw(); }
  });
}
function renderStats() {
  const ov = S.ov, el = $('stats');
  const ref = (S.A >= 0 && S.B >= 0) ? refDijkstra() : null;
  const rows = [];
  if (S.algo === 'bidir' || S.algo === 'ch') {
    let nf = 0, nb = 0; for (const x of ov.sideNode) { if (x === 1) nf++; else if (x === 2) nb++; }
    rows.push(['正向已确定', nf, 'f'], ['反向已确定', nb, 'b'], ['当前 μ', fmt(ov.mu) + (ov.mu < Infinity ? ' min' : '')]);
    if (S.algo === 'bidir') rows.push(['min Q_f + min Q_b', `${fmt(ov.topF)} + ${fmt(ov.topB)}`]);
    if (S.algo === 'ch') rows.push(['捷径总数', S.ch ? S.ch.nShortcuts : '—'], ['捷径展开步数', ov.unpack]);
  } else rows.push(['已确定路口', ov.nS], ['队列大小', ov.qsize]);
  rows.push(['松弛次数', ov.nR]);
  if (ref) rows.push(['Dijkstra 需确定', ref.nS, 'muted'], ['相对 Dijkstra', ov.nS ? Math.round(ov.nS / ref.nS * 100) + '% 搜索量' : '—']);
  rows.push(['路线耗时', ov.finished ? fmt(ov.cost) + ' min' : '…', ov.finished ? 'ok' : '']);
  el.innerHTML = rows.map(([k, v, c]) => `<div class="stat ${c || ''}"><span>${k}</span><b>${v}</b></div>`).join('');
  $('algolog').innerHTML = ov.log.map((l, i) => `<div class="${i === ov.log.length - 1 ? 'new' : ''}">${l}</div>`).join('');
}
function setAlgo(key) {
  S.algo = key;
  document.querySelectorAll('#chips .chip').forEach(c => c.classList.toggle('on', c.dataset.a === key));
  $('hourrow').classList.toggle('hidden', key !== 'td');
  $('departchip').textContent = key === 'td' ? `${hhmm(S.hour)} 出发` : '立即出发';
  if (key === 'td') { S.view.layers.traffic = true; $('ly-traffic').checked = true; S.view.trafficHour = S.hour; S.view.baseView = null; }
  const p = $('principle'); p.innerHTML = `<p>${ALGOS[key].principle}</p><p><a href="${ALGOS[key].link}" target="_blank">完整讲解与公式推导 →</a></p>`;
  if (window.renderMathInElement) renderMathInElement(p, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\(', right: '\\)', display: false }], throwOnError: false });
  $('algomsg').textContent = key === 'ch' && !S.chReady ? '首次使用 CH 需要先预处理整张路网（一次性）。' : ALGOS[key].tip;
  if (S.A >= 0 && S.B >= 0) startSearch(); else { resetOverlay(); renderStats(); requestDraw(); }
}

/* ---------- 模拟导航 ---------- */
function startNav() {
  const r = S.selRoute === 0 ? S.route : S.alts[S.selRoute - 1]; if (!r) return;
  const pts = r.pts, cum = [0]; let tot = 0;
  for (let i = 2; i < pts.length; i += 2) { tot += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]); cum.push(tot); }
  S.nav = { r, pts, cum, tot, t0: performance.now(), dur: Math.max(8000, Math.min(30000, r.cost * 600)), follow: true, startHour: S.algo === 'td' ? S.hour : nowHour() };
  $('navbar').classList.remove('hidden');
  const tick = () => { if (!S.nav) return; requestDraw(); S.nav.raf = requestAnimationFrame(tick); };
  tick();
}
function stopNav() { if (S.nav) { cancelAnimationFrame(S.nav.raf); S.nav = null; $('navbar').classList.add('hidden'); requestDraw(); } }
function drawNav(ctx) {
  const nv = S.nav, v = S.view, p = Math.min(1, (performance.now() - nv.t0) / nv.dur), dist = p * nv.tot;
  let i = 1; while (i < nv.cum.length && nv.cum[i] < dist) i++;
  const a = Math.min(i - 1, nv.cum.length - 2), seg = nv.cum[a + 1] - nv.cum[a] || 1, t = (dist - nv.cum[a]) / seg;
  const x = nv.pts[2 * a] + (nv.pts[2 * a + 2] - nv.pts[2 * a]) * t, y = nv.pts[2 * a + 1] + (nv.pts[2 * a + 3] - nv.pts[2 * a + 1]) * t;
  const ang = Math.atan2(nv.pts[2 * a + 3] - nv.pts[2 * a + 1], nv.pts[2 * a + 2] - nv.pts[2 * a]);
  if (nv.follow) { v.cx = x; v.cy = y; }
  const [sx, sy] = v.toScreen(x, y);
  ctx.save(); ctx.translate(sx, sy);
  ctx.fillStyle = 'rgba(66,133,244,0.25)'; ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2); ctx.fill();
  ctx.rotate(ang + Math.PI / 2);
  ctx.fillStyle = '#1a73e8'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(10, 11); ctx.lineTo(0, 6); ctx.lineTo(-10, 11); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
  const remainM = nv.tot * (1 - p), remainMin = nv.r.cost * (1 - p);
  /* 下一条指令 */
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
  m.innerHTML = `<div class="coord"><b>${node >= 0 ? S.g.describeNode(node) : '附近没有可行驶道路'}</b>${lat.toFixed(5)}, ${lon.toFixed(5)}</div><div class="item" data-a="A">从此处出发</div><div class="item" data-a="B">前往此处</div><div class="item" data-a="C">以此为中心</div>`;
  m.style.left = Math.min(sx, window.innerWidth - 210) + 'px'; m.style.top = Math.min(sy, window.innerHeight - 150) + 'px';
  m.classList.remove('hidden');
  m.querySelectorAll('.item').forEach(it => it.onclick = () => {
    const a = it.dataset.a;
    if (a === 'C') { S.view.cx = wx; S.view.cy = wy; hideCtx(); requestDraw(); }
    else if (node >= 0) setPoint(a, node);
  });
}
function hideCtx() { $('ctxmenu').classList.add('hidden'); }
function bindMap() {
  const cv = S.view.cv, v = S.view;
  const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener('mousedown', e => { if (e.button !== 0) return; const [x, y] = pos(e); S.drag = { x, y, moved: false }; hideCtx(); });
  window.addEventListener('mousemove', e => {
    const [x, y] = pos(e);
    if (S.drag) {
      const dx = x - S.drag.x, dy = y - S.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) { S.drag.moved = true; cv.classList.add('dragging'); if (S.nav) S.nav.follow = false; }
      v.pan(dx, dy); S.drag.x = x; S.drag.y = y; requestDraw(); hideTip(); return;
    }
    hover(x, y, e);
  });
  window.addEventListener('mouseup', () => { S.drag = null; cv.classList.remove('dragging'); });
  cv.addEventListener('wheel', e => { e.preventDefault(); const [x, y] = pos(e); v.zoomAt(x, y, Math.pow(2, -e.deltaY / 400)); if (S.nav) S.nav.follow = false; requestDraw(); }, { passive: false });
  cv.addEventListener('dblclick', e => { const [x, y] = pos(e); v.zoomAt(x, y, 2); requestDraw(); });
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
    if (S.nav) S.nav.follow = false;
    requestDraw();
  }, { passive: false });
  cv.addEventListener('touchend', e => { clearTimeout(pressTimer); if (e.touches.length === 0) touch = null; else if (e.touches.length === 1) { const t = e.touches[0]; touch = { mode: 'pan', x: t.clientX, y: t.clientY, moved: true }; } });
  $('zin').onclick = () => { v.zoomAt(v.w / 2, v.h / 2, 1.6); requestDraw(); };
  $('zout').onclick = () => { v.zoomAt(v.w / 2, v.h / 2, 1 / 1.6); requestDraw(); };
  $('home').onclick = () => { v.fit(S.g.bounds, 20); if (S.nav) S.nav.follow = false; requestDraw(); };
}
function hover(x, y, e) {
  const v = S.view, ov = S.ov;
  if (!ov.active) { hideTip(); return; }
  const [wx, wy] = v.toWorld(x, y);
  const id = S.g.nearestNode(wx, wy, 14 / v.scale);
  if (id < 0) { hideTip(); return; }
  const d0 = ov.dist[0][id], d1 = ov.dist[1][id];
  if (d0 === Infinity && d1 === Infinity) { hideTip(); return; }
  let html = `<b>${S.g.describeNode(id)}</b><br>`;
  if (S.algo === 'bidir' || S.algo === 'ch') html += `d_f = ${fmt(d0)} min · d_b = ${fmt(d1)} min`;
  else { html += `d(v) = ${fmt(d0)} min`; if (ov.h) { const h = ov.h(id); html += `<br>h(v) = ${fmt(h)} min · f = ${fmt(d0 + h)}`; } }
  if (S.algo === 'ch' && S.ch) html += `<br><span class="muted">rank ${S.ch.rank[id]}</span>`;
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
  const sp = $('speed'), spv = $('speedv');
  const updSpeed = () => { S.player.speed = Math.round(20 * Math.pow(1.07, +sp.value)); spv.textContent = S.player.speed + ' 步/秒'; };
  sp.oninput = updSpeed; updSpeed();
  $('b-play').onclick = () => { if (S.A < 0 || S.B < 0) return; if (S.player.done) startSearch(); else S.player.play(); };
  $('b-pause').onclick = () => S.player.pause();
  $('b-step').onclick = () => { if (S.A < 0 || S.B < 0) return; S.player.pause(); S.player.step(); renderStats(); requestDraw(); };
  $('b-end').onclick = () => { if (S.A < 0 || S.B < 0) return; if (S.player.done) return; S.player.runToEnd(); renderStats(); requestDraw(); };
  $('b-reset').onclick = () => { if (S.A < 0 || S.B < 0) return; startSearch(); };
  const hr = $('hour'), hrv = $('hourv');
  hr.oninput = () => { S.hour = +hr.value; hrv.textContent = hhmm(S.hour); $('departchip').textContent = `${hhmm(S.hour)} 出发`; S.view.trafficHour = S.hour; S.view.baseView = null; requestDraw(); };
  hr.onchange = () => { if (S.algo === 'td' && S.A >= 0 && S.B >= 0) startSearch(); };
  hrv.textContent = hhmm(S.hour);
  $('ly-traffic').onchange = e => { S.view.layers.traffic = e.target.checked; S.view.baseView = null; requestDraw(); };
  $('ly-buildings').onchange = e => { S.view.layers.buildings = e.target.checked; S.view.baseView = null; requestDraw(); };
  $('ly-labels').onchange = e => { S.view.layers.labels = e.target.checked; S.view.layers.pois = e.target.checked; S.view.baseView = null; requestDraw(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { hideCtx(); } });
}
document.addEventListener('DOMContentLoaded', () => {
  const D = window.CITY_DATA;
  S.g = buildCityGraph(D);
  S.view = new MapView($('map'), S.g);
  S.view.onchange = () => { S.ovView = null; requestDraw(); };
  S.player = new Player({ makeGen, onEvent: handleEvent, onFrame: () => { renderStats(); requestDraw(); }, onFinish: ev => { renderStats(); onSearchDone(ev); } });
  resetOverlay();
  bindMap(); bindUI();
  $('cityname').textContent = D.name;
  $('loading').classList.add('hidden');
  /* 默认：从大教堂广场到中央车站 */
  const duomo = S.g.nearestNode(...S.g.xyOf(45.4642, 9.1900), 400), centrale = S.g.nearestNode(...S.g.xyOf(45.4862, 9.2040), 500);
  /* URL 参数：?algo=astar&instant=1&zoom=1.4&hour=18  （instant = 直接出结果，便于截图/分享） */
  const q = new URLSearchParams(location.search);
  S.view.fit(S.g.bounds, 20);
  S.view.zoomAt(S.view.w / 2, S.view.h / 2, +(q.get('zoom') || 1.35));
  if (q.get('hour')) { S.hour = +q.get('hour'); $('hour').value = S.hour; $('hourv').textContent = hhmm(S.hour); }
  setAlgo(ALGOS[q.get('algo')] ? q.get('algo') : 'dijkstra');
  if (duomo >= 0) setPoint('A', duomo, 'Piazza del Duomo');
  if (centrale >= 0) setPoint('B', centrale, 'Stazione Centrale');
  if (q.get('instant') && S.algo !== 'ch') { S.player.runToEnd(); renderStats(); }
  requestDraw();
});
