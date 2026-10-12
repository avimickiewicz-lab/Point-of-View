// Point of view — веб-макет: камера → снимок → сохранение в галерею → распознавание Брайля.
// Аналог MainActivity.kt (CameraX) на Web API: getUserMedia + canvas + IndexedDB + ONNX Runtime Web.

import { recognize } from './recognizer.js';
import { classLabel, brailleChar } from './braille.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const shutterBtn = $('shutterBtn');
const switchBtn = $('switchBtn');
const torchBtn = $('torchBtn');
const galleryBtn = $('galleryBtn');
const lastThumb = $('lastThumb');
const galleryCount = $('galleryCount');
const cameraState = $('cameraState');
const cameraStateText = $('cameraStateText');

const FILE_PREFIX = 'POV_';
const JPEG_QUALITY = 0.92;
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let stream = null;
let facingMode = 'environment';   // задняя камера по умолчанию (как CameraSelector.DEFAULT_BACK_CAMERA)
let torchOn = false;

/* ================= Камера ================= */

async function startCamera() {
  stopCamera();
  shutterBtn.disabled = true;

  if (!navigator.mediaDevices?.getUserMedia) {
    return showCameraState(
      window.isSecureContext
        ? 'Браузер не поддерживает доступ к камере.'
        : 'Камера доступна только по HTTPS или на localhost. Откройте приложение по защищённому адресу.'
    );
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
    });
  } catch (err) {
    console.error(err);
    const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
    return showCameraState(denied
      ? 'Доступ к камере запрещён. Разрешите его в настройках браузера и нажмите кнопку ниже.'
      : `Не удалось запустить камеру: ${err.message || err.name}`);
  }

  video.srcObject = stream;
  video.classList.toggle('mirror', facingMode === 'user');
  try { await video.play(); } catch { /* autoplay ждёт жеста — не критично */ }

  cameraState.hidden = true;
  shutterBtn.disabled = false;
  setupTorch();
  updateSwitchVisibility();
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  torchOn = false;
}

function showCameraState(text) {
  cameraStateText.textContent = text;
  cameraState.hidden = false;
  shutterBtn.disabled = true;
}

function setupTorch() {
  const track = stream?.getVideoTracks()[0];
  const caps = track?.getCapabilities?.() || {};
  torchBtn.hidden = !caps.torch;
  torchBtn.setAttribute('aria-pressed', 'false');
}

async function toggleTorch() {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  try {
    torchOn = !torchOn;
    await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    torchBtn.setAttribute('aria-pressed', String(torchOn));
  } catch {
    torchOn = false;
    toast('Фонарик недоступен');
  }
}

async function updateSwitchVisibility() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    switchBtn.hidden = devices.filter((d) => d.kind === 'videoinput').length < 2;
  } catch { /* оставляем кнопку видимой */ }
}

/* ================= Съёмка ================= */

async function takePhoto() {
  if (!stream || shutterBtn.disabled) return;
  shutterBtn.disabled = true;
  shutterBtn.classList.add('busy');

  try {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) throw new Error('Камера ещё не готова');

    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);

    const blob = await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('Не удалось создать изображение'))),
        'image/jpeg', JPEG_QUALITY));

    flash();
    navigator.vibrate?.(30);

    const photo = { name: makeFileName(), blob, createdAt: Date.now(), width: w, height: h };
    photo.id = await db.add(photo);       // внутренняя галерея приложения (для распознавания)
    await refreshThumb(true);

    // Сохранение на устройство (аналог MediaStore → Pictures/)
    if (isIOS) {
      toast('Снимок сохранён. Откройте его и нажмите «Сохранить в галерею»');
    } else {
      downloadBlob(blob, photo.name);
      toast('Снимок сохранён в галерею');
    }

    openRecognize(photo);                 // автопереход в раздел «Распознать»
  } catch (err) {
    console.error('Photo capture failed', err);
    toast(`Ошибка съёмки: ${err.message}`);
  } finally {
    shutterBtn.classList.remove('busy');
    shutterBtn.disabled = !stream || section !== 'camera';
  }
}

