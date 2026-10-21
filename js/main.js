'use strict';
/* =====================================================================
 *  main.js —— 页面装配：各节演示、统计面板、公式渲染
 * ===================================================================== */
const app = { seed: 20261020, g: null, s: -1, t: -1, demos: [], alt: null, refs: {} };
const $ = id => document.getElementById(id);
const fmt = (x, d = 1) => (x === Infinity || x == null || Number.isNaN(x)) ? '∞' : Number(x).toFixed(d);
const SIDE_NAME = ['正向', '反向'];
const speedFromSlider = v => Math.round(2 * Math.pow(1.075, v));

/* ---------- 通用小部件 ---------- */
function buildControls(root, withSpeed = true) {
  root.innerHTML = `
    <button data-act="play" class="primary">▶ 播放</button>
    <button data-act="pause">⏸ 暂停</button>
    <button data-act="step">⏭ 单步</button>
    <button data-act="end">⏩ 直接出结果</button>
    <button data-act="reset">↺ 重置</button>
    ${withSpeed ? `<label class="speed">速度 <input type="range" min="0" max="100" value="50"><span class="speed-val"></span></label>` : ''}`;
}
function bindPlayer(root, player, onChange) {
  root.querySelector('[data-act=play]').onclick = () => { onChange && onChange('play'); player.play(); };
  root.querySelector('[data-act=pause]').onclick = () => { player.pause(); onChange && onChange('pause'); };
  root.querySelector('[data-act=step]').onclick = () => { player.pause(); onChange && onChange('step'); player.step(); onChange && onChange('after'); };
  root.querySelector('[data-act=end]').onclick = () => { onChange && onChange('end'); player.runToEnd(); onChange && onChange('after'); };
  root.querySelector('[data-act=reset]').onclick = () => { player.reset(); onChange && onChange('reset'); };
  const sl = root.querySelector('input[type=range]');
  if (sl) {
    const upd = () => { player.speed = speedFromSlider(+sl.value); root.querySelector('.speed-val').textContent = player.speed + ' 步/秒'; };
    sl.oninput = upd; upd();
  }
}
const statsHTML = rows => rows.map(([k, v, cls]) => `<div class="stat ${cls || ''}"><span>${k}</span><b>${v}</b></div>`).join('');
const queueHTML = qtop => qtop && qtop.length ? qtop.map(q => `<span class="qitem">#${q.val}<em>${fmt(q.key)}</em></span>`).join('') : '<span class="muted">（空）</span>';
const logHTML = log => log.map((l, i) => `<div class="${i === log.length - 1 ? 'new' : ''}">${l}</div>`).join('');
function showTip(evt, html) {
  const tip = $('tooltip');
  tip.innerHTML = html; tip.hidden = false;
  const x = evt.clientX + 14, y = evt.clientY + 14;
  tip.style.left = Math.min(x, window.innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = Math.min(y, window.innerHeight - tip.offsetHeight - 8) + 'px';
}
function hideTip() { $('tooltip').hidden = true; }
const hhmm = h => { h = ((h % 24) + 24) % 24; const H = Math.floor(h), M = Math.round((h - H) * 60); return `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`; };

/* ---------- 全局状态：图 / 起终点 / 参考结果 ---------- */
function newGraph(seed) {
  app.g = buildRoadNetwork(seed);
  app.seed = seed;
  const g = app.g;
  app.s = 10 * g.cols + 2;
  app.t = 2 * g.cols + (g.cols - 3);
  app.alt = null; app.refs = {};
  for (const d of app.demos) d.onGraphChanged();
}
function setStart(v) { if (v === app.t || v === app.s) return; app.s = v; app.refs = {}; for (const d of app.demos) d.onQueryChanged(); }
function setGoal(v) { if (v === app.s || v === app.t) return; app.t = v; app.refs = {}; for (const d of app.demos) d.onQueryChanged(); }
function getRefs() {
  const key = `${app.g.seed}:${app.s}:${app.t}`;
  if (app.refs.key === key) return app.refs;
  const r = { key };
  r.dj = runGen(dijkstraGen(app.g, app.s, app.t));
  r.astar = runGen(dijkstraGen(app.g, app.s, app.t, { h: euclidTimeHeuristic(app.g, app.t) }));
  app.refs = r;
  return r;
}
function getALT(k) {
  if (!app.alt || app.alt.k !== k || app.alt.seed !== app.g.seed) { app.alt = computeLandmarks(app.g, k); app.alt.k = k; app.alt.seed = app.g.seed; }
  return app.alt;
}
function heatOf(h) {
  const n = app.g.nodes.length, a = new Float32Array(n);
  let mx = 0;
  for (let v = 0; v < n; v++) { a[v] = h(v); if (a[v] > mx) mx = a[v]; }
  if (mx > 0) for (let v = 0; v < n; v++) a[v] /= mx;
  return a;
}

/* =====================================================================
 *  通用搜索演示（Dijkstra / A* / 双向 / ALT）
 * ===================================================================== */
class SearchDemo {
  constructor(cfg) {
    this.cfg = cfg;
    this.rc = new RoadCanvas(cfg.canvas, app.g, { onStart: setStart, onGoal: setGoal, onHover: (v, e, evt) => this.hover(v, evt) });
    this.player = new Player({ makeGen: () => cfg.makeGen(this), onEvent: ev => this.handle(ev), onFrame: () => this.render(), onFinish: () => this.render() });
    buildControls(cfg.controls);
    bindPlayer(cfg.controls, this.player, kind => { if (kind === 'reset') this.resetState(); this.render(); });
    this.showHeat = false; this.eps = 1; this.h = null; this.heat = null;
    this.resetState();
    app.demos.push(this);
  }
  resetState() {
    const n = app.g.nodes.length;
    this.st = { side: new Uint8Array(n), inQ: new Uint8Array(n), dist: [new Float64Array(n).fill(Infinity), new Float64Array(n).fill(Infinity)],
      current: -1, hlEdge: null, path: null, cost: Infinity, nS: 0, nR: 0, qsize: 0, qtop: [], mu: Infinity, topF: Infinity, topB: Infinity, meet: -1, stopped: false, finished: false };
    this.log = [];
    if (this.cfg.prepare) this.cfg.prepare(this);
  }
  onGraphChanged() { this.rc.setGraph(app.g); this.reset(); }
  onQueryChanged() { this.reset(); }
  reset() { this.player.reset(); this.resetState(); this.render(); }
  addLog(s) { this.log.push(s); if (this.log.length > 7) this.log.shift(); }
  handle(ev) {
    const st = this.st, bi = !!this.cfg.bidir;
    st.current = -1; st.hlEdge = null;
    switch (ev.type) {
      case 'init':
        st.inQ[ev.s] = 1; if (bi) st.inQ[ev.t] = 2;
        this.addLog(bi ? `初始化：正向 d_f(起点)=0，反向 d_b(终点)=0，其余 ∞；μ = ∞。` : `初始化：d(起点)=0，其余节点 d=∞；起点入队。`);
        break;
      case 'settle':
        st.side[ev.u] = ev.side + 1; st.inQ[ev.u] = 0; st.current = ev.u; st.dist[ev.side][ev.u] = ev.d;
        st.nS = ev.nS; st.nU = ev.nU; st.nR = ev.nR; st.qsize = ev.qsize; st.qtop = ev.qtop || [];
        if (ev.mu != null) { st.mu = ev.mu; st.topF = ev.topF; st.topB = ev.topB; }
        this.addLog(`${bi ? SIDE_NAME[ev.side] : ''}弹出队首 u=#${ev.u}，d(u)=${fmt(ev.d)} min${this.h && ev.key != null ? `（f(u)=${fmt(ev.key)}）` : ''}，标记为已确定；队列剩 ${ev.qsize} 项。`);
        break;
      case 'relax': {
        st.current = ev.u; st.hlEdge = { u: ev.u, v: ev.v, improved: ev.improved }; st.nR = ev.nR;
        if (ev.improved) { st.inQ[ev.v] = ev.side + 1; st.dist[ev.side][ev.v] = ev.nd; }
        const p = logDecimals(ev.du, ev.w, ev.nd, ev.old);     // 精度自适应：加数之和要等于显示的和，比较关系要与真实一致
        const raw = `精确值：${ev.du.toFixed(4)} + ${ev.w.toFixed(4)} = ${ev.nd.toFixed(4)}，原 d(v) = ${ev.old === Infinity ? '∞' : ev.old.toFixed(4)}`;
        this.addLog(`<span title="${raw}">松弛 (#${ev.u}→#${ev.v})：${fmt(ev.du, p)} + ${fmt(ev.w, p)} = ${fmt(ev.nd, p)} ${ev.improved ? `&lt; ${fmt(ev.old, p)} ⇒ 更新 d(v)，入队` : `≥ ${fmt(ev.old, p)} ⇒ 不更新`}${this.h && ev.improved ? `；f(v) = ${fmt(ev.nd, p)} + ${this.eps !== 1 ? this.eps.toFixed(1) + '×' : ''}${fmt(ev.hv, p)} = ${fmt(ev.key, p)}` : ''}</span>`);
        break;
      }
      case 'meet': {
        const p = logDecimals(ev.dF, ev.dB, ev.mu, st.mu);
        st.mu = ev.mu; st.meet = ev.u;
        this.addLog(`两侧在 #${ev.u} 相遇：候选 μ = d_f + d_b = ${fmt(ev.dF, p)} + ${fmt(ev.dB, p)} = <b>${fmt(ev.mu, p)}</b>${ev.onSettle ? '（弹出时发现另一侧已触达）' : ''}`);
        break;
      }
      case 'stop': {
        st.stopped = true; st.topF = ev.topF; st.topB = ev.topB;
        const p = logDecimals(ev.topF, ev.topB, ev.topF + ev.topB, ev.mu);
        this.addLog(`终止条件成立：min Q_f + min Q_b = ${fmt(ev.topF, p)} + ${fmt(ev.topB, p)} = ${fmt(ev.topF + ev.topB, p)} ≥ μ = ${fmt(ev.mu, p)}，再搜下去不可能更短。`);
        break;
      }
      case 'done':
        st.path = ev.path; st.cost = ev.cost; st.nS = ev.nS; st.nU = ev.nU; st.nR = ev.nR; st.finished = true;
        this.addLog(`<b>完成</b>：最短耗时 ${fmt(ev.cost)} min，路径 ${ev.path.length} 个节点；展开 ${ev.nS} 次${ev.nU != null && ev.nU !== ev.nS ? `（唯一路口 ${ev.nU} 个）` : ''}、松弛 ${ev.nR} 次。`);
        break;
    }
  }
  render() {
    const st = this.st;
    this.rc.draw({ side: st.side, inQ: st.inQ, current: st.current, hlEdge: st.hlEdge, path: st.path, s: app.s, t: app.t,
      heat: this.showHeat ? this.heat : null, landmarks: this.cfg.landmarks ? this.cfg.landmarks(this) : null });
    if (this.cfg.renderStats) this.cfg.renderStats(this);
    this.cfg.log.innerHTML = logHTML(this.log);
  }
  hover(v, evt) {
    if (v < 0) return hideTip();
    const st = this.st, d0 = st.dist[0][v], d1 = st.dist[1][v];
    let html = `<b>节点 #${v}</b><br>d(v) = ${fmt(d0)} min${this.cfg.bidir ? `<br>d_b(v) = ${fmt(d1)} min` : ''}`;
    if (this.h) { const h = this.h(v); html += `<br>h(v) = ${fmt(h)} min`; if (d0 < Infinity) html += `<br>f(v) = g + ε·h = ${fmt(d0 + this.eps * h)}`; }
    html += `<br><span class="muted">${st.side[v] ? '已确定' : st.inQ[v] ? '在队列中' : '未触达'}</span>`;
    showTip(evt, html);
  }
}

/* =====================================================================
 *  各节装配
 * ===================================================================== */
function setupModel() {
  const rc = new RoadCanvas($('model-canvas'), app.g, {
    onStart: setStart, onGoal: setGoal, edgeHover: true,
    onHover: (v, e, evt) => {
      if (e >= 0) {
        const ed = app.g.edges[e], rc2 = ROAD_CLASS[ed.cls];
        showTip(evt, `<b>${rc2.name}</b> #${ed.u} — #${ed.v}<br>长度 ℓ = ${fmt(ed.len, 2)} km<br>限速 v = ${ed.speed} km/h<br>耗时 w = ℓ/v = <b>${fmt(ed.w, 2)} min</b>`);
      } else if (v >= 0) {
        showTip(evt, `<b>路口 #${v}</b><br>度数 ${app.g.adj[v].length}（相邻路段数）`);
      } else hideTip();
    },
  });
  const demo = {
    onGraphChanged() { rc.setGraph(app.g); this.render(); },
    onQueryChanged() { this.render(); },
    render() {
      rc.draw({ s: app.s, t: app.t });
      $('model-seed').textContent = app.g.seed;
      $('model-info').textContent = `${app.g.nodes.length} 个路口，${app.g.edges.length} 条路段；起点 #${app.s}，终点 #${app.t}`;
    },
  };
  app.demos.push(demo);
  $('model-regen').onclick = () => newGraph(Math.floor(Math.random() * 1e9));
  $('model-legend').innerHTML = Object.values(ROAD_CLASS).map(r => `<span class="lg"><i style="background:${r.color};height:${r.width + 1}px"></i>${r.name} ${r.speed} km/h</span>`).join('');

  /* Haversine 小计算器 */
  const CITIES = { 北京: [39.9042, 116.4074], 上海: [31.2304, 121.4737], 广州: [23.1291, 113.2644], 成都: [30.5728, 104.0668], 乌鲁木齐: [43.8256, 87.6168], 伦敦: [51.5074, -0.1278], 纽约: [40.7128, -74.0060], 悉尼: [-33.8688, 151.2093] };
  const opts = Object.keys(CITIES).map(c => `<option>${c}</option>`).join('');
  $('hav-a').innerHTML = opts; $('hav-b').innerHTML = opts; $('hav-b').value = '上海';
  const calc = () => {
    const [a, b] = [CITIES[$('hav-a').value], CITIES[$('hav-b').value]];
    const d = haversine(a[0], a[1], b[0], b[1]);
    $('hav-out').innerHTML = `φ₁=${a[0]}°, λ₁=${a[1]}° → φ₂=${b[0]}°, λ₂=${b[1]}°：大圆距离 ≈ <b>${d.toFixed(1)} km</b>；按 90 km/h 直线飞过去要 ${(d / 90).toFixed(1)} h —— 这就是 A* 的一个合法下界。`;
  };
  $('hav-a').onchange = calc; $('hav-b').onchange = calc; calc();
  demo.render();
}

function setupDijkstra() {
  new SearchDemo({
    canvas: $('dj-canvas'), controls: $('dj-controls'), log: $('dj-log'),
    makeGen: () => dijkstraGen(app.g, app.s, app.t),
    renderStats(d) {
      const st = d.st;
      $('dj-stats').innerHTML = statsHTML([
        ['已确定节点', st.nS], ['松弛次数', st.nR], ['队列大小', st.qsize],
        ['当前 d(u)', st.current >= 0 ? fmt(st.dist[0][st.current]) + ' min' : '—'],
        ['最短耗时', st.finished ? fmt(st.cost) + ' min' : '…', st.finished ? 'ok' : ''],
      ]);
      $('dj-queue').innerHTML = queueHTML(st.qtop);
    },
  });
}

function setupAstar() {
  const epsEl = $('as-eps');
  const demo = new SearchDemo({
    canvas: $('as-canvas'), controls: $('as-controls'), log: $('as-log'),
    prepare(d) { d.eps = +epsEl.value; d.h = euclidTimeHeuristic(app.g, app.t); d.heat = heatOf(d.h); },
    makeGen: d => dijkstraGen(app.g, app.s, app.t, { h: d.h, eps: d.eps }),
    renderStats(d) {
      const st = d.st, ref = getRefs();
      const ratio = st.finished ? st.cost / ref.dj.cost : null;
      $('as-stats').innerHTML = statsHTML([
        ['已确定节点', st.nS], ['Dijkstra 需确定', ref.dj.nS, 'muted'],
        ['松弛次数', st.nR], ['队列大小', st.qsize],
        ['路径耗时', st.finished ? fmt(st.cost) + ' min' : '…', st.finished ? 'ok' : ''],
        ['相对最优', ratio == null ? '—' : (ratio > 1.0000001 ? `<span class="warn">${((ratio - 1) * 100).toFixed(1)}% 更长</span>` : '最优 ✓')],
      ]);
      $('as-queue').innerHTML = queueHTML(st.qtop);
    },
  });
  epsEl.oninput = () => { $('as-eps-val').textContent = (+epsEl.value).toFixed(1); demo.reset(); };
  $('as-eps-val').textContent = (+epsEl.value).toFixed(1);
  $('as-heat').onchange = () => { demo.showHeat = $('as-heat').checked; demo.render(); };
}

function setupBidir() {
  new SearchDemo({
    canvas: $('bi-canvas'), controls: $('bi-controls'), log: $('bi-log'), bidir: true,
    makeGen: () => bidirGen(app.g, app.s, app.t),
    renderStats(d) {
      const st = d.st, ref = getRefs();
      let nf = 0, nb = 0; for (const x of st.side) { if (x === 1) nf++; else if (x === 2) nb++; }
      const cond = st.topF + st.topB;
      $('bi-stats').innerHTML = statsHTML([
        ['正向已确定', nf, 'f'], ['反向已确定', nb, 'b'],
        ['展开次数（两侧合计）', st.nS], ['唯一确定路口', st.nU || nf + nb - 0, 'muted'],
        ['Dijkstra 需确定', ref.dj.nS, 'muted'], ['松弛次数', st.nR],
        ['当前 μ', fmt(st.mu) + (st.mu < Infinity ? ' min' : '')],
        ['min Q_f + min Q_b', `${fmt(st.topF)} + ${fmt(st.topB)} = ${fmt(cond)}`],
        ['终止判定', st.finished ? '已终止 ✓' : (cond >= st.mu && st.mu < Infinity ? '满足' : '未满足：继续'), st.finished ? 'ok' : ''],
        ['最短耗时', st.finished ? fmt(st.cost) + ' min' : '…', st.finished ? 'ok' : ''],
      ]);
    },
  });
}

function setupALT() {
  const kEl = $('alt-k');
  const demo = new SearchDemo({
    canvas: $('alt-canvas'), controls: $('alt-controls'), log: $('alt-log'),
    prepare(d) { d.alt = getALT(+kEl.value); d.h = altHeuristic(d.alt, app.t); d.heat = heatOf(d.h); d.eps = 1; },
    makeGen: d => dijkstraGen(app.g, app.s, app.t, { h: d.h }),
    landmarks: d => d.alt.lms,
    renderStats(d) {
      const st = d.st, ref = getRefs();
      const hS = d.h(app.s), real = ref.dj.cost;
      $('alt-stats').innerHTML = statsHTML([
        ['已确定节点', st.nS], ['欧氏 A* 需确定', ref.astar.nS, 'muted'], ['Dijkstra 需确定', ref.dj.nS, 'muted'],
        ['松弛次数', st.nR],
        ['起点处下界 h(s)', `${fmt(hS)} min（真实 ${fmt(real)}，占 ${(hS / real * 100).toFixed(0)}%）`],
        ['欧氏下界 h(s)', `${fmt(euclidTimeHeuristic(app.g, app.t)(app.s))} min（占 ${(euclidTimeHeuristic(app.g, app.t)(app.s) / real * 100).toFixed(0)}%）`, 'muted'],
        ['最短耗时', st.finished ? fmt(st.cost) + ' min' : '…', st.finished ? 'ok' : ''],
      ]);
    },
  });
  kEl.onchange = () => demo.reset();
  $('alt-heat').onchange = () => { demo.showHeat = $('alt-heat').checked; demo.render(); };
}

/* ---------- 玩具图上的 CH 逐帧讲解 ---------- */
function setupToy() {
  const g = toyGraph();
  g.adj = Array.from({ length: g.nodes.length }, () => []);
  for (const e of g.edges) { g.adj[e.u].push({ to: e.v, w: e.w, eid: e.id }); g.adj[e.v].push({ to: e.u, w: e.w, eid: e.id }); }
  const s = 0, t = 6;
  const { frames } = toyCHFrames(g, s, t);
  const tc = new ToyCanvas($('toy-canvas'), g);
  let i = 0, timer = null;
  const render = () => {
    const f = frames[i];
    tc.draw(f, s, t);
    $('toy-text').innerHTML = f.text;
    $('toy-step').textContent = `${i + 1} / ${frames.length}`;
    $('toy-phase').textContent = f.phase === 'pre' ? '阶段：预处理（收缩 + 加捷径）' : '阶段：查询（双向、只向上）';
    $('toy-phase').className = 'badge ' + f.phase;
  };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; $('toy-auto').textContent = '▶ 自动播放'; } };
  $('toy-prev').onclick = () => { stop(); i = Math.max(0, i - 1); render(); };
  $('toy-next').onclick = () => { stop(); i = Math.min(frames.length - 1, i + 1); render(); };
  $('toy-restart').onclick = () => { stop(); i = 0; render(); };
  $('toy-jump').onclick = () => { stop(); i = frames.findIndex(f => f.phase === 'query'); render(); };
  $('toy-auto').onclick = () => {
    if (timer) return stop();
    $('toy-auto').textContent = '⏸ 停止';
    timer = setInterval(() => { if (i >= frames.length - 1) return stop(); i++; render(); }, 1600);
  };
  render();
}

