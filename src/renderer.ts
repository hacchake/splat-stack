// WebGL2 による 3DGS プレビュー描画
// 手前から奥の順に並べたガウシアンを、楕円スプラットとして「手前優先」でブレンドする
import type { PackedSplats } from './splat';

const SPLAT_VS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_tex;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform vec2 u_focal;
uniform vec2 u_viewport;
uniform float u_near;
layout(location=0) in vec2 a_corner;
layout(location=1) in uint a_index;
out vec4 v_color;
out vec2 v_pos;
const uint ROW = 1365u;
void main() {
  bool removed = (a_index & 0x80000000u) != 0u;
  uint idx = a_index & 0x7fffffffu;
  ivec2 base = ivec2(int((idx % ROW) * 3u), int(idx / ROW));
  uvec4 t0 = texelFetch(u_tex, base, 0);
  vec4 cam = u_view * vec4(uintBitsToFloat(t0.xyz), 1.0);
  if (cam.z < u_near) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec4 clip = u_proj * cam;
  vec2 ndc = clip.xy / clip.w;
  if (any(greaterThan(abs(ndc), vec2(1.3)))) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }

  vec4 c1 = uintBitsToFloat(texelFetch(u_tex, base + ivec2(1, 0), 0));
  vec2 c2 = uintBitsToFloat(texelFetch(u_tex, base + ivec2(2, 0), 0).xy);
  mat3 Vrk = mat3(c1.x, c1.y, c1.z, c1.y, c1.w, c2.x, c1.z, c2.x, c2.y);
  float z = cam.z;
  mat3 J = mat3(
    u_focal.x / z, 0.0, 0.0,
    0.0, u_focal.y / z, 0.0,
    -u_focal.x * cam.x / (z * z), -u_focal.y * cam.y / (z * z), 0.0);
  mat3 T = J * mat3(u_view);
  mat3 cov = T * Vrk * transpose(T);
  float a = cov[0][0] + 0.3;
  float b = cov[0][1];
  float c = cov[1][1] + 0.3;
  float mid = 0.5 * (a + c);
  float rad = length(vec2(0.5 * (a - c), b));
  float l1 = mid + rad;
  float l2 = max(mid - rad, 0.01);
  vec2 dir = abs(b) < 1e-12 ? (a >= c ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) : normalize(vec2(b, l1 - a));
  vec2 major = min(3.0 * sqrt(l1), 2048.0) * dir;
  vec2 minor = min(3.0 * sqrt(l2), 2048.0) * vec2(-dir.y, dir.x);

  vec4 color = vec4(uvec4(t0.w & 0xffu, (t0.w >> 8u) & 0xffu, (t0.w >> 16u) & 0xffu, t0.w >> 24u)) / 255.0;
  // 除去予定のものは赤く、薄く（ほぼ透明なモヤが画面を埋めないよう上限を低めに）
  if (removed) color = vec4(1.0, 0.15, 0.1, clamp(color.a * 4.0, 0.06, 0.3));
  v_color = color;
  v_pos = a_corner * 3.0;
  vec2 off = (a_corner.x * major + a_corner.y * minor) * 2.0 / u_viewport;
  off.y = -off.y;
  gl_Position = vec4(ndc + off, 0.0, 1.0);
}`;

const SPLAT_FS = `#version 300 es
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

