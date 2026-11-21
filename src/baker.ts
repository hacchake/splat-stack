// スライスへの焼き込み（核心部分）
// 上方向の軸に沿って輪切りにし、各層に入るガウシアンを真上から正射影で描く。
// ガウシアンは「下から上」の順に並べてあるので、層ごとの範囲をそのまま順に描けばよい（並べ替え不要）。
import type { M3 } from './math';

const VS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_tex;
uniform mat3 u_R;        // 整列用の回転
uniform vec3 u_c;        // 回転の中心
uniform vec2 u_origin;   // 焼き込み範囲の左上（整列後の X, Z）
uniform float u_k;       // 1単位あたりのピクセル数
uniform float u_size;    // 描画先のピクセル数（正方形）
layout(location=0) in vec2 a_corner;
layout(location=1) in uint a_index;
out vec4 v_color;
out vec2 v_pos;
const uint ROW = 1365u;
void main() {
  uint idx = a_index;
  ivec2 base = ivec2(int((idx % ROW) * 3u), int(idx / ROW));
  uvec4 t0 = texelFetch(u_tex, base, 0);
  vec3 q = u_R * (uintBitsToFloat(t0.xyz) - u_c);
  vec2 center = (q.xz - u_origin) * u_k;   // ピクセル座標

  vec4 c1 = uintBitsToFloat(texelFetch(u_tex, base + ivec2(1, 0), 0));
  vec2 c2 = uintBitsToFloat(texelFetch(u_tex, base + ivec2(2, 0), 0).xy);
  mat3 S = mat3(c1.x, c1.y, c1.z, c1.y, c1.w, c2.x, c1.z, c2.x, c2.y);
  mat3 Sa = u_R * S * transpose(u_R);
  // 真上から見た2次元の広がり（X-Z成分）。小さすぎるものが消えないよう少しだけ太らせる
  float a = Sa[0][0] * u_k * u_k + 0.3;
  float b = Sa[0][2] * u_k * u_k;
  float c = Sa[2][2] * u_k * u_k + 0.3;
  float mid = 0.5 * (a + c);
  float rad = length(vec2(0.5 * (a - c), b));
  float l1 = mid + rad;
  float l2 = max(mid - rad, 0.01);
  vec2 dir = abs(b) < 1e-12 ? (a >= c ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) : normalize(vec2(b, l1 - a));
  vec2 major = min(3.0 * sqrt(l1), 4096.0) * dir;
  vec2 minor = min(3.0 * sqrt(l2), 4096.0) * vec2(-dir.y, dir.x);

  v_color = vec4(uvec4(t0.w & 0xffu, (t0.w >> 8u) & 0xffu, (t0.w >> 16u) & 0xffu, t0.w >> 24u)) / 255.0;
  v_pos = a_corner * 3.0;
  vec2 p = center + a_corner.x * major + a_corner.y * minor;
  gl_Position = vec4(p / u_size * 2.0 - 1.0, 0.0, 1.0);
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

export interface BakeRegion {
  /** 整列後の X, Z の左上（正方形の範囲） */
  originX: number;
  originZ: number;
  /** 正方形の一辺（整列後の単位） */
  width: number;
  /** Y の範囲 */
  y0: number;
  y1: number;
}

export interface BakeInput {
  R: M3;
  center: [number, number, number];
  region: BakeRegion;
  slices: number;
  resolution: number;
  /** 下から上へ並べた描画対象のインデックス */
  order: Uint32Array;
  /** 各層の開始位置（slices+1個） */
  starts: Uint32Array;
}

/** 層ごとの素材。どちらもふつうの（乗算済みでない）RGBA */
export interface BakeRaw {
  resolution: number;
  slices: number;
  /** 面積平均で縮小したもの（ソフトモード用） */
  soft: Uint8ClampedArray[];
  /** 最近傍で縮小したもの（ドット絵モード用） */
  nearest: Uint8ClampedArray[];
  region: BakeRegion;
}

function compile(gl: WebGL2RenderingContext): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('焼き込みシェーダーのエラー: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('焼き込みシェーダーのリンクエラー: ' + gl.getProgramInfoLog(p));
  return p;
}

export class SliceBaker {
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private indexBuf: WebGLBuffer;
  private u: Record<string, WebGLUniformLocation | null> = {};

  constructor(private gl: WebGL2RenderingContext, private splatTex: WebGLTexture) {
    this.prog = compile(gl);
    for (const n of ['u_tex', 'u_R', 'u_c', 'u_origin', 'u_k', 'u_size']) this.u[n] = gl.getUniformLocation(this.prog, n);
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
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
  }

  /** 拡大率：最終解像度の何倍で描いてから縮小するか */
  static superSample(res: number) {
    return Math.max(2, Math.min(8, Math.floor(1024 / res)));
  }

  async bake(inp: BakeInput, onProgress: (p: number) => void, isCancelled: () => boolean): Promise<BakeRaw | null> {
    const gl = this.gl;
    const res = inp.resolution;
    const S = SliceBaker.superSample(res);
    const hi = res * S;

    const target = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, hi, hi, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuf);
    gl.bufferData(gl.ARRAY_BUFFER, inp.order, gl.STATIC_DRAW);

    const R = inp.R;
    const Rcol = new Float32Array([R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]);
    const pixels = new Uint8Array(hi * hi * 4);
    const out: BakeRaw = { resolution: res, slices: inp.slices, soft: [], nearest: [], region: inp.region };
    let lastYield = performance.now();

    try {
      for (let k = 0; k < inp.slices; k++) {
        if (isCancelled()) return null;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.viewport(0, 0, hi, hi);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const start = inp.starts[k], count = inp.starts[k + 1] - start;
        if (count > 0) {
          gl.useProgram(this.prog);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.splatTex);
          gl.uniform1i(this.u.u_tex, 0);
          gl.uniformMatrix3fv(this.u.u_R, false, Rcol);
          gl.uniform3fv(this.u.u_c, inp.center);
          gl.uniform2f(this.u.u_origin, inp.region.originX, inp.region.originZ);
          gl.uniform1f(this.u.u_k, hi / inp.region.width);
          gl.uniform1f(this.u.u_size, hi);
          gl.enable(gl.BLEND);
          // 下から上へ順に「上に重ねる」合成（真上から見ると上のものが手前）
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.bindVertexArray(this.vao);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuf);
          gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, start * 4);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
          gl.bindVertexArray(null);
        }
        gl.readPixels(0, 0, hi, hi, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const { soft, nearest } = downsample(pixels, hi, S);
        out.soft.push(soft);
        out.nearest.push(nearest);
        onProgress((k + 1) / inp.slices);
        // 画面の更新（進捗バー）のために、30msごとに少し休む
        if (performance.now() - lastYield > 30) { await yieldToBrowser(); lastYield = performance.now(); }
      }
    } finally {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(target);
    }
    return out;
  }
}

