// 書き出し：スプライトシート（PNG）と連番PNG（ZIPにまとめる）
import type { Finished } from './postprocess';

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
