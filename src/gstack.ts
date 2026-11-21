// ガウシアン・スタック描画モード（本当の「Gaussian Splat Stacking」）
// スライスをピクセル画像にせず、各ガウシアンを「所属するスライスの高さに置いた、平たい2Dガウシアン」として持つ。
// 描画はスライスの下から順。スライスの順番がそのまま奥行きの順番なので、ガウシアン単位の並べ替えはしない。
import { quatToMat3, type SplatData } from './splat';
import type { M3 } from './math';
import type { BakeRegion } from './baker';

/** 1個あたり 28バイト：中心xz(2) + 平たい共分散 xx,xz,zz(3) + 層番号(1) + 色RGBA8 */
export const GSTACK_STRIDE = 28;

export interface GaussianStack {
  count: number;
  slices: number;
  buffer: ArrayBuffer;
  /** 1層の厚み（データの単位） */
  layerH: number;
  /** 各層の開始位置（slices+1個） */
  starts: Uint32Array;
  region: BakeRegion;
}

/** 焼き込みと同じ並び（下→上）から、ガウシアン・スタックのデータを作る */
export async function buildGaussianStack(
  d: SplatData, R: M3, c: [number, number, number], region: BakeRegion,
  order: Uint32Array, starts: Uint32Array, slices: number, onProgress: (p: number) => void,
): Promise<GaussianStack> {
  const n = order.length;
  const buffer = new ArrayBuffer(n * GSTACK_STRIDE);
  const f = new Float32Array(buffer);
  const u = new Uint32Array(buffer);
  const P = d.positions, S = d.scales, Q = d.rotations, C = d.colors;
  const cx = region.originX + region.width / 2, cz = region.originZ + region.width / 2;
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
      const b = k * 7;
      f[b] = ax - cx;
      f[b + 1] = az - cz;
      f[b + 2] = mx0 * mx0 + mx1 * mx1 + mx2 * mx2; // xx
      f[b + 3] = mx0 * mz0 + mx1 * mz1 + mx2 * mz2; // xz
      f[b + 4] = mz0 * mz0 + mz1 * mz1 + mz2 * mz2; // zz
      f[b + 5] = s;
      u[b + 6] = (C[i * 4] | (C[i * 4 + 1] << 8) | (C[i * 4 + 2] << 16) | (C[i * 4 + 3] << 24)) >>> 0;
      if ((k & 0xffff) === 0 && performance.now() - last > 30) {
        onProgress(k / n);
        await new Promise<void>((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
        last = performance.now();
      }
    }
  }
  return { count: n, slices, buffer, layerH: (region.y1 - region.y0) / slices, region, starts: starts.slice() };
}

const VS = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_viewport;
uniform float u_ppu;       // データの1単位が画面で何デバイスピクセルか
uniform float u_layerH;    // 1層の厚み（高さの倍率込み）
uniform float u_slices;
uniform float u_yaw;
uniform float u_pitch;
uniform float u_thick;     // 上方向の厚みを残す割合（0 = 完全に平ら）
uniform float u_shade;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec2 a_center;
layout(location=2) in vec3 a_cov;
layout(location=3) in float a_layer;
layout(location=4) in vec4 a_color;
out vec4 v_color;
out vec2 v_pos;
void main() {
  float total = u_slices * u_layerH;
  float h = (a_layer + 0.5) * u_layerH;
  float cy = cos(u_yaw), sy = sin(u_yaw), sp = sin(u_pitch), cp = cos(u_pitch);
  // 地面(x,z)と高さ(y)から画面への正射影：画面x = x·cy − z·sy, 画面下 = (x·sy + z·cy)·sp − y·cp
  vec2 center = vec2(a_center.x * cy - a_center.y * sy, (a_center.x * sy + a_center.y * cy) * sp - (h - total * 0.5) * cp);
  mat2 A = mat2(cy, sy * sp, -sy, cy * sp);  // 列優先
  mat2 S = mat2(a_cov.x, a_cov.y, a_cov.y, a_cov.z);
  mat2 C = A * S * transpose(A);
  float yStd = u_thick * u_layerH * 0.5;     // 残す厚み（標準偏差）
  C[1][1] += cp * cp * yStd * yStd;
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
  float bright = mix(1.0 - u_shade, 1.0, (a_layer + 0.5) / u_slices);
  v_color = vec4(a_color.rgb * bright, a_color.a);
  v_pos = a_corner * 3.0;
  gl_Position = vec4(screen.x / u_viewport.x * 2.0 - 1.0, 1.0 - screen.y / u_viewport.y * 2.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_pos;
out vec4 o;
void main() {
  float r2 = dot(v_pos, v_pos);
  if (r2 > 9.0) discard;
  float al = min(0.99, exp(-0.5 * r2) * v_color.a);
  if (al < 1.0 / 255.0) discard;
  o = vec4(v_color.rgb * al, al);
}`;

function compile(gl: WebGL2RenderingContext): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('ガウシアン・スタックのシェーダーエラー: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FS));
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
}

export class GaussianStackRenderer {
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private buf: WebGLBuffer;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private data: GaussianStack | null = null;

  constructor(private gl: WebGL2RenderingContext) {
    this.prog = compile(gl);
    for (const n of ['u_viewport', 'u_ppu', 'u_layerH', 'u_slices', 'u_yaw', 'u_pitch', 'u_thick', 'u_shade'])
      this.u[n] = gl.getUniformLocation(this.prog, n);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    for (let a = 1; a <= 4; a++) { gl.enableVertexAttribArray(a); gl.vertexAttribDivisor(a, 1); }
    this.setPointers(0);
    gl.bindVertexArray(null);
  }

  /** 何番目のガウシアンから描くか（VAOとバッファが結び付いた状態で呼ぶ） */
  private setPointers(first: number) {
    const gl = this.gl, st = GSTACK_STRIDE, o = first * st;
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, st, o);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, st, o + 8);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, st, o + 20);
    gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, st, o + 24);
  }

  get ready() { return !!this.data; }
  get stack() { return this.data; }
  /** GPUに置いているバイト数 */
  get gpuBytes() { return this.data ? this.data.count * GSTACK_STRIDE : 0; }

  set(s: GaussianStack | null) {
    this.data = s;
    if (!s) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, s.buffer, gl.STATIC_DRAW);
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
    const s = this.data;
    const from = s ? s.starts[Math.max(0, Math.min(s.slices, Math.floor(p.fromLayer ?? 0)))] : 0;
    const n = s ? s.count - from : 0;
    if (s && n > 0) {
      gl.useProgram(this.prog);
      gl.uniform2f(this.u.u_viewport, w, h);
      gl.uniform1f(this.u.u_ppu, p.ppu);
      gl.uniform1f(this.u.u_layerH, s.layerH * p.heightMul);
      gl.uniform1f(this.u.u_slices, s.slices);
      gl.uniform1f(this.u.u_yaw, p.yaw);
      gl.uniform1f(this.u.u_pitch, p.pitch);
      gl.uniform1f(this.u.u_thick, p.thickness);
      gl.uniform1f(this.u.u_shade, p.shade);
      gl.enable(gl.BLEND);
      // 下の層から順に「上に重ねる」。層の順番＝奥行きの順番なので並べ替え不要
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      this.setPointers(from);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      if (from) this.setPointers(0);
      gl.bindVertexArray(null);
    }
    gl.disable(gl.SCISSOR_TEST);
    return Math.max(0, n);
  }
}
