// ИИ-агент на стороне браузера: исправление ошибок распознавания и перевод RU <-> EN.
// Режимы (настройки fixMode / trMode):
//   off    — выключено;
//   local  — на устройстве: исправление по словарю (corrector.js), перевод моделью Opus-MT (transformers.js);
//   server — запрос к серверу агента (serve.py → agent/agent.py → Claude API или Ollama).

import { t } from './i18n.js';
import { correctLocal } from './corrector.js';
import { lineTranslator } from './standards.js';

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
const MT_MODELS = { 'ru-en': 'Xenova/opus-mt-ru-en', 'en-ru': 'Xenova/opus-mt-en-ru' };
const DOUBT = 0.6;   // клетки с уверенностью модели ниже — «сомнительные»

/* ---------------- сервер агента ---------------- */

export function agentUrl(settings) {
  const u = (settings.agentUrl || '').trim().replace(/\/+$/, '');
  return u || new URL('api/agent', location.href).href;
}

async function callServer(settings, payload, path = '') {
  let res;
  try {
    res = await fetch(agentUrl(settings) + path, {
      method: payload ? 'POST' : 'GET',
      headers: {
        ...(payload ? { 'content-type': 'application/json' } : {}),
        ...(settings.agentToken ? { 'X-POV-Token': settings.agentToken } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
  } catch (err) {
    throw new Error(t('ai.serverFail', { msg: err.message }));
  }
  let data = {};
  try { data = await res.json(); } catch { /* не JSON */ }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Проверка связи: { ok, provider, model, error? } */
export const checkAgent = (settings) => callServer(settings, null, '/health');

/* ---------------- исправление ---------------- */

/** Уверенность модели по клеткам, построчно (в том же порядке, что клетки в строке Брайля). */
export function cellScores(result) {
  const lines = [];
  for (const c of result.cells || []) (lines[c[6]] ??= []).push(c[5]);
  return lines.map((l) => l || []);
}

/** Слова, в которых есть сомнительные клетки, — подсказка для языковой модели. */
async function uncertainWords(result, std, settings) {
  const tr = await lineTranslator(std, settings);
  const scores = cellScores(result);
  const out = [];
  (result.braille || '').split('\n').forEach((line, li) => {
    let k = 0;
    for (const w of line.split(' ')) {
      const n = [...w].length;
      if (w && (scores[li] || []).slice(k, k + n).some((s) => s < DOUBT)) out.push(tr(w));
      k += n;
    }
  });
  return [...new Set(out)];
}

/**
 * Исправляет текст снимка. text — текущий текст (уже переведённый из Брайля по стандарту std).
 * Возвращает { text, changes: [{from, to}], source: 'local' | 'server' }.
 */
export async function correct({ result, std, text, settings }) {
  if (settings.fixMode === 'local') {
    let r;
    try {
      r = await correctLocal({ braille: result.braille, std, settings, scores: cellScores(result) });
    } catch (err) {
      throw new Error(t('ai.dictFail', { msg: err.message }));
    }
    return { text: r.text, changes: r.changes, source: 'local' };
  }
  if (settings.fixMode === 'server') {
    const r = await callServer(settings, {
      task: 'correct',
      lang: std,
      grade: settings.enGrade,
      text,
      braille: result.braille,
      uncertain: await uncertainWords(result, std, settings).catch(() => []),
    });
    return { text: r.text, changes: r.changes || [], source: 'server', model: r.model };
  }
  throw new Error(t('ai.off'));
}

/* ---------------- перевод ---------------- */

const mtPipelines = {};

async function localTranslator(key, onProgress) {
  mtPipelines[key] ??= (async () => {
    let lib;
    try {
      lib = await import(TRANSFORMERS_URL);
    } catch {
      throw new Error(t('ai.mtNoLib'));
    }
    const { pipeline, env } = lib;
    // Сначала ищем модель в web-app/models/<id>/ (для работы без интернета), затем на Hugging Face.
    env.localModelPath = new URL('models/', location.href).href;
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    const files = {};
    return pipeline('translation', MT_MODELS[key], {
      dtype: 'q8',
      progress_callback: (e) => {
        if (e.status === 'progress' && e.total) {
          files[e.file] = [e.loaded, e.total];
          const [l, tt] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
          onProgress?.(l / tt);
        }
      },
    });
  })();
  mtPipelines[key].catch(() => { delete mtPipelines[key]; });
  return mtPipelines[key];
}

/** Перевод RU <-> EN построчно (строк в переводе столько же, сколько в оригинале). Возвращает { text, source }. */
export async function translateText({ text, from, to, settings, onProgress }) {
  if (settings.trMode === 'local') {
    const key = `${from}-${to}`;
    if (!MT_MODELS[key]) throw new Error(t('ai.onlyRuEn'));
    const mt = await localTranslator(key, onProgress);
    // перевод в том же формате, что и оригинал: строка → строка (пустые строки сохраняются)
    const lines = text.split('\n');
    const idx = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
    const out = idx.length ? await mt(idx.map((i) => lines[i].trim())) : [];
    const res = lines.map(() => '');
    idx.forEach((i, k) => { res[i] = out[k]?.translation_text ?? ''; });
    return { text: res.join('\n'), source: 'local' };
  }
  if (settings.trMode === 'server') {
    const r = await callServer(settings, { task: 'translate', from, to, text });
    return { text: r.text, source: 'server', model: r.model };
  }
  throw new Error(t('ai.off'));
}

/* ---------------- сравнение по словам (подсветка исправлений) ---------------- */

/** Возвращает части нового текста: [{ text, changed }] — по словам, через LCS. */
export function diffWords(oldText, newText) {
  const a = oldText.split(/(\s+)/), b = newText.split(/(\s+)/);
  const n = a.length, m = b.length;
  if (n * m > 400000) return [{ text: newText, changed: false }];
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const parts = [];
  let i = 0, j = 0;
  while (j < m) {
    if (i < n && a[i] === b[j]) { parts.push({ text: b[j], changed: false }); i++; j++; }
    else if (i < n && L[i + 1][j] >= L[i][j + 1]) i++;
    else { parts.push({ text: b[j], changed: !/^\s+$/.test(b[j]) }); j++; }
  }
  return parts;
}
