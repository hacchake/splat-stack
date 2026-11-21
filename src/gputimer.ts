// GPUの描画時間を測る（対応しているブラウザだけ。Chrome/Edgeの多くで使える）
export class GpuTimer {
  private ext: any;
  private pending: { q: WebGLQuery; label: string }[] = [];
  private active: WebGLQuery | null = null;
  private activeLabel = '';
  private results = new Map<string, number>();

  constructor(private gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  get supported() { return !!this.ext; }

  begin(label: string) {
    if (!this.ext || this.active) return;
    // 同じ名前の計測が結果待ちなら、今回は測らない（どの表示も公平に測れるように）
    if (this.pending.some((p) => p.label === label)) return;
    const q = this.gl.createQuery()!;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
    this.activeLabel = label;
  }

  end() {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push({ q: this.active, label: this.activeLabel });
    this.active = null;
  }

  /** 毎フレーム呼ぶ：終わった計測を取り込む */
  poll() {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const { q, label } = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      gl.deleteQuery(q);
      this.pending.shift();
      if (disjoint) continue;
      const ms = ns / 1e6;
      const prev = this.results.get(label);
      this.results.set(label, prev === undefined ? ms : prev * 0.9 + ms * 0.1);
    }
  }

  /** 平均したミリ秒（まだ測れていなければ null） */
  get(label: string): number | null {
    return this.results.get(label) ?? null;
  }
}
