// Китайский Брайль (现行盲文, современная система) → пиньинь, затем подбор иероглифов по словарю.
// Слог = [согласная] + [гласная часть] + [тон]. Таблицы liblouis для китайского работают только
// в прямую сторону (иероглифы → Брайль), поэтому обратный перевод сделан здесь.
// Маска клетки: бит 0 = точка 1 … бит 5 = точка 6 (как у модели распознавания).

const d = (s) => [...String(s)].reduce((m, c) => m | (1 << (Number(c) - 1)), 0);

// Начальные согласные (声母). g/k/h перед i/ü читаются как j/q/x.
const INITIALS = {
  [d(12)]: 'b', [d(1234)]: 'p', [d(134)]: 'm', [d(124)]: 'f',
  [d(145)]: 'd', [d(2345)]: 't', [d(1345)]: 'n', [d(123)]: 'l',
  [d(1245)]: 'g', [d(13)]: 'k', [d(125)]: 'h',
  [d(34)]: 'zh', [d(12345)]: 'ch', [d(156)]: 'sh', [d(245)]: 'r',
  [d(1356)]: 'z', [d(14)]: 'c', [d(234)]: 's',
};

// Гласные части (韵母) в «полной» записи (iou, uei, uen); o/e — одна клетка.
const FINALS = {
  [d(35)]: 'a', [d(26)]: 'e', [d(24)]: 'i', [d(136)]: 'u', [d(346)]: 'ü', [d(1235)]: 'er',
  [d(246)]: 'ai', [d(235)]: 'ao', [d(2346)]: 'ei', [d(12356)]: 'ou',
  [d(1236)]: 'an', [d(356)]: 'en', [d(236)]: 'ang', [d(3456)]: 'eng', [d(256)]: 'ong',
  [d(1246)]: 'ia', [d(345)]: 'iao', [d(15)]: 'ie', [d(1256)]: 'iou', [d(146)]: 'ian',
  [d(126)]: 'in', [d(1346)]: 'iang', [d(16)]: 'ing', [d(1456)]: 'iong',
  [d(123456)]: 'ua', [d(135)]: 'uo', [d(13456)]: 'uai', [d(2456)]: 'uei', [d(12456)]: 'uan',
  [d(25)]: 'uen', [d(2356)]: 'uang',
  [d(23456)]: 'üe', [d(12346)]: 'üan', [d(456)]: 'ün',
};

const TONES = { [d(1)]: 1, [d(2)]: 2, [d(3)]: 3, [d(23)]: 4 };

// Знаки препинания (одна или две клетки)
const PUNCT2 = { [`${d(5)},${d(23)}`]: '。', [`${d(5)},${d(3)}`]: '？', [`${d(56)},${d(2)}`]: '！' };
const PUNCT1 = { [d(5)]: '，', [d(6)]: '、', [d(56)]: '；' };

const FRONT = /^(i|ü)/;           // гласные, перед которыми g/k/h → j/q/x
const RETRO = new Set(['zh', 'ch', 'sh', 'r', 'z', 'c', 's']);

/** Слог из согласной, гласной части и тона → { plain: 'zhong', marked: 'zhōng', tone } */
export function makeSyllable(ini, fin, tone) {
  let i = ini || '';
  let f = fin || '';
  if (!f) f = RETRO.has(i) ? 'i' : '';             // zhi chi shi ri zi ci si
  if (FRONT.test(f) && { g: 1, k: 1, h: 1 }[i]) i = { g: 'j', k: 'q', h: 'x' }[i];
  if ((f === 'e') && 'bpmf'.includes(i) && i) f = 'o';   // bo po mo fo

  let s;
  if (!i) {                                          // нулевая согласная: y/w
    s = {
      i: 'yi', ia: 'ya', iao: 'yao', ie: 'ye', iou: 'you', ian: 'yan', in: 'yin', iang: 'yang',
      ing: 'ying', iong: 'yong', u: 'wu', ua: 'wa', uo: 'wo', uai: 'wai', uei: 'wei', uan: 'wan',
      uen: 'wen', uang: 'wang', ü: 'yu', üe: 'yue', üan: 'yuan', ün: 'yun', ong: 'weng',
    }[f] ?? f;
  } else {
    f = { iou: 'iu', uei: 'ui', uen: 'un' }[f] ?? f;
    if ('jqx'.includes(i) && f.startsWith('ü')) f = 'u' + f.slice(1);  // ju qu xu
    s = i + f;
  }
  const plain = s.replace(/ü/g, 'v');
  return { plain, marked: tone ? markTone(s, tone) : s, tone: tone || 0 };
}

