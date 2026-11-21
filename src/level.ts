// 「地面をクリックして水平合わせ」のための処理
import type { SplatData } from './splat';
import { apply3, eigenSym3, type M3, type V3 } from './math';

/** 視線に最も近い（手前の）不透明なガウシアンの位置（整列後の座標）を返す */
export function pickPoint(d: SplatData, mask: Uint8Array, R: M3, c: V3, eye: V3, dir: V3, tol: number): V3 | null {
  const P = d.positions, C = d.colors;
  let best = Infinity;
  let hit: V3 | null = null;
  for (let i = 0; i < d.count; i++) {
    if (!mask[i] || C[i * 4 + 3] < 80) continue;
    const px = P[i * 3] - c[0], py = P[i * 3 + 1] - c[1], pz = P[i * 3 + 2] - c[2];
    const qx = R[0] * px + R[1] * py + R[2] * pz - eye[0];
    const qy = R[3] * px + R[4] * py + R[5] * pz - eye[1];
    const qz = R[6] * px + R[7] * py + R[8] * pz - eye[2];
    const t = qx * dir[0] + qy * dir[1] + qz * dir[2];
    if (t <= 0 || t >= best) continue;
    const d2 = qx * qx + qy * qy + qz * qz - t * t;
    const lim = tol * t;
    if (d2 < lim * lim) {
      best = t;
      hit = [qx + eye[0], qy + eye[1], qz + eye[2]];
    }
  }
  return hit;
}

/** 点Pのまわりのガウシアンに平面を当てはめ、その法線を返す（整列後の座標） */
export function fitPlane(d: SplatData, mask: Uint8Array, R: M3, c: V3, P0: V3, radius: number): { normal: V3; used: number } | null {
  const P = d.positions;
  const r2 = radius * radius;
  let n = 0, sx = 0, sy = 0, sz = 0;
  const pts: number[] = [];
  for (let i = 0; i < d.count; i++) {
    if (!mask[i]) continue;
    const q = apply3(R, [P[i * 3] - c[0], P[i * 3 + 1] - c[1], P[i * 3 + 2] - c[2]]);
    const dx = q[0] - P0[0], dy = q[1] - P0[1], dz = q[2] - P0[2];
    if (dx * dx + dy * dy + dz * dz > r2) continue;
    pts.push(q[0], q[1], q[2]);
    sx += q[0]; sy += q[1]; sz += q[2]; n++;
  }
  if (n < 10) return null;
  const mx = sx / n, my = sy / n, mz = sz / n;
  const A = new Array(9).fill(0);
  for (let k = 0; k < n; k++) {
    const x = pts[k * 3] - mx, y = pts[k * 3 + 1] - my, z = pts[k * 3 + 2] - mz;
    A[0] += x * x; A[1] += x * y; A[2] += x * z;
    A[4] += y * y; A[5] += y * z; A[8] += z * z;
  }
  A[3] = A[1]; A[6] = A[2]; A[7] = A[5];
  const { values, vectors } = eigenSym3(A);
  let mi = 0;
  for (let k = 1; k < 3; k++) if (values[k] < values[mi]) mi = k;
  return { normal: vectors[mi], used: n };
}
