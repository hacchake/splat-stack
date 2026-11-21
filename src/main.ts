// Splat Stack フェーズ1：読み込み・プレビュー・上方向合わせ・クロップ・ゴミ取り
import './style.css';
import { computeStats, packSplats, type PackedSplats, type SplatData, type SplatStats } from './splat';
import { SplatRenderer } from './renderer';
import { OrbitCamera } from './camera';
import { eulerToM3, m3ToEuler, modelMatrix, mul3, mul4, rotationBetween, dot, sub, normalize, I3, type M3, type V3 } from './math';
import { pickPoint, fitPlane } from './level';
import { makeCube, makeTree, makeStress } from './dummy';
import { makeHouse, makeMushroom, makeCar, makeChest, makeCactus } from './dummy2';
import { loadSpriteFiles, spritesToGaussians, type SpriteSource, type SheetOptions } from './sprites';
import { SliceBaker, type BakeRaw, type BakeRegion } from './baker';
import { finish, type Finished, type OutputMode, type PixelOptions } from './postprocess';
import { exportSheet, exportZip, exportPly, type ExportOptions } from './exporter';
import { StackRenderer } from './stack';
import { GaussianStackRenderer, buildGaussianStack } from './gstack';
import { GpuTimer } from './gputimer';

type ViewMode = '3dgs' | 'gstack' | 'stack' | 'compare' | 'split' | 'morph';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------- 状態 ----------------
const state = {
  data: null as SplatData | null,
  name: '',
  stats: { center: [0, 0, 0], size: 1 } as SplatStats,
  euler: [0, 0, 0] as V3,
  R: I3() as M3,
  cropMin: [-1, -1, -1] as V3,
  cropMax: [1, 1, 1] as V3,
  opacityMin: 0.05,
  isoRadiusPct: 1.5,
  isoMin: 0,
  isoCounts: null as Uint16Array | null,
  isoCountsRadius: -1,
  showRemoved: false,
  showBox: true,
  background: [0.106, 0.114, 0.141] as [number, number, number],
  mask: new Uint8Array(0),
  visible: 0,
  maskVersion: 0,
  dataGen: 0,
  groundY: null as number | null,
  picking: false,
  /** 表示中のガウシアンの中心が収まる範囲（整列後） */
  bounds: null as { min: V3; max: V3 } | null,
  // ---- フェーズ2 ----
  slices: 32,
  resolution: 64,
  mode: 'pixel' as OutputMode,
  pixel: { colors: 16, alphaThreshold: 0.5, outline: false, outlineColor: [26, 20, 36], fillInside: true, palette: 'auto', dither: false } as PixelOptions,
  showSlices: true,
  baking: false,
  bakeCancel: false,
  bakedKey: '',
  raw: null as BakeRaw | null,
  finished: null as Finished | null,
  selectedSlice: 0,
  // ---- フェーズ3 ----
  view: '3dgs' as ViewMode,
  // ---- フェーズ4 ----
  /** 左右比較の右側 */
  splitRight: 'stack' as 'stack' | 'gstack',
  /** 変身の進み具合 0（3DGS）〜1（ドット絵） */
  morph: 0,
  anim: null as null | { kind: 'morph'; start: number; dur: number; from: number; to: number }
    | { kind: 'demo'; start: number; dur: number; yaw0: number; layout: 'morph' | 'split' },
  /** ガウシアン・スタックで上方向に残す厚み（層の厚みに対する割合） */
  gThickness: 0,
  /** 低い角度ほど自動で厚くする */
  gAutoThick: true,
  /** ガウシアンの影のぼかし（高さ1あたりのぼけ） */
  gShadowSoft: 0.05,
  /** ガウシアン・スタックで、層の中の高さを保つ（段々を消す） */
  gKeepHeight: true,
  /** スプライトスタック素材から作ったときの元データ */
  sprite: null as null | { src: SpriteSource },
  spriteLayerPx: 1,
  spriteSoftness: 0.55,
  /** スタック系の表示で許す俯角の下限（度） */
  minPitchDeg: 20,
  texHeight: 0,
  autoRotate: true,
  rotateSpeed: 30, // 度/秒
  heightMul: 1,
  stackSub: 0, // 0 = 自動
  shade: 0.35,
  shadowStrength: 0.35,
  lightAzimuth: 35,
  lightElevation: 50,
  recDuration: 12,
  /** 表示のときにシルエットの外側へ付ける輪郭線 */
  viewOutline: false,
};

const canvas = $<HTMLCanvasElement>('gl');
let renderer: SplatRenderer;
try {
  renderer = new SplatRenderer(canvas);
} catch (e) {
  document.body.innerHTML = `<div style="padding:40px;color:#fff">${(e as Error).message}</div>`;
  throw e;
}
const camera = new OrbitCamera();

// ---------------- 小物UI ----------------
function toast(msg: string, error = false, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.className = error ? 'error' : '';
  t.hidden = false;
  clearTimeout((toast as any).timer);
  (toast as any).timer = setTimeout(() => (t.hidden = true), ms);
}
function progress(label: string | null, p = 0) {
  const box = $('progress');
  if (label === null) { box.hidden = true; return; }
  box.hidden = false;
  (box.querySelector('.label') as HTMLElement).textContent = `${label}… ${Math.round(p * 100)}%`;
  (box.querySelector('.fill') as HTMLElement).style.width = `${p * 100}%`;
}

interface Slider { input: HTMLInputElement; set(v: number): void; setRange(min: number, max: number, step: number): void }
function slider(parent: HTMLElement, label: string, min: number, max: number, step: number, value: number,
  fmt: (v: number) => string, onInput: (v: number) => void): Slider {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('span'); l.className = 'lbl'; l.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  const val = document.createElement('span'); val.className = 'val';
  row.append(l, input, val);
  parent.append(row);
  const setRange = (a: number, b: number, s: number) => { input.min = String(a); input.max = String(b); input.step = String(s); };
  setRange(min, max, step);
  input.value = String(value);
  val.textContent = fmt(value);
  input.addEventListener('input', () => { const v = parseFloat(input.value); val.textContent = fmt(v); onInput(v); });
  return {
    input,
    set(v: number) { input.value = String(v); val.textContent = fmt(v); },
    setRange,
  };
}

// ---------------- 上方向（回転） ----------------
const rotBox = $('rot-sliders');
const rotSliders = (['X', 'Y', 'Z'] as const).map((ax, i) =>
  slider(rotBox, `${ax}軸の回転`, -180, 180, 0.5, 0, (v) => `${v.toFixed(1)}°`, (v) => {
    state.euler[i] = v;
    applyRotation(eulerToM3(...state.euler));
  }));

function applyRotation(R: M3, syncSliders = false) {
  state.R = R;
  if (syncSliders) {
    state.euler = m3ToEuler(R);
    state.euler.forEach((v, i) => rotSliders[i].set(Math.round(v * 10) / 10));
  }
  state.groundY = null;
  ($('crop-ground') as HTMLButtonElement).disabled = true;
  scheduleMask();
}
/** 今の回転の「あと」に追加で回す（画面の軸基準） */
function rotateMore(D: M3) { applyRotation(mul3(D, state.R), true); }

$('rot-flip').onclick = () => rotateMore(eulerToM3(180, 0, 0));
$('rot-x90').onclick = () => rotateMore(eulerToM3(90, 0, 0));
$('rot-z90').onclick = () => rotateMore(eulerToM3(0, 0, 90));
$('rot-reset').onclick = () => applyRotation(I3(), true);

// ---------------- クロップ ----------------
const cropBox = $('crop-sliders');
const cropSliders: { min: Slider; max: Slider }[] = [];
(['X（左右）', 'Y（上下）', 'Z（前後）'] as const).forEach((ax, i) => {
  const t = document.createElement('div'); t.className = 'group-title'; t.textContent = ax; cropBox.append(t);
  const mn = slider(cropBox, '下限', -1, 1, 0.001, -1, (v) => v.toFixed(2), (v) => {
    state.cropMin[i] = Math.min(v, state.cropMax[i]);
    scheduleMask();
  });
  const mx = slider(cropBox, '上限', -1, 1, 0.001, 1, (v) => v.toFixed(2), (v) => {
    state.cropMax[i] = Math.max(v, state.cropMin[i]);
    scheduleMask();
  });
  cropSliders.push({ min: mn, max: mx });
});
const cropLimit = () => state.stats.size * 3;
function setCrop(min: V3, max: V3) {
  const L = cropLimit();
  for (let i = 0; i < 3; i++) {
    state.cropMin[i] = Math.max(-L, min[i]);
    state.cropMax[i] = Math.min(L, max[i]);
    cropSliders[i].min.set(state.cropMin[i]);
    cropSliders[i].max.set(state.cropMax[i]);
  }
  scheduleMask();
}
function resetCrop() {
  const L = cropLimit();
  for (let i = 0; i < 3; i++) {
    const step = L / 500;
    cropSliders[i].min.setRange(-L, L, step);
    cropSliders[i].max.setRange(-L, L, step);
  }
  setCrop([-L, -L, -L], [L, L, L]);
}
$('crop-reset').onclick = resetCrop;
$('crop-auto').onclick = autoCrop;
$('crop-ground').onclick = () => {
  if (state.groundY === null) return;
  const min = state.cropMin.slice() as V3;
  min[1] = state.groundY + state.stats.size * 0.015;
  setCrop(min, state.cropMax.slice() as V3);
  toast('地面のすぐ上から下を切り取りました。残したい部分まで消えたら「Y 下限」を少し下げてください。');
};

