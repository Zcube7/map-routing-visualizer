"""把 Overpass 下载的原始 OSM JSON 转成浏览器用的城市数据文件。

用法（原始文件是下载来的，用 -I 隔离运行）：
    python -I tools/build_city.py data/raw data/milan.js "Milano"

输出 window.CITY_DATA = {...}：
    nodes  : [x0,y0,x1,y1,...]            图节点（路口）坐标，米，相对 bbox 中心，y 向下
    edges  : [[u,v,cls,lenM,speed,nameIdx,oneway,[x,y,...]], ...]
             u/v = -1 表示只用于绘制、不进图（步行街、不连通的碎片）
    names  : 路名表
    polys  : {water:[...], park:[...], cemetery:[...], square:[...], building:[...]}
             每个多边形 = [ring, ring, ...]，第一个是外环，其余为内环（evenodd 填充）
    lines  : {rail:[[x,y,...]], waterway:[[x,y,...]]}
    pois   : [[x,y,name,kind], ...]
    labels : [[x,y,name,kind], ...]   公园/水域等面状要素的名字（放在质心）
"""
import json
import math
import sys
from collections import defaultdict

RAW, OUT, CITY = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else 'City')

CLASS_MAP = {
    'motorway': 'motorway', 'motorway_link': 'motorway_link',
    'trunk': 'trunk', 'trunk_link': 'trunk_link',
    'primary': 'primary', 'primary_link': 'primary_link',
    'secondary': 'secondary', 'secondary_link': 'secondary_link',
    'tertiary': 'tertiary', 'tertiary_link': 'tertiary_link',
    'unclassified': 'residential', 'residential': 'residential', 'living_street': 'living_street',
    'pedestrian': 'pedestrian',
}
# 市区典型行驶速度（含路口等待的平均速度，比限速低；有 maxspeed 标签时取两者较小值）
DEFAULT_SPEED = {
    'motorway': 90, 'motorway_link': 55, 'trunk': 60, 'trunk_link': 45,
    'primary': 38, 'primary_link': 32, 'secondary': 32, 'secondary_link': 28,
    'tertiary': 27, 'tertiary_link': 24, 'residential': 22, 'living_street': 14, 'pedestrian': 5,
}
DRIVABLE = {c for c in DEFAULT_SPEED if c != 'pedestrian'}


def load(name):
    with open(f'{RAW}/{name}.json', encoding='utf-8') as f:
        return json.load(f)['elements']


def haversine(lat1, lon1, lat2, lon2):
    R = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ---------------- 道路 ----------------
roads = load('roads')
nodes_ll = {}
ways = []
for el in roads:
    if el['type'] == 'node':
        nodes_ll[el['id']] = (el['lat'], el['lon'])
    elif el['type'] == 'way':
        ways.append(el)

lats = [v[0] for v in nodes_ll.values()]
lons = [v[1] for v in nodes_ll.values()]
lat0, lon0 = (min(lats) + max(lats)) / 2, (min(lons) + max(lons)) / 2
KX = 111320.0 * math.cos(math.radians(lat0))
KY = 110574.0


def proj(lat, lon):
    return round((lon - lon0) * KX, 1), round(-(lat - lat0) * KY, 1)


def parse_speed(tags, cls):
    s = tags.get('maxspeed', '')
    try:
        v = int(''.join(ch for ch in s.split()[0] if ch.isdigit())) if s else 0
        if 'mph' in s:
            v = round(v * 1.609)
        if 5 <= v <= 130:
            return min(v, DEFAULT_SPEED[cls])
    except (ValueError, IndexError):
        pass
    return DEFAULT_SPEED[cls]


# 节点使用计数：被 ≥2 条路使用或是路的端点 → 图节点
usage = defaultdict(int)
for w in ways:
    seen = set()
    for nid in w['nodes']:
        if nid in seen:
            continue
        seen.add(nid)
        usage[nid] += 1
    usage[w['nodes'][0]] += 1
    usage[w['nodes'][-1]] += 1

names = {}
def name_idx(n):
    if not n:
        return -1
    if n not in names:
        names[n] = len(names)
    return names[n]

