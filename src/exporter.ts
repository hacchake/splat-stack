// 書き出し：スプライトシート（PNG）と連番PNG（ZIPにまとめる）
import type { Finished } from './postprocess';
import type { SplatData } from './splat';
import type { M3, V3 } from './math';

export interface ExportOptions {
  /** 'vertical' = 縦に並べる / 'horizontal' = 横に並べる */
  layout: 'vertical' | 'horizontal';
  /** true = 一番下の層を先頭にする */
  bottomFirst: boolean;
  /** 1ピクセルを何倍に拡大して書き出すか */
  scale: number;
  baseName: string;
}

const MAX_CANVAS = 32000;

function orderedSlices(f: Finished, o: ExportOptions): ImageData[] {
  return o.bottomFirst ? f.slices : [...f.slices].reverse();
}

function sliceCanvas(img: ImageData, scale: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  if (scale === 1) return c;
  const s = document.createElement('canvas');
  s.width = img.width * scale; s.height = img.height * scale;
  const ctx = s.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c, 0, 0, s.width, s.height);
  return s;
}

function toBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((ok, ng) => c.toBlob((b) => (b ? ok(b) : ng(new Error('PNGを作れませんでした'))), 'image/png'));
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 縦（または横）に並べた1枚のPNG */
export async function exportSheet(f: Finished, o: ExportOptions) {
  const imgs = orderedSlices(f, o);
  const cell = f.resolution * o.scale;
  const long = cell * imgs.length;
  if (long > MAX_CANVAS) throw new Error(`画像が長すぎます（${long}px）。枚数・解像度・拡大率を下げるか、連番PNGで書き出してください。`);
  const c = document.createElement('canvas');
  c.width = o.layout === 'vertical' ? cell : long;
  c.height = o.layout === 'vertical' ? long : cell;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  imgs.forEach((img, i) => {
    const s = sliceCanvas(img, o.scale);
    if (o.layout === 'vertical') ctx.drawImage(s, 0, i * cell);
    else ctx.drawImage(s, i * cell, 0);
  });
  download(await toBlob(c), `${o.baseName}_sheet_${imgs.length}x${cell}px.png`);
}

/** 連番PNG＋情報ファイルをZIPにまとめる */
export async function exportZip(f: Finished, o: ExportOptions, info: Record<string, unknown>) {
  const imgs = orderedSlices(f, o);
  const files: { name: string; data: Uint8Array }[] = [];
  const digits = Math.max(3, String(imgs.length - 1).length);
  for (let i = 0; i < imgs.length; i++) {
    const b = await toBlob(sliceCanvas(imgs[i], o.scale));
    files.push({ name: `${o.baseName}/slice_${String(i).padStart(digits, '0')}.png`, data: new Uint8Array(await b.arrayBuffer()) });
  }
  const meta = { ...info, order: o.bottomFirst ? 'slice_000 が一番下の層' : 'slice_000 が一番上の層', pixelScale: o.scale };
  files.push({ name: `${o.baseName}/info.json`, data: new TextEncoder().encode(JSON.stringify(meta, null, 2)) });
  download(makeZip(files), `${o.baseName}_slices.zip`);
}

// ---------- 最小限のZIP作成（無圧縮。PNGはもともと圧縮済みなので十分） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(d: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files: { name: string; data: Uint8Array }[]): Blob {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true); // ファイル名はUTF-8
    h.setUint16(8, 0, true); // 無圧縮
    h.setUint32(14, crc, true);
    h.setUint32(18, f.data.length, true);
    h.setUint32(22, f.data.length, true);
    h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: 'application/zip' });
}

// ---------- 3DGS の標準形式 .ply として書き出す ----------
const SH_C0 = 0.28209479177387814;

/** 回転行列（行優先）→ クォータニオン (w,x,y,z) */
function mat3ToQuat(m: M3): [number, number, number, number] {
  const t = m[0] + m[4] + m[8];
  let w, x, y, z;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    w = 0.25 * s; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[7] - m[5]) / s; x = 0.25 * s; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = 0.25 * s; z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = 0.25 * s;
  }
  return [w, x, y, z];
}

/**
 * 表示中のガウシアン（クロップ・フィルタ・上方向合わせを反映したもの）を、
 * 一般的な3DGSビューア（SuperSplat など）で開ける .ply にして保存する。
 */
export function exportPly(d: SplatData, mask: Uint8Array, R: M3, c: V3, baseName: string): number {
  let n = 0;
  for (let i = 0; i < d.count; i++) if (mask[i]) n++;
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2',
    ...Array.from({ length: 45 }, (_, k) => 'f_rest_' + k), 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = 'ply\nformat binary_little_endian 1.0\n' +
    `comment Splat Stack（Claude Code（Opus 5.5）を使用して制作）で書き出し\nelement vertex ${n}\n` +
    props.map((pp) => 'property float ' + pp).join('\n') + '\nend_header\n';
  const head = new TextEncoder().encode(header);
  // 見出しの長さが4の倍数とは限らないので、数値は別に作ってから後ろにつなげる
  const f = new Float32Array(n * props.length);
  const qR = mat3ToQuat(R);
  const P = d.positions, S = d.scales, Q = d.rotations, C = d.colors;
  let k = 0;
  for (let i = 0; i < d.count; i++) {
    if (!mask[i]) continue;
    const b = k * props.length;
    const px = P[i * 3] - c[0], py = P[i * 3 + 1] - c[1], pz = P[i * 3 + 2] - c[2];
    f[b] = R[0] * px + R[1] * py + R[2] * pz;
    f[b + 1] = R[3] * px + R[4] * py + R[5] * pz;
    f[b + 2] = R[6] * px + R[7] * py + R[8] * pz;
    // f[b+3..5] = 法線（使わないので0）、f_rest も0
    for (let ch = 0; ch < 3; ch++) f[b + 6 + ch] = (C[i * 4 + ch] / 255 - 0.5) / SH_C0;
    const a = Math.min(0.999, Math.max(0.001, C[i * 4 + 3] / 255));
    f[b + 54] = Math.log(a / (1 - a));
    for (let ax = 0; ax < 3; ax++) f[b + 55 + ax] = Math.log(Math.max(1e-7, S[i * 3 + ax]));
    // 回転：上方向合わせの回転を、元の向きの前に掛ける
    const [w1, x1, y1, z1] = qR, w2 = Q[i * 4], x2 = Q[i * 4 + 1], y2 = Q[i * 4 + 2], z2 = Q[i * 4 + 3];
    f[b + 58] = w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2;
    f[b + 59] = w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2;
    f[b + 60] = w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2;
    f[b + 61] = w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2;
    k++;
  }
  download(new Blob([head, f], { type: 'application/octet-stream' }), `${baseName}_3dgs.ply`);
  return n;
}
