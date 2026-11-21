// 追加のテスト用データ（家・キノコ・車・宝箱・サボテンの鉢植え）
// どれもプログラムで作るので、ライセンスの心配はありません。
// 実際のスキャンでよく起きる「傾き・撮り漏れの穴・細い部分・色むら・浮いたゴミ・薄いモヤ」をわざと入れてあります。
import type { SplatData } from './splat';
import { Builder, rng, quatAxisAngle, quatMul, addGround, addJunk, OFFSET, type Q } from './dummy';

type V = [number, number, number];
type Col = [number, number, number];
/** 色を決める関数。null を返すとそこには置かない（窓の穴などに使う） */
type ColorFn = (p: V, n: V, s: number, t: number) => Col | null;

const DENSITY = 4200; // 面積1あたりのガウシアン数

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V): V => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** ガウシアンの薄い向き（ローカルZ）を、面の向き n にそろえる回転 */
function quatZTo(n: V): Q {
  if (n[2] < -0.9999) return [0, 1, 0, 0];
  const q: Q = [1 + n[2], -n[1], n[0], 0];
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** 色に少しむらを付けて置く */
function put(b: Builder, r: () => number, p: V, n: V, c: Col, size: number, alpha = 0.95, thin = 0.004) {
  const k = 0.93 + r() * 0.12;
  b.add(p, [size, size * (0.8 + r() * 0.4), thin], quatMul(quatZTo(n), quatAxisAngle(0, 0, 1, r() * 6.28)),
    [c[0] * k, c[1] * k, c[2] * k, alpha]);
}

const spacing = (density: number) => 1 / Math.sqrt(density);

/** 平行四辺形 p0 + s·u + t·v（0≤s,t≤1）。tri なら三角形（s+t≤1）の範囲だけ */
function quad(b: Builder, r: () => number, p0: V, u: V, v: V, col: ColorFn, tri = false, density = DENSITY) {
  const nn = cross(u, v);
  const area = len(nn) * (tri ? 0.5 : 1);
  const n = norm(nn);
  const count = Math.round(area * density);
  const size = spacing(density) * 0.75;
  for (let i = 0; i < count; i++) {
    let s = r(), t = r();
    if (tri && s + t > 1) { s = 1 - s; t = 1 - t; }
    const p: V = [p0[0] + s * u[0] + t * v[0], p0[1] + s * u[1] + t * v[1], p0[2] + s * u[2] + t * v[2]];
    const c = col(p, n, s, t);
    if (c) put(b, r, p, n, c, size);
  }
}

/** 箱の表面。bottom=false なら底面は作らない（地面に置いてある物は底が撮れない） */
function box(b: Builder, r: () => number, min: V, max: V, col: ColorFn, bottom = false, density = DENSITY) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  quad(b, r, [x0, y0, z1], [dx, 0, 0], [0, dy, 0], col, false, density); // 前 (+z)
  quad(b, r, [x1, y0, z0], [-dx, 0, 0], [0, dy, 0], col, false, density); // 後 (-z)
  quad(b, r, [x1, y0, z1], [0, 0, -dz], [0, dy, 0], col, false, density); // 右 (+x)
  quad(b, r, [x0, y0, z0], [0, 0, dz], [0, dy, 0], col, false, density); // 左 (-x)
  quad(b, r, [x0, y1, z1], [dx, 0, 0], [0, 0, -dz], col, false, density); // 上
  if (bottom) quad(b, r, [x0, y0, z0], [dx, 0, 0], [0, 0, dz], col, false, density);
}

/** 軸に垂直な2本の向き */
function basis(axis: V): [V, V] {
  const a = norm(axis);
  const e1 = norm(Math.abs(a[1]) < 0.9 ? cross(a, [0, 1, 0]) : cross(a, [1, 0, 0]));
  return [e1, cross(a, e1)];
}

/**
 * 円柱（rTop を変えると円すい台）。側面と、必要ならふた。
 * arc で角度の範囲を絞ると、かまぼこ形（宝箱のふたなど）になる。
 */
