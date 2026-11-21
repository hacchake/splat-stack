// .ply（3DGS標準形式）と .splat 形式の読み込み
import type { SplatData } from './splat';

const C0 = 0.28209479177387814; // 0次の球面調和関数の係数

type PlyType = 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';
const TYPE_ALIAS: Record<string, PlyType> = {
  char: 'int8', int8: 'int8', uchar: 'uint8', uint8: 'uint8',
  short: 'int16', int16: 'int16', ushort: 'uint16', uint16: 'uint16',
  int: 'int32', int32: 'int32', uint: 'uint32', uint32: 'uint32',
  float: 'float32', float32: 'float32', double: 'float64', float64: 'float64',
};
const TYPE_SIZE: Record<PlyType, number> = {
  int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, float64: 8,
};

interface PlyProp { name: string; type: PlyType; list: boolean }
interface PlyElement { name: string; count: number; props: PlyProp[] }

function readValue(dv: DataView, off: number, t: PlyType, le: boolean): number {
  switch (t) {
    case 'float32': return dv.getFloat32(off, le);
    case 'uint8': return dv.getUint8(off);
    case 'int8': return dv.getInt8(off);
    case 'int16': return dv.getInt16(off, le);
    case 'uint16': return dv.getUint16(off, le);
    case 'int32': return dv.getInt32(off, le);
    case 'uint32': return dv.getUint32(off, le);
    case 'float64': return dv.getFloat64(off, le);
  }
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp255 = (v: number) => (v < 0 ? 0 : v > 1 ? 255 : Math.round(v * 255));

export function parsePly(buf: ArrayBuffer, onProgress: (p: number) => void): SplatData {
  const bytes = new Uint8Array(buf);
  const headText = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1 << 17)));
  const endIdx = headText.indexOf('end_header');
  if (endIdx < 0) throw new Error('PLYファイルのヘッダーが読めません');
  let bodyStart = endIdx + 'end_header'.length;
  if (bytes[bodyStart] === 13) bodyStart++;
  if (bytes[bodyStart] === 10) bodyStart++;

  let format = '';
  const elements: PlyElement[] = [];
  for (const raw of headText.slice(0, endIdx).split(/\r?\n/)) {
    const t = raw.trim().split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') elements.push({ name: t[1], count: parseInt(t[2], 10), props: [] });
    else if (t[0] === 'property' && elements.length) {
      const el = elements[elements.length - 1];
      if (t[1] === 'list') el.props.push({ name: t[4], type: TYPE_ALIAS[t[3]] ?? 'uint8', list: true });
      else {
        const type = TYPE_ALIAS[t[1]];
        if (!type) throw new Error(`PLYの型「${t[1]}」に対応していません`);
        el.props.push({ name: t[2], type, list: false });
      }
    }
  }
  if (elements.some((e) => e.name === 'chunk')) {
    throw new Error('圧縮PLY（SuperSplat形式）にはまだ対応していません。SuperSplatで「PLY（圧縮なし）」として書き出し直してください。');
  }
  const vi = elements.findIndex((e) => e.name === 'vertex');
  if (vi < 0) throw new Error('PLYに頂点(vertex)データがありません');
  const vertex = elements[vi];
  const names = vertex.props.map((p) => p.name);
  for (const req of ['x', 'y', 'z']) if (!names.includes(req)) throw new Error(`PLYに「${req}」がありません`);
  if (vertex.props.some((p) => p.list)) throw new Error('頂点にリスト型のプロパティがあるPLYには対応していません');

  const n = vertex.count;
  const out: SplatData = {
    count: n,
    positions: new Float32Array(n * 3),
    scales: new Float32Array(n * 3),
    rotations: new Float32Array(n * 4),
    colors: new Uint8Array(n * 4),
  };

  const has = (k: string) => names.includes(k);
  const hasScale = has('scale_0') && has('scale_1') && has('scale_2');
  const hasRot = has('rot_0') && has('rot_1') && has('rot_2') && has('rot_3');
  const hasDC = has('f_dc_0') && has('f_dc_1') && has('f_dc_2');
  const hasRGB = has('red') && has('green') && has('blue');
  const hasOpacity = has('opacity');

  // 1行ごとの値を受け取って変換する
  const idx = (k: string) => names.indexOf(k);
  const iX = idx('x'), iY = idx('y'), iZ = idx('z');
  const iS = [idx('scale_0'), idx('scale_1'), idx('scale_2')];
  const iR = [idx('rot_0'), idx('rot_1'), idx('rot_2'), idx('rot_3')];
  const iD = hasDC ? [idx('f_dc_0'), idx('f_dc_1'), idx('f_dc_2')] : [idx('red'), idx('green'), idx('blue')];
  const iO = idx('opacity');
  const rgbIs8bit = !hasDC && hasRGB && vertex.props[iD[0]].type === 'uint8';
  const row = new Float64Array(names.length);

  const store = (i: number) => {
    out.positions[i * 3] = row[iX];
    out.positions[i * 3 + 1] = row[iY];
    out.positions[i * 3 + 2] = row[iZ];
    if (hasScale) {
      out.scales[i * 3] = Math.exp(row[iS[0]]);
      out.scales[i * 3 + 1] = Math.exp(row[iS[1]]);
      out.scales[i * 3 + 2] = Math.exp(row[iS[2]]);
    } else {
      out.scales[i * 3] = out.scales[i * 3 + 1] = out.scales[i * 3 + 2] = -1; // 後で決める
    }
    if (hasRot) {
      let w = row[iR[0]], x = row[iR[1]], y = row[iR[2]], z = row[iR[3]];
      const l = Math.hypot(w, x, y, z) || 1;
      w /= l; x /= l; y /= l; z /= l;
      out.rotations[i * 4] = w; out.rotations[i * 4 + 1] = x; out.rotations[i * 4 + 2] = y; out.rotations[i * 4 + 3] = z;
    } else {
      out.rotations[i * 4] = 1;
    }
    if (hasDC) {
      out.colors[i * 4] = clamp255(0.5 + C0 * row[iD[0]]);
      out.colors[i * 4 + 1] = clamp255(0.5 + C0 * row[iD[1]]);
      out.colors[i * 4 + 2] = clamp255(0.5 + C0 * row[iD[2]]);
    } else if (hasRGB) {
      const k = rgbIs8bit ? 1 / 255 : 1;
      out.colors[i * 4] = clamp255(row[iD[0]] * k);
      out.colors[i * 4 + 1] = clamp255(row[iD[1]] * k);
      out.colors[i * 4 + 2] = clamp255(row[iD[2]] * k);
    } else {
      out.colors[i * 4] = out.colors[i * 4 + 1] = out.colors[i * 4 + 2] = 200;
    }
    out.colors[i * 4 + 3] = hasOpacity ? clamp255(sigmoid(row[iO])) : 255;
  };

  if (format === 'ascii') {
    const text = new TextDecoder('latin1').decode(bytes.subarray(bodyStart));
    const lines = text.split(/\r?\n/);
    // vertexより前の要素の行を飛ばす
    let li = 0;
    for (let e = 0; e < vi; e++) li += elements[e].count;
    for (let i = 0; i < n; i++) {
      const t = lines[li + i].trim().split(/\s+/);
      for (let k = 0; k < names.length; k++) row[k] = parseFloat(t[k]);
      store(i);
      if ((i & 0xffff) === 0) onProgress(i / n);
    }
  } else if (format === 'binary_little_endian' || format === 'binary_big_endian') {
    const le = format === 'binary_little_endian';
    let off = bodyStart;
    for (let e = 0; e < vi; e++) {
      const el = elements[e];
      if (el.props.some((p) => p.list)) throw new Error(`PLYの要素「${el.name}」が読み飛ばせません`);
      off += el.count * el.props.reduce((s, p) => s + TYPE_SIZE[p.type], 0);
    }
    const offsets: number[] = [];
    let stride = 0;
    for (const p of vertex.props) { offsets.push(stride); stride += TYPE_SIZE[p.type]; }
    if (off + stride * n > bytes.length) throw new Error('PLYファイルが途中で切れています');
    const dv = new DataView(buf);
    // 必要なプロパティだけ読む
    const need = new Set([iX, iY, iZ, ...iS, ...iR, ...iD, iO].filter((v) => v >= 0));
    const needList = [...need];
    const types = vertex.props.map((p) => p.type);
    for (let i = 0; i < n; i++) {
      const base = off + i * stride;
      for (let j = 0; j < needList.length; j++) {
        const k = needList[j];
        row[k] = readValue(dv, base + offsets[k], types[k], le);
      }
      store(i);
      if ((i & 0xffff) === 0) onProgress(i / n);
    }
  } else {
    throw new Error(`PLYの形式「${format}」に対応していません`);
  }

  if (!hasScale) fillDefaultScales(out);
  return out;
}

