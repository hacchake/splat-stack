// 実データがなくても試せる、テスト用ガウシアン群の生成
// わざと「少し傾いている」「周りにゴミ（フローター）や薄いモヤがある」状態にしてある
import type { SplatData } from './splat';

type Q = [number, number, number, number]; // w,x,y,z

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quatAxisAngle(ax: number, ay: number, az: number, angle: number): Q {
  const s = Math.sin(angle / 2);
  return [Math.cos(angle / 2), ax * s, ay * s, az * s];
}
function quatMul(a: Q, b: Q): Q {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
function quatRotate(q: Q, v: [number, number, number]): [number, number, number] {
  const p = quatMul(quatMul(q, [0, v[0], v[1], v[2]]), [q[0], -q[1], -q[2], -q[3]]);
  return [p[1], p[2], p[3]];
}
function randomQuat(r: () => number): Q {
  const u1 = r(), u2 = r() * Math.PI * 2, u3 = r() * Math.PI * 2;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

class Builder {
  pos: number[] = []; scl: number[] = []; rot: number[] = []; col: number[] = [];
  add(p: [number, number, number], s: [number, number, number], q: Q, c: [number, number, number, number]) {
    this.pos.push(...p); this.scl.push(...s); this.rot.push(...q);
    this.col.push(...c.map((v) => Math.max(0, Math.min(255, Math.round(v * 255)))));
  }
  /** 全体を傾けてずらす（スキャンデータの「向きバラバラ」を再現） */
  build(tilt: Q, offset: [number, number, number]): SplatData {
    const n = this.pos.length / 3;
    const d: SplatData = {
      count: n,
      positions: new Float32Array(n * 3),
      scales: new Float32Array(this.scl),
      rotations: new Float32Array(n * 4),
      colors: new Uint8Array(this.col),
    };
    for (let i = 0; i < n; i++) {
      const p = quatRotate(tilt, [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]]);
      d.positions[i * 3] = p[0] + offset[0];
      d.positions[i * 3 + 1] = p[1] + offset[1];
      d.positions[i * 3 + 2] = p[2] + offset[2];
      const q = quatMul(tilt, [this.rot[i * 4], this.rot[i * 4 + 1], this.rot[i * 4 + 2], this.rot[i * 4 + 3]]);
      d.rotations.set(q, i * 4);
    }
    return d;
  }
}

const ID: Q = [1, 0, 0, 0];

function addGround(b: Builder, r: () => number, radius: number, count: number) {
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * radius;
    const g = 0.35 + r() * 0.15;
    b.add([Math.cos(a) * d, (r() - 0.5) * 0.004, Math.sin(a) * d], [0.035, 0.003, 0.035], quatAxisAngle(0, 1, 0, r() * 6.28),
      [g + 0.08, g + 0.04, g - 0.02, 0.95]);
  }
}

function addJunk(b: Builder, r: () => number, center: [number, number, number]) {
  // 遠くに散らばるフローター
  for (let i = 0; i < 500; i++) {
    const v = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    const d = 2.2 + r() * 3;
    const s = 0.02 + r() * 0.08;
    b.add([v[0] / l * d, v[1] / l * d + 0.5, v[2] / l * d], [s, s * (0.3 + r()), s], randomQuat(r),
      [r(), r(), r(), 0.15 + r() * 0.8]);
  }
  // 物体の近くの、ほとんど透明なモヤ（不透明度フィルタで消える）
  for (let i = 0; i < 2500; i++) {
    const s = 0.04 + r() * 0.05;
    b.add([center[0] + (r() - 0.5) * 2.2, center[1] + (r() - 0.5) * 1.8, center[2] + (r() - 0.5) * 2.2], [s, s, s], randomQuat(r),
      [0.8, 0.85, 0.95, 0.01 + r() * 0.04]);
  }
  // 物体の近くにぽつんと浮く孤立点（孤立除去で消える）
  for (let i = 0; i < 150; i++) {
    const s = 0.02 + r() * 0.02;
    b.add([center[0] + (r() - 0.5) * 2.4, center[1] + (r() - 0.3) * 2, center[2] + (r() - 0.5) * 2.4], [s, s, s], randomQuat(r),
      [1, 0.2 + r() * 0.8, r(), 0.9]);
  }
}

const TILT: Q = quatMul(quatAxisAngle(0, 0, 1, -0.22), quatAxisAngle(1, 0, 0, 0.33));
const OFFSET: [number, number, number] = [0.7, -0.4, 0.25];

/** 色付き立方体（各面が別の色） */
export function makeCube(): SplatData {
  const r = rng(1);
  const b = new Builder();
  const N = 40, s = 0.016, thin = 0.003;
  const faces: { axis: number; sign: number; color: [number, number, number] }[] = [
    { axis: 0, sign: 1, color: [0.92, 0.25, 0.22] },
    { axis: 0, sign: -1, color: [0.2, 0.78, 0.82] },
    { axis: 1, sign: 1, color: [0.98, 0.85, 0.25] },
    { axis: 2, sign: 1, color: [0.25, 0.4, 0.95] },
    { axis: 2, sign: -1, color: [0.3, 0.8, 0.35] },
    { axis: 1, sign: -1, color: [0.5, 0.5, 0.5] },
  ];
  for (const f of faces) {
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        const u = (i + 0.5 + (r() - 0.5) * 0.5) / N - 0.5, v = (j + 0.5 + (r() - 0.5) * 0.5) / N - 0.5;
        const p: [number, number, number] = [0, 0, 0];
        p[f.axis] = f.sign * 0.5;
        p[(f.axis + 1) % 3] = u;
        p[(f.axis + 2) % 3] = v;
        p[1] += 0.5;
        const sc: [number, number, number] = [s, s, s];
        sc[f.axis] = thin;
        // 面の上に格子模様をうっすら
        const checker = ((Math.floor((u + 0.5) * 4) + Math.floor((v + 0.5) * 4)) & 1) ? 1 : 0.82;
        const k = checker * (0.92 + r() * 0.08);
        b.add(p, sc, ID, [f.color[0] * k, f.color[1] * k, f.color[2] * k, 0.95]);
      }
  }
  addGround(b, r, 1.6, 7000);
  addJunk(b, r, [0, 0.6, 0]);
  return b.build(TILT, OFFSET);
}

