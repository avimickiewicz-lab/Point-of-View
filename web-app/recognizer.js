// Загрузка braile.onnx и запуск распознавания в браузере через ONNX Runtime Web.
import { preprocess, postprocess } from './braille.js';
import { t } from './i18n.js';

export const MODEL_URL = 'models/braile.onnx';
const ORT_DIST = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';

let sessionPromise = null;
let backend = '';

/** Загружает модель один раз; onProgress(доля 0..1 | null, текст). */
export function loadModel(onProgress = () => {}) {
  sessionPromise ??= (async () => {
    const ort = globalThis.ort;
    if (!ort) {
      throw new Error(t('model.noOrt'));
    }
    ort.env.wasm.wasmPaths = ORT_DIST;
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

    const model = await fetchWithProgress(MODEL_URL, (p) => onProgress(p, t('model.loading')));
    onProgress(null, t('model.preparing'));

    const opts = { graphOptimizationLevel: 'all' };
    if (navigator.gpu) {
      try {
        const s = await ort.InferenceSession.create(model, { ...opts, executionProviders: ['webgpu'] });
        backend = 'WebGPU';
        return s;
      } catch (err) {
        console.warn('WebGPU недоступен, используется WASM', err);
      }
    }
    const s = await ort.InferenceSession.create(model, { ...opts, executionProviders: ['wasm'] });
    backend = 'WASM';
    return s;
  })();
  sessionPromise.catch(() => { sessionPromise = null; }); // разрешаем повторную попытку
  return sessionPromise;
}

export const getBackend = () => backend;

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(t('model.notFound', { status: res.status, url }));
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());

  const buf = new Uint8Array(total);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.set(value, got);
    got += value.length;
    onProgress(got / total);
  }
  return buf;
}

/**
 * Распознаёт снимок (Blob). Возвращает { text, braille, cells, lines, ms, backend }.
 * cells — [x1, y1, x2, y2, класс, уверенность, номер строки] в пикселях исходного снимка.
 */
export async function recognize(blob, onProgress = () => {}, opts = {}) {
  const session = await loadModel(onProgress);
  onProgress(null, t('model.running'));

  const bitmap = await createImageBitmap(blob);
  const meta = preprocess(bitmap);
  bitmap.close?.();

  const ort = globalThis.ort;
  const input = new ort.Tensor('float32', meta.data, meta.dims);
  const t0 = performance.now();
  const outputs = await session.run({ [session.inputNames[0]]: input });
  const ms = Math.round(performance.now() - t0);
  const output = outputs[session.outputNames[0]];

  const r = postprocess(output.data, meta, opts);
  const cells = [];
  r.lines.forEach((line, li) => line.forEach((it) => {
    if (it.det) {
      const d = it.det;
      cells.push([d.x1, d.y1, d.x2, d.y2, d.cls, +d.score.toFixed(3), li].map((v, i) => (i < 4 ? Math.round(v) : v)));
    }
  }));
  return { text: r.text, braille: r.braille, cells, lines: r.lines.length, ms, backend };
}