/** フィルタを通ったガウシアンの、整列後の位置の1〜99%範囲で囲む */
function autoCrop() {
  const d = state.data;
  if (!d) return;
  const step = Math.max(1, Math.floor(d.count / 200000));
  const axes: number[][] = [[], [], []];
  const R = state.R, c = state.stats.center;
  for (let i = 0; i < d.count; i += step) {
    if (!passesFilters(i)) continue;
    const px = d.positions[i * 3] - c[0], py = d.positions[i * 3 + 1] - c[1], pz = d.positions[i * 3 + 2] - c[2];
    axes[0].push(R[0] * px + R[1] * py + R[2] * pz);
    axes[1].push(R[3] * px + R[4] * py + R[5] * pz);
    axes[2].push(R[6] * px + R[7] * py + R[8] * pz);
  }
  if (axes[0].length < 10) return;
  const min: V3 = [0, 0, 0], max: V3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const s = Float32Array.from(axes[a]).sort();
    const lo = s[Math.floor(s.length * 0.01)], hi = s[Math.floor(s.length * 0.99)];
    const m = (hi - lo) * 0.06;
    min[a] = lo - m; max[a] = hi + m;
  }
  setCrop(min, max);
  camera.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  toast('残っている部分を自動で囲みました。端の余分はスライダーで詰めてください。');
}

// ---------------- フィルタ ----------------
const filterBox = $('filter-sliders');
slider(filterBox, '不透明度の下限', 0, 0.8, 0.01, state.opacityMin, (v) => v.toFixed(2), (v) => {
  state.opacityMin = v; scheduleMask();
});
const isoRadiusSlider = slider(filterBox, '孤立判定の距離', 0.3, 6, 0.1, state.isoRadiusPct, (v) => `${v.toFixed(1)}%`, (v) => {
  state.isoRadiusPct = v; requestIsolation();
});
slider(filterBox, '近くの仲間が\nこれ未満なら除去', 0, 40, 1, state.isoMin, (v) => (v === 0 ? 'オフ' : `${v}個`), (v) => {
  state.isoMin = v; requestIsolation(); scheduleMask();
});
void isoRadiusSlider;

function passesFilters(i: number): boolean {
  const d = state.data!;
  if (d.colors[i * 4 + 3] < state.opacityMin * 255) return false;
  if (state.isoMin > 0 && state.isoCounts && state.isoCounts[i] < state.isoMin) return false;
  return true;
}

// 孤立判定（別スレッド）
const isoWorker = new Worker(new URL('./workers/isolation.worker.ts', import.meta.url), { type: 'module' });
let isoReqId = 0;
let isoTimer = 0;
function isoRadius() { return state.stats.size * 2 * state.isoRadiusPct / 100; }
function requestIsolation() {
  if (!state.data || state.isoMin === 0) return;
  if (state.isoCounts && state.isoCountsRadius === isoRadius()) return;
  clearTimeout(isoTimer);
  isoTimer = window.setTimeout(() => {
    isoReqId++;
    $('iso-status').textContent = '孤立判定を計算中… 0%';
    isoWorker.postMessage({ type: 'compute', radius: isoRadius(), id: isoReqId });
  }, 150);
}
isoWorker.onmessage = (e) => {
  const m = e.data;
  if (m.id !== isoReqId) return;
  if (m.type === 'progress') $('iso-status').textContent = `孤立判定を計算中… ${Math.round(m.p * 100)}%`;
  else if (m.type === 'done') {
    state.isoCounts = m.counts;
    state.isoCountsRadius = isoRadius();
    $('iso-status').textContent = '';
    scheduleMask();
  }
};

// ---------------- 描画対象マスク ----------------
let maskScheduled = false;
function scheduleMask() {
  if (maskScheduled) return;
  maskScheduled = true;
  requestAnimationFrame(() => { if (!maskScheduled) return; maskScheduled = false; recomputeMask(); });
}
function recomputeMask() {
  const d = state.data;
  if (!d) return;
  const n = d.count, P = d.positions, C = d.colors;
  const R = state.R, c = state.stats.center;
  const [x0, y0, z0] = state.cropMin, [x1, y1, z1] = state.cropMax;
  const opTh = state.opacityMin * 255;
  const iso = state.isoMin > 0 && state.isoCounts ? state.isoCounts : null;
  const isoMin = state.isoMin;
  const mask = new Uint8Array(n);
  let vis = 0;
  let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (C[i * 4 + 3] < opTh) continue;
    if (iso && iso[i] < isoMin) continue;
    const px = P[i * 3] - c[0], py = P[i * 3 + 1] - c[1], pz = P[i * 3 + 2] - c[2];
    const ax = R[0] * px + R[1] * py + R[2] * pz;
    if (ax < x0 || ax > x1) continue;
    const ay = R[3] * px + R[4] * py + R[5] * pz;
    if (ay < y0 || ay > y1) continue;
    const az = R[6] * px + R[7] * py + R[8] * pz;
    if (az < z0 || az > z1) continue;
    mask[i] = 1;
    vis++;
    if (ax < bx0) bx0 = ax; if (ax > bx1) bx1 = ax;
    if (ay < by0) by0 = ay; if (ay > by1) by1 = ay;
    if (az < bz0) bz0 = az; if (az > bz1) bz1 = az;
  }
  state.mask = mask;
  state.visible = vis;
  state.bounds = vis ? { min: [bx0, by0, bz0], max: [bx1, by1, bz1] } : null;
  updateBakeStatus();
  state.maskVersion++;
  const copy = mask.slice();
  sorter.postMessage({ type: 'mask', mask: copy }, [copy.buffer]);
}

// ---------------- 並べ替え（別スレッド） ----------------
const sorter = new Worker(new URL('./workers/sort.worker.ts', import.meta.url), { type: 'module' });
let sortBusy = false;
let lastSortKey = '';
let sortMs = 0;
let sortStart = 0;
let sortWaiter: (() => void) | null = null;
sorter.onmessage = (e) => {
  sortBusy = false;
  if (e.data.id === state.dataGen) {
    renderer.setOrder(e.data.order);
    sortMs = performance.now() - sortStart;
  }
  const w = sortWaiter;
  sortWaiter = null;
  w?.();
};
/** 並べ替えを今すぐ行い、終わるまで待つ（1コマずつ書き出す録画で使う） */
async function sortNow(row: number[]) {
  while (sortBusy) await yieldTask();
  sortBusy = true;
  lastSortKey = '';
  sortStart = performance.now();
  const done = new Promise<void>((r) => (sortWaiter = r));
  sorter.postMessage({ type: 'sort', row, showRemoved: state.showRemoved, id: state.dataGen });
  await done;
}
function yieldTask(): Promise<void> {
  return new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
}
function maybeSort(row: number[]) {
  if (sortBusy) return;
  const key = row.map((v) => v.toFixed(4)).join(',') + `|${state.maskVersion}|${state.showRemoved}|${state.dataGen}`;
  if (key === lastSortKey) return;
  lastSortKey = key;
  sortBusy = true;
  sortStart = performance.now();
  sorter.postMessage({ type: 'sort', row, showRemoved: state.showRemoved, id: state.dataGen });
}

// ---------------- データの差し替え ----------------
function setData(d: SplatData, packed: PackedSplats, name: string) {
  try {
    renderer.setSplats(packed);
    state.texHeight = packed.height;
  } catch (e) {
    toast((e as Error).message, true, 8000);
    return;
  }
  state.data = d;
  state.name = name;
  state.dataGen++;
  state.stats = computeStats(d);
  state.isoCounts = null;
  state.isoCountsRadius = -1;
  state.groundY = null;
  ($('crop-ground') as HTMLButtonElement).disabled = true;
  state.raw = null;
  state.finished = null;
  $('drawer').hidden = true;
  $('palette').innerHTML = '';
  $<HTMLButtonElement>('exp-sheet').disabled = true;
  $<HTMLButtonElement>('exp-zip').disabled = true;
  $<HTMLButtonElement>('open-drawer').disabled = true;
  $<HTMLButtonElement>('exp-ply').disabled = false;
  state.sprite = null;
  setView('3dgs');
  gstack.set(null);
  setTabsEnabled(false);
  sorter.postMessage({ type: 'data', positions: d.positions.slice() });
  isoWorker.postMessage({ type: 'data', positions: d.positions.slice() });
  applyRotation(I3(), true);
  resetCrop();
  recomputeMask();
  requestIsolation();
  resetCamera();
  $('empty').hidden = true;
  $('file-info').textContent = `${name}：${d.count.toLocaleString()} 個のガウシアン`;
}

function resetCamera() {
  camera.target = [0, 0, 0];
  camera.distance = state.stats.size * 3.2;
  camera.yaw = 0.7;
  camera.pitch = 0.4;
}
$('cam-reset').onclick = resetCamera;

// ---------------- ファイル読み込み ----------------
async function loadFile(file: File) {
  progress('ファイルを読み込み中', 0);
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    progress(null);
    toast('ファイルを読み込めませんでした（大きすぎる可能性があります）', true);
    return;
  }
  const w = new Worker(new URL('./workers/loader.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') progress(m.label, m.p);
    else {
      w.terminate();
      progress(null);
      if (m.type === 'error') toast(m.message, true, 9000);
      else {
        setData(m.data, m.packed, file.name);
        toast('読み込みました。まず「上方向を合わせる」から始めましょう。');
      }
    }
  };
  w.postMessage({ buffer, name: file.name }, [buffer]);
}