/** 木（幹・葉の塊・赤い実） */
export function makeTree(): SplatData {
  const r = rng(7);
  const b = new Builder();
  // 幹
  for (let i = 0; i < 5000; i++) {
    const h = r() * 0.95;
    const rad = 0.09 * (1 - h * 0.35);
    const a = r() * Math.PI * 2;
    const g = 0.75 + r() * 0.35;
    b.add([Math.cos(a) * rad, h, Math.sin(a) * rad], [0.004, 0.03, 0.014], quatAxisAngle(0, 1, 0, -a),
      [0.42 * g, 0.27 * g, 0.15 * g, 0.97]);
  }
  // 枝
  const branches: [number, number, number][] = [[0.3, 0.75, 0.1], [-0.25, 0.8, -0.2], [0.05, 0.85, 0.3]];
  for (const e of branches) {
    for (let i = 0; i < 800; i++) {
      const t = r();
      const p: [number, number, number] = [e[0] * t, 0.6 + (e[1] - 0.6) * t + 0.15 * t, e[2] * t];
      b.add([p[0] + (r() - 0.5) * 0.03, p[1] + (r() - 0.5) * 0.03, p[2] + (r() - 0.5) * 0.03], [0.012, 0.012, 0.012], ID,
        [0.38, 0.25, 0.14, 0.95]);
    }
  }
  // 葉の塊
  const blobs: [number, number, number, number][] = [
    [0, 1.25, 0, 0.45], [0.33, 1.05, 0.12, 0.32], [-0.3, 1.1, -0.18, 0.33], [0.08, 1.12, 0.36, 0.3], [-0.1, 1.5, 0.05, 0.3],
  ];
  for (const [cx, cy, cz, rad] of blobs) {
    const cnt = Math.round(rad * rad * 60000);
    for (let i = 0; i < cnt; i++) {
      const v = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      const d = rad * (0.75 + 0.25 * Math.cbrt(r()));
      const p: [number, number, number] = [cx + v[0] / l * d, cy + v[1] / l * d, cz + v[2] / l * d];
      const light = 0.65 + 0.35 * (v[1] / l + 1) / 2 + (r() - 0.5) * 0.25;
      b.add(p, [0.028, 0.022, 0.008], randomQuat(r), [0.2 * light, 0.55 * light, 0.18 * light, 0.9]);
    }
  }
  // 赤い実
  for (let k = 0; k < 14; k++) {
    const bl = blobs[k % blobs.length];
    const v = [r() * 2 - 1, r() * 2 - 0.6, r() * 2 - 1];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    const c: [number, number, number] = [bl[0] + v[0] / l * bl[3], bl[1] + v[1] / l * bl[3], bl[2] + v[2] / l * bl[3]];
    for (let i = 0; i < 120; i++) {
      const w = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
      const m = Math.hypot(w[0], w[1], w[2]) || 1;
      b.add([c[0] + w[0] / m * 0.045, c[1] + w[1] / m * 0.045, c[2] + w[2] / m * 0.045], [0.012, 0.012, 0.005], randomQuat(r),
        [0.9, 0.12 + r() * 0.1, 0.1, 0.97]);
    }
  }
  addGround(b, r, 1.4, 6000);
  addJunk(b, r, [0, 0.8, 0]);
  return b.build(TILT, OFFSET);
}

/** 負荷テスト用：100万個のガウシアンでできた虹色の球と地面 */
export function makeStress(count = 1_000_000): SplatData {
  const r = rng(3);
  const n = count;
  const d: SplatData = {
    count: n,
    positions: new Float32Array(n * 3),
    scales: new Float32Array(n * 3),
    rotations: new Float32Array(n * 4),
    colors: new Uint8Array(n * 4),
  };
  const ground = Math.floor(n * 0.2);
  for (let i = 0; i < n; i++) {
    let x, y, z, s, cr, cg, cb;
    if (i < ground) {
      const a = r() * Math.PI * 2, dd = Math.sqrt(r()) * 1.8;
      x = Math.cos(a) * dd; y = 0; z = Math.sin(a) * dd; s = 0.012;
      const g = 0.3 + r() * 0.1; cr = g; cg = g; cb = g + 0.05;
    } else {
      const v = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      x = v[0] / l * 0.8; y = v[1] / l * 0.8 + 0.85; z = v[2] / l * 0.8; s = 0.008;
      cr = 0.5 + 0.5 * v[0] / l; cg = 0.5 + 0.5 * v[1] / l; cb = 0.5 + 0.5 * v[2] / l;
    }
    d.positions[i * 3] = x; d.positions[i * 3 + 1] = y; d.positions[i * 3 + 2] = z;
    d.scales[i * 3] = s; d.scales[i * 3 + 1] = s; d.scales[i * 3 + 2] = s;
    d.rotations[i * 4] = 1;
    d.colors[i * 4] = cr * 255; d.colors[i * 4 + 1] = cg * 255; d.colors[i * 4 + 2] = cb * 255; d.colors[i * 4 + 3] = 235;
  }
  return d;
}
