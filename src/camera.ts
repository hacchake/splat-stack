// 注視点のまわりを回るカメラ
// カメラ座標系：x=右、y=下、z=奥（3DGSで一般的な向き）
import { cross, normalize, sub, DEG, type V3 } from './math';

export class OrbitCamera {
  target: V3 = [0, 0, 0];
  yaw = 0.7;
  pitch = 0.4;
  distance = 3;
  fovY = 45 * DEG;

  eye(): V3 {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
  }

  /** カメラの右・下・前方向 */
  basis(): { x: V3; y: V3; f: V3 } {
    const f = normalize(sub(this.target, this.eye()));
    const x = normalize(cross(f, [0, 1, 0]));
    const y = cross(f, x);
    return { x, y, f };
  }

  view(): Float32Array {
    const e = this.eye();
    const { x, y, f } = this.basis();
    const d = (a: V3) => a[0] * e[0] + a[1] * e[1] + a[2] * e[2];
    return new Float32Array([
      x[0], y[0], f[0], 0,
      x[1], y[1], f[1], 0,
      x[2], y[2], f[2], 0,
      -d(x), -d(y), -d(f), 1,
    ]);
  }

  focal(height: number): number {
    return height / (2 * Math.tan(this.fovY / 2));
  }

  proj(width: number, height: number, near: number, far: number): Float32Array {
    const fy = this.focal(height), fx = fy;
    return new Float32Array([
      (2 * fx) / width, 0, 0, 0,
      0, -(2 * fy) / height, 0, 0,
      0, 0, far / (far - near), 1,
      0, 0, -(far * near) / (far - near), 0,
    ]);
  }

  orbit(dx: number, dy: number) {
    this.yaw -= dx * 0.006;
    this.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, this.pitch + dy * 0.006));
  }

  pan(dx: number, dy: number, height: number) {
    const { x, y } = this.basis();
    const k = this.distance / this.focal(height);
    for (let i = 0; i < 3; i++) this.target[i] -= (x[i] * dx + y[i] * dy) * k;
  }

  zoom(delta: number) {
    this.distance *= Math.exp(delta * 0.0012);
  }

  /** 画面上の点（CSSピクセル）を通る視線の向き */
  rayDir(px: number, py: number, width: number, height: number): V3 {
    const { x, y, f } = this.basis();
    const fl = this.focal(height);
    const u = (px - width / 2) / fl, v = (py - height / 2) / fl;
    return normalize([f[0] + x[0] * u + y[0] * v, f[1] + x[1] * u + y[1] * v, f[2] + x[2] * u + y[2] * v]);
  }
}