function markTone(s, tone) {
  const MARKS = { a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', ü: 'ǖǘǚǜ' };
  let idx = s.search(/[ae]/);
  if (idx < 0) idx = s.indexOf('ou');
  if (idx < 0) {                                     // последняя гласная (iu → u, ui → i)
    for (let k = s.length - 1; k >= 0; k--) if (MARKS[s[k]]) { idx = k; break; }
  }
  if (idx < 0) return s;
  return s.slice(0, idx) + MARKS[s[idx]][tone - 1] + s.slice(idx + 1);
}

/**
 * Разбор строки клеток (маски 0..63, пробел = -1 или 0) в токены:
 * { syl: {plain, marked, tone} } | { punct: '。' } | { space: true } | { unknown: mask }
 */
export function parseCells(masks) {
  const out = [];
  let i = 0;
  while (i < masks.length) {
    const m = masks[i];
    if (m <= 0) { out.push({ space: true }); i++; continue; }

    const p2 = PUNCT2[`${m},${masks[i + 1]}`];
    if (p2) { out.push({ punct: p2 }); i += 2; continue; }

    const ini = INITIALS[m];
    let fin = FINALS[m];
    let j = i;
    let iniName = null, finName = null;
    if (ini !== undefined) {
      iniName = ini; j++;
      if (FINALS[masks[j]] !== undefined) { finName = FINALS[masks[j]]; j++; }
    } else if (fin !== undefined) {
      finName = fin; j++;
    } else {
      const p1 = PUNCT1[m];
      out.push(p1 !== undefined ? { punct: p1 } : { unknown: m });
      i++;
      continue;
    }
    let tone = 0;
    if (TONES[masks[j]] !== undefined) { tone = TONES[masks[j]]; j++; }
    out.push({ syl: makeSyllable(iniName, finName, tone) });
    i = j;
  }
  return out;
}

/* ---------- Подбор иероглифов: словарь слов с частотами (jieba + pinyin-data) ---------- */

let dict = null;   // { "zhong guo": [["中国", logFreq, "zhōng guó"], ...] }
const LOG_TOTAL = 17.91;  // ln(сумма частот словаря jieba) — переводит ln f в ln P

let dictPromise = null;
export function loadDict(url = 'data/zh-dict.json.gz') {
  dictPromise ??= (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Словарь не найден: ${url}`);
    // Сервер может сам распаковать .gz (Content-Encoding) — проверяем сигнатуру gzip
    const buf = new Uint8Array(await res.arrayBuffer());
    const gz = buf[0] === 0x1f && buf[1] === 0x8b;
    const body = gz ? new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')) : buf;
    dict = await new Response(body).json();
    return dict;
  })();
  dictPromise.catch(() => { dictPromise = null; });
  return dictPromise;
}
export const setDict = (d) => { dict = d; };

/**
 * Динамика по цепочке слогов: делим на слова так, чтобы сумма логарифмов частот была максимальной.
 * Тоны (если есть) дают бонус совпадающим вариантам. Возвращает строку иероглифов.
 */
export function toHanzi(syls) {
  if (!dict || !syls.length) return null;
  const n = syls.length;
  const best = new Array(n + 1).fill(-Infinity);
  const back = new Array(n + 1);
  best[0] = 0;
  for (let i = 0; i < n; i++) {
    if (best[i] === -Infinity) continue;
    for (let L = 1; L <= Math.min(4, n - i); L++) {
      const key = syls.slice(i, i + L).map((s) => s.plain).join(' ');
      const cands = dict[key];
      if (!cands) continue;
      let pick = null, score = -Infinity;
      for (const [w, lf, py] of cands) {
        const tones = py.split(' ');
        let bonus = 0;
        for (let k = 0; k < L; k++) {
          const t = syls[i + k].tone;
          if (t) bonus += toneOf(tones[k]) === t ? 2 : -3;
        }
        const sc = lf - LOG_TOTAL + bonus;          // log P(слово): чем больше слов, тем больше штраф
        if (sc > score) { score = sc; pick = w; }
      }
      if (best[i] + score > best[i + L]) { best[i + L] = best[i] + score; back[i + L] = [i, pick]; }
    }
  }
  if (best[n] === -Infinity) return null;
  const words = [];
  for (let k = n; k > 0; k = back[k][0]) words.unshift(back[k][1]);
  return words.join('');
}

function toneOf(py) {
  const n = py.normalize('NFD');
  if (/̄/.test(n)) return 1;
  if (/́/.test(n)) return 2;
  if (/̌/.test(n)) return 3;
  if (/̀/.test(n)) return 4;
  return 0;
}

/**
 * Полный перевод строк китайского Брайля.
 * lines — массив строк, каждая — массив масок (-1 = пробел).
 * Возвращает { text: иероглифы (если есть словарь), pinyin }.
 */
export function translateChinese(lines, withHanzi = true) {
  const textLines = [], pyLines = [];
  for (const masks of lines) {
    const toks = parseCells(masks);
    let py = '', hz = '';
    let run = [];
    const flush = () => {
      if (!run.length) return;
      hz += (withHanzi ? toHanzi(run) : null) ?? run.map((s) => s.marked).join(' ');
      run = [];
    };
    for (const t of toks) {
      if (t.syl) { py += (py && !/\s$/.test(py) ? ' ' : '') + t.syl.marked; run.push(t.syl); }
      else if (t.space) { py += ' '; flush(); if (!withHanzi || !dict) hz += ' '; }
      else if (t.punct !== undefined) { py += t.punct; flush(); hz += t.punct; }
      else { const ch = String.fromCharCode(0x2800 + t.unknown); py += ch; flush(); hz += ch; }
    }
    flush();
    pyLines.push(py.replace(/\s+/g, ' ').trim());
    textLines.push(hz.trim());
  }
  return { text: textLines.join('\n'), pinyin: pyLines.join('\n') };
}

/** Подпись клетки на фото: согласная, гласная часть или тон (¹²³⁴). */
export function cellLabel(mask) {
  if (INITIALS[mask]) return INITIALS[mask];
  if (FINALS[mask]) return FINALS[mask];
  if (TONES[mask]) return '¹²³⁴'[TONES[mask] - 1];
  if (PUNCT1[mask]) return PUNCT1[mask];
  return String.fromCharCode(0x2800 + mask);
}