$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) loadFile(f);
  (e.target as HTMLInputElement).value = '';
});
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.length) return;
  if (files.every((f) => /\.(png|zip|vox)$/i.test(f.name))) importSprites(files);
  else loadFile(files[0]);
});

function loadDummy(make: () => SplatData, name: string) {
  progress('テストデータを作成中', 0.3);
  setTimeout(() => {
    const d = make();
    setData(d, packSplats(d), name);
    progress(null);
    toast('テストデータはわざと傾けてあります。「地面をクリックして水平合わせ」を試してください。', false, 6000);
  }, 30);
}
$('dummy-cube').onclick = () => loadDummy(makeCube, 'テスト：色付き立方体');
$('dummy-tree').onclick = () => loadDummy(makeTree, 'テスト：木');
$('dummy-stress').onclick = () => loadDummy(() => makeStress(), 'テスト：100万個');
$('dummy-house').onclick = () => loadDummy(makeHouse, 'テスト：家');
$('dummy-mushroom').onclick = () => loadDummy(makeMushroom, 'テスト：キノコ');
$('dummy-car').onclick = () => loadDummy(makeCar, 'テスト：車');
$('dummy-chest').onclick = () => loadDummy(makeChest, 'テスト：宝箱');
$('dummy-cactus').onclick = () => loadDummy(makeCactus, 'テスト：サボテン');

// ---------------- 表示設定 ----------------
$<HTMLInputElement>('show-removed').onchange = (e) => { state.showRemoved = (e.target as HTMLInputElement).checked; };
$<HTMLInputElement>('show-box').onchange = (e) => { state.showBox = (e.target as HTMLInputElement).checked; };
$<HTMLInputElement>('bg').oninput = (e) => {
  const h = (e.target as HTMLInputElement).value;
  state.background = [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255) as [number, number, number];
};

// ---------------- 地面クリックで水平合わせ ----------------
function setPicking(on: boolean) {
  state.picking = on && !!state.data;
  $('pick-banner').hidden = !state.picking;
  canvas.classList.toggle('picking', state.picking);
  $('pick-ground').classList.toggle('active', state.picking);
}
$('pick-ground').onclick = () => {
  if (!state.data) { toast('先にデータを読み込んでください', true); return; }
  setPicking(!state.picking);
};
$('pick-cancel').onclick = () => setPicking(false);

function levelAt(px: number, py: number) {
  const d = state.data!;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const eye = camera.eye();
  const dir = camera.rayDir(px, py, w, h);
  const tol = 8 / camera.focal(h); // 8ピクセル以内
  const P = pickPoint(d, state.mask, state.R, state.stats.center, eye, dir, tol);
  if (!P) { toast('そこにはガウシアンが見つかりませんでした。地面の上をクリックしてください。', true); return; }
  const fit = fitPlane(d, state.mask, state.R, state.stats.center, P, state.stats.size * 0.12);
  if (!fit) { toast('周りのガウシアンが少なすぎて平面を推定できませんでした。別の場所を試してください。', true); return; }
  let n = normalize(fit.normal);
  if (dot(n, sub(eye, P)) < 0) n = [-n[0], -n[1], -n[2]]; // カメラ側を「上」にする
  const D = rotationBetween(n, [0, 1, 0]);
  rotateMore(D);
  // 回転後の地面の高さ
  const Pn = [D[0] * P[0] + D[1] * P[1] + D[2] * P[2], D[3] * P[0] + D[4] * P[1] + D[5] * P[2], D[6] * P[0] + D[7] * P[1] + D[8] * P[2]];
  state.groundY = Pn[1];
  ($('crop-ground') as HTMLButtonElement).disabled = false;
  setPicking(false);
  toast(`水平を合わせました（${fit.used.toLocaleString()}個のガウシアンから推定）。地面を消したいときは「地面より上だけ残す」を押してください。`, false, 7000);
}

// ---------------- マウス操作 ----------------
let drag: { x: number; y: number; sx: number; sy: number; button: number; shift: boolean } | null = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, button: e.button, shift: e.shiftKey };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.button === 2 || drag.button === 1 || drag.shift) camera.pan(dx, dy, canvas.clientHeight);
  else camera.orbit(dx, dy);
});
canvas.addEventListener('pointerup', (e) => {
  if (drag && state.picking && drag.button === 0 && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) {
    const r = canvas.getBoundingClientRect();
    levelAt(e.clientX - r.left, e.clientY - r.top);
  }
  drag = null;
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); camera.zoom(e.deltaY); }, { passive: false });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setPicking(false); });

// ---------------- 補助線 ----------------
function boxLines(): Float32Array {
  const [x0, y0, z0] = state.cropMin, [x1, y1, z1] = state.cropMax;
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  return new Float32Array(e.flatMap((i) => v[i]));
}
function gridLines(): Float32Array {
  const [x0, y0, z0] = state.cropMin, [x1, , z1] = state.cropMax;
  const out: number[] = [];
  const N = 12;
  for (let k = 0; k <= N; k++) {
    const x = x0 + (x1 - x0) * k / N, z = z0 + (z1 - z0) * k / N;
    out.push(x, y0, z0, x, y0, z1, x0, y0, z, x1, y0, z);
  }
  return new Float32Array(out);
}
function upArrow(): Float32Array {
  // 「上方向」を示す矢印（クロップボックスの中心から上へ）
  const c = [(state.cropMin[0] + state.cropMax[0]) / 2, state.cropMin[1], (state.cropMin[2] + state.cropMax[2]) / 2];
  const L = state.stats.size * 0.6, a = L * 0.15;
  return new Float32Array([
    c[0], c[1], c[2], c[0], c[1] + L, c[2],
    c[0], c[1] + L, c[2], c[0] + a, c[1] + L - a, c[2],
    c[0], c[1] + L, c[2], c[0] - a, c[1] + L - a, c[2],
  ]);
}

// ================= フェーズ2：スライスへの焼き込み =================
const baker = new SliceBaker(renderer.gl, renderer.tex);

const bakeBox = $('bake-sliders');
const slicesSlider = slider(bakeBox, '枚数', 8, 128, 1, state.slices, (v) => `${v}枚`, (v) => { state.slices = v; updateBakeStatus(); });
$<HTMLSelectElement>('bake-res').onchange = (e) => { state.resolution = parseInt((e.target as HTMLSelectElement).value, 10); updateBakeStatus(); };

const pixelBox = $('pixel-sliders');
const colorsSlider = slider(pixelBox, '色数', 4, 32, 1, state.pixel.colors, (v) => `${v}色`, (v) => { state.pixel.colors = v; scheduleRefinish(); });
slider(pixelBox, 'アルファの\nしきい値', 0.05, 0.95, 0.05, state.pixel.alphaThreshold, (v) => v.toFixed(2), (v) => {
  state.pixel.alphaThreshold = v; scheduleRefinish();
});
$<HTMLInputElement>('fill-inside').onchange = (e) => { state.pixel.fillInside = (e.target as HTMLInputElement).checked; scheduleRefinish(); };
$<HTMLInputElement>('outline').onchange = (e) => { state.viewOutline = (e.target as HTMLInputElement).checked; };
$<HTMLInputElement>('dither').onchange = (e) => { state.pixel.dither = (e.target as HTMLInputElement).checked; scheduleRefinish(); };
$<HTMLInputElement>('outline-slices').onchange = (e) => { state.pixel.outline = (e.target as HTMLInputElement).checked; scheduleRefinish(); };
$<HTMLInputElement>('outline-color').oninput = (e) => {
  const h = (e.target as HTMLInputElement).value;
  state.pixel.outlineColor = [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)) as [number, number, number];
  scheduleRefinish();
};
$('bake-mode').querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => {
    state.mode = b.dataset.mode as OutputMode;
    $('bake-mode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    $('pixel-opts').hidden = state.mode !== 'pixel';
    scheduleRefinish();
  });
});
$<HTMLInputElement>('show-slices').onchange = (e) => { state.showSlices = (e.target as HTMLInputElement).checked; };

/** 焼き込む範囲：X-Zは表示中のものが収まる正方形、Yは表示中のものの上端〜下端 */
function bakeRegion(): BakeRegion | null {
  const b = state.bounds;
  if (!b) return null;
  const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const w = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2], 1e-6) * 1.08;
  const h = Math.max(b.max[1] - b.min[1], 1e-6);
  return { originX: cx - w / 2, originZ: cz - w / 2, width: w, y0: b.min[1], y1: b.min[1] + h * 1.0001 };
}

const currentBakeKey = () => `${state.dataGen}|${state.maskVersion}|${state.slices}|${state.resolution}`;
function updateBakeStatus() {
  const el = $('bake-status');
  if (state.baking) return;
  if (!state.data) { el.textContent = ''; return; }
  const r = bakeRegion();
  if (!r) { el.textContent = '表示中のガウシアンがありません'; return; }
  const layer = (r.y1 - r.y0) / state.slices;
  const px = r.width / state.resolution;
  let msg = `1層の厚み ${layer.toPrecision(3)} ／ 1ピクセル ${px.toPrecision(3)}（単位はデータのまま）`;
  if (state.raw && state.bakedKey !== currentBakeKey()) msg += '\n⚠ 設定が変わりました。もう一度「焼き込む」を押してください。';
  el.textContent = msg;
  el.style.whiteSpace = 'pre-line';
}

