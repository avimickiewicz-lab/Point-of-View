// Распознавание Брайля: подготовка изображения, разбор выхода YOLO26 (ONNX) и сборка текста.
// Модель: braile.onnx (Ultralytics YOLO26m, датасет Angelina), вход [1,3,640,640], выход [1,68,8400].
// Номер класса = битовая маска точек ячейки (бит 0 = точка 1 … бит 5 = точка 6),
// поэтому символ Unicode Брайля для класса k — это U+2800 + k.

export const INPUT_SIZE = 640;
export const NUM_CLASSES = 64;

// Имена классов из метаданных модели (класс 1 «a» латинская → русская «а»).
// Числовые имена — шаблоны без русской буквы, для них выводится сам символ Брайля.
export const CLASS_NAMES = {
  0: '0', 1: 'а', 2: ',', 3: 'б', 4: '4', 5: 'к', 6: '6', 7: 'л', 8: "'", 9: 'ц', 10: 'и', 11: 'ф',
  12: '12', 13: 'м', 14: 'с', 15: 'п', 16: '16', 17: 'е', 18: '18', 19: 'х', 20: '20', 21: 'о',
  22: '!', 23: 'р', 24: 'CC', 25: 'д', 26: 'ж', 27: 'г', 28: '28', 29: 'н', 30: 'т', 31: 'ч',
  32: '32', 33: 'ё', 34: '34', 35: '35', 36: '-', 37: 'у', 38: '«', 39: '39', 40: '40', 41: '41',
  42: 'э', 43: 'я', 44: '§', 45: 'щ', 46: 'ы', 47: 'й', 48: '48', 49: 'ш', 50: '.', 51: 'ю',
  52: '»', 53: 'з', 54: '54', 55: 'ъ', 56: '|', 57: '57', 58: 'в', 59: '59', 60: 'NB', 61: '61',
  62: 'ь', 63: '63',
};

export const CAPITAL_SIGN = 24; // ⠘ точки 4-5 — следующая буква заглавная
export const NUMBER_SIGN = 60;  // ⠼ точки 3-4-5-6 — дальше цифры

// После цифрового знака буквы а…ж (шаблоны a–j) читаются как цифры 1…0
const DIGITS = { 1: '1', 3: '2', 9: '3', 25: '4', 17: '5', 11: '6', 27: '7', 19: '8', 10: '9', 26: '0' };

export const brailleChar = (mask) => String.fromCharCode(0x2800 + mask);

/** Короткая подпись класса для наложения на фото. */
export function classLabel(cls) {
  if (cls === CAPITAL_SIGN) return '⇧';
  if (cls === NUMBER_SIGN) return '#';
  const n = CLASS_NAMES[cls];
  return /^\d+$/.test(n) ? brailleChar(cls) : n;
}

/**
 * Letterbox 640×640 (серые поля 114, как в Ultralytics) → Float32Array CHW, RGB 0..1.
 * source — ImageBitmap / HTMLImageElement / HTMLCanvasElement.
 */
export function preprocess(source, size = INPUT_SIZE) {
  const w = source.width, h = source.height;
  const scale = Math.min(size / w, size / h);
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const padX = Math.floor((size - nw) / 2), padY = Math.floor((size - nh) / 2);

  const c = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, padX, padY, nw, nh);

  const px = ctx.getImageData(0, 0, size, size).data;
  const area = size * size;
  const data = new Float32Array(3 * area);
  for (let i = 0, p = 0; i < area; i++, p += 4) {
    data[i] = px[p] / 255;
    data[i + area] = px[p + 1] / 255;
    data[i + 2 * area] = px[p + 2] / 255;
  }
  return { data, dims: [1, 3, size, size], scale, padX, padY, width: w, height: h };
}

/**
 * Разбор выхода [1, 4+C, N]: рамки cx,cy,w,h (в пикселях 640) + оценки классов (уже после sigmoid).
 * Возвращает рамки в координатах исходного изображения после NMS.
 */