/** いったんブラウザに処理を返す（setTimeoutと違い、裏のタブでも1秒待たされない） */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

/** 乗算済みの高解像度画像を、面積平均（ソフト）と最近傍（ドット絵）の2通りに縮小 */
function downsample(px: Uint8Array, hi: number, S: number): { soft: Uint8ClampedArray; nearest: Uint8ClampedArray } {
  const res = hi / S;
  const soft = new Uint8ClampedArray(res * res * 4);
  const nearest = new Uint8ClampedArray(res * res * 4);
  const inv = 1 / (S * S);
  const half = S >> 1;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        let p = ((y * S + sy) * hi + x * S) * 4;
        for (let sx = 0; sx < S; sx++, p += 4) {
          r += px[p]; g += px[p + 1]; b += px[p + 2]; a += px[p + 3];
        }
      }
      const o = (y * res + x) * 4;
      writeStraight(soft, o, r * inv, g * inv, b * inv, a * inv);
      // 最近傍：ブロックの中心を基本にしつつ、それよりはっきり濃いものがあればそちらを選ぶ。
      // （中心の1点だけだと、真上から見た壁のような1ピクセル未満の細い線が抜け落ちるため）
      let c = ((y * S + half) * hi + x * S + half) * 4;
      let best = px[c + 3];
      for (let sy = 0; sy < S; sy++) {
        let q = ((y * S + sy) * hi + x * S) * 4;
        for (let sx = 0; sx < S; sx++, q += 4) if (px[q + 3] > best + 24) { best = px[q + 3]; c = q; }
      }
      writeStraight(nearest, o, px[c], px[c + 1], px[c + 2], px[c + 3]);
    }
  }
  return { soft, nearest };
}

function writeStraight(out: Uint8ClampedArray, o: number, r: number, g: number, b: number, a: number) {
  if (a <= 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; return; }
  const k = 255 / a;
  out[o] = r * k; out[o + 1] = g * k; out[o + 2] = b * k; out[o + 3] = a;
}
