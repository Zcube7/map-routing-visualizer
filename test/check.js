'use strict';
/* 一致性自检：node test/check.js
 * 1) Dijkstra / A* / 双向 / ALT / CH 在随机起终点上的最短耗时必须一致
 * 2) CH 展开后的路径按原图权重累加必须等于 μ
 * 3) 玩具图逐帧讲解可生成，且查询结果等于原图 Dijkstra
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..', 'js');
for (const f of ['core.js', 'algos.js', 'ch.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } };
const near = (a, b) => Math.abs(a - b) < 1e-6;

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
    // 启发式一致性抽查：h(u) <= w(u,v) + h(v)
    const hA = altHeuristic(alt, t), hE = euclidTimeHeuristic(g, t);
    for (const e of g.edges) {
      ok(hA(e.u) <= e.w + hA(e.v) + 1e-9 && hA(e.v) <= e.w + hA(e.u) + 1e-9, 'ALT 启发式不一致');
      ok(hE(e.u) <= e.w + hE(e.v) + 1e-9 && hE(e.v) <= e.w + hE(e.u) + 1e-9, 'Euclid 启发式不一致');
    }
    sum.dj += dj.nS; sum.as += as.nS; sum.bi += bi.nS; sum.alt += al.nS; sum.ch += c.nS;
  }
  console.log(`  平均确定节点数: Dijkstra ${(sum.dj / q).toFixed(1)}  A* ${(sum.as / q).toFixed(1)}  双向 ${(sum.bi / q).toFixed(1)}  ALT ${(sum.alt / q).toFixed(1)}  CH ${(sum.ch / q).toFixed(1)}`);
  // 时变：FIFO 抽查 与 路径评估一致
  for (const e of g.edges.slice(0, 50)) {
    for (let tau = 0; tau < 24; tau += 0.1) {
      const a = tau * 60 + tdEdgeTime(e, tau), b = (tau + 0.1) * 60 + tdEdgeTime(e, tau + 0.1);
      ok(a <= b + 1e-9, `FIFO 违反 edge ${e.id} tau ${tau}`);
    }
  }
  const td = tdDijkstra(g, 0, n - 1, 8.5);
  ok(near(evalPathTD(g, td.path, 8.5), td.minutes), 'TD 路径评估不一致');
  const free = runGen(dijkstraGen(g, 0, n - 1));
  console.log(`  时变 8:30 出发: ${td.minutes.toFixed(1)} min (路径 ${td.path.length} 点); 畅通最短路在该时刻实际 ${evalPathTD(g, free.path, 8.5).toFixed(1)} min`);
}

/* 玩具图 */
const tg = toyGraph();
tg.adj = Array.from({ length: tg.nodes.length }, () => []);
for (const e of tg.edges) { tg.adj[e.u].push({ to: e.v, w: e.w, eid: e.id }); tg.adj[e.v].push({ to: e.u, w: e.w, eid: e.id }); }
const { frames, ch: tch } = toyCHFrames(tg, 0, 6);
const ref = runGen(dijkstraGen(tg, 0, 6));
const last = frames[frames.length - 1];
console.log(`玩具图: ${frames.length} 帧, 收缩顺序 ${tch.order.map(v => tg.nodes[v].label).join('→')}, 捷径 ${tch.nShortcuts}`);
console.log('  最后一帧:', last.text);
ok(near(pathCost(tg, last.snap.q.path), ref.cost), `玩具图 CH 结果 ${pathCost(tg, last.snap.q.path)} != ${ref.cost}`);
console.log(process.exitCode ? '有失败' : '全部通过');