export function decode(output, meta, { confThreshold = 0.2, iouThreshold = 0.45, numClasses = NUM_CLASSES } = {}) {
  const n = output.length / (4 + numClasses);
  const cand = [];
  for (let i = 0; i < n; i++) {
    let best = 0, cls = -1;
    for (let c = 0; c < numClasses; c++) {
      const s = output[(4 + c) * n + i];
      if (s > best) { best = s; cls = c; }
    }
    if (best < confThreshold) continue;
    const cx = (output[i] - meta.padX) / meta.scale;
    const cy = (output[n + i] - meta.padY) / meta.scale;
    const w = output[2 * n + i] / meta.scale;
    const h = output[3 * n + i] / meta.scale;
    cand.push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, cx, cy, w, h, score: best, cls });
  }
  cand.sort((a, b) => b.score - a.score);

  // NMS без учёта класса: одна ячейка — один символ
  const keep = [];
  for (const d of cand) {
    let ok = true;
    for (const k of keep) {
      if (iou(d, k) > iouThreshold) { ok = false; break; }
    }
    if (ok) keep.push(d);
  }
  return keep;
}

function iou(a, b) {
  const iw = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const ih = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = iw * ih;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/**
 * Группировка ячеек в строки и вставка пробелов по расстоянию между ячейками.
 * Возвращает массив строк; каждая строка — массив элементов { cls, det } или { space: true }.
 */
export function toLines(dets) {
  if (!dets.length) return [];
  const medH = median(dets.map((d) => d.h));

  // строки: идём сверху вниз, ячейка относится к строке, если центр близок к её средней линии
  const sorted = [...dets].sort((a, b) => a.cy - b.cy);
  const rows = [];
  for (const d of sorted) {
    let row = null, bestDist = Infinity;
    for (const r of rows.slice(-3)) {
      const dist = Math.abs(r.cy - d.cy);
      if (dist < medH * 0.5 && dist < bestDist) { row = r; bestDist = dist; }
    }
    if (!row) { row = { cy: d.cy, cells: [] }; rows.push(row); }
    row.cells.push(d);
    row.cy += (d.cy - row.cy) / row.cells.length;
  }
  rows.sort((a, b) => a.cy - b.cy);
  rows.forEach((r) => r.cells.sort((a, b) => a.cx - b.cx));

  // шаг ячеек — медиана расстояний между соседями (пробелов заметно меньше, чем букв)
  const gaps = rows.flatMap((r) => r.cells.slice(1).map((d, i) => d.cx - r.cells[i].cx));
  const pitch = median(gaps) || median(dets.map((d) => d.w)) * 1.4;

  return rows.map((r) => {
    const out = [];
    r.cells.forEach((d, i) => {
      if (i > 0 && d.cx - r.cells[i - 1].cx > pitch * 1.5) out.push({ space: true });
      out.push({ cls: d.cls, det: d });
    });
    return out;
  });
}

/**
 * Перевод строк ячеек в текст по правилам русского Брайля
 * (знак заглавной буквы, цифровой знак). Возвращает русский текст и запись Unicode Брайлем.
 */
export function toText(lines) {
  const textLines = [];
  const brailleLines = [];
  for (const line of lines) {
    let text = '', braille = '';
    let numberMode = false, capital = false;
    for (const item of line) {
      if (item.space) {
        text += ' '; braille += ' ';
        numberMode = false; capital = false;
        continue;
      }
      const m = item.cls;
      braille += brailleChar(m);
      if (m === NUMBER_SIGN) { numberMode = true; continue; }
      if (m === CAPITAL_SIGN) { capital = true; continue; }
      if (numberMode && DIGITS[m] !== undefined) { text += DIGITS[m]; continue; }
      numberMode = false;
      const name = CLASS_NAMES[m];
      let ch = /^\d+$/.test(name) ? brailleChar(m) : name;
      if (capital) { ch = ch.toUpperCase(); capital = false; }
      text += ch;
    }
    textLines.push(text.trimEnd());
    brailleLines.push(braille.trimEnd());
  }
  return { text: textLines.join('\n'), braille: brailleLines.join('\n') };
}

/** Полный разбор: выход модели → ячейки, строки, текст. */
export function postprocess(output, meta, opts) {
  const detections = decode(output, meta, opts);
  const lines = toLines(detections);
  return { detections, lines, ...toText(lines) };
}