/** 表示中のガウシアンを、整列後の高さ（下→上）の順に並べ、層ごとの区切りを求める */
function buildSliceOrder(region: BakeRegion, N: number): { order: Uint32Array; starts: Uint32Array } {
  const d = state.data!;
  const P = d.positions, R = state.R, c = state.stats.center, mask = state.mask;
  const FINE = 2048; // 1層をさらに細かく分けて、層の中でも下→上の順に並べる
  const B = N * FINE;
  const keys = new Int32Array(d.count).fill(-1);
  const counts = new Uint32Array(B + 1);
  const scale = B / (region.y1 - region.y0);
  let total = 0;
  for (let i = 0; i < d.count; i++) {
    if (!mask[i]) continue;
    const px = P[i * 3] - c[0], py = P[i * 3 + 1] - c[1], pz = P[i * 3 + 2] - c[2];
    const y = R[3] * px + R[4] * py + R[5] * pz;
    let k = Math.floor((y - region.y0) * scale);
    if (k < 0) k = 0; else if (k >= B) k = B - 1;
    keys[i] = k;
    counts[k + 1]++;
    total++;
  }
  for (let k = 1; k <= B; k++) counts[k] += counts[k - 1];
  const starts = new Uint32Array(N + 1);
  for (let s = 0; s <= N; s++) starts[s] = counts[s * FINE];
  const order = new Uint32Array(total);
  for (let i = 0; i < d.count; i++) if (keys[i] >= 0) order[counts[keys[i]]++] = i;
  return { order, starts };
}

async function bake() {
  if (!state.data || state.baking) return;
  // 直前のスライダー操作がまだ反映されていなければ、先に反映する
  if (maskScheduled) { maskScheduled = false; recomputeMask(); }
  const region = bakeRegion();
  if (!region) { toast('焼き込むガウシアンがありません。クロップやフィルタを見直してください。', true); return; }
  state.baking = true;
  state.bakeCancel = false;
  const btn = $<HTMLButtonElement>('bake');
  btn.textContent = '中止する';
  const t0 = performance.now();
  try {
    progress('ガウシアンを層に振り分け中', 0);
    await new Promise((r) => setTimeout(r, 20));
    const { order, starts } = buildSliceOrder(region, state.slices);
    const key = currentBakeKey();
    const raw = await baker.bake({
      R: state.R, center: state.stats.center as [number, number, number], region,
      slices: state.slices, resolution: state.resolution, order, starts,
    }, (p) => progress(`${state.slices}枚のスライスを焼き込み中`, p), () => state.bakeCancel);
    if (!raw) { toast('焼き込みを中止しました'); return; }
    // ガウシアン・スタック（ピクセル化しない版）も同じ振り分けから作る
    const gs = await buildGaussianStack(state.data!, state.R, state.stats.center as [number, number, number], region,
      order, starts, state.slices, (p) => progress('ガウシアン・スタックを作成中', p));
    gstack.set(gs);
    state.raw = raw;
    state.bakedKey = key;
    state.selectedSlice = Math.floor(state.slices / 2);
    refinish();
    setTabsEnabled(true);
    // 3DGS表示の注視点を焼き込み範囲の中心に合わせ、スタック表示と位置をそろえる
    camera.target = [region.originX + region.width / 2, (region.y0 + region.y1) / 2, region.originZ + region.width / 2];
    setView('compare');
    toast(`${state.slices}枚 × ${state.resolution}px を焼き込みました（${((performance.now() - t0) / 1000).toFixed(1)}秒）`);
  } catch (e) {
    toast('焼き込みに失敗しました：' + (e as Error).message, true, 9000);
  } finally {
    state.baking = false;
    btn.textContent = '焼き込む';
    progress(null);
    updateBakeStatus();
  }
}
$('bake').onclick = () => { if (state.baking) state.bakeCancel = true; else bake(); };

// 仕上げ（モード・色数・輪郭など）は焼き直さずに作り直せる
let refinishTimer = 0;
function scheduleRefinish() {
  clearTimeout(refinishTimer);
  refinishTimer = window.setTimeout(refinish, 60);
}
function refinish() {
  if (!state.raw) return;
  state.finished = finish(state.raw, state.mode, state.pixel);
  const pal = $('palette');
  pal.innerHTML = '';
  for (const c of state.finished.palette ?? []) {
    const s = document.createElement('span');
    s.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
    pal.append(s);
  }
  $<HTMLButtonElement>('exp-sheet').disabled = false;
  $<HTMLButtonElement>('exp-zip').disabled = false;
  $<HTMLButtonElement>('open-drawer').disabled = false;
  stack.setSlices(state.finished, state.mode === 'soft');
  ($('view-tabs').querySelector('[data-view=stack]') as HTMLButtonElement).textContent = state.mode === 'pixel' ? 'ドット絵スタック' : 'ソフトスタック';
  renderDrawer();
}
$('open-drawer').onclick = openDrawer;

// ---- 焼き込み結果の一覧 ----
function openDrawer() { $('drawer').hidden = false; renderDrawer(); }
$('drawer-close').onclick = () => ($('drawer').hidden = true);
$<HTMLInputElement>('drawer-bg').onchange = () => renderDrawer();
function paint(canvas: HTMLCanvasElement, img: ImageData) {
  canvas.width = img.width; canvas.height = img.height;
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  canvas.classList.toggle('checker', $<HTMLInputElement>('drawer-bg').checked);
}
function renderDrawer() {
  const f = state.finished;
  if (!f || $('drawer').hidden) return;
  $('drawer-title').textContent = `焼き込み結果：${f.slices.length}枚 × ${f.resolution}px（${state.mode === 'pixel' ? 'ドット絵' : 'ソフト'}）　左上が一番上の層`;
  const thumbs = $('thumbs');
  thumbs.innerHTML = '';
  state.selectedSlice = Math.min(state.selectedSlice, f.slices.length - 1);
  // 上の層から順に並べる（見下ろしたときの感覚に合わせる）
  for (let k = f.slices.length - 1; k >= 0; k--) {
    const t = document.createElement('div');
    t.className = 'thumb' + (k === state.selectedSlice ? ' sel' : '');
    const c = document.createElement('canvas');
    paint(c, f.slices[k]);
    const label = document.createElement('span');
    label.textContent = `#${k}`;
    t.append(c, label);
    t.onclick = () => { state.selectedSlice = k; renderDrawer(); };
    thumbs.append(t);
  }
  paint($<HTMLCanvasElement>('big-slice'), f.slices[state.selectedSlice]);
  $('big-label').textContent = `層 #${state.selectedSlice}（0 = 一番下）`;
}

// ---- 書き出し ----
function exportOptions(): ExportOptions {
  const base = fileBaseName();
  return {
    layout: $<HTMLSelectElement>('exp-layout').value as 'vertical' | 'horizontal',
    bottomFirst: $<HTMLSelectElement>('exp-order').value === 'bottom',
    scale: parseInt($<HTMLSelectElement>('exp-scale').value, 10),
    baseName: `${base}_${state.slices}x${state.resolution}_${state.mode}`,
  };
}
$('exp-sheet').onclick = async () => {
  if (!state.finished) return;
  try { await exportSheet(state.finished, exportOptions()); toast('スプライトシートを保存しました（ダウンロードフォルダ）'); }
  catch (e) { toast((e as Error).message, true, 8000); }
};
$('exp-ply').onclick = () => {
  if (!state.data) return;
  if (maskScheduled) { maskScheduled = false; recomputeMask(); }
  const n = exportPly(state.data, state.mask, state.R, state.stats.center as V3, fileBaseName());
  toast(`3DGS（.ply）を保存しました（${n.toLocaleString()}個、ダウンロードフォルダ）`);
};
$('exp-zip').onclick = async () => {
  if (!state.finished || !state.raw) return;
  const r = state.raw.region;
  try {
    await exportZip(state.finished, exportOptions(), {
      tool: 'Splat Stack（Claude Code（Opus 5.5）を使用して制作）',
      source: state.name,
      slices: state.finished.slices.length,
      resolution: state.finished.resolution,
      mode: state.mode,
      layerHeight: (r.y1 - r.y0) / state.finished.slices.length,
      unitsPerPixel: r.width / state.finished.resolution,
    });
    toast('連番PNGのZIPを保存しました（ダウンロードフォルダ）');
  } catch (e) { toast((e as Error).message, true, 8000); }
};

// ================= フェーズ3：スプライトスタッキングのビューア =================
const stack = new StackRenderer(renderer.gl);

const gstack = new GaussianStackRenderer(renderer.gl);
const gpuTimer = new GpuTimer(renderer.gl);

function setTabsEnabled(on: boolean) {
  $('view-tabs').querySelectorAll('button').forEach((b) => {
    if (b.dataset.view !== '3dgs') (b as HTMLButtonElement).disabled = !on;
  });
}
slider($('gstack-sliders'), '上方向の厚み\n（層に対する割合）', 0, 1.5, 0.05, state.gThickness,
  (v) => (v === 0 ? '平ら' : `×${v.toFixed(2)}`), (v) => { state.gThickness = v; });
slider($('gstack-shadow-sliders'), '影のぼかし', 0, 0.4, 0.01, state.gShadowSoft,
  (v) => (v === 0 ? 'くっきり' : v.toFixed(2)), (v) => { state.gShadowSoft = v; });
$<HTMLInputElement>('g-keep-height').onchange = (e) => { state.gKeepHeight = (e.target as HTMLInputElement).checked; };
$<HTMLInputElement>('g-auto-thick').onchange = (e) => { state.gAutoThick = (e.target as HTMLInputElement).checked; };

/** ガウシアン・スタックの厚み：低い角度ほど層のすき間が見えやすいので、自動で厚くする */
function gstackShadow() {
  return state.shadowStrength > 0
    ? { strength: state.shadowStrength, azimuth: state.lightAzimuth, elevation: state.lightElevation, softness: state.gShadowSoft }
    : null;
}

