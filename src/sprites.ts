// スプライトスタックの素材（ドット絵の輪切り）を読み込んで、ガウシアンに変換する
// 対応：PNGのスプライトシート（縦並び・横並び）、連番PNG（複数選択・ZIP）、MagicaVoxel の .vox
import type { SplatData } from './splat';

/** 読み込んだ素材：同じ大きさの層を、下から順に並べたもの */
export interface SpriteSource {
  name: string;
  /** 層の横幅（X）と縦（Z。画像の行の向き） */
  w: number;
  d: number;
  /** 下から順の層（RGBA、w×d） */
  layers: Uint8ClampedArray[];
}

export interface SheetOptions {
  /** 'auto' = 自動判定 / 'vertical' = 縦に並んでいる / 'horizontal' = 横に並んでいる */
  layout: 'auto' | 'vertical' | 'horizontal';
  /** 1枚の大きさ（並んでいる向きの長さ）。0 なら正方形とみなして自動 */
  frame: number;
  /** true なら、先頭（上または左）が一番下の層 */
  firstIsBottom: boolean;
}

// ---------------- 画像の読み込み ----------------
async function decodeImage(blob: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** 1枚のスプライトシートを、層に切り分ける */
export function splitSheet(img: ImageData, o: SheetOptions): { w: number; d: number; layers: Uint8ClampedArray[] } {
  const W = img.width, H = img.height;
  let layout = o.layout;
  if (layout === 'auto') layout = H >= W ? 'vertical' : 'horizontal';
  const across = layout === 'vertical' ? W : H; // 並びと直角の向きの長さ
  const along = layout === 'vertical' ? H : W; // 並んでいる向きの長さ
  const frame = o.frame > 0 ? o.frame : across; // 自動なら正方形
  const n = Math.floor(along / frame);
  if (n < 1) throw new Error('シートを層に分けられませんでした。「1枚の大きさ」を確かめてください');
  const w = layout === 'vertical' ? W : frame;
  const d = layout === 'vertical' ? frame : H;
  const layers: Uint8ClampedArray[] = [];
  for (let k = 0; k < n; k++) {
    const out = new Uint8ClampedArray(w * d * 4);
    const ox = layout === 'vertical' ? 0 : k * frame, oy = layout === 'vertical' ? k * frame : 0;
    for (let y = 0; y < d; y++) {
      const src = ((oy + y) * W + ox) * 4;
      out.set(img.data.subarray(src, src + w * 4), y * w * 4);
    }
    layers.push(out);
  }
  if (!o.firstIsBottom) layers.reverse();
  return { w, d, layers };
}

/** 連番の画像（名前順）を層として並べる */
function stackImages(imgs: ImageData[], firstIsBottom: boolean): { w: number; d: number; layers: Uint8ClampedArray[] } {
  const w = imgs[0].width, d = imgs[0].height;
  if (imgs.some((i) => i.width !== w || i.height !== d)) throw new Error('連番の画像の大きさがそろっていません');
  const layers = imgs.map((i) => new Uint8ClampedArray(i.data));
  if (!firstIsBottom) layers.reverse();
  return { w, d, layers };
}

// ---------------- ZIP（このアプリで書き出したもの・一般的なもの）----------------
async function readZipImages(buf: ArrayBuffer): Promise<{ name: string; blob: Blob }[]> {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  // 末尾の「中央ディレクトリの終わり」を探す
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIPファイルが読めません');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: { name: string; blob: Blob }[] = [];
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!/\.png$/i.test(name) || name.includes('__MACOSX')) continue;
    const lnlen = dv.getUint16(local + 26, true), lxlen = dv.getUint16(local + 28, true);
    const data = u8.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    let blob: Blob;
    if (method === 0) blob = new Blob([data.slice()], { type: 'image/png' });
    else if (method === 8) {
      const ds = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      blob = new Blob([await new Response(ds).arrayBuffer()], { type: 'image/png' });
    } else throw new Error(`ZIPの圧縮方式（${method}）に対応していません`);
    out.push({ name, blob });
  }
  if (!out.length) throw new Error('ZIPの中にPNGが見つかりませんでした');
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// ---------------- MagicaVoxel (.vox) ----------------
function parseVox(buf: ArrayBuffer): { w: number; d: number; layers: Uint8ClampedArray[]; note: string } {
  const dv = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'VOX ') throw new Error('MagicaVoxel の .vox ファイルではないようです');
  let size: [number, number, number] | null = null;
  let voxels: Uint8Array | null = null;
  let models = 0;
  let palette: Uint8Array | null = null;
  // MAIN の中の子チャンクを順に読む
  let p = 8 + 12; // "VOX " + version + MAIN の見出し
  while (p + 12 <= buf.byteLength) {
    const id = tag(p), csize = dv.getInt32(p + 4, true), kids = dv.getInt32(p + 8, true);
    const body = p + 12;
    if (id === 'SIZE' && !size) size = [dv.getInt32(body, true), dv.getInt32(body + 4, true), dv.getInt32(body + 8, true)];
    else if (id === 'SIZE') models++;
    else if (id === 'XYZI' && !voxels) {
      const n = dv.getInt32(body, true);
      voxels = new Uint8Array(buf, body + 4, n * 4);
    } else if (id === 'RGBA') palette = new Uint8Array(buf, body, 256 * 4);
    p = body + csize + kids;
  }
  if (!size || !voxels) throw new Error('.vox の中にボクセルが見つかりませんでした');
  let note = models > 0 ? `（モデルが${models + 1}個入っていたので、最初の1個だけを使いました）` : '';
  if (!palette) {
    note += '（色の表が入っていなかったので、仮の色を付けました）';
    palette = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const h = (i * 137.5) % 360, c = 0.8, x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
      palette.set([(r + 0.15) * 230, (g + 0.15) * 230, (b + 0.15) * 230, 255], i * 4);
    }
  }
  // MagicaVoxel は z が上。x → 画像の横、y → 画像の縦、z → 層
  const [w, d, h] = size;
  const layers = Array.from({ length: h }, () => new Uint8ClampedArray(w * d * 4));
  for (let i = 0; i < voxels.length; i += 4) {
    const x = voxels[i], y = voxels[i + 1], z = voxels[i + 2], ci = voxels[i + 3];
    if (x >= w || y >= d || z >= h || ci === 0) continue;
    const o = ((d - 1 - y) * w + x) * 4; // 画像の上が奥になるように
    layers[z].set(palette.subarray((ci - 1) * 4, (ci - 1) * 4 + 4), o);
    layers[z][o + 3] = 255;
  }
  return { w, d, layers, note };
}

