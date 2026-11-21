// 焼き込んだ層の仕上げ：ソフトモード／ドット絵モード（減色・アルファ2値化・輪郭線）
import type { BakeRaw } from './baker';
import { GAMEBOY, NES, PICO8, nearest, type RGB } from './palettes';

export type OutputMode = 'soft' | 'pixel';

export interface PixelOptions {
  /** 色数（4〜32） */
  colors: number;
  /** これ以上の不透明度なら「ある」とみなす（0〜1） */
  alphaThreshold: number;
  /** 輪郭線を付けるか */
  outline: boolean;
  /** 輪郭線の色 [r,g,b] 0〜255 */
  outlineColor: [number, number, number];
  /** スキャンは表面にしかガウシアンがないので、輪切りが「輪」になる。その内側を埋める */
  fillInside: boolean;
  /** 'auto' = 自動で色を選ぶ / 'gb' = ゲームボーイ4階調 / 'nes' = ファミコンの色に寄せる / 'pico8' = PICO-8の16色に寄せる */
  palette: 'auto' | 'gb' | 'nes' | 'pico8';
  /** ディザ（中間の色を点々の混ざりで表す） */
  dither: boolean;
}

function fillInside(o: Uint8ClampedArray, res: number) {
  const n = res * res;
  const outside = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const push = (p: number) => { if (!outside[p] && !o[p * 4 + 3]) { outside[p] = 1; queue[tail++] = p; } };
  for (let i = 0; i < res; i++) { push(i); push((res - 1) * res + i); push(i * res); push(i * res + res - 1); }
  while (head < tail) {
    const p = queue[head++], x = p % res, y = (p / res) | 0;
    if (x > 0) push(p - 1); if (x < res - 1) push(p + 1);
    if (y > 0) push(p - res); if (y < res - 1) push(p + res);
  }
  // 色のあるマスから内側へ、近い順に色を広げる
  head = tail = 0;
  const done = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (o[p * 4 + 3]) { done[p] = 1; queue[tail++] = p; }
  while (head < tail) {
    const p = queue[head++], x = p % res, y = (p / res) | 0;
    const nb = [x > 0 ? p - 1 : -1, x < res - 1 ? p + 1 : -1, y > 0 ? p - res : -1, y < res - 1 ? p + res : -1];
    for (const q of nb) {
      if (q < 0 || done[q] || outside[q]) continue;
      done[q] = 1;
      o[q * 4] = o[p * 4]; o[q * 4 + 1] = o[p * 4 + 1]; o[q * 4 + 2] = o[p * 4 + 2]; o[q * 4 + 3] = 255;
      queue[tail++] = q;
    }
  }
}

export interface Finished {
  resolution: number;
  slices: ImageData[];
  /** ドット絵モードで使った色 */
  palette: [number, number, number][] | null;
}