function cylinder(b: Builder, r: () => number, base: V, axis: V, radius: number, height: number, col: ColorFn,
  opt: { rTop?: number; capTop?: boolean; capBottom?: boolean; arc?: [number, number]; density?: number } = {}) {
  const density = opt.density ?? DENSITY;
  const a = norm(axis);
  const [e1, e2] = basis(a);
  const rTop = opt.rTop ?? radius;
  const [a0, a1] = opt.arc ?? [0, Math.PI * 2];
  const size = spacing(density) * 0.75;
  const side = Math.round((a1 - a0) * ((radius + rTop) / 2) * height * density);
  for (let i = 0; i < side; i++) {
    const ang = a0 + r() * (a1 - a0), t = r();
    const rad = mix(radius, rTop, t);
    const dir: V = [e1[0] * Math.cos(ang) + e2[0] * Math.sin(ang), e1[1] * Math.cos(ang) + e2[1] * Math.sin(ang), e1[2] * Math.cos(ang) + e2[2] * Math.sin(ang)];
    const p: V = [base[0] + a[0] * t * height + dir[0] * rad, base[1] + a[1] * t * height + dir[1] * rad, base[2] + a[2] * t * height + dir[2] * rad];
    const c = col(p, dir, ang, t);
    if (c) put(b, r, p, dir, c, size);
  }
  const cap = (at: number, rad: number, n: V) => {
    const cnt = Math.round(((a1 - a0) / 2) * rad * rad * density);
    for (let i = 0; i < cnt; i++) {
      const ang = a0 + r() * (a1 - a0), d = Math.sqrt(r()) * rad;
      const p: V = [base[0] + a[0] * at + (e1[0] * Math.cos(ang) + e2[0] * Math.sin(ang)) * d,
        base[1] + a[1] * at + (e1[1] * Math.cos(ang) + e2[1] * Math.sin(ang)) * d,
        base[2] + a[2] * at + (e1[2] * Math.cos(ang) + e2[2] * Math.sin(ang)) * d];
      const c = col(p, n, d / rad, at / height);
      if (c) put(b, r, p, n, c, size);
    }
  };
  if (opt.capTop) cap(height, rTop, a);
  if (opt.capBottom) cap(0, radius, [-a[0], -a[1], -a[2]]);
}

/** 楕円体の表面。keep で単位球上の向きを見て一部だけ残せる（半球など） */
function ellipsoid(b: Builder, r: () => number, center: V, radii: V, col: ColorFn, keep?: (d: V) => boolean, density = DENSITY) {
  const [ra, rb, rc] = radii;
  const p16 = 1.6;
  const area = 4 * Math.PI * Math.pow((Math.pow(ra * rb, p16) + Math.pow(ra * rc, p16) + Math.pow(rb * rc, p16)) / 3, 1 / p16);
  const count = Math.round(area * density);
  const size = spacing(density) * 0.75;
  for (let i = 0; i < count; i++) {
    const z = r() * 2 - 1, ang = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
    const d: V = [s * Math.cos(ang), z, s * Math.sin(ang)];
    if (keep && !keep(d)) continue;
    const p: V = [center[0] + d[0] * ra, center[1] + d[1] * rb, center[2] + d[2] * rc];
    const n = norm([d[0] / ra, d[1] / rb, d[2] / rc]);
    const c = col(p, n, d[1], ang);
    if (c) put(b, r, p, n, c, size);
  }
}

/** 撮り漏れの穴：ランダムな場所のまわりのガウシアンを消す（from 番目以降だけが対象） */
function punchHoles(b: Builder, r: () => number, from: number, count: number, radius: number) {
  const n = b.pos.length / 3;
  if (n <= from) return;
  const centers: V[] = [];
  for (let k = 0; k < count; k++) {
    const i = from + Math.floor(r() * (n - from));
    centers.push([b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]]);
  }
  const keep = (i: number) => {
    if (i < from) return true;
    const p: V = [b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]];
    return centers.every((c) => len(sub(p, c)) > radius * (0.7 + 0.6 * ((i * 2654435761) % 1000) / 1000));
  };
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (keep(i)) idx.push(i);
  const pick = <T>(arr: T[], w: number) => idx.flatMap((i) => arr.slice(i * w, i * w + w));
  b.pos = pick(b.pos, 3); b.scl = pick(b.scl, 3); b.rot = pick(b.rot, 4); b.col = pick(b.col, 4);
}

