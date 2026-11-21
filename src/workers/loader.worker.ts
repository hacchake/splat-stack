// ファイルの解析とGPU用データの準備（画面が固まらないよう別スレッドで行う）
import { parsePly, parseSplatFile } from '../parsers';
import { packSplats } from '../splat';

self.onmessage = (e: MessageEvent<{ buffer: ArrayBuffer; name: string }>) => {
  const { buffer, name } = e.data;
  const progress = (p: number, label: string) => postMessage({ type: 'progress', p, label });
  try {
    const head = new Uint8Array(buffer, 0, Math.min(3, buffer.byteLength));
    const isPly = head[0] === 0x70 && head[1] === 0x6c && head[2] === 0x79; // "ply"
    let d;
    if (isPly) d = parsePly(buffer, (p) => progress(p * 0.7, 'PLYを読み込み中'));
    else if (name.toLowerCase().endsWith('.splat')) d = parseSplatFile(buffer, (p) => progress(p * 0.7, '.splatを読み込み中'));
    else throw new Error('対応していない形式です（.ply または .splat を選んでください）');
    const packed = packSplats(d, (p) => progress(0.7 + p * 0.3, 'GPU用に変換中'));
    postMessage({ type: 'done', data: d, packed }, {
      transfer: [d.positions.buffer, d.scales.buffer, d.rotations.buffer, d.colors.buffer, packed.data.buffer] as Transferable[],
    });
  } catch (err) {
    postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