/** 選ばれたファイル（1つ以上）から素材を読み込む */
export async function loadSpriteFiles(files: File[], o: SheetOptions): Promise<{ src: SpriteSource; note: string }> {
  const name = files.length === 1 ? files[0].name : `${files[0].name} ほか${files.length - 1}枚`;
  if (files.length === 1 && /\.vox$/i.test(files[0].name)) {
    const v = parseVox(await files[0].arrayBuffer());
    return { src: { name, w: v.w, d: v.d, layers: v.layers }, note: v.note };
  }
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
    const items = await readZipImages(await files[0].arrayBuffer());
    const imgs = await Promise.all(items.map((it) => decodeImage(it.blob)));
    const s = imgs.length === 1 ? splitSheet(imgs[0], o) : stackImages(imgs, o.firstIsBottom);
    return { src: { name, ...s }, note: imgs.length > 1 ? `（${imgs.length}枚の連番PNG）` : '' };
  }
  const pngs = files.filter((f) => /\.png$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!pngs.length) throw new Error('PNG・ZIP・.vox のどれかを選んでください');
  const imgs = await Promise.all(pngs.map((f) => decodeImage(f)));
  const s = imgs.length === 1 ? splitSheet(imgs[0], o) : stackImages(imgs, o.firstIsBottom);
  return { src: { name, ...s }, note: imgs.length > 1 ? `（${imgs.length}枚の連番PNG）` : '' };
}

// ---------------- ガウシアンへの変換 ----------------
export interface ConvertOptions {
  /** 1層の高さ（ピクセル何個ぶんか） */
  layerPx: number;
  /** ぼかし：1マスの大きさに対するガウシアンの広がり（0.3 = くっきり、1.0 = もこもこ） */
  softness: number;
}

export interface Converted {
  data: SplatData;
  /** 1マスの大きさ（データの単位） */
  cell: number;
  /** 格子の左下手前の角（データの単位） */
  minX: number;
  minZ: number;
  /** 一番下の層の下の面と、一番上の層の上の面の高さ */
  y0: number;
  y1: number;
  /** 捨てた「中に埋もれたマス」の数 */
  hidden: number;
}

/** 色のあるマスを、それぞれ1個のガウシアンにする（外から見えないマスは捨てる） */
export function spritesToGaussians(src: SpriteSource, o: ConvertOptions): Converted {
  const { w, d, layers } = src;
  const n = layers.length;
  const cell = 1.6 / Math.max(w, d, n * o.layerPx);
  const lh = cell * o.layerPx;
  const solid = (x: number, z: number, k: number) =>
    x >= 0 && z >= 0 && k >= 0 && x < w && z < d && k < n && layers[k][(z * w + x) * 4 + 3] >= 128;
  const pos: number[] = [], col: number[] = [];
  let hidden = 0;
  for (let k = 0; k < n; k++) {
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        const i = (z * w + x) * 4;
        if (layers[k][i + 3] < 128) continue;
        if (solid(x - 1, z, k) && solid(x + 1, z, k) && solid(x, z - 1, k) && solid(x, z + 1, k) && solid(x, z, k - 1) && solid(x, z, k + 1)) {
          hidden++;
          continue;
        }
        pos.push((x + 0.5 - w / 2) * cell, (k + 0.5) * lh, (z + 0.5 - d / 2) * cell);
        col.push(layers[k][i], layers[k][i + 1], layers[k][i + 2], 250);
      }
    }
  }
  const count = pos.length / 3;
  if (!count) throw new Error('色のあるマスが見つかりませんでした（全部透明かもしれません）');
  const data: SplatData = {
    count,
    positions: new Float32Array(pos),
    scales: new Float32Array(count * 3),
    rotations: new Float32Array(count * 4),
    colors: new Uint8Array(col),
  };
  const sh = cell * o.softness, sv = lh * o.softness;
  for (let i = 0; i < count; i++) {
    data.scales[i * 3] = sh; data.scales[i * 3 + 1] = sv; data.scales[i * 3 + 2] = sh;
    data.rotations[i * 4] = 1;
  }
  return { data, cell, minX: (-w / 2) * cell, minZ: (-d / 2) * cell, y0: 0, y1: n * lh, hidden };
}
