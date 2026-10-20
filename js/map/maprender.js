'use strict';
/* =====================================================================
 *  maprender.js —— Google 风格的底图渲染：平移/缩放、分级道路、路名、图层
 * ===================================================================== */
const MAP_STYLE = {
  land: '#f5f4f0', building: '#e8e6e1', buildingStroke: '#d8d5ce', park: '#c7e5b5', cemetery: '#d6e3cc', square: '#ecebe7',
  water: '#a8d1f3', rail: '#c7c7c7', label: '#4b4f54', parkLabel: '#2f7a3a', waterLabel: '#3870b8',
  poi: { station: '#3f6fb5', museum: '#7b5ea7', attraction: '#c27b3a', church: '#7b5ea7', square: '#6b6f74' },
  traffic: ['#4caf50', '#ffa000', '#e53935', '#8e1b1b'],
};
const ROAD_STYLE = {
  motorway:       { wm: 14, min: 3,   fill: '#f6c25b', casing: '#d6a03a', z: 6 },
  motorway_link:  { wm: 9,  min: 2,   fill: '#f6c25b', casing: '#d6a03a', z: 6 },
  trunk:          { wm: 13, min: 3,   fill: '#f6c25b', casing: '#d6a03a', z: 6 },
  trunk_link:     { wm: 8,  min: 2,   fill: '#f6c25b', casing: '#d6a03a', z: 6 },
  primary:        { wm: 11, min: 2.6, fill: '#fde7a0', casing: '#ddc67c', z: 5 },
  primary_link:   { wm: 7,  min: 1.8, fill: '#fde7a0', casing: '#ddc67c', z: 5 },
  secondary:      { wm: 9,  min: 2,   fill: '#ffffff', casing: '#d3d0c9', z: 4 },
  secondary_link: { wm: 6,  min: 1.5, fill: '#ffffff', casing: '#d3d0c9', z: 4 },
  tertiary:       { wm: 8,  min: 1.6, fill: '#ffffff', casing: '#dad7d0', z: 3 },
  tertiary_link:  { wm: 5,  min: 1.2, fill: '#ffffff', casing: '#dad7d0', z: 3 },
  residential:    { wm: 6,  min: 1,   fill: '#ffffff', casing: '#e1dfd9', z: 2, hide: 0.1 },
  living_street:  { wm: 5,  min: 1,   fill: '#ffffff', casing: '#e1dfd9', z: 2, hide: 0.1 },
  pedestrian:     { wm: 5,  min: 1,   fill: '#f4f3ef', casing: '#dcd9d2', z: 1, hide: 0.18 },
};
const CLASS_ORDER = ['pedestrian', 'living_street', 'residential', 'tertiary_link', 'tertiary', 'secondary_link', 'secondary', 'primary_link', 'primary', 'trunk_link', 'trunk', 'motorway_link', 'motorway'];
const LABEL_FONT = '11px Roboto, "Segoe UI", "Helvetica Neue", Arial, "Microsoft YaHei", sans-serif';

function polyPath(ctx, pts) {
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
}
function trafficColor(eff) {
  return eff > 0.8 ? MAP_STYLE.traffic[0] : eff > 0.55 ? MAP_STYLE.traffic[1] : eff > 0.35 ? MAP_STYLE.traffic[2] : MAP_STYLE.traffic[3];
}

