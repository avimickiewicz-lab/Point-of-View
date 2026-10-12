// Исправление ошибок распознавания на устройстве (русский и английский), без сети и без ИИ.
// Идея: типичная ошибка распознавания Брайля — лишняя или потерянная точка в одной клетке.
// Для слова, которого нет в словаре, перебираем клетки, отличающиеся на одну точку (и удаление
// лишней клетки), переводим каждый вариант через liblouis и выбираем самый частотный словарный.
// Клетки, в которых модель была не уверена, проверяются в первую очередь.

import { lineTranslator } from './standards.js';

const dicts = {};
const EXTRA = {
  ru: ['брайль', 'брайля', 'брайлю', 'брайлем', 'брайле', 'брайлевский', 'брайлевского', 'брайлевская', 'брайлевской',
    'брайлевские', 'брайлевских', 'шрифт', 'шрифта', 'рельефно', 'рельефный', 'рельефного', 'рельефная', 'рельефной',
    'тифлопедагог', 'тифлотехника', 'незрячий', 'незрячих', 'незрячим', 'незрячие', 'слабовидящий', 'слабовидящих',
    'точечный', 'точечного', 'клетка', 'клетки', 'клеток'],
  en: ['braille', 'brailled', 'tactile', 'embossed', 'embosser', 'uncontracted', 'contracted', 'refreshable', 'louis'],
};

/** Частотный словарь: слово → вес (чем частотнее, тем больше). */
export function loadWords(lang) {
  dicts[lang] ??= (async () => {
    const res = await fetch(`data/words-${lang}.txt.gz`);
    if (!res.ok) throw new Error(`data/words-${lang}.txt.gz: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const gz = buf[0] === 0x1f && buf[1] === 0x8b;
    const text = gz
      ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
      : new TextDecoder().decode(buf);
    const map = new Map();
    text.split('\n').forEach((w, rank) => { if (w) map.set(w, -Math.log(rank + 20)); });
    // предметная лексика, которой нет в частотном словаре
    (EXTRA[lang] || []).forEach((w) => { if (!map.has(w)) map.set(w, -Math.log(5000)); });
    return map;
  })();
  dicts[lang].catch(() => { delete dicts[lang]; });
  return dicts[lang];
}

const COMMON = -Math.log(10000);   // вес слова из первых 10 тыс. по частоте
const norm = (w) => w.toLowerCase().replace(/ё/g, 'е');
const tokens = (s) => (s.match(/\p{L}+(?:['’-]\p{L}+)*/gu) || []).map(norm);

/**
 * braille — строки Unicode-Брайля через \n (пробел между словами — обычный пробел);
 * scores — уверенность модели по клеткам: массив строк, в каждой — по одному числу на клетку.
 * Возвращает { braille, text, changes: [{ from, to }] }.
 */
export async function correctLocal({ braille, std, settings = {}, scores = [] }) {
  if (std !== 'ru' && std !== 'en') throw new Error('ru/en only');
  const [tr, dict] = await Promise.all([lineTranslator(std, settings), loadWords(std)]);
  const known = (w) => dict.has(w) || (std === 'ru' && dict.has(w.replace(/-.*/, '')));

  const changes = [];
  const outLines = (braille || '').split('\n').map((line, li) => {
    const conf = scores[li] || [];
    let cellIdx = 0;
    return line.split(' ').map((bw) => {
      const start = cellIdx;
      cellIdx += [...bw].length;
      if (!bw) return bw;

      const base = tr(bw);
      const toks = tokens(base);
      if (!toks.length || /\d/.test(base) || toks.every(known)) return bw;

      const cells = [...bw].map((c) => c.codePointAt(0) - 0x2800);
      // две и больше сомнительных клеток — вероятно, несколько ошибок: оставляем ИИ-агенту
      const doubtful = conf.slice(start, start + cells.length).filter((c) => c < 0.6).length;
      if (doubtful >= 2) return bw;
      let best = null;
      const consider = (cand, penalty, pos) => {
        const txt = tr(cand);
        const tk = tokens(txt);
        if (!tk.length || !tk.every(known)) return;
        // не дробим и не склеиваем слова и не добавляем знаков препинания внутри слова
        if (tk.length !== toks.length && !(toks.length === 1 && tk.length === 2 && /\s/.test(txt))) return;
        if (/[^\p{L}\s'’-]/u.test(txt.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))) return;
        if (/['’-]/.test(txt) && !/['’-]/.test(base)) return;
        if (/\\\d+\//.test(txt)) return;           // liblouis: клетка без значения (\45/)
        const c = conf[start + pos];
        // уверенно распознанную клетку меняем только ради очень частого слова (топ-10 тыс.)
        const common = tk.every((w) => (dict.get(w) ?? -99) > COMMON);
        if (c != null && c >= 0.75 && !common) return;
        const doubt = c == null ? 0 : (c < 0.5 ? 1.5 : c < 0.75 ? 0.5 : -0.5);
        const score = tk.reduce((s, w) => s + (dict.get(w) ?? dict.get(w.replace(/-.*/, '')) ?? -12), 0) / tk.length
          - penalty + doubt;
        if (!best || score > best.score) best = { cand, txt, score };
      };

      cells.forEach((m, i) => {
        for (let d = 0; d < 6; d++) {                       // одна точка добавлена / потеряна
          const m2 = m ^ (1 << d);
          if (!m2) continue;
          const arr = cells.slice();
          arr[i] = m2;
          consider(String.fromCharCode(...arr.map((x) => 0x2800 + x)), 0, i);
        }
        if (cells.length > 1) {                             // лишняя клетка
          const arr = cells.filter((_, k) => k !== i);
          consider(String.fromCharCode(...arr.map((x) => 0x2800 + x)), 1, i);
        }
      });

      if (!best) return bw;
      changes.push({ from: base, to: best.txt });
      return best.cand;
    }).join(' ');
  });

  const fixed = outLines.join('\n');
  return { braille: fixed, text: outLines.map(tr).join('\n'), changes };
}
