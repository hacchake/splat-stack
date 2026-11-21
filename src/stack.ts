// スプライトスタッキングのビューア
// 焼き込んだスライスを下から順に、1枚ごとに少しずつ上へずらして重ね描きする。
// 3DGS表示と同じカメラ（向き・俯角・距離）を使うので、同じ角度・同じ大きさで見える。
import type { Finished } from './postprocess';

const VS = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_viewport;     // 描画先の大きさ（デバイスピクセル）
uniform vec2 u_center;       // スタックの中心を置く位置（デバイスピクセル）
uniform float u_res;         // スライスの一辺（px）
uniform int u_sub;           // 厚み補間：1層を何回に分けて描くか
uniform float u_layerPx;     // 1層の厚み（スライスのピクセル単位）
uniform float u_slices;
uniform float u_ppu;         // スライス1pxが画面で何デバイスピクセルか
uniform float u_yaw;
uniform float u_pitch;
uniform int u_shadow;        // 1 = 影の形を描くパス
uniform vec2 u_light;        // 高さ1あたりの影のずれ（地面上、画面基準の向き）
uniform vec2 u_offset;       // 輪郭線用：画面上でずらす量（デバイスピクセル）
out vec2 v_uv;
flat out float v_layer;
out float v_height;          // 0 = 一番下, 1 = 一番上
void main() {
  int k = gl_InstanceID / u_sub;
  int j = gl_InstanceID - k * u_sub;
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  v_uv = c;
  v_layer = float(k);
  float h = (float(k) + float(j) / float(u_sub)) * u_layerPx;   // 地面からの高さ
  float total = u_slices * u_layerPx;
  v_height = h / max(total, 1e-6);
  vec2 p = (c - 0.5) * u_res;                                    // スライス内の位置（右=+X, 下=+Z）
  float cy = cos(u_yaw), sy = sin(u_yaw);
  vec2 g = vec2(p.x * cy - p.y * sy, p.x * sy + p.y * cy);       // 回したあとの地面上の位置
  float lift = h;
  if (u_shadow == 1) { g += u_light * h; lift = 0.0; }           // 影は地面に落とす
  float sx = g.x;
  float sd = g.y * sin(u_pitch) - (lift - total * 0.5) * cos(u_pitch);
  vec2 screen = u_center + vec2(sx, sd) * u_ppu + u_offset;
  gl_Position = vec4(screen.x / u_viewport.x * 2.0 - 1.0, 1.0 - screen.y / u_viewport.y * 2.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray u_tex;
uniform int u_shadow;
uniform float u_shade;       // 高さによる明るさの差（0 = なし）
uniform float u_flashLayer;  // 変身演出：光らせる層
uniform float u_flash;       // 光らせる強さ 0〜1
uniform vec4 u_outline;      // a > 0 なら輪郭線のパス（rgbで塗る）
in vec2 v_uv;
flat in float v_layer;
in float v_height;
out vec4 o;
void main() {
  vec4 t = texture(u_tex, vec3(v_uv, v_layer));   // 乗算済みアルファ
  if (u_shadow == 1) { if (t.a < 0.5) discard; o = vec4(0.0); return; }
  if (u_outline.a > 0.0) { if (t.a < 0.5) discard; o = vec4(u_outline.rgb, 1.0); return; }
  if (t.a < 0.004) discard;
  float b = mix(1.0 - u_shade, 1.0, v_height);
  vec3 c = t.rgb * b;
  if (abs(v_layer - u_flashLayer) < 0.5) c = mix(c, vec3(t.a), u_flash);
  o = vec4(c, t.a);
}`;

// 変身演出の「スキャン線」（輪切りの位置を示す四角）
const RING_VS = `#version 300 es
layout(location=0) in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FILL_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const FILL_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 o;
void main() { o = u_color; }`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('スタック表示シェーダーのエラー: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('スタック表示シェーダーのリンクエラー: ' + gl.getProgramInfoLog(p));
  return p;
}

export interface StackParams {
  /** 描画先の長方形（デバイスピクセル、左上原点） */
  rect: { x: number; y: number; w: number; h: number };
  canvasHeight: number;
  yaw: number;
  pitch: number;
  /** スライス1pxが画面で何デバイスピクセルか */
  ppu: number;
  /** 1層の厚み（スライスのピクセル単位） */
  layerPx: number;
  /** 厚み補間の分割数（1 = なし） */
  sub: number;
  /** 高さによる明るさの差 0〜1 */
  shade: number;
  shadow: { strength: number; azimuth: number; elevation: number } | null;
  background: [number, number, number];
  /** 下から何層だけ描くか（省略時は全部） */
  layers?: number;
  /** false なら背景を塗らずに上から描き足す */
  clear?: boolean;
  /** 背景を塗った直後に呼ぶ（変身演出で、ガウシアン部分の影を先に描くため） */
  beforeDraw?: () => void;
  /** 変身演出：光らせる層とその強さ */
  flashLayer?: number;
  flash?: number;
  /** 画面上のシルエットに付ける輪郭線（スライスごとではなく、重ねた後の外側だけ） */
  outline?: [number, number, number] | null;
}

export class StackRenderer {
  private prog: WebGLProgram;
  private fill: WebGLProgram;
  private ringProg: WebGLProgram;
  private ringVao: WebGLVertexArrayObject;
  private ringBuf: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private tex: WebGLTexture | null = null;
  private res = 0;
  private slices = 0;
  private u: Record<string, WebGLUniformLocation | null> = {};

  constructor(private gl: WebGL2RenderingContext) {
    this.prog = compile(gl, VS, FS);
    this.fill = compile(gl, FILL_VS, FILL_FS);
    this.ringProg = compile(gl, RING_VS, FILL_FS);
    this.ringVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.ringVao);
    this.ringBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ringBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.u.r_color = gl.getUniformLocation(this.ringProg, 'u_color');
    for (const n of ['u_viewport', 'u_center', 'u_res', 'u_sub', 'u_layerPx', 'u_slices', 'u_ppu', 'u_yaw', 'u_pitch', 'u_shadow', 'u_light', 'u_tex', 'u_shade', 'u_flashLayer', 'u_flash', 'u_offset', 'u_outline'])
      this.u[n] = gl.getUniformLocation(this.prog, n);
    this.u.f_color = gl.getUniformLocation(this.fill, 'u_color');
    this.vao = gl.createVertexArray()!; // 頂点データは使わない（gl_VertexIDで作る）
  }

  get ready() { return !!this.tex; }
  get sliceCount() { return this.slices; }

  /** 仕上がったスライスをGPUのテクスチャ配列に送る */
  setSlices(f: Finished, smooth: boolean) {
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    this.res = f.resolution;
    this.slices = f.slices.length;
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, this.res, this.res, this.slices);
    // 3Dテクスチャでは自動の乗算済み変換が使えないので、自分で乗算済みアルファにする
    const buf = new Uint8Array(this.res * this.res * 4);
    f.slices.forEach((img, k) => {
      const s = img.data;
      for (let i = 0; i < s.length; i += 4) {
        const a = s[i + 3];
        buf[i] = (s[i] * a + 127) / 255; buf[i + 1] = (s[i + 1] * a + 127) / 255; buf[i + 2] = (s[i + 2] * a + 127) / 255; buf[i + 3] = a;
      }
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, k, this.res, this.res, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    });
    const filter = smooth ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /**
   * 変身演出のスキャン線：高さ layerF（層の単位）の位置に、スライスの外枠を光る線で描く。
   * 位置の計算はシェーダーと同じ正射影。
   */
  drawRing(p: StackParams, layerF: number, color: [number, number, number, number]) {
    if (!this.tex) return;
    const gl = this.gl;
    const { x, y, w, h } = p.rect;
    const glY = p.canvasHeight - y - h;
    gl.viewport(x, glY, w, h);
    const r = this.res / 2, total = this.slices * p.layerPx, hh = layerF * p.layerPx;
    const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw), sp = Math.sin(p.pitch), cp = Math.cos(p.pitch);
    const pts: number[] = [];
    for (const [u, v] of [[-r, -r], [r, -r], [r, -r], [r, r], [r, r], [-r, r], [-r, r], [-r, -r]]) {
      const gx = u * cy - v * sy, gd = u * sy + v * cy;
      const sx = w / 2 + gx * p.ppu, sd = h / 2 + (gd * sp - (hh - total / 2) * cp) * p.ppu;
      pts.push(sx / w * 2 - 1, 1 - sd / h * 2);
    }
    gl.useProgram(this.ringProg);
    gl.uniform4fv(this.u.r_color, color);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.bindVertexArray(this.ringVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ringBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STREAM_DRAW);
    gl.drawArrays(gl.LINES, 0, 8);
    gl.bindVertexArray(null);
  }

  /** 描いた四角形の数（=スライス数×厚み補間） */
  render(p: StackParams): number {
    const gl = this.gl;
    const { x, y, w, h } = p.rect;
    const glY = p.canvasHeight - y - h;
    gl.viewport(x, glY, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, glY, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(p.background[0], p.background[1], p.background[2], 1);
    gl.clearStencil(0);
    gl.clear(p.clear === false ? gl.STENCIL_BUFFER_BIT : gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    if (p.beforeDraw) {
      p.beforeDraw();
      gl.viewport(x, glY, w, h);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x, glY, w, h);
    }
    if (!this.tex) { gl.disable(gl.SCISSOR_TEST); return 0; }

    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.uniform1i(this.u.u_tex, 0);
    gl.uniform2f(this.u.u_viewport, w, h);
    gl.uniform2f(this.u.u_center, w / 2, h / 2);
    gl.uniform1f(this.u.u_res, this.res);
    gl.uniform1i(this.u.u_sub, p.sub);
    gl.uniform1f(this.u.u_layerPx, p.layerPx);
    gl.uniform1f(this.u.u_slices, this.slices);
    gl.uniform1f(this.u.u_ppu, p.ppu);
    gl.uniform1f(this.u.u_yaw, p.yaw);
    gl.uniform1f(this.u.u_pitch, p.pitch);
    gl.uniform1f(this.u.u_shade, p.shade);
    gl.uniform1f(this.u.u_flashLayer, p.flashLayer ?? -10);
    gl.uniform1f(this.u.u_flash, p.flash ?? 0);
    gl.uniform2f(this.u.u_offset, 0, 0);
    gl.uniform4f(this.u.u_outline, 0, 0, 0, 0);
    gl.bindVertexArray(this.vao);
    const layers = Math.max(0, Math.min(this.slices, p.layers ?? this.slices));
    const count = layers * p.sub;
    if (count === 0) { gl.bindVertexArray(null); gl.disable(gl.SCISSOR_TEST); return 0; }

    // 1) 影：全層の形をステンシルに書き、その範囲を1回だけ暗くする（重なっても濃くならない）
    if (p.shadow && p.shadow.strength > 0) {
      const el = Math.max(5, Math.min(85, p.shadow.elevation)) * Math.PI / 180;
      const az = p.shadow.azimuth * Math.PI / 180;
      const len = 1 / Math.tan(el);
      gl.uniform2f(this.u.u_light, Math.cos(az) * len, Math.sin(az) * len);
      gl.uniform1i(this.u.u_shadow, 1);
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.ALWAYS, 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      gl.colorMask(false, false, false, false);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.colorMask(true, true, true, true);
      gl.useProgram(this.fill);
      gl.stencilFunc(gl.EQUAL, 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform4f(this.u.f_color, 0, 0, 0, p.shadow.strength);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.STENCIL_TEST);
      gl.useProgram(this.prog);
    }

    gl.uniform1i(this.u.u_shadow, 0);
    gl.enable(gl.BLEND);
    // 2) 輪郭線：全体を上下左右に1ドットずらして塗りつぶしで描き、その上に本体を描く → 外側だけ線が残る
    if (p.outline) {
      const d = Math.max(1, Math.round(p.ppu));
      gl.blendFunc(gl.ONE, gl.ZERO);
      gl.uniform4f(this.u.u_outline, p.outline[0], p.outline[1], p.outline[2], 1);
      for (const [ox, oy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
        gl.uniform2f(this.u.u_offset, ox, oy);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      }
      gl.uniform4f(this.u.u_outline, 0, 0, 0, 0);
      gl.uniform2f(this.u.u_offset, 0, 0);
    }
    // 3) 本体：下の層から順に上へ重ねる
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
    return count;
  }
}