/* ---------- 路网上的 CH：预处理动画 + 查询动画 ---------- */
class CHDemo {
  constructor() {
    this.rc = new RoadCanvas($('ch-canvas'), app.g, { onStart: setStart, onGoal: setGoal, onHover: (v, e, evt) => this.hover(v, evt) });
    this.prePlayer = new Player({ makeGen: () => this.ch.preprocessGen(), onEvent: ev => this.handlePre(ev), onFrame: () => this.render(), onFinish: () => { this.phase = 'ready'; this.render(); } });
    this.qPlayer = new Player({ makeGen: () => { if (this.phase === 'pre') this.prePlayer.runToEnd(); this.phase = 'query'; return this.ch.queryGen(app.s, app.t); }, onEvent: ev => this.handleQ(ev), onFrame: () => this.render(), onFinish: () => this.render() });
    buildControls($('ch-pre-controls'));
    $('ch-pre-controls').querySelector('input[type=range]').value = 35;   // 预处理默认慢一点，便于观察
    bindPlayer($('ch-pre-controls'), this.prePlayer, kind => { if (kind === 'reset') this.resetAll(); this.render(); });
    buildControls($('ch-q-controls'));
    bindPlayer($('ch-q-controls'), this.qPlayer, kind => { if (kind === 'reset') this.resetQuery(); this.render(); });
    this.resetAll();
    app.demos.push(this);
  }
  resetAll() {
    this.prePlayer.reset(); this.qPlayer.reset();
    this.ch = new CH(app.g); this.phase = 'pre';
    this.pre = { current: -1, newShortcuts: [], count: 0, last: null };
    this.resetQState();
  }
  resetQState() {
    const n = app.g.nodes.length;
    this.q = { side: new Uint8Array(n), inQ: new Uint8Array(n), dist: [new Float64Array(n).fill(Infinity), new Float64Array(n).fill(Infinity)],
      current: -1, hlEdge: null, path: null, cost: Infinity, nS: 0, nR: 0, mu: Infinity, topF: Infinity, topB: Infinity, meet: -1, unpack: 0, chLen: 0, finished: false };
    this.qlog = [];
  }
  resetQuery() { this.qPlayer.reset(); this.resetQState(); if (this.phase === 'query') this.phase = 'ready'; }
  onGraphChanged() { this.rc.setGraph(app.g); this.resetAll(); this.render(); }
  onQueryChanged() { this.resetQuery(); this.render(); }
  addLog(s) { this.qlog.push(s); if (this.qlog.length > 7) this.qlog.shift(); }
  handlePre(ev) {
    if (ev.type === 'contract') { this.pre.current = ev.v; this.pre.newShortcuts = ev.shortcuts; this.pre.count = ev.rank + 1; this.pre.last = ev; }
    else { this.pre.current = -1; this.pre.newShortcuts = []; }
  }
  handleQ(ev) {
    const q = this.q; q.current = -1; q.hlEdge = null;
    switch (ev.type) {
      case 'init': q.inQ[ev.s] = 1; q.inQ[ev.t] = 2; this.addLog('查询开始：正向从起点、反向从终点，都只允许走向 rank 更高的节点。'); break;
      case 'settle':
        q.side[ev.u] = ev.side + 1; q.inQ[ev.u] = 0; q.current = ev.u; q.dist[ev.side][ev.u] = ev.d; q.nS = ev.nS; q.nR = ev.nR; q.mu = ev.mu; q.topF = ev.topF; q.topB = ev.topB;
        this.addLog(`${SIDE_NAME[ev.side]}弹出 #${ev.u}（d=${fmt(ev.d)}，rank ${ev.rank}），只松弛向上的边。`); break;
      case 'relax':
        q.current = ev.u; q.hlEdge = { u: ev.u, v: ev.v, improved: ev.improved }; q.nR = ev.nR;
        if (ev.improved) { q.inQ[ev.v] = ev.side + 1; q.dist[ev.side][ev.v] = ev.nd; }
        this.addLog(`${SIDE_NAME[ev.side]}松弛 #${ev.u}→#${ev.v}${ev.isShortcut ? '<span class="sc">捷径</span>' : ''}：${fmt(ev.du)} + ${fmt(ev.w)} = ${fmt(ev.nd)} ${ev.improved ? `&lt; ${fmt(ev.old)} ⇒ 更新` : `≥ ${fmt(ev.old)} ⇒ 不更新`}`); break;
      case 'meet': q.mu = ev.mu; q.meet = ev.u; this.addLog(`#${ev.u} 被两侧触达：μ = ${fmt(ev.dF)} + ${fmt(ev.dB)} = <b>${fmt(ev.mu)}</b>`); break;
      case 'stopside': this.addLog(`${SIDE_NAME[ev.side]}${ev.top === Infinity ? '队列已空' : `队首 ${fmt(ev.top)} ≥ μ=${fmt(ev.mu)}`}，该方向停止。`); break;
      case 'chpath': q.path = ev.path; q.chLen = ev.path.length; q.cost = ev.cost; q.nS = ev.nS; q.nR = ev.nR; this.addLog(`层次图上的路径有 ${ev.path.length} 个节点（含捷径，虚线弧），长 ${fmt(ev.cost)} min。开始展开捷径……`); break;
      case 'unpack': q.path = ev.path; q.unpack++; this.addLog(`展开捷径 (#${ev.a}, #${ev.b}) → 经中间点 #${ev.mid}；路径现在 ${ev.path.length} 个节点。`); break;
      case 'done': q.path = ev.path; q.cost = ev.cost; q.finished = true; this.addLog(`<b>完成</b>：真实路径 ${ev.path.length} 个节点，耗时 ${fmt(ev.cost)} min；双向共确定 ${ev.nS} 个节点、松弛 ${ev.nR} 次。`); break;
    }
  }
  render() {
    const ch = this.ch, n = app.g.nodes.length;
    if (this.phase === 'pre') {
      this.rc.draw({ contracted: ch.contracted, fadeContracted: true, shortcuts: ch.shortcuts, newShortcuts: this.pre.newShortcuts, focus: this.pre.current, s: app.s, t: app.t });
      const L = this.pre.last;
      $('ch-stats').innerHTML = statsHTML([
        ['已收缩节点', `${this.pre.count} / ${n}`], ['累计捷径', ch.nShortcuts],
        ['正在收缩', L ? `#${L.v}` : '—'],
        ['它的未收缩邻居', L ? L.deg : '—'], ['本次新增捷径', L ? L.shortcuts.length : '—'],
        ['边差 ED', L ? `${L.shortcuts.length} − ${L.deg} = ${L.ed}` : '—'],
        ['优先级 ED+已收缩邻居', L ? `${L.ed} + ${L.cn} = ${L.p}` : '—'],
      ]);
      $('ch-phase').textContent = this.pre.count >= n ? '预处理完成，可以查询' : '阶段 1：预处理（收缩节点、加捷径）';
      $('ch-log').innerHTML = L ? `<div class="new">收缩 #${L.v}：邻居对两两做见证搜索，需要 ${L.shortcuts.length} 条捷径${L.shortcuts.length ? '：' + L.shortcuts.map(s => `(#${s.u},#${s.w}) ${fmt(s.wt)}`).join('，') : ''}。</div>` : '<div class="muted">点"播放"观看收缩过程（紫色虚线 = 新加的捷径，变淡 = 已收缩）。也可"直接出结果"跳过。</div>';
    } else {
      const q = this.q;
      this.rc.draw({ rank: ch.rank, rankSize: true, shortcuts: ch.shortcuts, shortcutAlpha: 0.18, side: q.side, inQ: q.inQ, current: q.current, hlEdge: q.hlEdge, path: q.path, isShortcut: (a, b) => ch.isShortcut(a, b), s: app.s, t: app.t });
      let nf = 0, nb = 0; for (const x of q.side) { if (x === 1) nf++; else if (x === 2) nb++; }
      const ref = getRefs();
      $('ch-stats').innerHTML = statsHTML([
        ['捷径总数', ch.nShortcuts], ['正向已确定', nf, 'f'], ['反向已确定', nb, 'b'],
        ['Dijkstra 需确定', ref.dj.nS, 'muted'], ['松弛次数', q.nR],
        ['当前 μ', fmt(q.mu) + (q.mu < Infinity ? ' min' : '')],
        ['捷径展开步数', q.unpack],
        ['最短耗时', q.finished ? fmt(q.cost) + ' min' : '…', q.finished ? 'ok' : ''],
      ]);
      $('ch-phase').textContent = this.phase === 'ready' ? '阶段 2：查询（预处理已完成；节点越大 rank 越高）' : (q.finished ? '查询完成' : '阶段 2：查询进行中');
      $('ch-log').innerHTML = logHTML(this.qlog);
    }
  }
  hover(v, evt) {
    if (v < 0) return hideTip();
    const r = this.ch.rank[v];
    let html = `<b>节点 #${v}</b><br>rank = ${r >= 0 ? r : '未收缩'}`;
    if (this.phase !== 'pre') html += `<br>d_f = ${fmt(this.q.dist[0][v])}，d_b = ${fmt(this.q.dist[1][v])}`;
    let up = 0, tot = 0; for (const [x] of this.ch.adj[v]) { tot++; if (this.ch.rank[x] > r) up++; }
    html += `<br>邻边 ${tot} 条，其中向上 ${up} 条`;
    showTip(evt, html);
  }
}

/* ---------- 时变权重 / 实时路况 ---------- */
function congestionColor(m) {
  const x = Math.max(0, Math.min(1, (0.9 - m) / 0.7));   // 0 畅通 → 1 严重拥堵
  const c0 = [250, 204, 21], c1 = [185, 28, 28];
  const c = c0.map((a, i) => Math.round(a + (c1[i] - a) * x));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
class TrafficDemo {
  constructor() {
    this.rc = new RoadCanvas($('td-canvas'), app.g, {
      onStart: setStart, onGoal: setGoal, edgeHover: true,
      onHover: (v, e, evt) => {
        if (e < 0) return hideTip();
        const ed = app.g.edges[e], h = this.hour(), m = tdMultiplier(ed.cls, h);
        showTip(evt, `<b>${ROAD_CLASS[ed.cls].name}</b> #${ed.u}—#${ed.v}<br>${hhmm(h)} 速度倍率 m = ${m.toFixed(2)}<br>畅通耗时 ${fmt(ed.w, 2)} min → 此刻 <b>${fmt(tdEdgeTime(ed, h), 2)} min</b>`);
      },
    });
    this.slider = $('td-time');
    this.slider.oninput = () => this.update();
    this.chart = $('td-chart');
    const dpr = window.devicePixelRatio || 1;
    this.chart.width = 420 * dpr; this.chart.height = 150 * dpr;
    this.cctx = this.chart.getContext('2d'); this.cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    app.demos.push(this);
    this.update();
  }
  hour() { return +this.slider.value; }
  onGraphChanged() { this.rc.setGraph(app.g); this.update(); }
  onQueryChanged() { this.update(); }
  update() {
    const h = this.hour(), g = app.g;
    this.res = tdDijkstra(g, app.s, app.t, h);
    this.free = getRefs().dj;
    this.freeTD = evalPathTD(g, this.free.path, h);
    const same = this.res.path.length === this.free.path.length && this.res.path.every((x, i) => x === this.free.path[i]);
    this.rc.draw({
      edgeColor: e => { const m = tdMultiplier(e.cls, h); return m > 0.88 ? null : { color: congestionColor(m), width: ROAD_CLASS[e.cls].width + 1.2 }; },
      path: this.res.path, path2: same ? null : this.free.path, s: app.s, t: app.t,
    });
    $('td-time-val').textContent = hhmm(h);
    $('td-stats').innerHTML = statsHTML([
      ['出发时刻', hhmm(h)], ['时变最短路（绿）', `${fmt(this.res.minutes)} min → ${hhmm(h + this.res.minutes / 60)} 到达`, 'ok'],
      ['畅通最短路（灰虚线）此刻实际', `${fmt(this.freeTD)} min`], ['畅通时的耗时', `${fmt(this.free.cost)} min`, 'muted'],
      ['两条路线', same ? '相同' : `<span class="warn">不同</span>，改道省 ${fmt(this.freeTD - this.res.minutes)} min`],
      ['快速路此刻倍率', tdMultiplier('highway', h).toFixed(2)],
    ]);
    this.drawChart(h);
  }
  drawChart(h) {
    const ctx = this.cctx, W = 420, H = 150, L = 34, R = 8, T = 10, B = 24;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    const X = t => L + (W - L - R) * t / 24, Y = m => T + (H - T - B) * (1 - m);
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
    for (const m of [0, 0.5, 1]) { ctx.beginPath(); ctx.moveTo(L, Y(m)); ctx.lineTo(W - R, Y(m)); ctx.stroke(); }
    ctx.fillStyle = '#64748b'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const m of [0, 0.5, 1]) ctx.fillText(m.toFixed(1), L - 4, Y(m));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let t = 0; t <= 24; t += 6) ctx.fillText(t + ':00', X(t), H - B + 4);
    for (const cls of ['highway', 'arterial', 'local']) {
      ctx.strokeStyle = ROAD_CLASS[cls].color === '#d6dde6' ? '#94a3b8' : ROAD_CLASS[cls].color; ctx.lineWidth = cls === 'highway' ? 2.5 : 1.6;
      if (cls === 'local') ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (let t = 0; t <= 24; t += 0.1) { const x = X(t), y = Y(tdMultiplier(cls, t)); t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(h), T); ctx.lineTo(X(h), H - B); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#0f172a'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('速度倍率 m(τ)', L + 4, T);
  }
}

/* ---------- 对比表 ---------- */
function setupCompare() {
  $('cmp-run').onclick = () => {
    const g = app.g, s = app.s, t = app.t;
    const rows = [];
    const time = fn => { const t0 = performance.now(); const r = fn(); return [r, performance.now() - t0]; };
    let [dj, tdj] = time(() => runGen(dijkstraGen(g, s, t)));
    rows.push(['Dijkstra', '无', dj.nS, dj.nR, dj.cost, tdj, dj.nU]);
    let [as, tas] = time(() => runGen(dijkstraGen(g, s, t, { h: euclidTimeHeuristic(g, t) })));
    rows.push(['A*（欧氏/最高限速）', '无', as.nS, as.nR, as.cost, tas, as.nU]);
    let [bi, tbi] = time(() => runGen(bidirGen(g, s, t)));
    rows.push(['双向 Dijkstra', '无', bi.nS, bi.nR, bi.cost, tbi, bi.nU]);
    const alt = getALT(4);
    let [al, tal] = time(() => runGen(dijkstraGen(g, s, t, { h: altHeuristic(alt, t) })));
    rows.push(['ALT（4 个地标）', '4 次全图 Dijkstra，存 4×|V| 个距离', al.nS, al.nR, al.cost, tal, al.nU]);
    const [tAlt] = [0];
    const [ch, tpre] = time(() => new CH(g).preprocess());
    let [cq, tcq] = time(() => runGen(ch.queryGen(s, t)));
    rows.push(['CH 收缩层次', `收缩 ${g.nodes.length} 个节点，加 ${ch.nShortcuts} 条捷径（${tpre.toFixed(0)} ms）`, cq.nS, cq.nR, cq.cost, tcq, cq.nU]);
    /* 口径说明：展开次数 = 从队列弹出并确定的次数（双向/CH 同一路口可能两侧各算一次）；唯一路口 = 被任一方向确定过的不同路口数 */
    const uniq = r => r[6] != null ? r[6] : r[2];
    const maxS = Math.max(...rows.map(r => r[2]));
    /* 30 组随机起终点上的平均每次查询耗时（ms），用于"预处理值不值"的收支平衡估算 */
    const rnd = mulberry32(g.seed + 99), Q = [];
    while (Q.length < 30) { const a = Math.floor(rnd() * g.nodes.length), b = Math.floor(rnd() * g.nodes.length); if (a !== b) Q.push([a, b]); }
    const avgMs = fn => { const t0 = performance.now(); for (const [a, b] of Q) fn(a, b); return (performance.now() - t0) / Q.length; };
    const msDj = avgMs((a, b) => runGen(dijkstraGen(g, a, b)));
    const msAs = avgMs((a, b) => runGen(dijkstraGen(g, a, b, { h: euclidTimeHeuristic(g, b) })));
    const msBi = avgMs((a, b) => runGen(bidirGen(g, a, b)));
    const t0a = performance.now(); const alt2 = computeLandmarks(g, 4); const preAlt = performance.now() - t0a;
    const msAl = avgMs((a, b) => runGen(dijkstraGen(g, a, b, { h: altHeuristic(alt2, b) })));
    const msCh = avgMs((a, b) => runGen(ch.queryGen(a, b)));
    const extra = {
      'Dijkstra': ['—', '—', msDj, '—'],
      'A*（欧氏/最高限速）': ['—', '—', msAs, '—'],
      '双向 Dijkstra': ['—', '—', msBi, '—'],
      'ALT（4 个地标）': [preAlt, `${4 * g.nodes.length} 个距离（${(4 * g.nodes.length * 8 / 1024).toFixed(0)} KB）`, msAl, msDj > msAl ? Math.ceil(preAlt / (msDj - msAl)) + ' 次' : '永不（单次没省到时间）'],
      'CH 收缩层次': [tpre, `${ch.nShortcuts} 条捷径（约 ${(ch.nShortcuts * 24 / 1024).toFixed(0)} KB）`, msCh, msDj > msCh ? Math.ceil(tpre / (msDj - msCh)) + ' 次' : '永不'],
    };
    $('cmp-table').innerHTML = `<table><thead><tr><th>算法</th><th>展开次数</th><th>唯一确定路口</th><th>松弛次数</th><th>路径耗时</th><th>相对 Dijkstra</th><th>预处理耗时</th><th>额外存储</th><th>每次查询 ms<br><span class="muted">(30 组随机平均)</span></th><th>收支平衡<br><span class="muted">(查几次回本)</span></th></tr></thead><tbody>` +
      rows.map(r => { const x = extra[r[0]]; return `<tr><td>${r[0]}</td><td><div class="bar"><i style="width:${(r[2] / maxS * 100).toFixed(0)}%"></i><span>${r[2]}</span></div></td><td>${uniq(r)}</td><td>${r[3]}</td><td>${fmt(r[4])} min</td><td>${(r[2] / dj.nS * 100).toFixed(0)}%</td><td>${typeof x[0] === 'number' ? x[0].toFixed(0) + ' ms' : x[0]}</td><td class="small">${x[1]}</td><td>${x[2].toFixed(3)}</td><td>${x[3]}</td></tr>`; }).join('') +
      `</tbody></table><p class="muted small">起点 #${s} → 终点 #${t}，所有算法算出的最短耗时一致（${fmt(dj.cost)} min）才算正确。<b>口径</b>：展开次数 = 从队列弹出并确定的次数（双向/CH 同一路口可能两侧各计一次）；唯一确定路口 = 被任一方向确定过的不同路口数。本页路网仅 ${g.nodes.length} 个节点，毫秒级耗时噪声很大（同一机器前后两次可差一倍），"收支平衡"只看数量级：预处理一次的时间除以每次查询省下的时间，就是查多少次才回本。</p>`;
  };
}

/* ---------- 公式渲染 / 导航高亮 ---------- */
function renderMath() {
  if (!window.renderMathInElement) { document.body.classList.add('no-katex'); return; }
  renderMathInElement(document.body, {
    delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\(', right: '\\)', display: false }],
    throwOnError: false,
  });
}
function setupNav() {
  const links = [...document.querySelectorAll('#nav a')];
  const secs = links.map(a => document.querySelector(a.getAttribute('href')));
  const io = new IntersectionObserver(entries => {
    for (const en of entries) if (en.isIntersecting) { links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + en.target.id)); }
  }, { rootMargin: '-30% 0px -60% 0px' });
  secs.forEach(s => s && io.observe(s));
}

document.addEventListener('DOMContentLoaded', () => {
  renderMath();
  newGraph(app.seed);
  setupModel();
  setupDijkstra();
  setupAstar();
  setupBidir();
  setupALT();
  setupToy();
  new CHDemo();
  new TrafficDemo();
  setupCompare();
  setupNav();
  for (const d of app.demos) d.render && d.render();
});