function makeFileName() {
  // Формат как в FILENAME_FORMAT Android-версии: yyyy-MM-dd-HH-mm-ss-SSS
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${FILE_PREFIX}${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-` +
    `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}.jpg`;
}

function flash() {
  const el = $('flash');
  el.classList.remove('go');
  void el.offsetWidth;
  el.classList.add('go');
}

/* ================= Сохранение на устройство ================= */

function downloadBlob(blob, name) {
  // Android: файл попадает в «Загрузки» и виден в Галерее / Google Фото
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function shareBlob(blob, name) {
  // iOS: в меню «Поделиться» выбрать «Сохранить изображение» → Фото
  const file = new File([blob], name, { type: 'image/jpeg' });
  if (!navigator.canShare?.({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title: name });
  } catch (err) {
    if (err.name !== 'AbortError') toast('Не удалось открыть меню «Поделиться»');
  }
  return true;
}

async function saveToDevice(photo) {
  if (isIOS && await shareBlob(photo.blob, photo.name)) return;
  downloadBlob(photo.blob, photo.name);
  toast('Снимок сохранён в галерею');
}

/* ================= Внутренняя галерея (IndexedDB) ================= */

const db = (() => {
  let dbp;
  const open = () => (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('pov-gallery', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction('photos', mode);
      const req = fn(t.objectStore('photos'));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    add: (p) => tx('readwrite', (s) => s.add(p)),
    put: (p) => tx('readwrite', (s) => s.put(p)),
    all: () => tx('readonly', (s) => s.getAll()),
    get: (id) => tx('readonly', (s) => s.get(id)),
    remove: (id) => tx('readwrite', (s) => s.delete(id)),
  };
})();

let thumbUrl = null;
async function refreshThumb(animate = false) {
  let photos = [];
  try { photos = await db.all(); } catch { /* приватный режим и т.п. */ }
  const last = photos.at(-1);

  if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  thumbUrl = last ? URL.createObjectURL(last.blob) : null;
  lastThumb.hidden = !last;
  galleryBtn.querySelector('.thumb-placeholder').toggleAttribute('hidden', !!last); // у SVG нет свойства .hidden
  if (last) lastThumb.src = thumbUrl;

  galleryCount.hidden = photos.length === 0;
  galleryCount.textContent = photos.length > 99 ? '99+' : photos.length;
  galleryBtn.setAttribute('aria-label', `Открыть галерею снимков, ${photos.length}`);

  if (animate) {
    galleryBtn.classList.remove('pop');
    void galleryBtn.offsetWidth;
    galleryBtn.classList.add('pop');
  }
}

let gridUrls = [];
async function openGallery() {
  const photos = (await db.all()).reverse();
  gridUrls.forEach(URL.revokeObjectURL);
  gridUrls = [];

  const grid = $('galleryGrid');
  grid.replaceChildren(...photos.map((p) => {
    const url = URL.createObjectURL(p.blob);
    gridUrls.push(url);
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Снимок ${p.name}`);
    b.innerHTML = `<img src="${url}" alt="" loading="lazy">`;
    b.onclick = () => openViewer(p.id);
    li.append(b);
    return li;
  }));
  $('toast').classList.remove('show');
  $('galleryEmpty').hidden = photos.length > 0;
  $('gallery').hidden = false;
  $('galleryClose').focus();
}

function closeGallery() {
  $('gallery').hidden = true;
  galleryBtn.focus();
}

let current = null;
let viewerUrl = null;
async function openViewer(id) {
  current = await db.get(id);
  if (!current) return;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(current.blob);
  $('viewerImg').src = viewerUrl;
  $('viewerName').textContent = current.name;
  $('shareBtn').hidden = !navigator.canShare || isIOS; // на iOS «Сохранить» и так открывает меню
  $('viewer').hidden = false;
  $('viewerClose').focus();
}

function closeViewer() {
  $('viewer').hidden = true;
  current = null;
}

/* ================= Разделы ================= */

let section = 'camera';

function setSection(name) {
  if (section === name) return;
  section = name;
  const isCam = name === 'camera';
  $('cameraControls').hidden = !isCam;
  document.querySelector('.viewfinder').hidden = !isCam;
  $('recognize').hidden = name !== 'recognize';
  $('recControls').hidden = name !== 'recognize';

  document.querySelectorAll('.menu-item').forEach((m) => {
    const on = m.dataset.section === name;
    m.classList.toggle('active', on);
    if (on) m.setAttribute('aria-current', 'page'); else m.removeAttribute('aria-current');
  });

  stopSpeaking();
  if (isCam) startCamera(); else stopCamera();   // камера не держится включённой в других разделах
}