function gstackThickness(pitch: number): number {
  // 層の中の高さを保つときは層のすき間が小さいので、足す厚みも少なくてよい（そのぶん軽くなる）
  const auto = Math.cos(pitch) * (state.gKeepHeight ? 0.4 : 1);
  return state.gAutoThick ? Math.max(state.gThickness, auto) : state.gThickness;
}

function setView(v: ViewMode) {
  if (v !== '3dgs' && !(stack.ready && state.finished && gstack.ready)) return;
  state.view = v;
  $('view-tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  if (v !== '3dgs') { $('drawer').hidden = true; setPicking(false); }
  $('panel-labels').innerHTML = '';
  $('panel-labels').dataset.key = '';
}
$('view-tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view as ViewMode)));

const stackBox = $('stack-sliders');
slider(stackBox, '俯角の下限', 0, 60, 1, state.minPitchDeg, (v) => `${v}°`, (v) => { state.minPitchDeg = v; });
slider(stackBox, '回転の速さ', -90, 90, 1, state.rotateSpeed, (v) => `${v}°/秒`, (v) => { state.rotateSpeed = v; });
slider(stackBox, '高さの倍率', 0.25, 3, 0.05, state.heightMul, (v) => `×${v.toFixed(2)}`, (v) => { state.heightMul = v; });
slider(stackBox, '高さによる\n明るさの差', 0, 0.8, 0.01, state.shade, (v) => v.toFixed(2), (v) => { state.shade = v; });
slider(stackBox, '影の濃さ', 0, 0.8, 0.01, state.shadowStrength, (v) => (v === 0 ? 'なし' : v.toFixed(2)), (v) => { state.shadowStrength = v; });
slider(stackBox, '光の向き', 0, 360, 1, state.lightAzimuth, (v) => `${v}°`, (v) => { state.lightAzimuth = v; });
slider(stackBox, '光の高さ', 15, 85, 1, state.lightElevation, (v) => `${v}°`, (v) => { state.lightElevation = v; });
$<HTMLInputElement>('auto-rotate').onchange = (e) => { state.autoRotate = (e.target as HTMLInputElement).checked; };
$<HTMLSelectElement>('stack-sub').onchange = (e) => { state.stackSub = parseInt((e.target as HTMLSelectElement).value, 10); };

/** スタック系の表示（3DGS単独以外）では、俯角を下限より下げない。スプライトスタッキングは斜め上から見る技法なので */
function clampPitch() {
  if (state.view === '3dgs') return;
  camera.pitch = Math.max(camera.pitch, state.minPitchDeg * Math.PI / 180);
}

/** スタック表示用の値：3DGS表示と同じ大きさに見えるよう、カメラの距離から倍率を決める */
function stackGeometry(canvasH: number) {
  const r = state.raw!.region;
  const res = state.raw!.resolution;
  const unitsPerPixel = r.width / res;
  const layerH = (r.y1 - r.y0) / state.raw!.slices;
  const ppu = camera.focal(canvasH) / camera.distance * unitsPerPixel;
  const layerPx = layerH / unitsPerPixel * state.heightMul;
  const pitch = Math.max(Math.max(3, state.minPitchDeg) * Math.PI / 180, camera.pitch);
  // 自動：隣の層との画面上の隙間（px）ぶん描き足して、すき間をなくす
  const gapPx = layerPx * Math.cos(pitch) * ppu;
  const sub = state.stackSub > 0 ? state.stackSub : Math.max(1, Math.min(16, Math.ceil(gapPx)));
  return { ppu, layerPx, pitch, sub };
}

/** 3D表示に重ねる輪切りの位置（各層の境目の四角） */
function sliceLines(): Float32Array | null {
  const r = bakeRegion();
  if (!r) return null;
  const out: number[] = [];
  const x0 = r.originX, x1 = r.originX + r.width, z0 = r.originZ, z1 = r.originZ + r.width;
  for (let k = 0; k <= state.slices; k++) {
    const y = r.y0 + (r.y1 - r.y0) * k / state.slices;
    out.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
  }
  return new Float32Array(out);
}

// ================= フェーズ4：デモ映えする機能 =================

// ---- 変身演出 ----
/**
 * 変身の1コマ：下から kf 層ぶんがドット絵に変わり、それより上はまだガウシアンのまま。
 * まだ変わっていない部分は「厚みを残したガウシアン・スタック」で描くので、元の3DGSとほぼ同じ見た目で、
 * ドット絵と同じ正射影で描けるため、境目がずれない。
 */
function drawMorph(rect: Rect, canvasH: number, g: ReturnType<typeof stackGeometry>): PanelStats {
  const N = stack.sliceCount;
  const kf = Math.max(0, Math.min(1, state.morph)) * N;
  const k = Math.floor(kf);
  const base = {
    rect, canvasHeight: canvasH, yaw: camera.yaw, pitch: g.pitch, ppu: g.ppu, layerPx: g.layerPx, sub: g.sub,
    shade: state.shade, background: state.background, outline: viewOutlineColor(),
    shadow: state.shadowStrength > 0 ? { strength: state.shadowStrength, azimuth: state.lightAzimuth, elevation: state.lightElevation } : null,
  };
  const gParams = {
    rect, canvasHeight: canvasH, yaw: camera.yaw, pitch: g.pitch, ppu: camera.focal(rect.h) / camera.distance,
    heightMul: state.heightMul, thickness: Math.max(state.gThickness, 1), shade: 0, background: state.background,
    fromLayer: k, clear: false, shadow: gstackShadow(), keepHeight: state.gKeepHeight,
  };
  // 1) ドット絵になった層（いま変わったばかりの層は白く光る）。背景を塗った直後に、まだガウシアンの部分の影を落とす
  stack.render({
    ...base, layers: k, flashLayer: k - 1, flash: k > 0 && k < N ? 0.85 * (1 - (kf - k)) : 0,
    beforeDraw: k < N ? () => gstack.drawShadow(gParams) : undefined,
  });
  // 2) まだガウシアンのままの層（影はもう描いたので描かない）
  if (k < N) gstack.render({ ...gParams, shadow: null });
  // 3) スキャン線
  if (kf > 0 && kf < N) stack.drawRing(base, kf, [0.45, 0.9, 1, 0.9]);
  return {
    title: '変身',
    lines: [`進み具合   ${Math.round(state.morph * 100)}%（${k} / ${N}層）`],
  };
}

function viewOutlineColor(): [number, number, number] | null {
  if (!state.viewOutline || state.mode !== 'pixel') return null;
  return state.pixel.outlineColor.map((v) => v / 255) as [number, number, number];
}

const smooth = (t: number) => t * t * (3 - 2 * t);
/** 録画・デモの台本：3DGSで回る → 変身 → ドット絵で回る → 逆変身 → 3DGSに戻る（ちょうど1回転で元に戻る） */
function demoMorphAt(t: number, D: number): number {
  const T = Math.min(3, D * 0.25); // 変身にかける秒数
  const R = D - 2 * T;
  const a = R * 0.15, c = R * 0.6;
  if (t < a) return 0;
  if (t < a + T) return (t - a) / T;
  if (t < a + T + c) return 1;
  if (t < a + 2 * T + c) return 1 - (t - a - T - c) / T;
  return 0;
}

/** 毎フレームのアニメーション更新。動かしていれば true */
function stepAnimation(now: number): boolean {
  const a = state.anim;
  if (!a) return false;
  const t = (now - a.start) / 1000;
  if (a.kind === 'morph') {
    const u = Math.min(1, t / a.dur);
    state.morph = a.from + (a.to - a.from) * smooth(u);
    morphSlider.set(state.morph);
    if (u >= 1) state.anim = null;
    return false; // 変身中もふつうの自動回転は続ける
  }
  // デモ／録画：ちょうど1回転して、最初と同じ絵で終わる（継ぎ目なくループする）
  if (t >= a.dur) {
    camera.yaw = a.yaw0;
    state.morph = 0;
    if (rec.active) stopRecording();
    else state.anim = { ...a, start: now }; // デモ再生はくり返す
    return true;
  }
  camera.yaw = a.yaw0 + (Math.PI * 2 * t) / a.dur * Math.sign(state.rotateSpeed || 1);
  if (a.layout === 'morph') { state.morph = demoMorphAt(t, a.dur); morphSlider.set(state.morph); }
  return true;
}

function playMorph() {
  if (!state.finished) { toast('先に「焼き込む」を押してください', true); return; }
  setView('morph');
  const to = state.morph > 0.5 ? 0 : 1;
  state.anim = { kind: 'morph', start: performance.now(), dur: 3, from: state.morph, to };
}

// ---- 録画 ----
const rec = {
  active: false,
  width: 1080,
  height: 1080,
  duration: 12,
  mime: '',
  captions: true,
  layout: 'morph' as 'morph' | 'split',
  recorder: null as MediaRecorder | null,
  track: null as CanvasCaptureMediaStreamTrack | null,
  /** true の間だけコマを動画に送る */
  rolling: false,
  /** 1コマずつ書き出し中 */
  offline: false,
  cancel: false,
  chunks: [] as Blob[],
  comp: document.createElement('canvas'),
};

/** 使える動画形式（MP4を優先、なければWebM） */
function pickMime(): string {
  const list = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4d0028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4',
    'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  if (typeof MediaRecorder === 'undefined') return '';
  return list.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

/** 保存するファイル名のもと（使えない文字を _ にする） */
function fileBaseName(): string {
  return (state.name || 'splat').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^テスト：/, 'test_');
}

// ---- 1コマずつ書き出す録画（WebCodecs で H.264 にして MP4 に詰める）----
const REC_FPS = 60;

async function pickAvcCodec(w: number, h: number): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of ['avc1.640033', 'avc1.640032', 'avc1.4d0033', 'avc1.4d0032', 'avc1.42e033', 'avc1.42e032']) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: 12_000_000, framerate: REC_FPS });
      if (r.supported) return codec;
    } catch { /* 次を試す */ }
  }
  return null;
}