/** 細い部分（アンテナ・トゲなど）：細長いガウシアンを並べる */
function thinLine(b: Builder, r: () => number, from: V, to: V, c: Col, width = 0.006) {
  const d = sub(to, from), L = len(d), n = norm(d);
  const steps = Math.max(2, Math.round(L / (width * 2.5)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    put(b, r, [from[0] + d[0] * t, from[1] + d[1] * t, from[2] + d[2] * t], n, c, width, 0.97, L / steps * 0.8);
  }
}

const tiltOf = (x: number, z: number): Q => quatMul(quatAxisAngle(0, 0, 1, z), quatAxisAngle(1, 0, 0, x));
function finishScene(b: Builder, r: () => number, junkCenter: V, groundR: number, tilt: Q): SplatData {
  addGround(b, r, groundR, Math.round(groundR * groundR * 3000));
  addJunk(b, r, junkCenter);
  return b.build(tilt, OFFSET);
}

// ============================================================
/** 家：壁・木の柱・窓・扉・切妻屋根・煙突・屋根の上の細い風見 */
export function makeHouse(): SplatData {
  const r = rng(11);
  const b = new Builder();
  const cream: Col = [0.93, 0.87, 0.72], beam: Col = [0.42, 0.28, 0.17], glass: Col = [0.38, 0.58, 0.82], frame: Col = [0.95, 0.95, 0.93];
  const wall: ColorFn = (p, n) => {
    const onX = Math.abs(n[0]) > 0.5;
    const h = onX ? p[2] : p[0]; // 面の横方向
    const half = onX ? 0.4 : 0.5;
    if (Math.abs(h) > half - 0.04 || Math.abs(p[1] - 0.36) < 0.02 || p[1] < 0.04) return beam;
    // 正面の扉
    if (n[2] > 0.5 && Math.abs(p[0]) < 0.12 && p[1] < 0.46) {
      if (Math.abs(p[0] - 0.08) < 0.015 && Math.abs(p[1] - 0.22) < 0.015) return [0.85, 0.7, 0.2];
      return Math.abs(p[0]) > 0.11 || p[1] > 0.445 ? beam : [0.55, 0.34, 0.18];
    }
    // 窓（扉の両わき・側面）
    const wins = onX ? [0] : n[2] > 0.5 ? [-0.3, 0.3] : [-0.25, 0.25];
    for (const wx of wins) {
      if (Math.abs(h - wx) < 0.1 && Math.abs(p[1] - 0.5) < 0.1) {
        if (Math.abs(h - wx) > 0.085 || Math.abs(p[1] - 0.5) > 0.085 || Math.abs(h - wx) < 0.008 || Math.abs(p[1] - 0.5) < 0.008) return frame;
        return glass;
      }
    }
    return cream;
  };
  box(b, r, [-0.5, 0, -0.4], [0.5, 0.7, 0.4], wall);
  // 切妻（屋根の下の三角の壁）
  const gable: ColorFn = (p) => (Math.abs(p[2]) < 0.02 || p[1] < 0.72 ? beam : cream);
  quad(b, r, [0.5, 0.7, -0.4], [0, 0, 0.8], [0, 0.35, 0.4], gable, true);
  quad(b, r, [-0.5, 0.7, -0.4], [0, 0, 0.8], [0, 0.35, 0.4], gable, true);
  // 屋根（瓦の段）
  const roof: ColorFn = (_p, _n, s, t) => {
    const row = Math.floor(t * 9);
    const tile = (Math.floor(s * 14 + (row % 2) * 0.5) % 2) ? 0.92 : 1;
    const base: Col = row % 2 ? [0.72, 0.2, 0.15] : [0.8, 0.26, 0.18];
    return t > 0.97 ? [0.35, 0.12, 0.1] : [base[0] * tile, base[1] * tile, base[2] * tile];
  };
  quad(b, r, [-0.62, 0.64, 0.52], [1.24, 0, 0], [0, 0.41, -0.52], roof);
  quad(b, r, [0.62, 0.64, -0.52], [-1.24, 0, 0], [0, 0.41, 0.52], roof);
  // 煙突（レンガ）
  const brick: ColorFn = (p) => {
    const row = Math.floor(p[1] / 0.04);
    const mortar = (p[1] / 0.04) % 1 < 0.15;
    return mortar ? [0.75, 0.72, 0.68] : row % 2 ? [0.55, 0.3, 0.22] : [0.62, 0.34, 0.24];
  };
  box(b, r, [0.2, 0.78, -0.3], [0.36, 1.18, -0.14], brick);
  // 屋根の上の細い風見（細い部分のテスト）
  thinLine(b, r, [-0.35, 1.05, 0], [-0.35, 1.32, 0], [0.2, 0.2, 0.22]);
  thinLine(b, r, [-0.45, 1.27, 0], [-0.25, 1.27, 0], [0.2, 0.2, 0.22]);
  // 撮り漏れ：屋根の裏側などに穴
  punchHoles(b, r, 0, 4, 0.07);
  return finishScene(b, r, [0, 0.6, 0], 1.5, tiltOf(0.28, -0.18));
}

/** キノコ：赤い傘に白い水玉、ひだ、細い草。小さいキノコも2本 */
export function makeMushroom(): SplatData {
  const r = rng(23);
  const b = new Builder();
  const dots: V[] = [];
  for (let i = 0; i < 16; i++) {
    const z = 0.15 + r() * 0.85, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
    dots.push([s * Math.cos(a), z, s * Math.sin(a)]);
  }
  const one = (cx: number, cz: number, k: number, capCol: Col, dotted: boolean) => {
    const stem: ColorFn = (_p, _n, ang) => {
      const streak = 0.94 + 0.06 * Math.sin(ang * 9);
      return [0.93 * streak, 0.89 * streak, 0.8 * streak];
    };
    cylinder(b, r, [cx, 0, cz], [0, 1, 0], 0.13 * k, 0.55 * k, stem, { rTop: 0.1 * k });
    const cap: ColorFn = (p) => {
      const d = norm([(p[0] - cx) / (0.45 * k), (p[1] - 0.5 * k) / (0.3 * k), (p[2] - cz) / (0.45 * k)]);
      if (dotted && dots.some((q) => d[0] * q[0] + d[1] * q[1] + d[2] * q[2] > 0.975)) return [0.97, 0.95, 0.9];
      return capCol;
    };
    ellipsoid(b, r, [cx, 0.5 * k, cz], [0.45 * k, 0.3 * k, 0.45 * k], cap, (d) => d[1] > -0.05);
    // 傘の裏のひだ
    const gills: ColorFn = (_p, _n, s) => (s < 0.25 ? null : [0.85 - 0.1 * Math.abs(Math.sin(s * 40)), 0.78, 0.66]);
    cylinder(b, r, [cx, 0.49 * k, cz], [0, 1, 0], 0.45 * k, 0.001, gills, { capBottom: true, density: DENSITY * 0.8 });
  };
  one(0, 0, 1, [0.86, 0.13, 0.1], true);
  one(0.48, 0.22, 0.45, [0.6, 0.38, 0.2], false);
  one(-0.36, 0.38, 0.32, [0.68, 0.45, 0.25], false);
  // 細い草（細い部分のテスト）
  for (let i = 0; i < 40; i++) {
    const a = r() * Math.PI * 2, d = 0.25 + r() * 0.45;
    const x = Math.cos(a) * d, z = Math.sin(a) * d, h = 0.1 + r() * 0.18;
    thinLine(b, r, [x, 0, z], [x + (r() - 0.5) * 0.08, h, z + (r() - 0.5) * 0.08], [0.3 + r() * 0.1, 0.6 + r() * 0.15, 0.2], 0.005);
  }
  punchHoles(b, r, 0, 3, 0.06);
  return finishScene(b, r, [0, 0.45, 0], 1.2, tiltOf(-0.25, 0.3));
}

/** 車：ボディ・窓・タイヤ・ライト・細いアンテナ */
export function makeCar(): SplatData {
  const r = rng(37);
  const b = new Builder();
  const blue: Col = [0.18, 0.42, 0.85];
  const body: ColorFn = (p, n) => {
    if (n[0] > 0.5) { // 前
      if (Math.abs(Math.abs(p[2]) - 0.22) < 0.07 && Math.abs(p[1] - 0.33) < 0.04) return [1, 0.95, 0.6];
      if (Math.abs(p[2]) < 0.12 && p[1] < 0.32 && p[1] > 0.18) return (Math.floor(p[1] * 60) % 2) ? [0.15, 0.15, 0.17] : [0.3, 0.3, 0.32];
    }
    if (n[0] < -0.5 && Math.abs(Math.abs(p[2]) - 0.24) < 0.06 && Math.abs(p[1] - 0.34) < 0.03) return [0.9, 0.12, 0.1];
    if (Math.abs(p[1] - 0.27) < 0.008) return [0.12, 0.3, 0.65]; // 横の線
    if (p[1] < 0.15) return [0.2, 0.2, 0.22]; // バンパー
    return blue;
  };
  box(b, r, [-0.7, 0.1, -0.33], [0.7, 0.42, 0.33], body);
  const cabin: ColorFn = (p, n) => {
    if (n[1] > 0.5) return blue;
    const glass: Col = [0.25, 0.32, 0.42];
    if (p[1] > 0.45 && p[1] < 0.65) {
      if (Math.abs(n[2]) > 0.5 && p[0] > -0.32 && p[0] < 0.27 && Math.abs(p[0] + 0.02) > 0.02) return glass;
      if (Math.abs(n[0]) > 0.5 && Math.abs(p[2]) < 0.26) return glass;
    }
    return blue;
  };
  box(b, r, [-0.35, 0.42, -0.29], [0.3, 0.68, 0.29], cabin);
  // タイヤ
  for (const x of [-0.45, 0.45]) for (const zs of [-1, 1]) {
    const tire: ColorFn = (_p, n, s) => {
      if (Math.abs(n[2]) > 0.5) return s < 0.5 ? (s < 0.15 ? [0.5, 0.5, 0.52] : [0.75, 0.76, 0.78]) : [0.1, 0.1, 0.11];
      return [0.09, 0.09, 0.1];
    };
    cylinder(b, r, [x, 0.14, zs * 0.28], [0, 0, zs], 0.14, 0.1, tire, { capTop: true });
  }
  // 細いアンテナ
  thinLine(b, r, [-0.6, 0.42, 0.2], [-0.72, 0.78, 0.2], [0.15, 0.15, 0.15], 0.005);
  punchHoles(b, r, 0, 3, 0.06);
  return finishScene(b, r, [0, 0.4, 0], 1.4, tiltOf(0.2, 0.22));
}

/** 宝箱：木の板・金の帯・錠前・かまぼこ形のふた・金貨と宝石 */
export function makeChest(): SplatData {
  const r = rng(53);
  const b = new Builder();
  const gold: Col = [0.95, 0.75, 0.22];
  const wood = (v: number): Col => {
    const plank = Math.floor(v * 10) % 2 ? 0.9 : 1;
    const grain = 0.95 + 0.05 * Math.sin(v * 140);
    return [0.55 * plank * grain, 0.33 * plank * grain, 0.17 * plank * grain];
  };
  const base: ColorFn = (p, n) => {
    if (Math.abs(Math.abs(p[0]) - 0.3) < 0.03 || p[1] > 0.42 || p[1] < 0.03) return gold;
    if (n[2] > 0.5 && Math.abs(p[0]) < 0.07 && p[1] > 0.28) return Math.abs(p[0]) < 0.015 && Math.abs(p[1] - 0.36) < 0.03 ? [0.2, 0.15, 0.05] : gold;
    return wood(p[1]);
  };
  box(b, r, [-0.45, 0, -0.3], [0.45, 0.45, 0.3], base);
  // ふた（かまぼこ形）
  const lid: ColorFn = (p, n) => {
    if (Math.abs(Math.abs(p[0]) - 0.3) < 0.03) return gold;
    if (Math.abs(n[0]) > 0.5) return Math.abs(Math.hypot(p[1] - 0.45, p[2]) - 0.3) < 0.03 ? gold : wood(p[2] + 1);
    return wood(Math.atan2(p[1] - 0.45, p[2]));
  };
  cylinder(b, r, [-0.45, 0.45, 0], [1, 0, 0], 0.3, 0.9, lid, { arc: [Math.PI, Math.PI * 2], capTop: true, capBottom: true }); // 上半分だけ
  // 金貨と宝石
  for (let i = 0; i < 14; i++) {
    const x = (r() - 0.5) * 0.7, z = 0.38 + r() * 0.25;
    cylinder(b, r, [x, 0.003 + r() * 0.01, z], [0, 1, 0], 0.04, 0.008, () => gold, { capTop: true });
  }
  const gems: Col[] = [[0.9, 0.1, 0.2], [0.1, 0.75, 0.35], [0.2, 0.4, 0.95]];
  for (let i = 0; i < 6; i++) {
    const c = gems[i % 3];
    ellipsoid(b, r, [(r() - 0.5) * 0.6, 0.03, 0.4 + r() * 0.2], [0.035, 0.03, 0.035], () => c);
  }
  punchHoles(b, r, 0, 3, 0.05);
  return finishScene(b, r, [0, 0.4, 0.1], 1.3, tiltOf(-0.3, -0.25));
}

/** サボテンの鉢植え：素焼きの鉢・土・うね模様のサボテン・細いトゲ・花 */
export function makeCactus(): SplatData {
  const r = rng(71);
  const b = new Builder();
  const pot: ColorFn = (p) => (p[1] > 0.3 ? [0.7, 0.36, 0.22] : [0.8, 0.44, 0.27]);
  cylinder(b, r, [0, 0, 0], [0, 1, 0], 0.22, 0.36, pot, { rTop: 0.28 });
  cylinder(b, r, [0, 0.33, 0], [0, 1, 0], 0.265, 0.001, () => [0.3, 0.2, 0.13], { capTop: true }); // 土
  const green: ColorFn = (p) => {
    const a = Math.atan2(p[2], p[0]);
    const rib = 0.82 + 0.18 * Math.abs(Math.cos(a * 4));
    return [0.25 * rib, 0.6 * rib, 0.28 * rib];
  };
  ellipsoid(b, r, [0, 0.72, 0], [0.13, 0.42, 0.13], green);
  // 腕（横に出て上に伸びる）
  cylinder(b, r, [0.1, 0.7, 0], [1, 0, 0], 0.055, 0.17, green);
  ellipsoid(b, r, [0.28, 0.86, 0], [0.065, 0.19, 0.065], green);
  cylinder(b, r, [-0.1, 0.58, 0.02], [-1, 0, 0], 0.05, 0.14, green);
  ellipsoid(b, r, [-0.25, 0.7, 0.02], [0.055, 0.14, 0.055], green);
  // 花
  ellipsoid(b, r, [0, 1.15, 0], [0.07, 0.04, 0.07], () => [0.98, 0.45, 0.65]);
  ellipsoid(b, r, [0, 1.17, 0], [0.025, 0.02, 0.025], () => [1, 0.9, 0.3]);
  // 細いトゲ（細い部分のテスト）
  for (let i = 0; i < 160; i++) {
    const a = r() * Math.PI * 2, y = r() * 2 - 1;
    const s = Math.sqrt(1 - y * y);
    const n = norm([s * Math.cos(a) / 0.13, y / 0.42, s * Math.sin(a) / 0.13]);
    const p: V = [s * Math.cos(a) * 0.13, 0.72 + y * 0.42, s * Math.sin(a) * 0.13];
    thinLine(b, r, p, [p[0] + n[0] * 0.045, p[1] + n[1] * 0.045, p[2] + n[2] * 0.045], [0.95, 0.93, 0.8], 0.003);
  }
  punchHoles(b, r, 0, 2, 0.05);
  return finishScene(b, r, [0, 0.6, 0], 1.1, tiltOf(0.32, 0.15));
}
