'use strict';
/* 一致性自检：node test/check.js
 * A. 模拟路网：Dijkstra / A* / 双向 / ALT / CH 在随机起终点上的最短耗时必须一致；CH 展开路径代价 = μ；
 *    启发式一致性；时变权重 FIFO；玩具图 CH 查询结果等于 Dijkstra
 * B. 米兰真实路网回归：固定查询（大教堂 → 中央车站）的耗时与各算法展开次数
 * C. 边界：起点 == 终点、不可达（两个连通分量）、ALT 地标落在另一分量时不产生 NaN
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
global.window = {};
for (const f of ['js/core.js', 'js/algos.js', 'js/ch.js', 'js/map/citygraph.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; process.exitCode = 1; } };
const near = (a, b) => Math.abs(a - b) < 1e-6;

/* ---------------- A. 模拟路网 ---------------- */
for (const seed of [20261020, 7, 12345]) {
  const g = buildRoadNetwork(seed);
  const n = g.nodes.length;
  console.log(`seed ${seed}: ${n} nodes, ${g.edges.length} edges`);
  const t0 = Date.now();
  const ch = new CH(g).preprocess();
  const tCH = Date.now() - t0;
  const alt = computeLandmarks(g, 4);
  console.log(`  CH 预处理 ${tCH} ms, 捷径 ${ch.nShortcuts}, 地标 ${alt.lms.join(',')}`);
  const rnd = mulberry32(seed + 1);
  let sum = { dj: 0, as: 0, bi: 0, alt: 0, ch: 0 }, q = 0;
  for (let k = 0; k < 40; k++) {
    const s = Math.floor(rnd() * n), t = Math.floor(rnd() * n);
    if (s === t) continue;
    q++;
    const dj = runGen(dijkstraGen(g, s, t));
    const as = runGen(dijkstraGen(g, s, t, { h: euclidTimeHeuristic(g, t) }));
    const bi = runGen(bidirGen(g, s, t));
    const al = runGen(dijkstraGen(g, s, t, { h: altHeuristic(alt, t) }));
    const c = runGen(ch.queryGen(s, t));
    ok(near(dj.cost, as.cost), `A* cost ${as.cost} != ${dj.cost} (s=${s},t=${t})`);
    ok(near(dj.cost, bi.cost), `bidir cost ${bi.cost} != ${dj.cost} (s=${s},t=${t})`);
    ok(near(dj.cost, al.cost), `ALT cost ${al.cost} != ${dj.cost} (s=${s},t=${t})`);
    ok(near(dj.cost, c.cost), `CH cost ${c.cost} != ${dj.cost} (s=${s},t=${t})`);
    ok(near(pathCost(g, dj.path), dj.cost), `dijkstra path cost mismatch`);
    ok(near(pathCost(g, bi.path), bi.cost), `bidir path cost mismatch`);
    ok(near(pathCost(g, c.path), c.cost), `CH unpacked path cost ${pathCost(g, c.path)} != ${c.cost}`);
    ok(c.path[0] === s && c.path[c.path.length - 1] === t, 'CH path endpoints');
    ok(bi.nU <= bi.nS && c.nU <= c.nS && bi.nU > 0, '唯一路口数不应超过展开次数');
    const hA = altHeuristic(alt, t), hE = euclidTimeHeuristic(g, t);
    for (const e of g.edges) {
      ok(hA(e.u) <= e.w + hA(e.v) + 1e-9 && hA(e.v) <= e.w + hA(e.u) + 1e-9, 'ALT 启发式不一致');
      ok(hE(e.u) <= e.w + hE(e.v) + 1e-9 && hE(e.v) <= e.w + hE(e.u) + 1e-9, 'Euclid 启发式不一致');
    }
    sum.dj += dj.nS; sum.as += as.nS; sum.bi += bi.nS; sum.alt += al.nS; sum.ch += c.nS;
  }
  console.log(`  平均展开次数: Dijkstra ${(sum.dj / q).toFixed(1)}  A* ${(sum.as / q).toFixed(1)}  双向 ${(sum.bi / q).toFixed(1)}  ALT ${(sum.alt / q).toFixed(1)}  CH ${(sum.ch / q).toFixed(1)}`);
  for (const e of g.edges.slice(0, 50)) {
    for (let tau = 0; tau < 24; tau += 0.1) {
      const a = tau * 60 + tdEdgeTime(e, tau), b = (tau + 0.1) * 60 + tdEdgeTime(e, tau + 0.1);
      ok(a <= b + 1e-9, `FIFO 违反 edge ${e.id} tau ${tau}`);
    }
  }
  const td = tdDijkstra(g, 0, n - 1, 8.5);
  ok(near(evalPathTD(g, td.path, 8.5), td.minutes), 'TD 路径评估不一致');
  const tdg = runGen(tdDijkstraGen(g, 0, n - 1, 8.5));
  ok(near(tdg.cost, td.minutes), 'tdDijkstraGen 与 tdDijkstra 不一致');
}