const LINE_VS = `#version 300 es
uniform mat4 u_mvp;
layout(location=0) in vec3 a_pos;
void main() { gl_Position = u_mvp * vec4(a_pos, 1.0); }`;
const LINE_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 o;
void main() { o = u_color; }`;

const BG_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const BG_FS = `#version 300 es
precision mediump float;
uniform vec3 u_color;
out vec4 o;
void main() { o = vec4(u_color, 1.0); }`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('シェーダーのエラー: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('シェーダーのリンクエラー: ' + gl.getProgramInfoLog(p));
  return p;
}

export interface FrameParams {
  view: Float32Array; // カメラ×モデル
  viewOnly: Float32Array; // カメラのみ（補助線用）
  proj: Float32Array;
  focal: number;
  width: number;
  height: number;
  near: number;
  background: [number, number, number];
  /** 画面の一部だけに描くとき：左上原点の長方形とキャンバスの高さ（デバイスピクセル） */
  rect?: { x: number; y: number };
  canvasHeight?: number;
  /** 物体の後ろに描く線（床の格子など） */
  backLines?: { data: Float32Array; color: [number, number, number, number] }[];
  /** 物体の手前に描く線（クロップボックスなど） */
  frontLines?: { data: Float32Array; color: [number, number, number, number] }[];
}

export class SplatRenderer {
  readonly gl: WebGL2RenderingContext;
  private splatProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private bgProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private indexBuf: WebGLBuffer;
  private lineVao: WebGLVertexArrayObject;
  private lineBuf: WebGLBuffer;
  /** ガウシアンのデータが入ったテクスチャ（焼き込みでも使う） */
  readonly tex: WebGLTexture;
  private instanceCount = 0;
  private u: Record<string, WebGLUniformLocation | null> = {};

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false, stencil: true });
    if (!gl) throw new Error('このブラウザはWebGL2に対応していません。最新のChromeかEdgeで開いてください。');
    this.gl = gl;
    this.splatProg = compile(gl, SPLAT_VS, SPLAT_FS);
    this.lineProg = compile(gl, LINE_VS, LINE_FS);
    this.bgProg = compile(gl, BG_VS, BG_FS);
    for (const n of ['u_tex', 'u_view', 'u_proj', 'u_focal', 'u_viewport', 'u_near'])
      this.u[n] = gl.getUniformLocation(this.splatProg, n);
    this.u.l_mvp = gl.getUniformLocation(this.lineProg, 'u_mvp');
    this.u.l_color = gl.getUniformLocation(this.lineProg, 'u_color');
    this.u.bg_color = gl.getUniformLocation(this.bgProg, 'u_color');

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.indexBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);

    this.lineVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.lineVao);
    this.lineBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  setSplats(p: PackedSplats) {
    const gl = this.gl;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (p.height > max) throw new Error(`ガウシアンが多すぎてGPUに載りません（最大 約${(max * 1365 / 1e6).toFixed(0)}00万個）`);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, p.width, p.height, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, p.data);
    this.instanceCount = 0;
  }

  /** 描画順（手前→奥）のインデックス。最上位ビットが立っていれば「除去予定」として赤く描く */
  setOrder(order: Uint32Array) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuf);
    gl.bufferData(gl.ARRAY_BUFFER, order, gl.DYNAMIC_DRAW);
    this.instanceCount = order.length;
  }

  render(f: FrameParams) {
    const gl = this.gl;
    const rx = f.rect?.x ?? 0;
    const ry = f.rect ? (f.canvasHeight ?? f.height) - f.rect.y - f.height : 0;
    gl.viewport(rx, ry, f.width, f.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(rx, ry, f.width, f.height);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    // 手前から順に重ねる（under合成）
    gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);

    if (this.instanceCount > 0) {
      gl.useProgram(this.splatProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(this.u.u_tex, 0);
      gl.uniformMatrix4fv(this.u.u_view, false, f.view);
      gl.uniformMatrix4fv(this.u.u_proj, false, f.proj);
      gl.uniform2f(this.u.u_focal, f.focal, f.focal);
      gl.uniform2f(this.u.u_viewport, f.width, f.height);
      gl.uniform1f(this.u.u_near, f.near);
      gl.bindVertexArray(this.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.instanceCount);
      gl.bindVertexArray(null);
    }

    const mvp = mulMat(f.proj, f.viewOnly);
    // 物体の後ろの線（under合成のまま描くと物体に隠れる）
    for (const l of f.backLines ?? []) this.drawLines(l.data, mvp, premul(l.color));
    // 背景
    gl.useProgram(this.bgProg);
    gl.uniform3fv(this.u.bg_color, f.background);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 手前の線（ふつうのアルファ合成）
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    for (const l of f.frontLines ?? []) this.drawLines(l.data, mvp, l.color);
    gl.disable(gl.SCISSOR_TEST);
  }

  /** GPUに置いているバイト数（データのテクスチャ＋描画順） */
  gpuBytes(texHeight: number, visible: number) {
    return texHeight * 4095 * 16 + visible * 4;
  }

  private drawLines(data: Float32Array, mvp: Float32Array, color: [number, number, number, number]) {
    const gl = this.gl;
    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(this.u.l_mvp, false, mvp);
    gl.uniform4fv(this.u.l_color, color);
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.drawArrays(gl.LINES, 0, data.length / 3);
    gl.bindVertexArray(null);
  }
}

const premul = (c: [number, number, number, number]): [number, number, number, number] => [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];

function mulMat(a: Float32Array, b: Float32Array): Float32Array {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = s;
    }
  return r;
}