async function recordVideo() {
  if (!state.finished) { toast('先に「焼き込む」を押してください', true); return; }
  const [w, h] = $<HTMLSelectElement>('rec-size').value.split('x').map(Number);
  const codec = await pickAvcCodec(w, h);
  if (!codec) { startRecording(); return; } // 対応していなければ、リアルタイム録画（WebM など）にする
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');

  rec.width = w; rec.height = h; rec.mime = 'video/mp4';
  rec.duration = state.recDuration;
  rec.layout = $<HTMLSelectElement>('rec-layout').value as 'morph' | 'split';
  rec.captions = $<HTMLInputElement>('rec-captions').checked;
  rec.comp.width = w; rec.comp.height = h;
  setView(rec.layout === 'morph' ? 'morph' : 'split');
  setPicking(false);
  rec.active = true;
  rec.offline = true;
  rec.cancel = false;
  canvas.classList.add('recording');
  $('rec-start').textContent = '書き出しを中止';
  const savedYaw = camera.yaw, savedMorph = state.morph;
  state.anim = null;

  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: w, height: h, frameRate: REC_FPS }, fastStart: 'in-memory' });
  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e as Error; },
  });
  encoder.configure({ codec, width: w, height: h, bitrate: 12_000_000, framerate: REC_FPS });

  const total = Math.round(rec.duration * REC_FPS);
  const t0 = performance.now();
  try {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    for (let i = 0; i < total; i++) {
      if (rec.cancel) throw new Error('cancel');
      if (encodeError) throw encodeError;
      const t = i / REC_FPS;
      // 台本どおりの角度と変身の進み具合（最後のコマの次が、ちょうど最初のコマになる）
      camera.yaw = savedYaw + (Math.PI * 2 * t) / rec.duration * Math.sign(state.rotateSpeed || 1);
      state.morph = rec.layout === 'morph' ? demoMorphAt(t, rec.duration) : 0;
      clampPitch();
      const layout = layoutFor(state.view, w, h);
      // 左右比較では、元の3DGSをこの角度で並べ替えてから描く
      if (layout.some((l) => l.panel === '3dgs')) {
        const vm = mul4(camera.view(), modelMatrix(state.R, state.stats.center));
        await sortNow([vm[2], vm[6], vm[10], vm[14]]);
      }
      const stats = layout.map(({ panel, rect }) => drawPanel(panel, rect, h));
      composeRecordingFrame(layout, stats);
      const frame = new VideoFrame(rec.comp, { timestamp: Math.round((i * 1e6) / REC_FPS), duration: Math.round(1e6 / REC_FPS) });
      encoder.encode(frame, { keyFrame: i % (REC_FPS * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 6) await yieldTask();
      if (i % 6 === 0) {
        const el = (performance.now() - t0) / 1000;
        progress(`動画を書き出し中（${i} / ${total}コマ、あと約${Math.ceil(el / Math.max(1, i) * (total - i))}秒）`, i / total);
        await yieldTask();
      }
    }
    progress('動画を仕上げ中', 1);
    await encoder.flush();
    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    const base = fileBaseName();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}_${rec.layout}_${w}x${h}_${rec.duration}s.mp4`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`動画を保存しました（MP4、${rec.duration}秒、${(blob.size / 1048576).toFixed(1)} MB、ダウンロードフォルダ）`, false, 9000);
  } catch (e) {
    if ((e as Error).message === 'cancel') toast('動画の書き出しを中止しました');
    else toast('動画の書き出しに失敗しました：' + (e as Error).message, true, 9000);
  } finally {
    try { if (encoder.state !== 'closed') encoder.close(); } catch { /* 何もしない */ }
    rec.offline = false;
    rec.active = false;
    canvas.classList.remove('recording');
    $('rec-start').textContent = '録画して保存';
    camera.yaw = savedYaw;
    state.morph = savedMorph;
    progress(null);
  }
}

/** リアルタイム録画（WebCodecs が使えないブラウザ用の予備） */
function startRecording() {
  if (!state.finished || rec.active) { if (!state.finished) toast('先に「焼き込む」を押してください', true); return; }
  const mime = pickMime();
  if (!mime) { toast('このブラウザは動画の録画に対応していません。ChromeかEdgeを使ってください。', true, 8000); return; }
  const [w, h] = $<HTMLSelectElement>('rec-size').value.split('x').map(Number);
  rec.width = w; rec.height = h; rec.mime = mime;
  rec.duration = state.recDuration;
  rec.layout = $<HTMLSelectElement>('rec-layout').value as 'morph' | 'split';
  rec.captions = $<HTMLInputElement>('rec-captions').checked;
  rec.comp.width = w; rec.comp.height = h;
  setView(rec.layout === 'morph' ? 'morph' : 'split');
  setPicking(false);
  canvas.classList.add('recording');
  // 描いたコマを1枚ずつ手動で渡す（取りこぼしを防ぐ）
  const stream = rec.comp.captureStream(0);
  rec.track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16_000_000 });
  rec.chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
  recorder.onstop = () => {
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const blob = new Blob(rec.chunks, { type: mime.split(';')[0] });
    const base = fileBaseName();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}_${rec.layout}_${w}x${h}_${rec.duration}s.${ext}`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`動画を保存しました（${ext.toUpperCase()}、${(blob.size / 1048576).toFixed(1)} MB、ダウンロードフォルダ）` +
      (ext === 'webm' ? '。Xに投稿するにはMP4への変換が必要です（READMEを参照）' : ''), false, 9000);
  };
  rec.recorder = recorder;
  rec.active = true;
  rec.rolling = false;
  $('rec-start').textContent = '録画を中止';
  state.anim = null;
  state.morph = 0;
  const yaw0 = camera.yaw;
  // エンコーダーの準備ができてから動かし始める（最初のコマの取りこぼしを防ぐ）
  recorder.onstart = () => setTimeout(() => {
    if (!rec.active) return;
    rec.rolling = true;
    state.anim = { kind: 'demo', start: performance.now(), dur: rec.duration, yaw0, layout: rec.layout };
  }, 300);
  recorder.start(250);
}

function stopRecording(cancel = false) {
  if (!rec.active) return;
  rec.active = false;
  rec.rolling = false;
  state.anim = null;
  canvas.classList.remove('recording');
  $('rec-start').textContent = '録画して保存';
  const r = rec.recorder;
  rec.recorder = null;
  if (!r) return;
  if (cancel) { r.onstop = () => toast('録画を中止しました'); r.stop(); return; }
  // 最後のコマが1コマ分の長さを持つよう、少し待ってから止める
  progress('動画を仕上げ中', 1);
  setTimeout(() => { r.stop(); progress(null); }, 120);
}