export function finish(raw: BakeRaw, mode: OutputMode, opt: PixelOptions): Finished {
  const res = raw.resolution;
  if (mode === 'soft') {
    return { resolution: res, slices: raw.soft.map((d) => new ImageData(new Uint8ClampedArray(d), res, res)), palette: null };
  }
  const th = Math.round(opt.alphaThreshold * 255);
  // 1) アルファを2値化
  const layers = raw.nearest.map((d) => {
    const o = new Uint8ClampedArray(d);
    for (let i = 3; i < o.length; i += 4) o[i] = o[i] >= th ? 255 : 0;
    return o;
  });
  // 2) 全層共通のパレットをメディアンカットで作る（層ごとに色がばらつかないように）
  let palette: RGB[];
  if (opt.palette === 'gb') {
    // ゲームボーイ風：明るさの順に4等分して、4階調に割り当てる
    palette = GAMEBOY;
    const lum = (o: Uint8ClampedArray, i: number) => 0.3 * o[i] + 0.59 * o[i + 1] + 0.11 * o[i + 2];
    const samples: number[] = [];
    for (const o of layers) for (let i = 0; i < o.length; i += 4) if (o[i + 3]) samples.push(lum(o, i));
    samples.sort((a, b) => a - b);
    const q = (t: number) => samples[Math.floor(t * (samples.length - 1))] ?? 0;
    const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
    for (const o of layers)
      for (let i = 0; i < o.length; i += 4) {
        if (!o[i + 3]) { o[i] = o[i + 1] = o[i + 2] = 0; continue; }
        const l = lum(o, i);
        const p = palette[l < t1 ? 0 : l < t2 ? 1 : l < t3 ? 2 : 3];
        o[i] = p[0]; o[i + 1] = p[1]; o[i + 2] = p[2];
      }
  } else {
    palette = medianCut(layers, opt.colors);
    // ファミコン風・PICO-8風：作った色を、その機種で出せる一番近い色に寄せる
    const fixed = opt.palette === 'nes' ? NES : opt.palette === 'pico8' ? PICO8 : null;
    if (fixed) {
      const seen = new Set<number>();
      palette = palette.map((c) => fixed[nearest(fixed, c[0], c[1], c[2])]).filter((c) => {
        const k = (c[0] << 16) | (c[1] << 8) | c[2];
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  }
  // 3) 一番近いパレット色に置き換え
  const cache = new Map<number, number>();
  // ディザ：4×4の決まった模様で少しずつ色をずらしてから一番近い色を選ぶと、中間の色が「点々の混ざり」で表せる
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const amp = opt.dither ? 40 : 0;
  if (opt.palette !== 'gb') for (const o of layers) {
    for (let i = 0; i < o.length; i += 4) {
      if (!o[i + 3]) { o[i] = o[i + 1] = o[i + 2] = 0; continue; }
      const px = (i >> 2) % res, py = Math.floor((i >> 2) / res);
      const d = amp ? (BAYER[(py & 3) * 4 + (px & 3)] / 16 - 0.47) * amp : 0;
      const r = Math.max(0, Math.min(255, o[i] + d)) | 0, g = Math.max(0, Math.min(255, o[i + 1] + d)) | 0, b = Math.max(0, Math.min(255, o[i + 2] + d)) | 0;
      const key = (r << 16) | (g << 8) | b;
      let pi = cache.get(key);
      if (pi === undefined) { pi = nearestIndex(palette, r, g, b); cache.set(key, pi); }
      const p = palette[pi];
      o[i] = p[0]; o[i + 1] = p[1]; o[i + 2] = p[2];
    }
  }
  // 3.5) 中空対策：輪の内側（外から回り込めない透明なマス）を、一番近い色で埋める
  if (opt.fillInside) for (const o of layers) fillInside(o, res);
  // 4) 輪郭線（透明なマスのうち、上下左右に色のあるマスが隣にあるもの）
  if (opt.outline) {
    const [lr, lg, lb] = opt.outlineColor;
    for (let k = 0; k < layers.length; k++) {
      const src = layers[k];
      const dst = new Uint8ClampedArray(src);
      const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < res && y < res && src[(y * res + x) * 4 + 3] > 0;
      for (let y = 0; y < res; y++)
        for (let x = 0; x < res; x++) {
          const i = (y * res + x) * 4;
          if (src[i + 3]) continue;
          if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) {
            dst[i] = lr; dst[i + 1] = lg; dst[i + 2] = lb; dst[i + 3] = 255;
          }
        }
      layers[k] = dst;
    }
  }
  return { resolution: res, slices: layers.map((d) => new ImageData(d, res, res)), palette };
}

function nearestIndex(pal: [number, number, number][], r: number, g: number, b: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < pal.length; i++) {
    // 人の目に合わせて緑を重めに
    const dr = pal[i][0] - r, dg = pal[i][1] - g, db = pal[i][2] - b;
    const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** メディアンカット減色：色の箱を「一番幅の広い色成分の中央」で割り続ける */
function medianCut(layers: Uint8ClampedArray[], k: number): [number, number, number][] {
  let total = 0;
  for (const o of layers) for (let i = 3; i < o.length; i += 4) if (o[i]) total++;
  if (total === 0) return [[0, 0, 0]];
  const step = Math.max(1, Math.floor(total / 200000));
  const cols: number[] = [];
  let c = 0;
  for (const o of layers)
    for (let i = 0; i < o.length; i += 4)
      if (o[i + 3] && (c++ % step) === 0) cols.push(o[i], o[i + 1], o[i + 2]);
  const n = cols.length / 3;
  type Box = { idx: Uint32Array };
  const all = new Uint32Array(n);
  for (let i = 0; i < n; i++) all[i] = i;
  let boxes: Box[] = [{ idx: all }];
  const range = (b: Box) => {
    const mn = [255, 255, 255], mx = [0, 0, 0];
    for (const i of b.idx) for (let ch = 0; ch < 3; ch++) {
      const v = cols[i * 3 + ch];
      if (v < mn[ch]) mn[ch] = v;
      if (v > mx[ch]) mx[ch] = v;
    }
    const w = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    const ch = w[1] >= w[0] && w[1] >= w[2] ? 1 : w[0] >= w[2] ? 0 : 2;
    return { ch, w: w[ch] };
  };
  while (boxes.length < k) {
    // 「幅 × 個数」が一番大きい箱を割る
    let bi = -1, bestScore = 0, bestCh = 0;
    boxes.forEach((b, i) => {
      if (b.idx.length < 2) return;
      const r = range(b);
      const score = r.w * Math.sqrt(b.idx.length);
      if (score > bestScore) { bestScore = score; bi = i; bestCh = r.ch; }
    });
    if (bi < 0) break;
    const b = boxes[bi];
    const sorted = Array.from(b.idx).sort((p, q) => cols[p * 3 + bestCh] - cols[q * 3 + bestCh]);
    const mid = sorted.length >> 1;
    boxes = [...boxes.slice(0, bi), { idx: Uint32Array.from(sorted.slice(0, mid)) }, { idx: Uint32Array.from(sorted.slice(mid)) }, ...boxes.slice(bi + 1)];
  }
  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0;
    for (const i of b.idx) { r += cols[i * 3]; g += cols[i * 3 + 1]; bl += cols[i * 3 + 2]; }
    const m = b.idx.length || 1;
    return [Math.round(r / m), Math.round(g / m), Math.round(bl / m)] as [number, number, number];
  });
}
