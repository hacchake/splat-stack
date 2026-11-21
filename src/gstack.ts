// ガウシアン・スタック描画モード（本当の「Gaussian Splat Stacking」）
// スライスをピクセル画像にせず、各ガウシアンを「所属するスライスの高さに置いた、平たい2Dガウシアン」として持つ。
// 描画はスライスの下から順。スライスの順番がそのまま奥行きの順番なので、層をまたいだ並べ替えはしない。
// 層の中の順番は、8方向から見たときの「奥→手前」の並びをあらかじめ作っておき、カメラの向きに近いものを選ぶ
// （描くときに並べ替えはしない）。
import { quatToMat3, type SplatData } from './splat';
import type { M3 } from './math';
import type { BakeRegion } from './baker';

/** テクスチャの幅（1ガウシアン = 1テクセル = 16バイト） */
const TEX_W = 4096;
/** 向き別の描画順の数（45°ごと） */
export const GSTACK_DIRS = 8;

export interface GaussianStack {
  count: number;
  slices: number;
  /**
   * 1個 = 4つの uint：
   *  [0] x,z を焼き込み範囲の中で16bitに（下位x／上位z）
   *  [1] 広がり σ1,σ2（範囲の一辺で割った値）の half×2
   *  [2] 下位16bit：楕円の角度θの half、次の8bit：層番号
   *  [3] 色 RGBA8
   */
  tex: Uint32Array;
  texHeight: number;
  /** 層の中の描画順（層内の番号）。8方向ぶんを連結 */
  orders: Uint16Array | Uint32Array;
  /** 1層の厚み（データの単位） */
  layerH: number;
  /** 各層の開始位置（slices+1個） */
  starts: Uint32Array;
  region: BakeRegion;
}

// ---- float → half（16bit浮動小数点）----
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // 無限・NaN
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // 大きすぎる
  if (e <= 0) {
    // 非正規化数（とても小さい値）
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >>> shift;
    if ((mant >>> (shift - 1)) & 1) h++; // 四捨五入
    return sign | h;
  }
  let h = sign | (e << 10) | (mant >>> 13);
  if (mant & 0x1000) h++; // 四捨五入（繰り上がりで指数も正しく上がる）
  return h;
}

const yieldTask = () => new Promise<void>((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });

/** 焼き込みと同じ並び（下→上）から、ガウシアン・スタックのデータを作る */
export async function buildGaussianStack(
  d: SplatData, R: M3, c: [number, number, number], region: BakeRegion,
  order: Uint32Array, starts: Uint32Array, slices: number, onProgress: (p: number) => void,
): Promise<GaussianStack> {
  const n = order.length;
  const texHeight = Math.max(1, Math.ceil(n / TEX_W));
  const tex = new Uint32Array(TEX_W * texHeight * 4);
  const qx = new Uint16Array(n), qz = new Uint16Array(n);
  const layerOf = new Uint8Array(n);
  const P = d.positions, S = d.scales, Q = d.rotations, C = d.colors;
  const W = region.width, invW = 1 / W;
  const Rq = new Array(9);
  let k = 0;
  let last = performance.now();
  for (let s = 0; s < slices; s++) {
    for (let j = starts[s]; j < starts[s + 1]; j++, k++) {
      const i = order[j];
      const px = P[i * 3] - c[0], py = P[i * 3 + 1] - c[1], pz = P[i * 3 + 2] - c[2];
      const ax = R[0] * px + R[1] * py + R[2] * pz;
      const az = R[6] * px + R[7] * py + R[8] * pz;
      // 整列後の回転 A = R·Rq、スケールを掛けた M = A·diag(s)。必要なのは x と z の行だけ
      quatToMat3(Q[i * 4], Q[i * 4 + 1], Q[i * 4 + 2], Q[i * 4 + 3], Rq);
      const sx = S[i * 3], sy = S[i * 3 + 1], sz = S[i * 3 + 2];
      const mx0 = (R[0] * Rq[0] + R[1] * Rq[3] + R[2] * Rq[6]) * sx;
      const mx1 = (R[0] * Rq[1] + R[1] * Rq[4] + R[2] * Rq[7]) * sy;
      const mx2 = (R[0] * Rq[2] + R[1] * Rq[5] + R[2] * Rq[8]) * sz;
      const mz0 = (R[6] * Rq[0] + R[7] * Rq[3] + R[8] * Rq[6]) * sx;
      const mz1 = (R[6] * Rq[1] + R[7] * Rq[4] + R[8] * Rq[7]) * sy;
      const mz2 = (R[6] * Rq[2] + R[7] * Rq[5] + R[8] * Rq[8]) * sz;
      const xx = mx0 * mx0 + mx1 * mx1 + mx2 * mx2;
      const xz = mx0 * mz0 + mx1 * mz1 + mx2 * mz2;
      const zz = mz0 * mz0 + mz1 * mz1 + mz2 * mz2;
      // 2次元の広がりを「長い軸・短い軸の長さと角度」にする
      const mid = 0.5 * (xx + zz);
      const rad = Math.hypot(0.5 * (xx - zz), xz);
      const l1 = mid + rad, l2 = Math.max(mid - rad, 0);
      const theta = 0.5 * Math.atan2(2 * xz, xx - zz);
      // 中心を焼き込み範囲の中で 0〜65535 に
      const ux = Math.min(65535, Math.max(0, Math.round((ax - region.originX) * invW * 65535)));
      const uz = Math.min(65535, Math.max(0, Math.round((az - region.originZ) * invW * 65535)));
      qx[k] = ux; qz[k] = uz; layerOf[k] = s;
      const b = k * 4;
      tex[b] = (ux | (uz << 16)) >>> 0;
      tex[b + 1] = (toHalf(Math.sqrt(l1) * invW) | (toHalf(Math.sqrt(l2) * invW) << 16)) >>> 0;
      tex[b + 2] = (toHalf(theta) | (s << 16)) >>> 0;
      tex[b + 3] = (C[i * 4] | (C[i * 4 + 1] << 8) | (C[i * 4 + 2] << 16) | (C[i * 4 + 3] << 24)) >>> 0;
      if ((k & 0xffff) === 0 && performance.now() - last > 30) {
        onProgress(0.6 * k / n);
        await yieldTask();
        last = performance.now();
      }
    }
  }

  // ---- 向き別の描画順（層の中だけ、奥→手前）----
  let maxSlice = 0;
  for (let s = 0; s < slices; s++) maxSlice = Math.max(maxSlice, starts[s + 1] - starts[s]);
  const orders = maxSlice <= 65535 ? new Uint16Array(n * GSTACK_DIRS) : new Uint32Array(n * GSTACK_DIRS);
  const key = new Uint16Array(n);
  const tmp = new Uint32Array(n);
  const counts = new Uint32Array(65537);
  const fill = new Uint32Array(slices);
  for (let dir = 0; dir < GSTACK_DIRS; dir++) {
    const a = (dir * Math.PI * 2) / GSTACK_DIRS;
    const sa = Math.sin(a), ca = Math.cos(a);
    // 画面の下ほど手前：奥行きの値 = x·sin(yaw) + z·cos(yaw)。昇順に描けば奥→手前
    const lim = Math.abs(sa) + Math.abs(ca);
    for (let i = 0; i < n; i++) {
      const v = ((qx[i] / 65535 - 0.5) * sa + (qz[i] / 65535 - 0.5) * ca) / lim; // -0.5〜0.5
      key[i] = Math.min(65535, Math.max(0, Math.round((v + 0.5) * 65535)));
    }
    // 1回目：奥行きの値で並べる（計数ソート）
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[key[i] + 1]++;
    for (let v = 1; v <= 65536; v++) counts[v] += counts[v - 1];
    for (let i = 0; i < n; i++) tmp[counts[key[i]]++] = i;
    // 2回目：順番を保ったまま層ごとに分ける（安定なので、層の中は奥→手前のまま）
    for (let s = 0; s < slices; s++) fill[s] = starts[s];
    const base = dir * n;
    for (let t = 0; t < n; t++) {
      const g = tmp[t], s = layerOf[g];
      orders[base + fill[s]++] = g - starts[s];
    }
    onProgress(0.6 + 0.4 * (dir + 1) / GSTACK_DIRS);
    await yieldTask();
  }

  return { count: n, slices, tex, texHeight, orders, layerH: (region.y1 - region.y0) / slices, region, starts: starts.slice() };
}