class MapView {
  constructor(canvas, g) {
    this.cv = canvas; this.g = g;
    this.cx = 0; this.cy = 0; this.scale = 0.5;
    this.layers = { buildings: true, labels: true, traffic: false, pois: true };
    this.trafficHour = 8.5;
    this.base = document.createElement('canvas');
    this.baseView = null;
    this.edgesByClass = {};
    for (const e of g.renderEdges) (this.edgesByClass[e.cls] || (this.edgesByClass[e.cls] = [])).push(e);
    this.labelOrder = g.renderEdges.filter(e => e.name).sort((a, b) => (ROAD_STYLE[b.cls].z - ROAD_STYLE[a.cls].z) || (b.lenM - a.lenM));
    this.resize();
    window.addEventListener('resize', () => { this.resize(); if (this.onchange) this.onchange(); });
  }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.cv.clientWidth || 800; this.h = this.cv.clientHeight || 600; this.dpr = dpr;
    this.cv.width = this.w * dpr; this.cv.height = this.h * dpr;
    this.base.width = this.w * dpr; this.base.height = this.h * dpr;
    this.baseView = null;
  }
  fit(bounds, pad = 30) {
    const [x0, y0, x1, y1] = bounds;
    this.scale = Math.min((this.w - 2 * pad) / (x1 - x0), (this.h - 2 * pad) / (y1 - y0));
    this.cx = (x0 + x1) / 2; this.cy = (y0 + y1) / 2;
  }
  toScreen(x, y) { return [(x - this.cx) * this.scale + this.w / 2, (y - this.cy) * this.scale + this.h / 2]; }
  toWorld(sx, sy) { return [(sx - this.w / 2) / this.scale + this.cx, (sy - this.h / 2) / this.scale + this.cy]; }
  zoomAt(sx, sy, f) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = Math.max(0.05, Math.min(10, this.scale * f));
    const [nx, ny] = this.toWorld(sx, sy);
    this.cx += wx - nx; this.cy += wy - ny;
  }
  pan(dx, dy) { this.cx -= dx / this.scale; this.cy -= dy / this.scale; }
  visible(bbox, margin = 60) {
    const [sx0, sy0] = this.toScreen(bbox[0], bbox[1]), [sx1, sy1] = this.toScreen(bbox[2], bbox[3]);
    return sx1 >= -margin && sx0 <= this.w + margin && sy1 >= -margin && sy0 <= this.h + margin;
  }
  setWorldTransform(ctx) {
    const s = this.scale * this.dpr;
    ctx.setTransform(s, 0, 0, s, this.dpr * (this.w / 2 - this.cx * this.scale), this.dpr * (this.h / 2 - this.cy * this.scale));
  }
  setScreenTransform(ctx) { ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }
  px(n) { return n / this.scale; }   // 屏幕像素 → 世界米（在世界变换下画线宽用）

  /* ---------- 底图 ---------- */
  renderBase() {
    const ctx = this.base.getContext('2d'), g = this.g, sc = this.scale;
    this.setScreenTransform(ctx);
    ctx.fillStyle = MAP_STYLE.land; ctx.fillRect(0, 0, this.w, this.h);
    this.setWorldTransform(ctx);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const fillPolys = (list, color, stroke) => {
      ctx.fillStyle = color;
      for (const poly of list) {
        const bb = poly.bbox || (poly.bbox = ringsBBox(poly));
        if (!this.visible(bb)) continue;
        ctx.beginPath();
        for (const ring of poly) { if (ring.length >= 6) { polyPath(ctx, ring); ctx.closePath(); } }
        ctx.fill('evenodd');
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = this.px(0.6); ctx.stroke(); }
      }
    };
    fillPolys(g.polys.square, MAP_STYLE.square);
    fillPolys(g.polys.cemetery, MAP_STYLE.cemetery);
    fillPolys(g.polys.park, MAP_STYLE.park);
    fillPolys(g.polys.water, MAP_STYLE.water);
    ctx.strokeStyle = MAP_STYLE.water; ctx.lineWidth = Math.max(this.px(2), 5);
    for (const ln of g.lines.waterway) { if (ln.length >= 4) { ctx.beginPath(); polyPath(ctx, ln); ctx.stroke(); } }
    if (sc >= 0.12) {
      ctx.strokeStyle = MAP_STYLE.rail; ctx.lineWidth = Math.max(this.px(1.5), 3);
      for (const ln of g.lines.rail) { if (ln.length >= 4) { ctx.beginPath(); polyPath(ctx, ln); ctx.stroke(); } }
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(this.px(0.8), 1.5); ctx.setLineDash([this.px(7), this.px(7)]);
      for (const ln of g.lines.rail) { if (ln.length >= 4) { ctx.beginPath(); polyPath(ctx, ln); ctx.stroke(); } }
      ctx.setLineDash([]);
    }
    if (this.layers.buildings && sc >= 0.42) fillPolys(g.polys.building, MAP_STYLE.building, sc >= 1.1 ? MAP_STYLE.buildingStroke : null);

    /* 道路：按等级从低到高，每级先画描边再画填充 */
    for (const cls of CLASS_ORDER) {
      const st = ROAD_STYLE[cls], list = this.edgesByClass[cls];
      if (!list || (st.hide && sc < st.hide)) continue;
      const wpx = Math.max(st.min, st.wm * sc);
      const vis = [];
      for (const e of list) if (this.visible(e.bbox)) vis.push(e);
      if (wpx >= 2.2) {
        ctx.strokeStyle = st.casing; ctx.lineWidth = this.px(wpx + Math.max(1.2, 0.22 * wpx));
        ctx.beginPath(); for (const e of vis) polyPath(ctx, e.pts); ctx.stroke();
        ctx.strokeStyle = st.fill; ctx.lineWidth = this.px(wpx);
        ctx.beginPath(); for (const e of vis) polyPath(ctx, e.pts); ctx.stroke();
      } else {
        ctx.strokeStyle = st.fill === '#ffffff' ? st.casing : st.fill; ctx.lineWidth = this.px(Math.max(0.8, wpx));
        ctx.beginPath(); for (const e of vis) polyPath(ctx, e.pts); ctx.stroke();
      }
    }
    /* 路况图层 */
    if (this.layers.traffic) {
      const h = this.trafficHour;
      for (const cls of CLASS_ORDER) {
        const st = ROAD_STYLE[cls], list = this.edgesByClass[cls];
        if (!list || (st.hide && sc < st.hide)) continue;
        const wpx = Math.max(1.6, Math.max(st.min, st.wm * sc) * 0.45);
        const groups = [[], [], [], []];
        for (const e of list) {
          if (!e.edge || !this.visible(e.bbox)) continue;
          const eff = tdMultiplier(cls, h) / e.edge.tf;
          groups[eff > 0.8 ? 0 : eff > 0.55 ? 1 : eff > 0.35 ? 2 : 3].push(e);
        }
        ctx.lineWidth = this.px(wpx); ctx.lineCap = 'butt';
        groups.forEach((grp, i) => { if (!grp.length) return; ctx.strokeStyle = MAP_STYLE.traffic[i]; ctx.beginPath(); for (const e of grp) polyPath(ctx, e.pts); ctx.stroke(); });
        ctx.lineCap = 'round';
      }
    }
    /* 标注（屏幕坐标） */
    this.setScreenTransform(ctx);
    if (this.layers.labels) this.drawLabels(ctx);
    this.baseView = { cx: this.cx, cy: this.cy, scale: this.scale, w: this.w, h: this.h };
  }

  drawLabels(ctx) {
    const sc = this.scale, occ = new Set(), cellPx = 64, placed = new Map();
    const cellKey = (x, y) => Math.floor(x / cellPx) * 4099 + Math.floor(y / cellPx);
    ctx.font = LABEL_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    /* 面状要素名字 */
    if (sc >= 0.1) {
      ctx.font = 'italic 11.5px Roboto, "Segoe UI", Arial, sans-serif';
      for (const [x, y, name, kind] of this.g.labels) {
        const [sx, sy] = this.toScreen(x, y);
        if (sx < 0 || sx > this.w || sy < 0 || sy > this.h) continue;
        const k = cellKey(sx, sy); if (occ.has(k)) continue; occ.add(k);
        ctx.fillStyle = kind === 'water' ? MAP_STYLE.waterLabel : MAP_STYLE.parkLabel;
        ctx.strokeText(name, sx, sy); ctx.fillText(name, sx, sy);
      }
      ctx.font = LABEL_FONT;
    }
    /* 路名沿路放置 */
    if (sc >= 0.2) {
      let count = 0;
      for (const e of this.labelOrder) {
        const st = ROAD_STYLE[e.cls];
        if (st.hide && sc < st.hide) continue;
        if (sc < 0.45 && st.z < 3) continue;
        if (sc < 0.3 && st.z < 4) continue;
        if (!this.visible(e.bbox, 0)) continue;
        const tw = ctx.measureText(e.name).width;
        const p = e.pts; let best = -1, bl = 0;
        for (let i = 0; i + 3 < p.length; i += 2) {
          const l = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]) * sc;
          if (l > bl) { bl = l; best = i; }
        }
        if (best < 0 || bl < tw + 18) continue;
        const [ax, ay] = this.toScreen(p[best], p[best + 1]), [bx, by] = this.toScreen(p[best + 2], p[best + 3]);
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        if (mx < 0 || mx > this.w || my < 0 || my > this.h) continue;
        let ang = Math.atan2(by - ay, bx - ax);
        if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
        const k = cellKey(mx, my); if (occ.has(k)) continue;
        const prev = placed.get(e.name);
        if (prev && prev.some(q => Math.hypot(q[0] - mx, q[1] - my) < 280)) continue;
        ctx.save(); ctx.translate(mx, my); ctx.rotate(ang);
        ctx.fillStyle = MAP_STYLE.label; ctx.strokeText(e.name, 0, 0); ctx.fillText(e.name, 0, 0);
        ctx.restore();
        const c = Math.cos(ang), s = Math.sin(ang);
        for (let t = -tw / 2; t <= tw / 2; t += cellPx / 2) occ.add(cellKey(mx + c * t, my + s * t));
        occ.add(k);
        if (!prev) placed.set(e.name, [[mx, my]]); else prev.push([mx, my]);
        if (++count > 420) break;
      }
    }
    /* POI */
    if (this.layers.pois && sc >= 0.14) {
      ctx.textAlign = 'left';
      for (const [x, y, name, kind] of this.g.pois) {
        if (kind !== 'station' && sc < 0.3) continue;
        const [sx, sy] = this.toScreen(x, y);
        if (sx < -20 || sx > this.w + 20 || sy < 0 || sy > this.h) continue;
        const k = cellKey(sx, sy); if (occ.has(k)) continue; occ.add(k); occ.add(cellKey(sx + 60, sy));
        if (kind !== 'square') {
          ctx.fillStyle = MAP_STYLE.poi[kind] || '#777'; ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        }
        ctx.fillStyle = kind === 'square' ? MAP_STYLE.poi.square : '#333';
        ctx.font = kind === 'square' ? 'italic 11px Roboto, "Segoe UI", Arial, sans-serif' : LABEL_FONT;
        ctx.strokeText(name, sx + (kind === 'square' ? 0 : 9), sy); ctx.fillText(name, sx + (kind === 'square' ? 0 : 9), sy);
      }
      ctx.textAlign = 'center'; ctx.font = LABEL_FONT;
    }
  }

  /* 把缓存底图按当前视图变换画到目标画布；返回是否与当前视图完全一致 */
  drawCached(ctx, canvas, cv) {
    if (!cv) return false;
    const k = this.scale / cv.scale;
    const ox = this.w / 2 * (1 - k) + (cv.cx - this.cx) * this.scale, oy = this.h / 2 * (1 - k) + (cv.cy - this.cy) * this.scale;
    ctx.save(); this.setScreenTransform(ctx);
    ctx.translate(ox, oy); ctx.scale(k, k);
    ctx.drawImage(canvas, 0, 0, this.w, this.h);
    ctx.restore();
    return Math.abs(k - 1) < 1e-9 && Math.abs(ox) < 1e-6 && Math.abs(oy) < 1e-6;
  }
  drawBase(ctx) {
    if (!this.baseView) this.renderBase();
    ctx.save(); this.setScreenTransform(ctx); ctx.fillStyle = MAP_STYLE.land; ctx.fillRect(0, 0, this.w, this.h); ctx.restore();
    return this.drawCached(ctx, this.base, this.baseView);
  }
  /* 比例尺 */
  scaleBar() {
    for (const m of [2000, 1000, 500, 200, 100, 50, 20]) { const px = m * this.scale; if (px <= 130) return { m, px }; }
    return { m: 10, px: 10 * this.scale };
  }
}
function ringsBBox(poly) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const ring of poly) for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i], y = ring[i + 1];
    if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  return [minx, miny, maxx, maxy];
}
