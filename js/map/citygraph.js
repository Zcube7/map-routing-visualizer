'use strict';
/* =====================================================================
 *  citygraph.js —— 把 data/*.js 的城市数据装配成算法可用的图 + 空间索引
 * ===================================================================== */
const TD_CLASS_ALIAS = {
  motorway: 'highway', motorway_link: 'highway', trunk: 'highway', trunk_link: 'highway',
  primary: 'arterial', primary_link: 'arterial', secondary: 'arterial', secondary_link: 'arterial',
  tertiary: 'local', tertiary_link: 'local', residential: 'local', living_street: 'local', pedestrian: 'local',
};
const stripAccents = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function buildCityGraph(D) {
  const n = D.nodes.length / 2;
  const nodes = new Array(n);
  for (let i = 0; i < n; i++) nodes[i] = { id: i, x: D.nodes[2 * i], y: D.nodes[2 * i + 1] };
  const edges = [], renderEdges = [];
  const adj = Array.from({ length: n }, () => []);
  const rnd = mulberry32(20261020);
  let vmax = 0;
  for (const e of D.edges) {
    const [u, v, cls, lenM, speed, ni, oneway, pts] = e;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    const re = { cls, pts, name: ni >= 0 ? D.names[ni] : '', lenM, bbox: [minx, miny, maxx, maxy], edge: null };
    renderEdges.push(re);
    if (u >= 0) {
      const id = edges.length;
      const len = lenM / 1000, w = len / speed * 60;
      const ed = { id, u, v, cls, len, lenM, speed, w, name: re.name, pts, oneway, tf: 0.85 + rnd() * 0.3, bbox: re.bbox };
      edges.push(ed); re.edge = ed;
      adj[u].push({ to: v, w, eid: id }); adj[v].push({ to: u, w, eid: id });
      if (speed > vmax) vmax = speed;
    }
  }
  /* 节点网格索引 */
  const cell = 120, grid = new Map();
  const key = (cx, cy) => cx * 100003 + cy;
  for (const nd of nodes) {
    const k = key(Math.floor(nd.x / cell), Math.floor(nd.y / cell));
    let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(nd.id);
  }
  const g = { nodes, edges, adj, renderEdges, names: D.names, vmax, bounds: D.bounds, center: D.center, k: D.k,
    polys: D.polys, lines: D.lines, pois: D.pois, labels: D.labels, name: D.name };
  g.nearestNode = (x, y, maxD = 200) => {
    let best = -1, bd = maxD * maxD;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), r = Math.ceil(maxD / cell);
    for (let i = cx - r; i <= cx + r; i++) for (let j = cy - r; j <= cy + r; j++) {
      const a = grid.get(key(i, j)); if (!a) continue;
      for (const id of a) { const nd = nodes[id]; const d = (nd.x - x) ** 2 + (nd.y - y) ** 2; if (d < bd) { bd = d; best = id; } }
    }
    return best;
  };
  g.nodeStreets = v => { const s = new Set(); for (const e of adj[v]) { const nm = edges[e.eid].name; if (nm) s.add(nm); } return [...s]; };
  g.describeNode = v => { const s = g.nodeStreets(v); if (!s.length) return `路口 #${v}`; return s.length === 1 ? s[0] : `${s[0]} & ${s[1]}`; };
  /* 街道名检索 */
  const byName = new Map();
  for (const e of edges) { if (!e.name) continue; const cur = byName.get(e.name); if (!cur || e.lenM > cur.lenM) byName.set(e.name, e); }
  g.streetNames = [...byName.keys()].sort((a, b) => a.localeCompare(b));
  const normNames = g.streetNames.map(stripAccents);
  g.searchStreets = (q, limit = 6) => {
    q = stripAccents(q.trim()); if (!q) return [];
    const starts = [], contains = [];
    for (let i = 0; i < normNames.length; i++) {
      const l = normNames[i];
      if (l.startsWith(q)) starts.push(g.streetNames[i]);
      else if (l.includes(q)) contains.push(g.streetNames[i]);
      if (starts.length >= limit) break;
    }
    return starts.concat(contains).slice(0, limit);
  };
  g.nodeForStreet = nm => { const e = byName.get(nm); return e ? e.u : -1; };
  g.latLon = (x, y) => [D.center[0] - y / D.k[1], D.center[1] + x / D.k[0]];
  g.xyOf = (lat, lon) => [(lon - D.center[1]) * D.k[0], -(lat - D.center[0]) * D.k[1]];
  return g;
}
/* 欧氏启发式（分钟）：直线距离 / 全图最高限速 */
function cityHeuristic(g, t) {
  const T = g.nodes[t], v = g.vmax;
  return u => Math.hypot(g.nodes[u].x - T.x, g.nodes[u].y - T.y) / 1000 / v * 60;
}
