'use strict';
/* 在米兰数据里找适合做"引导案例"的起终点：node tools/find_case_pairs.js
 *  1) 双向搜索：第一次相遇的节点不在最终路线上（且首个 μ 明显大于最终 μ）
 *  2) 距离最短的路线比耗时最短的路线更慢
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
global.window = {};
for (const f of ['data/milan.js', 'js/core.js', 'js/algos.js', 'js/ch.js', 'js/map/citygraph.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}
const g = buildCityGraph(window.CITY_DATA);
const rnd = mulberry32(7);
const duomo = g.nearestNode(...g.xyOf(45.4642, 9.1900), 400);
const ll = v => g.latLon(g.nodes[v].x, g.nodes[v].y).map(x => x.toFixed(5)).join(', ');

console.log('--- 双向搜索：第一次相遇点不在最终路线上 ---');
const found = [];
for (let k = 0; k < 400 && found.length < 6; k++) {
  const s = k < 200 ? duomo : Math.floor(rnd() * g.nodes.length);
  const t = Math.floor(rnd() * g.nodes.length);
  if (s === t) continue;
  let firstMeet = -1, firstMu = Infinity, fin = null, meets = 0;
  for (const ev of bidirGen(g, s, t)) {
    if (ev.type === 'meet') { meets++; if (firstMeet < 0) { firstMeet = ev.u; firstMu = ev.mu; } }
    if (ev.type === 'done') fin = ev;
  }
  if (!fin || fin.cost < 4 || fin.cost > 12) continue;
  const onPath = fin.path.includes(firstMeet);
  if (!onPath && firstMu > fin.cost * 1.04) {
    found.push({ s, t, firstMeet, firstMu, cost: fin.cost, meets, nS: fin.nS });
    console.log(`s=${s} (${ll(s)}) t=${t} (${ll(t)}) ${g.describeNode(s)} → ${g.describeNode(t)} | 首次相遇 #${firstMeet} ${g.describeNode(firstMeet)} μ=${firstMu.toFixed(2)} → 最终 ${fin.cost.toFixed(2)} min，相遇更新 ${meets} 次，确定 ${fin.nS}`);
  }
}

console.log('--- 距离最短 vs 耗时最短 ---');
const adjD = g.adj.map(l => l.map(e => ({ to: e.to, w: g.edges[e.eid].lenM, eid: e.eid })));
const gD = { nodes: g.nodes, adj: adjD };
const lenOf = p => { let s = 0; for (let i = 0; i + 1 < p.length; i++) { const e = edgeBetween(g, p[i], p[i + 1]); s += g.edges[e.eid].lenM; } return s; };
const found2 = [];
for (let k = 0; k < 300 && found2.length < 6; k++) {
  const s = k < 150 ? duomo : Math.floor(rnd() * g.nodes.length);
  const t = Math.floor(rnd() * g.nodes.length);
  if (s === t) continue;
  const rt = runGen(dijkstraGen(g, s, t)), rd = runGen(dijkstraGen(gD, s, t));
  if (!rt.path.length || rt.cost < 4 || rt.cost > 12) continue;
  const tFast = rt.cost, tShort = pathCost(g, rd.path), lFast = lenOf(rt.path), lShort = rd.cost;
  if (lShort < lFast * 0.92 && tShort > tFast * 1.15) {
    found2.push({ s, t });
    console.log(`s=${s} (${ll(s)}) t=${t} (${ll(t)}) ${g.describeNode(s)} → ${g.describeNode(t)} | 最快 ${tFast.toFixed(1)} min / ${(lFast / 1000).toFixed(2)} km；最短 ${tShort.toFixed(1)} min / ${(lShort / 1000).toFixed(2)} km`);
  }
}