/** 録画用のキャンバスに、描いた絵と文字（タイトル・クレジット）を重ねる */
function composeRecordingFrame(layout: { panel: Panel; rect: Rect }[], _stats: PanelStats[]) {
  const ctx = rec.comp.getContext('2d')!;
  const W = rec.comp.width, H = rec.comp.height;
  ctx.drawImage(canvas, 0, 0, W, H);
  if (!rec.captions) return;
  const unit = Math.min(W, H) / 1080;
  const text = (s: string, x: number, y: number, size: number, align: CanvasTextAlign, alpha = 1) => {
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `700 ${size}px "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    ctx.lineWidth = size * 0.18;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineJoin = 'round';
    ctx.strokeText(s, x, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(s, x, y);
    ctx.restore();
  };
  if (rec.layout === 'morph') {
    const m = state.morph;
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    text('実物スキャン（3D Gaussian Splatting）', W / 2, 48 * unit, 46 * unit, 'center', clamp(1 - m * 3));
    text('↓ 輪切りにして変身中…', W / 2, 48 * unit, 46 * unit, 'center', clamp(1 - Math.abs(m - 0.5) * 3.3));
    text('ドット絵のスプライトスタック', W / 2, 48 * unit, 46 * unit, 'center', clamp((m - 0.67) * 3));
  } else {
    const titles: Record<Panel, string> = { '3dgs': '元の3DGS', gstack: 'ガウシアン・スタック', stack: state.mode === 'pixel' ? 'ドット絵スタック' : 'スプライトスタック', morph: '' };
    for (const l of layout) {
      const sx = W / canvas.width, sy = H / canvas.height;
      text(titles[l.panel], (l.rect.x + l.rect.w / 2) * sx, l.rect.y * sy + 36 * unit, 40 * unit, 'center');
    }
  }
  text('Claude Code（Opus 5.5）を使用して制作', W - 28 * unit, H - 52 * unit, 24 * unit, 'right', 0.9);
}

/** 録画用キャンバスの今のコマを動画に送る */
function pushRecordingFrame() {
  if (rec.rolling) rec.track?.requestFrame();
}

// ---- プリセット ----
interface Preset {
  label: string; mode: OutputMode; resolution: number; colors: number; palette: PixelOptions['palette'];
  outline: boolean; outlineColor: string; bg: string;
}
const PRESETS: Record<string, Preset> = {
  gb: { label: 'ゲームボーイ風', mode: 'pixel', resolution: 48, colors: 4, palette: 'gb', outline: true, outlineColor: '#0f380f', bg: '#9bbc0f' },
  nes: { label: 'ファミコン風', mode: 'pixel', resolution: 64, colors: 12, palette: 'nes', outline: true, outlineColor: '#000000', bg: '#5c94fc' },
  c16: { label: '16色', mode: 'pixel', resolution: 64, colors: 16, palette: 'auto', outline: false, outlineColor: '#1a1424', bg: '#1b1d24' },
  pico8: { label: 'PICO-8風', mode: 'pixel', resolution: 64, colors: 16, palette: 'pico8', outline: true, outlineColor: '#000000', bg: '#1d2b53' },
  soft: { label: 'なめらか（ソフト）', mode: 'soft', resolution: 128, colors: 16, palette: 'auto', outline: false, outlineColor: '#1a1424', bg: '#101216' },
};

function applyPreset(key: string) {
  const p = PRESETS[key];
  const resChanged = p.resolution !== state.resolution;
  state.resolution = p.resolution;
  $<HTMLSelectElement>('bake-res').value = String(p.resolution);
  state.pixel.colors = p.colors;
  colorsSlider.set(p.colors);
  state.pixel.palette = p.palette;
  $<HTMLSelectElement>('palette-mode').value = p.palette;
  state.viewOutline = p.outline;
  $<HTMLInputElement>('outline').checked = p.outline;
  $<HTMLInputElement>('outline-color').value = p.outlineColor;
  state.pixel.outlineColor = [1, 3, 5].map((k) => parseInt(p.outlineColor.slice(k, k + 2), 16)) as [number, number, number];
  ($('bake-mode').querySelector(`[data-mode=${p.mode}]`) as HTMLButtonElement).click();
  $<HTMLInputElement>('bg').value = p.bg;
  state.background = [1, 3, 5].map((k) => parseInt(p.bg.slice(k, k + 2), 16) / 255) as [number, number, number];
  document.querySelectorAll('#presets button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.preset === key));
  if (state.raw && !resChanged) refinish();
  else if (state.data) { const v = state.view; bake().then(() => { if (v !== '3dgs') setView(v); }); }
  updateBakeStatus();
  toast(`プリセット「${p.label}」にしました`);
}

// ---- UI ----
const morphSlider = slider($('morph-sliders'), '変身の\n進み具合', 0, 1, 0.01, 0, (v) => `${Math.round(v * 100)}%`, (v) => {
  state.anim = null;
  state.morph = v;
  setView('morph');
});
slider($('rec-sliders'), '長さ', 10, 20, 1, 12, (v) => `${v}秒`, (v) => { state.recDuration = v; });
$('morph-play').onclick = playMorph;
$<HTMLSelectElement>('split-right').onchange = (e) => { state.splitRight = (e.target as HTMLSelectElement).value as 'stack' | 'gstack'; };
$<HTMLSelectElement>('palette-mode').onchange = (e) => { state.pixel.palette = (e.target as HTMLSelectElement).value as PixelOptions['palette']; scheduleRefinish(); };
document.querySelectorAll('#presets button').forEach((b) => b.addEventListener('click', () => applyPreset((b as HTMLElement).dataset.preset!)));
$('rec-start').onclick = () => {
  if (rec.offline) { rec.cancel = true; return; }
  if (rec.active) { stopRecording(true); return; }
  recordVideo();
};
$('demo-play').onclick = () => {
  if (!state.finished) { toast('先に「焼き込む」を押してください', true); return; }
  if (state.anim?.kind === 'demo') { state.anim = null; state.morph = 0; $('demo-play').textContent = 'デモを再生（録画しない）'; return; }
  const layout = $<HTMLSelectElement>('rec-layout').value as 'morph' | 'split';
  setView(layout === 'morph' ? 'morph' : 'split');
  state.anim = { kind: 'demo', start: performance.now(), dur: state.recDuration, yaw0: camera.yaw, layout };
  $('demo-play').textContent = 'デモを止める';
};
{
  const m = pickMime();
  $('rec-format').textContent = typeof VideoEncoder !== 'undefined'
    ? '保存形式：MP4（H.264・60fps）。1コマずつ書き出すので、長さぴったり・継ぎ目なくループします'
    : !m ? '⚠ このブラウザは録画に対応していません'
    : m.startsWith('video/mp4') ? '保存形式：MP4（そのままXに投稿できます）'
    : '保存形式：WebM（このブラウザはMP4録画に非対応。Xに投稿するにはMP4への変換が必要です）';
}

// ================= スプライトスタック素材 → ガウシアン =================
slider($('sprite-sliders'), '1層の高さ', 0.25, 4, 0.25, state.spriteLayerPx, (v) => `${v}px`, (v) => { state.spriteLayerPx = v; });
slider($('sprite-sliders'), 'ぼかし', 0.3, 1.2, 0.05, state.spriteSoftness, (v) => (v < 0.45 ? `${v.toFixed(2)}（くっきり）` : v > 0.8 ? `${v.toFixed(2)}（もこもこ）` : v.toFixed(2)), (v) => { state.spriteSoftness = v; });
let spriteFiles: File[] = [];
$<HTMLInputElement>('sprite-file').addEventListener('change', (e) => {
  const fs = Array.from((e.target as HTMLInputElement).files ?? []);
  (e.target as HTMLInputElement).value = '';
  if (fs.length) importSprites(fs);
});
$('sprite-reconvert').onclick = () => { if (spriteFiles.length) importSprites(spriteFiles); };

function sheetOptions(): SheetOptions {
  return {
    layout: $<HTMLSelectElement>('sprite-layout').value as SheetOptions['layout'],
    frame: Math.max(0, parseInt($<HTMLInputElement>('sprite-frame').value, 10) || 0),
    firstIsBottom: $<HTMLSelectElement>('sprite-order').value === 'bottom',
  };
}

/** 素材を読み込み、ガウシアンにして表示する。ドット絵スタックには元の絵をそのまま使う */
async function importSprites(files: File[]) {
  spriteFiles = files;
  $('sprite-opts').hidden = false;
  progress('スプライトスタック素材を読み込み中', 0.2);
  try {
    const { src, note } = await loadSpriteFiles(files, sheetOptions());
    progress('ガウシアンに変換中', 0.5);
    await new Promise((r) => setTimeout(r, 20));
    const conv = spritesToGaussians(src, { layerPx: state.spriteLayerPx, softness: state.spriteSoftness });
    // ドット絵の素材にはゴミがないので、ゴミ取りフィルタは外す（等間隔のマスでは孤立判定が誤って全部消してしまう）
    const filterInputs = [...document.querySelectorAll<HTMLInputElement>('#filter-sliders input')];
    filterInputs[0].value = '0'; filterInputs[0].dispatchEvent(new Event('input'));
    filterInputs[2].value = '0'; filterInputs[2].dispatchEvent(new Event('input'));
    setData(conv.data, packSplats(conv.data), src.name);
    state.sprite = { src };
    // 焼き込みの代わりに、元のドット絵をそのままスライスとして使う
    const c = state.stats.center;
    const res = Math.max(src.w, src.d);
    const region: BakeRegion = {
      originX: conv.minX - c[0], originZ: conv.minZ - c[2], width: res * conv.cell,
      y0: conv.y0 - c[1], y1: conv.y1 - c[1] + 1e-6,
    };
    const n = src.layers.length;
    const pad = (l: Uint8ClampedArray) => {
      const o = new Uint8ClampedArray(res * res * 4);
      for (let y = 0; y < src.d; y++) o.set(l.subarray(y * src.w * 4, (y + 1) * src.w * 4), y * res * 4);
      return o;
    };
    const imgs = src.layers.map(pad);
    const { order, starts } = buildSliceOrder(region, n);
    progress('ガウシアン・スタックを作成中', 0.7);
    gstack.set(await buildGaussianStack(conv.data, state.R, c as [number, number, number], region, order, starts, n, () => {}));
    state.raw = { resolution: res, slices: n, soft: imgs, nearest: imgs, region };
    state.slices = Math.min(128, n);
    slicesSlider.set(state.slices);
    state.bakedKey = currentBakeKey();
    // 元の色のまま・ドット絵モードで表示
    state.pixel.palette = 'keep';
    $<HTMLSelectElement>('palette-mode').value = 'keep';
    if (state.mode !== 'pixel') ($('bake-mode').querySelector('[data-mode=pixel]') as HTMLButtonElement).click();
    state.selectedSlice = Math.floor(n / 2);
    refinish();
    setTabsEnabled(true);
    camera.target = [region.originX + region.width / 2, (region.y0 + region.y1) / 2, region.originZ + region.width / 2];
    // 素材全体（横幅と高さの大きいほう）が収まる距離にする
    camera.distance = Math.max(region.width, region.y1 - region.y0) * 2.2;
    setView('compare');
    $('sprite-info').textContent = `${src.w}×${src.d}px × ${n}層 → ガウシアン ${conv.data.count.toLocaleString()}個（中に埋もれたマス ${conv.hidden.toLocaleString()}個は省略）${note}`;
    toast('ドット絵の素材をガウシアンに変換しました。左が3DGS、真ん中がガウシアン・スタック、右が元のドット絵です', false, 7000);
  } catch (e) {
    toast('素材を読み込めませんでした：' + (e as Error).message, true, 9000);
  } finally {
    progress(null);
  }
}

// ---------------- メインループ ----------------
let lastT = performance.now();
let fps = 0;
function frame() {
  // 1コマずつ書き出している間は、ふつうの描画を止める
  if (rec.offline) { requestAnimationFrame(frame); return; }
  const now = performance.now();
  const dt = now - lastT;
  lastT = now;
  fps = fps ? fps * 0.93 + (1000 / Math.max(dt, 0.1)) * 0.07 : 60;

  // 録画中は、決まった大きさ（1080×1080など）で描く
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = rec.active ? rec.width : Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = rec.active ? rec.height : Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

  // アニメーション（変身・デモ）か、ふつうの自動回転
  const animating = stepAnimation(now);
  clampPitch();
  if (!animating && state.view !== '3dgs' && state.autoRotate && !drag) camera.yaw += state.rotateSpeed * Math.PI / 180 * Math.min(dt, 100) / 1000;

  const layout = layoutFor(state.view, w, h);
  const stats: PanelStats[] = [];
  for (const { panel, rect } of layout) {
    gpuTimer.begin(panel);
    stats.push(drawPanel(panel, rect, h));
    gpuTimer.end();
  }
  gpuTimer.poll();
  if (rec.active) { composeRecordingFrame(layout, stats); pushRecordingFrame(); }
  updateHud(layout, stats, w, h);
  requestAnimationFrame(frame);
}

type Panel = '3dgs' | 'gstack' | 'stack' | 'morph';
type Rect = { x: number; y: number; w: number; h: number };

/** 表示モードごとの画面の分け方 */
function layoutFor(v: ViewMode, w: number, h: number): { panel: Panel; rect: Rect }[] {
  if (v === 'compare') {
    const pw = Math.floor(w / 3);
    return (['3dgs', 'gstack', 'stack'] as Panel[]).map((panel, i) => ({ panel, rect: { x: i * pw, y: 0, w: i === 2 ? w - 2 * pw : pw, h } }));
  }
  if (v === 'split') {
    const right: Panel = state.splitRight;
    if (w >= h) {
      const pw = Math.floor(w / 2);
      return [{ panel: '3dgs', rect: { x: 0, y: 0, w: pw, h } }, { panel: right, rect: { x: pw, y: 0, w: w - pw, h } }];
    }
    // 縦長の画面では上下に並べる
    const ph = Math.floor(h / 2);
    return [{ panel: '3dgs', rect: { x: 0, y: 0, w, h: ph } }, { panel: right, rect: { x: 0, y: ph, w, h: h - ph } }];
  }
  return [{ panel: v as Panel, rect: { x: 0, y: 0, w, h } }];
}
interface PanelStats { title: string; lines: string[] }
const MB = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
const gpuMs = (p: Panel) => {
  const v = gpuTimer.get(p);
  return v === null ? (gpuTimer.supported ? '計測中' : '測定不可') : `${v.toFixed(2)} ms`;
};

function drawPanel(p: Panel, rect: { x: number; y: number; w: number; h: number }, canvasH: number): PanelStats {
  const single = layoutFor(state.view, 2, 1).length === 1;
  if (p === '3dgs') {
    const view = camera.view();
    const model = modelMatrix(state.R, state.stats.center);
    const vm = mul4(view, model);
    if (state.data && !rec.offline) maybeSort([vm[2], vm[6], vm[10], vm[14]]);
    const size = state.stats.size;
    const lines = state.data && state.showBox && single;
    const sliceData = lines && state.showSlices ? sliceLines() : null;
    renderer.render({
      view: vm,
      viewOnly: view,
      proj: camera.proj(rect.w, rect.h, size * 0.005, size * 2000),
      focal: camera.focal(rect.h),
      width: rect.w,
      height: rect.h,
      rect: { x: rect.x, y: rect.y },
      canvasHeight: canvasH,
      near: size * 0.005,
      background: state.background,
      backLines: lines ? [{ data: gridLines(), color: [0.55, 0.6, 0.7, 0.35] }] : [],
      frontLines: lines ? [
        { data: boxLines(), color: [1, 0.71, 0.28, 0.8] },
        { data: upArrow(), color: [0.44, 0.83, 1, 0.9] },
        ...(sliceData ? [{ data: sliceData, color: [0.44, 0.83, 1, 0.18] as [number, number, number, number] }] : []),
      ] : [],
    });
    const d = state.data;
    return {
      title: '元の3DGS',
      lines: d ? [
        `ガウシアン ${state.visible.toLocaleString()}` + (single ? ` / ${d.count.toLocaleString()}` : ''),
        `GPUメモリ  ${MB(renderer.gpuBytes(state.texHeight, state.visible))}`,
        `GPU時間    ${gpuMs(p)}`,
        `並べ替え   ${sortMs.toFixed(0)} ms（毎回必要）`,
      ] : [],
    };
  }
  const g = stackGeometry(rect.h);
  if (p === 'morph') return drawMorph(rect, canvasH, g);
  if (p === 'gstack') {
    const n = gstack.render({
      rect, canvasHeight: canvasH, yaw: camera.yaw, pitch: g.pitch,
      ppu: camera.focal(rect.h) / camera.distance, heightMul: state.heightMul,
      thickness: gstackThickness(g.pitch), shade: state.shade, background: state.background,
      shadow: gstackShadow(), keepHeight: state.gKeepHeight,
    });
    return {
      title: 'ガウシアン・スタック',
      lines: [
        `ガウシアン ${n.toLocaleString()}`,
        `GPUメモリ  ${MB(gstack.gpuBytes)}（1個 ${gstack.bytesPerGaussian.toFixed(0)}B）`,
        `GPU時間    ${gpuMs(p)}`,
        `並べ替え   なし（層の順＝奥行き）`,
        `層内の並び 8方向から選択（並べ替えなし）`,
        `厚み       ×${gstackThickness(g.pitch).toFixed(2)}`,
      ],
    };
  }
  const quads = stack.render({
    rect, canvasHeight: canvasH, yaw: camera.yaw, pitch: g.pitch, ppu: g.ppu, layerPx: g.layerPx, sub: g.sub,
    shade: state.shade, outline: viewOutlineColor(),
    shadow: state.shadowStrength > 0 ? { strength: state.shadowStrength, azimuth: state.lightAzimuth, elevation: state.lightElevation } : null,
    background: state.background,
  });
  const r = state.raw;
  return {
    title: state.mode === 'pixel' ? 'ドット絵スタック' : 'ソフトスタック',
    lines: r ? [
      `スライス   ${r.slices}枚 × ${r.resolution}px`,
      `描いた板   ${quads.toLocaleString()}枚（補間${g.sub}回）`,
      `GPUメモリ  ${MB(r.resolution * r.resolution * r.slices * 4)}`,
      `GPU時間    ${gpuMs(p)}`,
    ] : [],
  };
}

let hudTimer = 0;
function updateHud(layout: { panel: Panel; rect: Rect }[], stats: PanelStats[], w: number, h: number) {
  const now = performance.now();
  if (now - hudTimer < 200) return; // 文字の書き換えは1秒に5回まで
  hudTimer = now;
  const pitch = `俯角       ${(Math.max(3, camera.pitch * 180 / Math.PI)).toFixed(0)}°`;
  const labels = $('panel-labels');
  if (rec.active) {
    labels.innerHTML = '';
    labels.dataset.key = '';
    const t = (now - (state.anim?.start ?? now)) / 1000;
    $('hud').textContent = `● 録画中  ${t.toFixed(1)} / ${rec.duration} 秒\n${rec.width}×${rec.height}  ${rec.mime.split(';')[0]}`;
    return;
  }
  if (layout.length === 1) {
    labels.innerHTML = '';
    labels.dataset.key = '';
    const s = stats[0];
    $('hud').textContent = [`FPS        ${fps.toFixed(0)}`, ...s.lines, ...(layout[0].panel !== '3dgs' ? [pitch] : [])].join('\n');
    return;
  }
  $('hud').textContent = `FPS ${fps.toFixed(0)}（${layout.length}つ合計）`;
  const key = layout.map((l) => `${l.rect.x},${l.rect.y},${w},${h}`).join('|');
  if (labels.dataset.key !== key) {
    labels.dataset.key = key;
    labels.innerHTML = '';
    for (const l of layout) {
      const el = document.createElement('div');
      el.className = 'panel-label';
      el.style.left = `calc(${(100 * l.rect.x) / w}% + 10px)`;
      el.style.top = `calc(${(100 * l.rect.y) / h}% + ${l.rect.y ? 10 : 50}px)`;
      labels.append(el);
    }
  }
  stats.forEach((s, i) => {
    (labels.children[i] as HTMLElement).textContent = [s.title, ...s.lines].join('\n');
  });
}
requestAnimationFrame(frame);

// 動作確認用にコンソールから触れるようにしておく
(window as any).splatStack = {
  state, camera, stack, renderer, stackGeometry,
  /** 動作確認用：テストの木で「水平合わせ→ゴミ取り→囲む→焼き込み」までを一気に行う */
  async demo(kind: 'tree' | 'house' | 'mushroom' | 'car' | 'chest' | 'cactus' = 'tree') {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const makers = { tree: makeTree, house: makeHouse, mushroom: makeMushroom, car: makeCar, chest: makeChest, cactus: makeCactus };
    state.data = null;
    loadDummy(makers[kind], `テスト：${kind}`);
    for (let i = 0; i < 40 && !state.data; i++) await wait(100);
    await wait(200);
    const r = canvas.getBoundingClientRect();
    setPicking(true);
    levelAt(200, r.height * 0.8);
    state.isoMin = 3;
    requestIsolation();
    for (let i = 0; i < 80 && !state.isoCounts; i++) await wait(100);
    recomputeMask();
    autoCrop();
    $('crop-ground').click();
    await bake();
  },
};