/* 玩具图 */
{
  const tg = toyGraph();
  tg.adj = Array.from({ length: tg.nodes.length }, () => []);
  for (const e of tg.edges) { tg.adj[e.u].push({ to: e.v, w: e.w, eid: e.id }); tg.adj[e.v].push({ to: e.u, w: e.w, eid: e.id }); }
  const { frames, ch: tch } = toyCHFrames(tg, 0, 6);
  const ref = runGen(dijkstraGen(tg, 0, 6));
  const last = frames[frames.length - 1];
  console.log(`玩具图: ${frames.length} 帧, 收缩顺序 ${tch.order.map(v => tg.nodes[v].label).join('→')}, 捷径 ${tch.nShortcuts}`);
  ok(near(pathCost(tg, last.snap.q.path), ref.cost), `玩具图 CH 结果 ${pathCost(tg, last.snap.q.path)} != ${ref.cost}`);
  ok(!frames.some(f => /不连通\)/.test(f.text)), '玩具图文案不应把"搜不到见证"说成"不连通"');
}

/* ---------------- B. 米兰真实路网回归 ---------------- */
{
  vm.runInThisContext(fs.readFileSync(path.join(root, 'data/milan.js'), 'utf8'), { filename: 'data/milan.js' });
  const g = buildCityGraph(window.CITY_DATA);
  const s = g.nearestNode(...g.xyOf(45.4642, 9.1900), 400), t = g.nearestNode(...g.xyOf(45.4862, 9.2040), 500);
  console.log(`米兰: ${g.nodes.length} 路口, ${g.edges.length} 路段; 大教堂 #${s} → 中央车站 #${t}`);
  const t0 = Date.now(); const ch = new CH(g).preprocess(); const chMs = Date.now() - t0;
  const lm = computeLandmarks(g, 8);
  const R = {
    dijkstra: runGen(dijkstraGen(g, s, t)),
    astar: runGen(dijkstraGen(g, s, t, { h: cityHeuristic(g, t) })),
    bidir: runGen(bidirGen(g, s, t)),
    alt: runGen(dijkstraGen(g, s, t, { h: altHeuristic(lm, t) })),
    ch: runGen(ch.queryGen(s, t)),
  };
  /* 回归基线（2026-10-21）：改动算法后若数值变化，需确认是预期的再更新 */
  const EXPECT = { cost: 7.9563, nodes: 4704, edges: 6412, pathNodes: 79, nS: { dijkstra: 3630, astar: 1150, bidir: 1408, alt: 394, ch: 108 } };
  ok(g.nodes.length === EXPECT.nodes && g.edges.length === EXPECT.edges, `米兰图规模 ${g.nodes.length}/${g.edges.length} != ${EXPECT.nodes}/${EXPECT.edges}`);
  ok(Math.abs(R.dijkstra.cost - EXPECT.cost) < 5e-4, `米兰基准耗时 ${R.dijkstra.cost} != ${EXPECT.cost}`);
  ok(R.dijkstra.path.length === EXPECT.pathNodes, `米兰基准路径节点数 ${R.dijkstra.path.length} != ${EXPECT.pathNodes}`);
  for (const k of Object.keys(R)) {
    ok(near(R[k].cost, R.dijkstra.cost), `米兰 ${k} 耗时 ${R[k].cost} != ${R.dijkstra.cost}`);
    ok(R[k].nS === EXPECT.nS[k], `米兰 ${k} 展开次数 ${R[k].nS} != 基线 ${EXPECT.nS[k]}`);
    ok(near(pathCost(g, R[k].path), R[k].cost), `米兰 ${k} 路径代价与报告不一致`);
  }
  ok(R.bidir.nU <= R.bidir.nS && R.ch.nU < R.ch.nS, `唯一路口不应超过展开次数（双向 ${R.bidir.nU}/${R.bidir.nS}，CH ${R.ch.nU}/${R.ch.nS}；CH 里相遇点两侧各计一次）`);
  console.log(`  耗时 ${R.dijkstra.cost.toFixed(4)} min, 路径 ${R.dijkstra.path.length} 点; 展开 Dijkstra ${R.dijkstra.nS} / A* ${R.astar.nS} / 双向 ${R.bidir.nS}(唯一 ${R.bidir.nU}) / ALT ${R.alt.nS} / CH ${R.ch.nS}(唯一 ${R.ch.nU}); CH 预处理 ${chMs} ms, 捷径 ${ch.nShortcuts}`);
  /* 时变：高峰期耗时应不低于畅通 */
  const tdq = runGen(tdDijkstraGen(g, s, t, 8.5));
  ok(tdq.cost >= R.dijkstra.cost - 1e-9, '米兰 8:30 出发的时变耗时不应低于畅通耗时');
  ok(g.searchStreets('corso buenos')[0] === 'Corso Buenos Aires', '街道名检索（忽略大小写/重音）');
  ok(g.nodeForStreet('Corso Buenos Aires') >= 0, '街道名 → 节点');
}