const VS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_tex;
uniform uint u_base;       // この層の先頭の番号
uniform float u_width;     // 焼き込み範囲の一辺（データの単位）
uniform vec2 u_viewport;
uniform float u_ppu;       // データの1単位が画面で何デバイスピクセルか
uniform float u_layerH;    // 1層の厚み（高さの倍率込み）
uniform float u_slices;
uniform float u_yaw;
uniform float u_pitch;
uniform float u_thick;     // 上方向の厚みを残す割合（0 = 完全に平ら）
uniform float u_shade;
uniform int u_shadow;      // 1 = 影の形を地面に描くパス
uniform vec2 u_light;      // 高さ1あたりの影のずれ（地面上、画面基準の向き）
uniform float u_penumbra;  // 高さ1あたりの影のぼけ（標準偏差）
layout(location=0) in vec2 a_corner;
layout(location=1) in uint a_local;   // 層の中の番号（向き別の描画順から）
out vec4 v_color;
out vec2 v_pos;
void main() {
  uint idx = u_base + a_local;
  uvec4 t = texelFetch(u_tex, ivec2(int(idx & 4095u), int(idx >> 12u)), 0);
  vec2 pos = (vec2(float(t.x & 0xffffu), float(t.x >> 16u)) / 65535.0 - 0.5) * u_width;   // 範囲の中心から
  vec2 sig = unpackHalf2x16(t.y) * u_width;
  float theta = unpackHalf2x16(t.z & 0xffffu).x;
  float layer = float((t.z >> 16u) & 0xffu);
  vec4 col = vec4(uvec4(t.w & 0xffu, (t.w >> 8u) & 0xffu, (t.w >> 16u) & 0xffu, t.w >> 24u)) / 255.0;

  float total = u_slices * u_layerH;
  float h = (layer + 0.5) * u_layerH;
  float cy = cos(u_yaw), sy = sin(u_yaw), sp = sin(u_pitch), cp = cos(u_pitch);
  // 地面(x,z)と高さ(y)から画面への正射影：画面x = x·cy − z·sy, 画面下 = (x·sy + z·cy)·sp − y·cp
  vec2 center = vec2(pos.x * cy - pos.y * sy, (pos.x * sy + pos.y * cy) * sp - (h - total * 0.5) * cp);
  mat2 A = mat2(cy, sy * sp, -sy, cy * sp);  // 列優先
  float ct = cos(theta), st = sin(theta);
  mat2 Rt = mat2(ct, st, -st, ct);
  mat2 S = Rt * mat2(sig.x * sig.x, 0.0, 0.0, sig.y * sig.y) * transpose(Rt);
  mat2 C;
  if (u_shadow == 1) {
    // 影：光の向きに沿って地面（高さ0）へずらし、高いところほどぼかす
    vec2 g = vec2(pos.x * cy - pos.y * sy, pos.x * sy + pos.y * cy) + u_light * h;
    center = vec2(g.x, g.y * sp + total * 0.5 * cp);
    float pen = u_penumbra * h;
    C = A * (S + mat2(pen * pen, 0.0, 0.0, pen * pen)) * transpose(A);
    // 1層ぶんの厚みが落とす影は、光の向きに細長く伸びる（これがないと層ごとの影が縞になる）
    vec2 L = u_light * u_layerH * 0.6;
    C += mat2(L.x * L.x, L.x * L.y * sp, L.x * L.y * sp, L.y * L.y * sp * sp);
  } else {
    C = A * S * transpose(A);
    float yStd = u_thick * u_layerH * 0.5;     // 残す厚み（標準偏差）
    C[1][1] += cp * cp * yStd * yStd;
  }
  C *= u_ppu * u_ppu;
  float a = C[0][0] + 0.3, b = C[0][1], c = C[1][1] + 0.3;
  float mid = 0.5 * (a + c);
  float rad = length(vec2(0.5 * (a - c), b));
  float l1 = mid + rad, l2 = max(mid - rad, 0.01);
  vec2 dir = abs(b) < 1e-12 ? (a >= c ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) : normalize(vec2(b, l1 - a));
  vec2 major = min(3.0 * sqrt(l1), 2048.0) * dir;
  vec2 minor = min(3.0 * sqrt(l2), 2048.0) * vec2(-dir.y, dir.x);
  vec2 sc = u_viewport * 0.5 + center * u_ppu;
  // 画面の外にあるものは描かない
  float rmax = length(major);
  if (sc.x < -rmax || sc.y < -rmax || sc.x > u_viewport.x + rmax || sc.y > u_viewport.y + rmax) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec2 screen = sc + a_corner.x * major + a_corner.y * minor;
  float bright = mix(1.0 - u_shade, 1.0, (layer + 0.5) / u_slices);
  v_color = vec4(col.rgb * bright, col.a);
  v_pos = a_corner * 3.0;
  gl_Position = vec4(screen.x / u_viewport.x * 2.0 - 1.0, 1.0 - screen.y / u_viewport.y * 2.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
uniform int u_shadow;
in vec4 v_color;
in vec2 v_pos;
out vec4 o;
void main() {
  float r2 = dot(v_pos, v_pos);
  if (r2 > 9.0) discard;
  float al = min(0.99, exp(-0.5 * r2) * v_color.a);
  if (al < 1.0 / 255.0) discard;
  o = u_shadow == 1 ? vec4(al) : vec4(v_color.rgb * al, al);
}`;

// 影のマップを画面に重ねる（マップは縮小して描くので、なめらかに引き伸ばされる）
const SHADOW_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const SHADOW_FS = `#version 300 es
precision highp float;
uniform sampler2D u_mask;
uniform vec4 u_rect;       // 描画先の左下とサイズ（デバイスピクセル）
uniform float u_strength;
out vec4 o;
void main() {
  vec2 uv = (gl_FragCoord.xy - u_rect.xy) / u_rect.zw;
  o = vec4(0.0, 0.0, 0.0, u_strength * texture(u_mask, uv).r);
}`;

function compile(gl: WebGL2RenderingContext, vs = VS, fs = FS): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('ガウシアン・スタックのシェーダーエラー: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('ガウシアン・スタックのリンクエラー: ' + gl.getProgramInfoLog(p));
  return p;
}

export interface GStackParams {
  rect: { x: number; y: number; w: number; h: number };
  canvasHeight: number;
  yaw: number;
  pitch: number;
  ppu: number;
  heightMul: number;
  thickness: number;
  shade: number;
  background: [number, number, number];
  /** この層から上だけ描く（変身演出用） */
  fromLayer?: number;
  /** false なら背景を塗らずに上から描き足す */
  clear?: boolean;
  /** 地面に落ちる影（濃さ・光の向き・光の高さ・ぼかし） */
  shadow?: GShadow | null;
}

export interface GShadow { strength: number; azimuth: number; elevation: number; softness: number }

export class GaussianStackRenderer {
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private orderBuf: WebGLBuffer;
  private tex: WebGLTexture;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private data: GaussianStack | null = null;
  private bpe = 2; // 描画順の1個のバイト数（2 = Uint16, 4 = Uint32）
  private shadowProg: WebGLProgram;
  private shadowFbo: WebGLFramebuffer;
  private shadowTex: WebGLTexture;
  private shadowSize = [0, 0];

  constructor(private gl: WebGL2RenderingContext) {
    this.prog = compile(gl);
    for (const n of ['u_tex', 'u_base', 'u_width', 'u_viewport', 'u_ppu', 'u_layerH', 'u_slices', 'u_yaw', 'u_pitch', 'u_thick', 'u_shade',
      'u_shadow', 'u_light', 'u_penumbra'])
      this.u[n] = gl.getUniformLocation(this.prog, n);
    this.shadowProg = compile(gl, SHADOW_VS, SHADOW_FS);
    for (const n of ['u_mask', 'u_rect', 'u_strength']) this.u['s_' + n] = gl.getUniformLocation(this.shadowProg, n);
    this.shadowTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.shadowFbo = gl.createFramebuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.orderBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.orderBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribDivisor(1, 1);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_SHORT, 0, 0);
    gl.bindVertexArray(null);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  get ready() { return !!this.data; }
  get stack() { return this.data; }
  /** GPUに置いているバイト数（データのテクスチャ＋向き別の描画順） */
  get gpuBytes() { return this.data ? this.data.tex.byteLength + this.data.orders.byteLength : 0; }
  /** 1ガウシアンあたりのバイト数 */
  get bytesPerGaussian() { return this.data && this.data.count ? this.gpuBytes / this.data.count : 0; }

  set(s: GaussianStack | null) {
    this.data = s;
    if (!s) return;
    const gl = this.gl;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (s.texHeight > max) throw new Error('ガウシアンが多すぎて、ガウシアン・スタックをGPUに載せられません');
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, TEX_W, s.texHeight, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, s.tex);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.orderBuf);
    gl.bufferData(gl.ARRAY_BUFFER, s.orders, gl.STATIC_DRAW);
    this.bpe = s.orders.BYTES_PER_ELEMENT;
  }

  /** カメラの向きに一番近い描画順の番号（0〜7） */
  static dirFor(yaw: number): number {
    const step = (Math.PI * 2) / GSTACK_DIRS;
    return ((Math.round(yaw / step) % GSTACK_DIRS) + GSTACK_DIRS) % GSTACK_DIRS;
  }

  render(p: GStackParams): number {
    const gl = this.gl;
    const { x, y, w, h } = p.rect;
    const glY = p.canvasHeight - y - h;
    gl.viewport(x, glY, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, glY, w, h);
    if (p.clear !== false) {
      gl.clearColor(p.background[0], p.background[1], p.background[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (p.shadow && p.shadow.strength > 0) this.drawShadow(p);
    gl.viewport(x, glY, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, glY, w, h);
    const s = this.data;
    let drawn = 0;
    if (s && s.count > 0) {
      this.setup(p, w, h);
      gl.uniform1i(this.u.u_shadow, 0);
      gl.enable(gl.BLEND);
      // 下の層から順に「上に重ねる」。層の中は、向きに合った「奥→手前」の順（あらかじめ作った表から選ぶだけ）
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      drawn = this.drawLayers(p, GaussianStackRenderer.dirFor(p.yaw));
    }
    gl.disable(gl.SCISSOR_TEST);
    return drawn;
  }

  /** 描画に共通の設定 */
  private setup(p: GStackParams, w: number, h: number) {
    const gl = this.gl, s = this.data!;
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.u_tex, 0);
    gl.uniform1f(this.u.u_width, s.region.width);
    gl.uniform2f(this.u.u_viewport, w, h);
    gl.uniform1f(this.u.u_ppu, p.ppu);
    gl.uniform1f(this.u.u_layerH, s.layerH * p.heightMul);
    gl.uniform1f(this.u.u_slices, s.slices);
    gl.uniform1f(this.u.u_yaw, p.yaw);
    gl.uniform1f(this.u.u_pitch, p.pitch);
    gl.uniform1f(this.u.u_thick, p.thickness);
    gl.uniform1f(this.u.u_shade, p.shade);
  }

  /** fromLayer から上の層を、向き dir の描画順で描く */
  private drawLayers(p: GStackParams, dir: number): number {
    const gl = this.gl, s = this.data!;
    let drawn = 0;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.orderBuf);
    const type = this.bpe === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
    const dirBase = dir * s.count;
    const from = Math.max(0, Math.min(s.slices, Math.floor(p.fromLayer ?? 0)));
    for (let k = from; k < s.slices; k++) {
      const start = s.starts[k], cnt = s.starts[k + 1] - start;
      if (cnt <= 0) continue;
      gl.uniform1ui(this.u.u_base, start);
      gl.vertexAttribIPointer(1, 1, type, 0, (dirBase + start) * this.bpe);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cnt);
      drawn += cnt;
    }
    gl.vertexAttribIPointer(1, 1, type, 0, 0);
    gl.bindVertexArray(null);
    return drawn;
  }

  /**
   * 地面に落ちる影を、いま塗ってある背景の上に重ねる。
   * 1) 縮小した影マップに、各ガウシアンを地面へ落とした形を「濃いほうを残す」合成で描く（重なっても濃くならない）
   * 2) それを引き伸ばして、黒の半透明として重ねる（縮小してあるので縁がなめらかになる）
   * 変身演出から、ドット絵より先に呼べるよう public にしてある。
   */
  drawShadow(p: GStackParams) {
    const gl = this.gl, s = this.data, sh = p.shadow;
    if (!s || !sh || s.count === 0) return;
    const { x, y, w, h } = p.rect;
    const glY = p.canvasHeight - y - h;
    const sw = Math.max(1, Math.ceil(w / 2)), shh = Math.max(1, Math.ceil(h / 2));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    if (this.shadowSize[0] !== sw || this.shadowSize[1] !== shh) {
      gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sw, shh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.shadowTex, 0);
      this.shadowSize = [sw, shh];
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, sw, shh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.setup(p, w, h);
    const el = Math.max(5, Math.min(85, sh.elevation)) * Math.PI / 180;
    const az = sh.azimuth * Math.PI / 180;
    const len = 1 / Math.tan(el);
    gl.uniform1i(this.u.u_shadow, 1);
    gl.uniform2f(this.u.u_light, Math.cos(az) * len, Math.sin(az) * len);
    gl.uniform1f(this.u.u_penumbra, sh.softness);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.drawLayers(p, 0);
    gl.blendEquation(gl.FUNC_ADD);
    gl.uniform1i(this.u.u_shadow, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // 画面に重ねる
    gl.viewport(x, glY, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, glY, w, h);
    gl.useProgram(this.shadowProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.uniform1i(this.u.s_u_mask, 0);
    gl.uniform4f(this.u.s_u_rect, x, glY, w, h);
    gl.uniform1f(this.u.s_u_strength, sh.strength);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