/** スケール情報がない点群PLY用：全体の大きさから適当な大きさを決める */
function fillDefaultScales(d: SplatData) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < d.count; i++) {
    const x = d.positions[i * 3], y = d.positions[i * 3 + 1], z = d.positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const vol = Math.max(1e-9, (maxX - minX) * (maxY - minY) * (maxZ - minZ));
  const s = Math.cbrt(vol / Math.max(1, d.count)) * 0.6;
  d.scales.fill(s);
}

/** .splat形式（antimatter15形式：1個32バイト） */
export function parseSplatFile(buf: ArrayBuffer, onProgress: (p: number) => void): SplatData {
  const n = Math.floor(buf.byteLength / 32);
  if (n === 0) throw new Error('.splatファイルが空です');
  const f = new Float32Array(buf, 0, n * 8);
  const u = new Uint8Array(buf);
  const out: SplatData = {
    count: n,
    positions: new Float32Array(n * 3),
    scales: new Float32Array(n * 3),
    rotations: new Float32Array(n * 4),
    colors: new Uint8Array(n * 4),
  };
  for (let i = 0; i < n; i++) {
    out.positions[i * 3] = f[i * 8];
    out.positions[i * 3 + 1] = f[i * 8 + 1];
    out.positions[i * 3 + 2] = f[i * 8 + 2];
    out.scales[i * 3] = f[i * 8 + 3];
    out.scales[i * 3 + 1] = f[i * 8 + 4];
    out.scales[i * 3 + 2] = f[i * 8 + 5];
    const b = i * 32;
    out.colors[i * 4] = u[b + 24];
    out.colors[i * 4 + 1] = u[b + 25];
    out.colors[i * 4 + 2] = u[b + 26];
    out.colors[i * 4 + 3] = u[b + 27];
    let w = (u[b + 28] - 128) / 128, x = (u[b + 29] - 128) / 128, y = (u[b + 30] - 128) / 128, z = (u[b + 31] - 128) / 128;
    const l = Math.hypot(w, x, y, z) || 1;
    out.rotations[i * 4] = w / l; out.rotations[i * 4 + 1] = x / l; out.rotations[i * 4 + 2] = y / l; out.rotations[i * 4 + 3] = z / l;
    if ((i & 0xffff) === 0) onProgress(i / n);
  }
  return out;
}
