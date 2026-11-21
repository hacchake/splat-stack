// 孤立したガウシアンを見つけるため、各ガウシアンの「近くにいる仲間の数」を数える
// 半径rの格子に分け、自分のマスと周り26マスの合計を数える（近似）
let positions: Float32Array | null = null;

type Msg = { type: 'data'; positions: Float32Array } | { type: 'compute'; radius: number; id: number };

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === 'data') { positions = m.positions; return; }
  if (!positions) return;
  const P = positions;
  const n = P.length / 3;
  const r = m.radius;
  const progress = (p: number) => postMessage({ type: 'progress', p, id: m.id });

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
  }
  // マス番号（各軸 0〜2^17 に収め、3軸合わせて2^51 < 2^53 で数値誤差が出ないようにする）
  const DIM = 1 << 17;
  const cellOf = new Float64Array(n);
  const cellMap = new Map<number, number>();
  const cellCount: number[] = [];
  const cellKeys: number[] = [];
  const keyOf = (ix: number, iy: number, iz: number) => (iz * DIM + iy) * DIM + ix;
  for (let i = 0; i < n; i++) {
    const ix = Math.min(DIM - 2, Math.max(1, Math.floor((P[i * 3] - minX) / r) + 1));
    const iy = Math.min(DIM - 2, Math.max(1, Math.floor((P[i * 3 + 1] - minY) / r) + 1));
    const iz = Math.min(DIM - 2, Math.max(1, Math.floor((P[i * 3 + 2] - minZ) / r) + 1));
    const key = keyOf(ix, iy, iz);
    let c = cellMap.get(key);
    if (c === undefined) {
      c = cellCount.length;
      cellMap.set(key, c);
      cellCount.push(0);
      cellKeys.push(key);
    }
    cellCount[c]++;
    cellOf[i] = c;
    if ((i & 0x3ffff) === 0) progress(0.6 * i / n);
  }
  // 各マスの周囲27マスの合計
  const nc = cellCount.length;
  const sum = new Uint32Array(nc);
  for (let c = 0; c < nc; c++) {
    const key = cellKeys[c];
    const ix = key % DIM, iy = Math.floor(key / DIM) % DIM, iz = Math.floor(key / (DIM * DIM));
    let s = 0;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const o = cellMap.get(keyOf(ix + dx, iy + dy, iz + dz));
          if (o !== undefined) s += cellCount[o];
        }
    sum[c] = s;
    if ((c & 0x3ffff) === 0) progress(0.6 + 0.35 * c / nc);
  }
  const counts = new Uint16Array(n);
  for (let i = 0; i < n; i++) counts[i] = Math.min(65535, sum[cellOf[i]] - 1); // 自分自身は数えない
  postMessage({ type: 'done', counts, id: m.id }, { transfer: [counts.buffer] });
};

export {};