/* ---------------- C. 边界 ---------------- */
{
  /* 两个连通分量：0-1-2 和 3-4 */
  const nodes = [0, 1, 2, 3, 4].map(id => ({ id, x: id * 100, y: 0 }));
  const edges = [{ id: 0, u: 0, v: 1, w: 1 }, { id: 1, u: 1, v: 2, w: 1 }, { id: 2, u: 3, v: 4, w: 1 }];
  const adj = nodes.map(() => []);
  for (const e of edges) { adj[e.u].push({ to: e.v, w: e.w, eid: e.id }); adj[e.v].push({ to: e.u, w: e.w, eid: e.id }); }
  const g = { nodes, edges, adj };
  const ch = new CH(g).preprocess();
  const lm = computeLandmarks(g, 2);
  const h = altHeuristic(lm, 0);
  ok(lm.dists.some(d => !isFinite(d[0]) || !isFinite(d[3])), '构造的地标应落在不同分量（否则本用例无效）');
  ok([0, 1, 2, 3, 4].every(v => isFinite(h(v))), 'ALT 启发式在不连通图上不能是 NaN/∞');
  for (const [name, run] of [['Dijkstra', () => runGen(dijkstraGen(g, 0, 3))], ['A*', () => runGen(dijkstraGen(g, 0, 3, { h }))], ['双向', () => runGen(bidirGen(g, 0, 3))], ['CH', () => runGen(ch.queryGen(0, 3))], ['时变', () => runGen(tdDijkstraGen({ ...g, edges: edges.map(e => ({ ...e, len: 0.1, speed: 30, cls: 'residential' })) }, 0, 3, 8))]]) {
    const r = run();
    ok(r.cost === Infinity && r.path.length === 0, `${name} 不可达应返回 ∞ 与空路径，得到 ${r.cost} / ${r.path.length}`);
  }
  for (const [name, run] of [['Dijkstra', () => runGen(dijkstraGen(g, 2, 2))], ['A*', () => runGen(dijkstraGen(g, 2, 2, { h }))], ['双向', () => runGen(bidirGen(g, 2, 2))], ['CH', () => runGen(ch.queryGen(2, 2))]]) {
    const r = run();
    ok(r.cost === 0 && r.path.length === 1 && r.path[0] === 2, `${name} 起点=终点应返回 0 与单点路径，得到 ${r.cost} / ${JSON.stringify(r.path)}`);
  }
  ok(cmpDecimals(3.12, 3.14) === 2 && cmpDecimals(3.04, 3.06) === 1 && cmpDecimals(3.0, 3.0) === 1 && cmpDecimals(1.00004, 1.00005) === 4, 'cmpDecimals 精度选择');
  ok(sumDecimals(3.74, 1.72) === 2 && sumDecimals(3.0, 1.0) === 1, 'sumDecimals：显示的加数之和必须等于显示的和');
  { const a = 3.74, b = 1.72, d = sumDecimals(a, b); ok((Number(a.toFixed(d)) + Number(b.toFixed(d))).toFixed(d) === (a + b).toFixed(d), '3.74+1.72 显示一致'); }
  console.log('边界用例: 不可达 / 同点 / 不连通地标 通过');
}

console.log(fails ? `有 ${fails} 处失败` : '全部通过');
