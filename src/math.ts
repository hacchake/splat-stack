// 小さな行列・ベクトル計算
// M3 は行優先の3x3、Mat4 は WebGL 用の列優先4x4

export type V3 = [number, number, number];
export type M3 = number[];
export const DEG = Math.PI / 180;

export const I3 = (): M3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul3(a: M3, b: M3): M3 {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

export function apply3(m: M3, v: V3): V3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

const rotX = (a: number): M3 => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; };
const rotY = (a: number): M3 => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
const rotZ = (a: number): M3 => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; };

/** X→Y→Zの順に回す（R = Rz·Ry·Rx）。角度は度 */
export function eulerToM3(x: number, y: number, z: number): M3 {
  return mul3(rotZ(z * DEG), mul3(rotY(y * DEG), rotX(x * DEG)));
}

export function m3ToEuler(m: M3): V3 {
  const sy = Math.max(-1, Math.min(1, -m[6]));
  const y = Math.asin(sy);
  let x: number, z: number;
  if (Math.abs(sy) < 0.99999) {
    x = Math.atan2(m[7], m[8]);
    z = Math.atan2(m[3], m[0]);
  } else {
    x = Math.atan2(m[1] * sy, m[4]);
    z = 0;
  }
  return [x / DEG, y / DEG, z / DEG];
}

export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** 単位ベクトルaをbへ重ねる回転 */
export function rotationBetween(a: V3, b: V3): M3 {
  const v = cross(a, b);
  const c = dot(a, b);
  if (c < -0.99999) {
    // 180度：aに垂直な軸で回す
    const axis = normalize(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    const [x, y, z] = axis;
    return [2 * x * x - 1, 2 * x * y, 2 * x * z, 2 * x * y, 2 * y * y - 1, 2 * y * z, 2 * x * z, 2 * y * z, 2 * z * z - 1];
  }
  const k = 1 / (1 + c);
  const [x, y, z] = v;
  return [
    1 + k * (-y * y - z * z), -z + k * x * y, y + k * x * z,
    z + k * x * y, 1 + k * (-x * x - z * z), -x + k * y * z,
    -y + k * x * z, x + k * y * z, 1 + k * (-x * x - y * y),
  ];
}

/** p ↦ R(p − c) を表す4x4（列優先） */
export function modelMatrix(R: M3, c: V3): Float32Array {
  const t = apply3(R, c);
  return new Float32Array([
    R[0], R[3], R[6], 0,
    R[1], R[4], R[7], 0,
    R[2], R[5], R[8], 0,
    -t[0], -t[1], -t[2], 1,
  ]);
}

export function mul4(a: Float32Array, b: Float32Array): Float32Array {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = s;
    }
  return r;
}

/** 対称3x3行列の固有値・固有ベクトル（ヤコビ法）。固有ベクトルは列 */
export function eigenSym3(A: M3): { values: V3; vectors: V3[] } {
  const a = A.slice();
  const v = I3();
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-15) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-18) continue;
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p], akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k], aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  return {
    values: [a[0], a[4], a[8]],
    vectors: [0, 1, 2].map((j) => [v[j], v[3 + j], v[6 + j]] as V3),
  };
}
