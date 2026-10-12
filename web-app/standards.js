// Стандарты Брайля и обратный перевод: Unicode-Брайль → текст.
// Русский и английский (UEB) — через liblouis (таблицы в vendor/liblouis/tables),
// китайский — свой декодер (zh.js), т.к. китайские таблицы liblouis работают только в прямую сторону.

import { translateChinese, loadDict, cellLabel as zhCellLabel } from './zh.js';
import { classLabel } from './braille.js';
import { t } from './i18n.js';

const LOUIS_BASE = 'vendor/liblouis/';
const LOUIS_FILES = [
  'unicode.dis', 'ru-unicode.dis', 'text_nabcc.dis', 'spaces.uti', 'braille-patterns.cti',
  'ru-litbrl-detailed.utb', 'ru-litbrl.ctb', 'ru-math.uti',
  'en-ueb-g1.ctb', 'en-ueb-g2.ctb', 'en-ueb-chardefs.uti', 'en-ueb-math.ctb',
  'latinLetterDef6Dots.uti', 'latinUppercaseComp6.uti', 'litdigits6Dots.uti', 'loweredDigits6Dots.uti',
  'IPA-unicode-range.uti',
];

export const STANDARDS = {
  ru: { id: 'ru', short: 'RU', speech: 'ru-RU', get label() { return t('std.ru.label'); }, get name() { return t('std.ru.name'); } },
  en: { id: 'en', short: 'EN', speech: 'en-US', get label() { return t('std.en.label'); }, get name() { return t('std.en.name'); } },
  zh: { id: 'zh', short: '中文', speech: 'zh-CN', get label() { return t('std.zh.label'); }, get name() { return t('std.zh.name'); } },
};

const TABLES = {
  ru: 'unicode.dis,ru-litbrl-detailed.utb',     // с указанием заглавных (⠘), как в датасете модели
  en_g1: 'unicode.dis,en-ueb-g1.ctb',
  en_g2: 'unicode.dis,en-ueb-g2.ctb',
};
const tablePath = (t) => t.split(',').map((f) => `/tables/${f}`).join(',');

/* ---------------- liblouis ---------------- */

let louisPromise = null;

export function loadLouis() {
  louisPromise ??= (async () => {
    if (!globalThis.liblouisBuild) await loadScript(LOUIS_BASE + 'liblouis.js');
    const M = globalThis.liblouisBuild;
    if (!M?.ccall) throw new Error(t('std.noLouis'));
    try { M.FS.mkdir('/tables'); } catch { /* уже есть */ }
    await Promise.all(LOUIS_FILES.map(async (f) => {
      const res = await fetch(LOUIS_BASE + 'tables/' + f);
      if (!res.ok) throw new Error(t('std.noTable', { f }));
      M.FS.writeFile('/tables/' + f, await res.text());
    }));
    M.ccall('lou_setLogLevel', 'void', ['number'], [40000]);   // только ошибки
    return M;
  })();
  louisPromise.catch(() => { louisPromise = null; });
  return louisPromise;
}

export const louisVersion = async () => (await loadLouis()).ccall('lou_version', 'string', [], []);

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(t('std.loadFail', { src })));
    document.head.append(s);
  });
}

/** Обратный перевод одной строки (сборка UTF-32: 4 байта на символ). */
export function backTranslate(M, table, str) {
  return louisCall(M, 'lou_backTranslateString', table, str);
}

function louisCall(M, fn, table, str) {
  const cps = [...str].map((c) => c.codePointAt(0));
  if (!cps.length) return '';
  const n = cps.length, cap = n * 8 + 64;
  const inp = M._malloc(n * 4), out = M._malloc(cap * 4), inLen = M._malloc(4), outLen = M._malloc(4);
  try {
    cps.forEach((c, i) => M.setValue(inp + i * 4, c, 'i32'));
    M.setValue(inLen, n, 'i32');
    M.setValue(outLen, cap, 'i32');
    const ok = M.ccall(fn, 'number',
      ['string', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
      [tablePath(table), inp, inLen, out, outLen, 0, 0, 0]);
    if (!ok) throw new Error(t('std.louisErr'));
    const m = M.getValue(outLen, 'i32');
    let s = '';
    for (let i = 0; i < m; i++) s += String.fromCodePoint(M.getValue(out + i * 4, 'i32') >>> 0);
    return s;
  } finally {
    [inp, out, inLen, outLen].forEach((p) => M._free(p));
  }
}

/* ---------------- Перевод ---------------- */

/**
 * braille — строки Unicode-Брайля (пробел между словами — обычный пробел), разделённые \n.
 * Возвращает { text, pinyin? , note? }.
 */
export async function translate(braille, std, settings = {}) {
  const lines = (braille || '').split('\n');

  if (std === 'zh') {
    const masks = lines.map((l) => [...l].map((c) => (c === ' ' ? -1 : c.codePointAt(0) - 0x2800)));
    let note = '';
    if (settings.zhHanzi !== false) {
      try { await loadDict(); } catch (e) { note = t('std.noDict'); }
    }
    const r = translateChinese(masks, settings.zhHanzi !== false);
    return { text: r.text, pinyin: r.pinyin, note };
  }

  const M = await loadLouis();
  const table = std === 'en' ? (settings.enGrade === 'g1' ? TABLES.en_g1 : TABLES.en_g2) : TABLES.ru;
  const text = lines
    .map((l) => backTranslate(M, table, l.replace(/ /g, '⠀')).replace(/\s+$/, ''))
    .join('\n');
  return { text };
}

/* ---------------- Подписи клеток на фото ---------------- */

let enLabels = null;
async function buildEnLabels() {
  if (enLabels) return enLabels;
  const M = await loadLouis();
  enLabels = {};
  for (let m = 1; m < 64; m++) {
    let t = '';
    try { t = backTranslate(M, TABLES.en_g1, String.fromCharCode(0x2800 + m)); } catch { /* пусто */ }
    enLabels[m] = /^[\p{L}\p{N}\p{P}]{1,2}$/u.test(t) ? t : String.fromCharCode(0x2800 + m);
  }
  return enLabels;
}

/** Функция «класс клетки → подпись» для выбранного стандарта. */
export async function labeler(std) {
  if (std === 'zh') return zhCellLabel;
  if (std === 'en') {
    try {
      const L = await buildEnLabels();
      return (m) => L[m] ?? String.fromCharCode(0x2800 + m);
    } catch { /* ниже — русские подписи */ }
  }
  return classLabel;
}

/**
 * Синхронный обратный перевод для русского/английского (для исправления по словарю:
 * тысячи вызовов на странице). Возвращает функцию «строка Unicode-Брайля → текст».
 */
export async function lineTranslator(std, settings = {}) {
  const M = await loadLouis();
  const table = std === 'en' ? (settings.enGrade === 'g1' ? TABLES.en_g1 : TABLES.en_g2) : TABLES.ru;
  return (braille) => backTranslate(M, table, braille.replace(/ /g, '⠀')).replace(/\s+$/, '');
}

/**
 * Прямой перевод: текст → Unicode-Брайль выбранного стандарта (русский или английский), построчно.
 * Пробелы между словами выводятся обычным пробелом, как в распознанной записи.
 */
export async function toBraille(text, std, settings = {}) {
  const M = await loadLouis();
  const table = std === 'en' ? (settings.enGrade === 'g1' ? TABLES.en_g1 : TABLES.en_g2) : TABLES.ru;
  return (text || '').split('\n')
    .map((l) => (l.trim() ? louisCall(M, 'lou_translateString', table, l) : '').replace(/⠀/g, ' ').replace(/\s+$/, ''))
    .join('\n');
}