/* ================= Распознавание ================= */

let recPhoto = null;        // снимок, открытый в разделе «Распознать»
let recBitmap = null;       // его изображение для отрисовки
let recToken = 0;           // защита от устаревших результатов
let overlayMode = 'letters';
const recCanvas = $('recCanvas');
const ROW_COLORS = ['#ffc83d', '#4fd1ff'];   // чередование цветов по строкам

async function openRecognize(photo) {
  setSection('recognize');
  const token = ++recToken;
  recPhoto = photo;
  $('recEmpty').hidden = true;
  $('recResult').hidden = false;
  renderText(null);

  recBitmap?.close?.();
  recBitmap = await createImageBitmap(photo.blob);
  if (token !== recToken) return;
  drawOverlay();

  if (photo.result) {                      // уже распознан ранее
    renderResult(photo.result);
    return;
  }
  runRecognition(photo, token);
}

async function runRecognition(photo, token) {
  setProgress('Распознавание…');
  $('recStatus').textContent = '';
  try {
    const result = await recognize(photo.blob, (p, label) => {
      if (token !== recToken) return;
      setProgress(p == null ? `${label}…` : `${label}… ${Math.round(p * 100)}%`);
    });
    if (token !== recToken) return;
    result.at = Date.now();
    photo.result = result;
    db.put(photo).catch(() => {});         // сохраняем результат вместе со снимком
    renderResult(result);
    announce(result);
  } catch (err) {
    console.error(err);
    if (token !== recToken) return;
    setProgress(err.message || String(err), true);
  }
}

function setProgress(text, isError = false) {
  const box = $('recProgress');
  box.hidden = false;
  box.classList.toggle('error', isError);
  $('recProgressText').textContent = text;
  $('recRetry').hidden = !isError;
  document.querySelector('[data-section="recognize"]').classList.toggle('busy', !isError);
}

function hideProgress() {
  $('recProgress').hidden = true;
  document.querySelector('[data-section="recognize"]').classList.remove('busy');
}

function renderResult(r) {
  hideProgress();
  drawOverlay();
  renderText(r);
  const n = r.cells.length;
  $('recStatus').textContent = n
    ? `${n} ${plural(n, 'символ', 'символа', 'символов')} · ${r.lines} ${plural(r.lines, 'строка', 'строки', 'строк')} · ${(r.ms / 1000).toFixed(1).replace('.', ',')} с${r.backend ? ' · ' + r.backend : ''}`
    : 'Символы не найдены';
}

function renderText(r) {
  $('recText').textContent = r ? (r.text || '') : '';
  $('recBraille').textContent = r ? (r.braille || '') : '';
  if (r && !r.cells.length) $('recText').textContent = 'Брайль не найден. Снимите страницу ближе, ровно и при боковом освещении.';
}

function showRecEmpty() {
  recToken++;
  hideProgress();
  $('recResult').hidden = true;
  $('recEmpty').hidden = false;
  $('recStatus').textContent = '';
}

function announce(r) {
  if (!r.cells.length) return toast('Брайль не найден на снимке');
  toast(`Распознано: ${r.cells.length} ${plural(r.cells.length, 'символ', 'символа', 'символов')}`);
}

/** Фото + рамки распознанных ячеек с подписями. */
function drawOverlay() {
  if (!recBitmap) return;
  const MAX = 2000;
  const k = Math.min(1, MAX / Math.max(recBitmap.width, recBitmap.height));
  const W = Math.round(recBitmap.width * k), H = Math.round(recBitmap.height * k);
  recCanvas.width = W;
  recCanvas.height = H;
  const ctx = recCanvas.getContext('2d');
  ctx.drawImage(recBitmap, 0, 0, W, H);

  const cells = recPhoto?.result?.cells;
  if (!cells?.length || overlayMode === 'none') return;

  ctx.lineWidth = Math.max(1.5, W / 700);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [x1, y1, x2, y2, cls, , line] of cells) {
    const x = x1 * k, y = y1 * k, w = (x2 - x1) * k, h = (y2 - y1) * k;
    const color = ROW_COLORS[line % 2];
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, w, h);
    if (overlayMode === 'boxes') continue;

    const label = overlayMode === 'braille' ? brailleChar(cls) : classLabel(cls);
    const fs = Math.max(10, Math.min(w * 0.95, h * 0.6));
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    const tw = Math.max(ctx.measureText(label).width + fs * 0.3, fs * 0.9);
    const ly = y - fs * 0.55;                  // подпись над ячейкой
    ctx.fillStyle = 'rgba(11,13,16,.78)';
    ctx.fillRect(x + w / 2 - tw / 2, ly - fs * 0.55, tw, fs * 1.1);
    ctx.fillStyle = color;
    ctx.fillText(label, x + w / 2, ly);
  }
}