raw_edges = []   # (a_osm, b_osm, cls, lenM, speed, nameIdx, oneway, drivable, pts)
for w in ways:
    tags = w.get('tags', {})
    cls = CLASS_MAP.get(tags.get('highway'))
    if not cls:
        continue
    access = tags.get('access', '')
    motor = tags.get('motor_vehicle', '')
    drivable = cls in DRIVABLE and access not in ('private', 'no') and motor not in ('private', 'no')
    speed = parse_speed(tags, cls)
    oneway = 1 if tags.get('oneway') in ('yes', '1', 'true') else (-1 if tags.get('oneway') == '-1' else 0)
    ni = name_idx(tags.get('name'))
    nd = [x for x in w['nodes'] if x in nodes_ll]
    if len(nd) < 2:
        continue
    seg = [nd[0]]
    for nid in nd[1:]:
        seg.append(nid)
        if usage[nid] >= 2 or nid == nd[-1]:
            L = sum(haversine(*nodes_ll[seg[i]], *nodes_ll[seg[i + 1]]) for i in range(len(seg) - 1))
            pts = []
            for s in seg:
                x, y = proj(*nodes_ll[s])
                pts += [x, y]
            if L > 0:
                raw_edges.append((seg[0], seg[-1], cls, round(L, 1), speed, ni, oneway, drivable, pts))
            seg = [nid]

# 可行驶子图的最大连通分量
adj = defaultdict(list)
for i, e in enumerate(raw_edges):
    if e[7]:
        adj[e[0]].append(e[1]); adj[e[1]].append(e[0])
best = set()
seen_all = set()
for start in list(adj):
    if start in seen_all:
        continue
    comp = {start}; stack = [start]; seen_all.add(start)
    while stack:
        u = stack.pop()
        for v in adj[u]:
            if v not in seen_all:
                seen_all.add(v); comp.add(v); stack.append(v)
    if len(comp) > len(best):
        best = comp

node_index = {}
node_xy = []
for osm_id in sorted(best):
    node_index[osm_id] = len(node_xy) // 2
    x, y = proj(*nodes_ll[osm_id])
    node_xy += [x, y]

edges_out = []
n_graph = 0
for a, b, cls, L, speed, ni, oneway, drivable, pts in raw_edges:
    if drivable and a in node_index and b in node_index:
        edges_out.append([node_index[a], node_index[b], cls, L, speed, ni, oneway, pts]); n_graph += 1
    else:
        edges_out.append([-1, -1, cls, L, 0, ni, 0, pts])

# ---------------- 面状/线状要素 ----------------
def closed(nd):
    return len(nd) >= 4 and nd[0] == nd[-1]


def ring_xy(nd, ll):
    out = []
    for nid in nd:
        if nid in ll:
            x, y = proj(*ll[nid]); out += [x, y]
    return out


def assemble_rings(member_ways, ll):
    """把 relation 的成员 way 首尾相接拼成环"""
    segs = [list(w) for w in member_ways if len(w) >= 2]
    rings = []
    while segs:
        cur = segs.pop()
        changed = True
        while changed and cur[0] != cur[-1]:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]:
                    cur += s[1:]; segs.pop(i); changed = True; break
                if s[-1] == cur[-1]:
                    cur += list(reversed(s))[1:]; segs.pop(i); changed = True; break
                if s[-1] == cur[0]:
                    cur = s[:-1] + cur; segs.pop(i); changed = True; break
                if s[0] == cur[0]:
                    cur = list(reversed(s))[:-1] + cur; segs.pop(i); changed = True; break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(ring_xy(cur, ll))
    return rings


def centroid(ring):
    xs = ring[0::2]; ys = ring[1::2]
    return round(sum(xs) / len(xs), 1), round(sum(ys) / len(ys), 1)


def ring_area(ring):
    xs = ring[0::2]; ys = ring[1::2]; n = len(xs); a = 0.0
    for i in range(n):
        j = (i + 1) % n
        a += xs[i] * ys[j] - xs[j] * ys[i]
    return abs(a) / 2


polys = {'water': [], 'park': [], 'cemetery': [], 'square': [], 'building': []}
lines = {'rail': [], 'waterway': []}
pois = []
labels = []


def kind_of(tags):
    if tags.get('natural') == 'water' or tags.get('waterway') in ('riverbank',):
        return 'water'
    if tags.get('leisure') in ('park', 'garden', 'pitch', 'playground') or tags.get('landuse') in ('grass', 'forest'):
        return 'park'
    if tags.get('landuse') == 'cemetery':
        return 'cemetery'
    if tags.get('place') == 'square' or tags.get('landuse') == 'railway':
        return 'square'
    return None


