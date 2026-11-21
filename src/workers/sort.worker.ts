// 視点からの距離でガウシアンを手前→奥に並べ替える（16bitの計数ソート）
let positions: Float32Array | null = null;
let mask: Uint8Array | null = null;
let depthBuf = new Int32Array(0);
let indexBuf = new Uint32Array(0);
const counts = new Uint32Array(65536);
const starts = new Uint32Array(65536);

type Msg =
  | { type: 'data'; positions: Float32Array }
  | { type: 'mask'; mask: Uint8Array }
  | { type: 'sort'; row: number[]; showRemoved: boolean; id: number };

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === 'data') {
    positions = m.positions;
    mask = null;
    const n = positions.length / 3;
    depthBuf = new Int32Array(n);
    indexBuf = new Uint32Array(n);
  } else if (m.type === 'mask') {
    mask = m.mask;
  } else if (m.type === 'sort') {
    if (!positions) return;
    const order = sort(m.row, m.showRemoved);
    postMessage({ type: 'sorted', order, id: m.id }, { transfer: [order.buffer] });
  }
};

function sort(row: number[], showRemoved: boolean): Uint32Array {
  const P = positions!;
  const n = P.length / 3;
  const [a, b, c, d] = row;
  // 描画対象を集めて深度を計算
  let k = 0;
  let minD = Infinity, maxD = -Infinity;
  const depthF = new Float32Array(depthBuf.buffer);
  for (let i = 0; i < n; i++) {
    const m = mask ? mask[i] : 1;
    if (!m && !showRemoved) continue;
    const z = a * P[i * 3] + b * P[i * 3 + 1] + c * P[i * 3 + 2] + d;
    depthF[k] = z;
    indexBuf[k] = m ? i : (i | 0x80000000) >>> 0;
    if (z < minD) minD = z;
    if (z > maxD) maxD = z;
    k++;
  }
  const out = new Uint32Array(k);
  if (k === 0) return out;
  const scale = maxD > minD ? 65535 / (maxD - minD) : 0;
  counts.fill(0);
  const keys = new Uint16Array(k);
  for (let i = 0; i < k; i++) {
    const key = ((depthF[i] - minD) * scale) | 0;
    keys[i] = key;
    counts[key]++;
  }
  starts[0] = 0;
  for (let i = 1; i < 65536; i++) starts[i] = starts[i - 1] + counts[i - 1];
  for (let i = 0; i < k; i++) out[starts[keys[i]]++] = indexBuf[i];
  return out;
}

export {};