document.querySelectorAll('.seg button').forEach((b) => {
  b.addEventListener('click', () => {
    overlayMode = b.dataset.mode;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    drawOverlay();
  });
});

$('recRetry').addEventListener('click', () => recPhoto && runRecognition(recPhoto, ++recToken));
$('newPhotoBtn').addEventListener('click', () => setSection('camera'));

$('copyBtn').addEventListener('click', async () => {
  const t = recPhoto?.result?.text;
  if (!t) return toast('Нет текста для копирования');
  try {
    await navigator.clipboard.writeText(t);
    toast('Текст скопирован');
  } catch {
    toast('Не удалось скопировать');
  }
});

function stopSpeaking() {
  window.speechSynthesis?.cancel();
  $('speakBtn').setAttribute('aria-pressed', 'false');
}

$('speakBtn').addEventListener('click', () => {
  const t = recPhoto?.result?.text;
  if (!window.speechSynthesis) return toast('Озвучивание не поддерживается');
  if ($('speakBtn').getAttribute('aria-pressed') === 'true') return stopSpeaking();
  if (!t) return toast('Нет текста для озвучивания');
  const u = new SpeechSynthesisUtterance(t);
  u.lang = 'ru-RU';
  u.onend = u.onerror = () => $('speakBtn').setAttribute('aria-pressed', 'false');
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  $('speakBtn').setAttribute('aria-pressed', 'true');
});

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* ================= Уведомления ================= */

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ================= События ================= */

shutterBtn.addEventListener('click', takePhoto);
switchBtn.addEventListener('click', () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  startCamera();
});
torchBtn.addEventListener('click', toggleTorch);
$('retryBtn').addEventListener('click', startCamera);

galleryBtn.addEventListener('click', openGallery);
$('galleryClose').addEventListener('click', closeGallery);
$('viewerClose').addEventListener('click', closeViewer);
$('saveBtn').addEventListener('click', () => current && saveToDevice(current));
$('recognizeBtn').addEventListener('click', () => {
  if (!current) return;
  const p = current;
  closeViewer();
  closeGallery();
  openRecognize(p);
});
$('shareBtn').addEventListener('click', () => current && shareBlob(current.blob, current.name));
$('deleteBtn').addEventListener('click', async () => {
  if (!current) return;
  await db.remove(current.id);
  if (recPhoto?.id === current.id) { recPhoto = null; showRecEmpty(); }
  closeViewer();
  await refreshThumb();
  if (!$('gallery').hidden) openGallery();
  toast('Снимок удалён из приложения');
});

// Меню приложения
document.querySelectorAll('.menu-item').forEach((item) => {
  item.addEventListener('click', async () => {
    const name = item.dataset.section;
    if (item.dataset.soon !== undefined) return toast(`Раздел «${item.textContent.trim()}» в разработке`);
    if (name === 'camera') return setSection('camera');
    if (name === 'recognize') {
      if (recPhoto) return setSection('recognize');
      const last = (await db.all()).at(-1);
      return last ? openRecognize(last) : (setSection('recognize'), showRecEmpty());
    }
  });
});

// Клавиши: пробел/Enter — снимок, Esc — закрыть окна
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('viewer').hidden) closeViewer();
    else if (!$('gallery').hidden) closeGallery();
    else if (section === 'recognize') setSection('camera');
  }
  if ((e.key === ' ' || e.key === 'VolumeUp') && $('viewer').hidden && $('gallery').hidden &&
      section === 'camera' &&
      document.activeElement === document.body) {
    e.preventDefault();
    takePhoto();
  }
});

// Освобождаем камеру в фоне, перезапускаем при возврате
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else if (section === 'camera') startCamera();
});

/* ================= Старт ================= */

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
refreshThumb();
startCamera();