POI_KIND = [('railway', 'station', 'station'), ('tourism', 'museum', 'museum'), ('tourism', 'attraction', 'attraction'),
            ('historic', 'castle', 'attraction'), ('historic', 'monument', 'attraction'), ('historic', 'church', 'church'),
            ('place', 'square', 'square')]

try:
    landuse = load('landuse')
except (FileNotFoundError, ValueError, KeyError) as exc:
    print('landuse.json unusable, skipping:', exc)
    landuse = []
ll2 = {el['id']: (el['lat'], el['lon']) for el in landuse if el['type'] == 'node'}
way_nodes = {el['id']: el['nodes'] for el in landuse if el['type'] == 'way'}
used_in_relation = set()
for el in landuse:
    if el['type'] == 'relation':
        tags = el.get('tags', {})
        k = kind_of(tags)
        if not k:
            continue
        outers = [way_nodes[m['ref']] for m in el['members'] if m['type'] == 'way' and m.get('role') in ('outer', '') and m['ref'] in way_nodes]
        inners = [way_nodes[m['ref']] for m in el['members'] if m['type'] == 'way' and m.get('role') == 'inner' and m['ref'] in way_nodes]
        for m in el['members']:
            if m['type'] == 'way':
                used_in_relation.add(m['ref'])
        rings = assemble_rings(outers, ll2)
        holes = assemble_rings(inners, ll2)
        if rings:
            polys[k].append(rings + holes)
            if tags.get('name') and k in ('water', 'park', 'cemetery'):
                big = max(rings, key=ring_area)
                if ring_area(big) > 8000:
                    labels.append([*centroid(big), tags['name'], k])
for el in landuse:
    if el['type'] == 'node':
        tags = el.get('tags', {})
        for key, val, kind in POI_KIND:
            if tags.get(key) == val and tags.get('name'):
                x, y = proj(el['lat'], el['lon'])
                pois.append([x, y, tags['name'], kind]); break
    elif el['type'] == 'way':
        tags = el.get('tags', {})
        nd = el['nodes']
        if tags.get('railway') in ('rail', 'light_rail'):
            lines['rail'].append(ring_xy(nd, ll2)); continue
        if tags.get('waterway') in ('river', 'canal') and not closed(nd):
            lines['waterway'].append(ring_xy(nd, ll2)); continue
        if el['id'] in used_in_relation:
            continue
        k = kind_of(tags)
        if k and closed(nd):
            ring = ring_xy(nd, ll2)
            polys[k].append([ring])
            if tags.get('name') and k in ('water', 'park', 'cemetery') and ring_area(ring) > 8000:
                labels.append([*centroid(ring), tags['name'], k])
            if tags.get('place') == 'square' and tags.get('name'):
                pois.append([*centroid(ring), tags['name'], 'square'])

# ---------------- 建筑 ----------------
try:
    bld = load('buildings')
    ll3 = {el['id']: (el['lat'], el['lon']) for el in bld if el['type'] == 'node'}
    for el in bld:
        if el['type'] == 'way' and closed(el['nodes']):
            ring = ring_xy(el['nodes'], ll3)
            if len(ring) >= 8 and ring_area(ring) >= 25:
                polys['building'].append([ring])
except (FileNotFoundError, ValueError, KeyError) as exc:
    print('buildings.json unusable, skipping:', exc)

# ---------------- 输出 ----------------
xs = node_xy[0::2]; ys = node_xy[1::2]
data = {
    'name': CITY,
    'center': [lat0, lon0],
    'k': [KX, KY],
    'bounds': [min(xs), min(ys), max(xs), max(ys)],
    'classes': sorted(DEFAULT_SPEED),
    'names': [n for n, _ in sorted(names.items(), key=lambda kv: kv[1])],
    'nodes': node_xy,
    'edges': edges_out,
    'polys': polys,
    'lines': lines,
    'pois': pois,
    'labels': labels,
}
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('window.CITY_DATA = ')
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    f.write(';\n')

print(f'{CITY}: graph nodes {len(node_xy)//2}, graph edges {n_graph}, render-only edges {len(edges_out)-n_graph}, names {len(names)}')
for k, v in polys.items():
    print(f'  polys.{k}: {len(v)}')
for k, v in lines.items():
    print(f'  lines.{k}: {len(v)}')
print(f'  pois {len(pois)}, area labels {len(labels)}')
import os
print(f'  output {os.path.getsize(OUT)/1e6:.2f} MB')
