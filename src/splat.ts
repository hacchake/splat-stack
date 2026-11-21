// ガウシアン群のデータ形式と、GPU用テクスチャへの詰め込み

/** 読み込んだガウシアン群（すべて「実際の値」に変換済み） */
export interface SplatData {
  count: number;
  /** 位置 xyz（3個ずつ） */
  positions: Float32Array;
  /** 各軸の標準偏差（exp済み、3個ずつ） */
  scales: Float32Array;
  /** 回転クォータニオン w,x,y,z（正規化済み、4個ずつ） */
  rotations: Float32Array;
  /** 色 RGBA 0〜255（Aは不透明度、シグモイド済み、4個ずつ） */
  colors: Uint8Array;
}

/** GPUテクスチャ1行あたりのガウシアン数（1個につき3テクセル使う） */
export const SPLATS_PER_ROW = 1365;
export const TEX_WIDTH = SPLATS_PER_ROW * 3; // 4095

export interface PackedSplats {
  data: Uint32Array;
  width: number;
  height: number;
}

/** クォータニオン(w,x,y,z)から回転行列（行優先）を作る */
export function quatToMat3(w: number, x: number, y: number, z: number, out: number[] = new Array(9)): number[] {
  out[0] = 1 - 2 * (y * y + z * z);
  out[1] = 2 * (x * y - w * z);
  out[2] = 2 * (x * z + w * y);
  out[3] = 2 * (x * y + w * z);
  out[4] = 1 - 2 * (x * x + z * z);
  out[5] = 2 * (y * z - w * x);
  out[6] = 2 * (x * z - w * y);
  out[7] = 2 * (y * z + w * x);
  out[8] = 1 - 2 * (x * x + y * y);
  return out;
}

/**
 * 1ガウシアン = 3テクセル(RGBA32UI) に詰める。
 * テクセル0: 位置xyz(float) + 色(RGBA8)
 * テクセル1: 共分散 s00 s01 s02 s11
 * テクセル2: 共分散 s12 s22 (残り未使用)
 */
export function packSplats(d: SplatData, onProgress?: (p: number) => void): PackedSplats {
  const n = d.count;
  const height = Math.max(1, Math.ceil(n / SPLATS_PER_ROW));
  const data = new Uint32Array(TEX_WIDTH * height * 4);
  const f = new Float32Array(data.buffer);
  const P = d.positions, S = d.scales, Q = d.rotations, C = d.colors;
  const R = new Array(9);
  for (let i = 0; i < n; i++) {
    const b = i * 12;
    f[b] = P[i * 3];
    f[b + 1] = P[i * 3 + 1];
    f[b + 2] = P[i * 3 + 2];
    data[b + 3] = (C[i * 4] | (C[i * 4 + 1] << 8) | (C[i * 4 + 2] << 16) | (C[i * 4 + 3] << 24)) >>> 0;

    quatToMat3(Q[i * 4], Q[i * 4 + 1], Q[i * 4 + 2], Q[i * 4 + 3], R);
    const sx = S[i * 3], sy = S[i * 3 + 1], sz = S[i * 3 + 2];
    // M = R * diag(s)
    const m00 = R[0] * sx, m01 = R[1] * sy, m02 = R[2] * sz;
    const m10 = R[3] * sx, m11 = R[4] * sy, m12 = R[5] * sz;
    const m20 = R[6] * sx, m21 = R[7] * sy, m22 = R[8] * sz;
    // Σ = M Mᵀ
    f[b + 4] = m00 * m00 + m01 * m01 + m02 * m02;
    f[b + 5] = m00 * m10 + m01 * m11 + m02 * m12;
    f[b + 6] = m00 * m20 + m01 * m21 + m02 * m22;
    f[b + 7] = m10 * m10 + m11 * m11 + m12 * m12;
    f[b + 8] = m10 * m20 + m11 * m21 + m12 * m22;
    f[b + 9] = m20 * m20 + m21 * m21 + m22 * m22;
    if (onProgress && (i & 0xffff) === 0) onProgress(i / n);
  }
  return { data, width: TEX_WIDTH, height };
}

export interface SplatStats {
  /** 中央値ベースの中心 */
  center: [number, number, number];
  /** 外れ値を除いたおおよその半径（大きい軸） */
  size: number;
}

/** 間引きサンプルから、外れ値に強い中心と大きさを求める */
export function computeStats(d: SplatData): SplatStats {
  const n = d.count;
  const step = Math.max(1, Math.floor(n / 200000));
  const m = Math.ceil(n / step);
  const center: [number, number, number] = [0, 0, 0];
  let size = 0;
  for (let a = 0; a < 3; a++) {
    const s = new Float32Array(m);
    let k = 0;
    for (let i = 0; i < n; i += step) s[k++] = d.positions[i * 3 + a];
    const arr = s.subarray(0, k).sort();
    const q = (t: number) => arr[Math.min(k - 1, Math.floor(t * (k - 1)))];
    center[a] = q(0.5);
    size = Math.max(size, (q(0.98) - q(0.02)) / 2);
  }
  if (!(size > 0)) size = 1;
  return { center, size };
}
