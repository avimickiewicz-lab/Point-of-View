// Point of view — камера → снимок → галерея → распознавание Брайля → исправление и перевод.
// Аналог MainActivity.kt (CameraX) на Web API: getUserMedia + canvas + IndexedDB + ONNX Runtime Web.

import { recognize } from './recognizer.js';
import { classLabel, brailleChar } from './braille.js';
import { STANDARDS, translate, labeler, louisVersion, toBraille } from './standards.js';
import { t, plural, fmt, setLang, detectLang } from './i18n.js';
import { correct, translateText, checkAgent, diffWords } from './agent.js';

/* ================= Настройки (хранятся на устройстве) ================= */

const SETTINGS_KEY = 'pov-settings';
const SETTINGS_VERSION = 2;
const DEFAULTS = {
  v: SETTINGS_VERSION,
  uiLang: detectLang(),
  defaultStd: 'ru', enGrade: 'g2', zhHanzi: true,
  fixMode: 'local',          // off | local (словарь на устройстве) | server
  trMode: 'local',           // off | local (Opus-MT на устройстве) | server
  autoFix: false,
  agentUrl: '', agentToken: '',
};
const settings = { ...DEFAULTS, ...readSettings() };

function readSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* нет хранилища */ }
  if (s.v !== SETTINGS_VERSION) {
    // v2: новые значения по умолчанию для исправления и перевода
    delete s.fixMode;
    delete s.trMode;
    s.v = SETTINGS_VERSION;
  }
  return s;
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* приватный режим */ }
}

setLang(settings.uiLang);

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
const AI_LANGS = ['ru', 'en'];          // исправление и перевод — для русского и английского

let stream = null;
let facingMode = 'environment';   // задняя камера по умолчанию (как CameraSelector.DEFAULT_BACK_CAMERA)
let torchOn = false;
let cameraErrorKey = null;        // текст ошибки камеры (ключ и параметры) — для смены языка
let cameraErrorParams = null;

/* ================= Камера ================= */

async function startCamera() {
  stopCamera();
  shutterBtn.disabled = true;

  if (!navigator.mediaDevices?.getUserMedia) {
    return showCameraState(window.isSecureContext ? 'cam.noSupport' : 'cam.insecure');
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
    return denied
      ? showCameraState('cam.denied')
      : showCameraState('cam.failed', { msg: err.message || err.name });
  }

  video.srcObject = stream;
  video.classList.toggle('mirror', facingMode === 'user');
  try { await video.play(); } catch { /* autoplay ждёт жеста — не критично */ }

  cameraState.hidden = true;
  cameraErrorKey = null;
  shutterBtn.disabled = false;
  setupTorch();
  updateSwitchVisibility();
}

function stopCamera() {
  stream?.getTracks().forEach((tr) => tr.stop());
  stream = null;
  torchOn = false;
}

function showCameraState(key, params) {
  cameraErrorKey = key;
  cameraErrorParams = params;
  cameraStateText.textContent = t(key, params);
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
    toast(t('cam.torchNA'));
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
    if (!w || !h) throw new Error(t('cam.notReady'));

    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);

    const blob = await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error(t('cam.imgFail')))), 'image/jpeg', JPEG_QUALITY));

    flash();
    navigator.vibrate?.(30);

    const photo = { name: makeFileName(), blob, createdAt: Date.now(), width: w, height: h };
    photo.id = await db.add(photo);       // внутренняя галерея приложения (для распознавания)
    await refreshThumb(true);

    // Сохранение на устройство (аналог MediaStore → Pictures/)
    if (isIOS) {
      toast(t('save.iosHint'));
    } else {
      downloadBlob(blob, photo.name);
      toast(t('save.done'));
    }

    openRecognize(photo);                 // автопереход в раздел «Распознать»
  } catch (err) {
    console.error('Photo capture failed', err);
    toast(t('cam.captureFail', { msg: err.message }));
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
    if (err.name !== 'AbortError') toast(t('save.shareFail'));
  }
  return true;
}

async function saveToDevice(photo) {
  if (isIOS && await shareBlob(photo.blob, photo.name)) return;
  downloadBlob(photo.blob, photo.name);
  toast(t('save.done'));
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
      const tr = d.transaction('photos', mode);
      const req = fn(tr.objectStore('photos'));
      tr.oncomplete = () => res(req?.result);
      tr.onerror = () => rej(tr.error);
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
let photoCount = 0;
async function refreshThumb(animate = false) {
  let photos = [];
  try { photos = await db.all(); } catch { /* приватный режим и т.п. */ }
  const last = photos.at(-1);
  photoCount = photos.length;

  if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  thumbUrl = last ? URL.createObjectURL(last.blob) : null;
  lastThumb.hidden = !last;
  galleryBtn.querySelector('.thumb-placeholder').toggleAttribute('hidden', !!last); // у SVG нет свойства .hidden
  if (last) lastThumb.src = thumbUrl;

  galleryCount.hidden = photos.length === 0;
  galleryCount.textContent = photos.length > 99 ? '99+' : photos.length;
  galleryBtn.setAttribute('aria-label', t('cam.galleryN', { n: photos.length }));

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
    b.setAttribute('aria-label', t('gal.item', { name: p.name }));
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    b.append(img);
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
  $('translateView').hidden = name !== 'translate';
  $('recControls').hidden = name !== 'recognize' && name !== 'translate';
  $('settings').hidden = name !== 'settings';
  if (name === 'settings') renderAbout();

  markMenu(name);
  stopSpeaking();
  if (isCam) startCamera(); else stopCamera();   // камера не держится включённой в других разделах
}

function markMenu(name) {
  document.querySelectorAll('.menu-item').forEach((m) => {
    const on = m.dataset.section === name;
    m.classList.toggle('active', on);
    if (on) m.setAttribute('aria-current', 'page'); else m.removeAttribute('aria-current');
  });
}

/* ================= Распознавание ================= */

let recPhoto = null;        // снимок, открытый в разделе «Распознать»
let recBitmap = null;       // его изображение для отрисовки
let recToken = 0;           // защита от устаревших результатов
let overlayMode = 'letters';
let recStd = settings.defaultStd;     // стандарт, в котором показан текущий снимок
let recView = null;                   // { std, text, pinyin, note } — текст после перевода из Брайля
let cellLabelFn = classLabel;         // подписи клеток на фото для текущего стандарта
let recDirty = false;                 // настройки изменились — перевести заново
let progressKey = null;               // текущая надпись прогресса (для смены языка)
const recCanvas = $('recCanvas');
const ROW_COLORS = ['#ffc83d', '#4fd1ff'];   // чередование цветов по строкам

async function openRecognize(photo) {
  setSection('recognize');
  const token = ++recToken;
  recPhoto = photo;
  recView = null;
  recStd = photo.result?.std || settings.defaultStd;
  markStd(recStd);
  $('recEmpty').hidden = true;
  $('recResult').hidden = false;
  renderText(null);
  renderAi();

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
  setProgress(t('rec.progress'));
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
    await renderResult(result, { fresh: true });
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

async function renderResult(r, { fresh = false } = {}) {
  hideProgress();
  drawOverlay();
  renderStatus();
  await applyStandard(recStd);
  // автоматическое исправление сразу после распознавания
  if (fresh && settings.autoFix && settings.fixMode !== 'off' && AI_LANGS.includes(recStd)) {
    runFix({ auto: true });
  }
}

function renderStatus() {
  const r = recPhoto?.result;
  if (!r) { $('recStatus').textContent = ''; return; }
  const n = r.cells.length;
  $('recStatus').textContent = n
    ? `${n} ${plural(n, 'rec.symbols')} · ${r.lines} ${plural(r.lines, 'rec.lines')} · ${fmt(r.ms / 1000)} ${t('rec.sec')}${r.backend ? ' · ' + r.backend : ''}`
    : t('rec.none');
}

/** Состояние ИИ для снимка и стандарта: { fix: {...}, tr: {...} } */
function aiState(create = false) {
  const r = recPhoto?.result;
  if (!r) return null;
  if (create) { r.ai ??= {}; r.ai[recStd] ??= {}; }
  return r.ai?.[recStd] || null;
}

/** Текст, который видит пользователь: исправленный (если принят) или исходный. */
function displayedText() {
  const fix = aiState()?.fix;
  return fix?.accepted ? fix.text : (recView?.text || '');
}

function renderText(view, r = recPhoto?.result) {
  const std = STANDARDS[recStd];
  const recText = $('recText');
  recText.lang = view?.text && view.pinyin && view.text === view.pinyin ? 'zh-Latn' : std.speech;

  const fix = aiState()?.fix;
  if (view && fix?.accepted && fix.base === view.text) {
    renderDiff(recText, view.text, fix.text);
    $('fixAppliedText').textContent = t('ai.fixedNote', { src: t(`ai.src.${fix.source}`) });
    $('fixAppliedNote').hidden = false;
  } else {
    recText.textContent = view ? (view.text || '') : '';
    $('fixAppliedNote').hidden = true;
  }
  $('recBraille').textContent = r ? (r.braille || '') : '';
  $('pinyinBlock').hidden = !(view?.pinyin && view.pinyin !== view.text);
  $('recPinyin').textContent = view?.pinyin || '';
  $('recNote').hidden = !view?.note;
  $('recNote').textContent = view?.note || '';
  if (r && !r.cells.length) recText.textContent = t('rec.notFound');
}

/** Текст с подсветкой изменённых слов. */
function renderDiff(el, oldText, newText) {
  el.replaceChildren(...diffWords(oldText, newText).map((p) => {
    if (!p.changed) return document.createTextNode(p.text);
    const m = document.createElement('mark');
    m.textContent = p.text;
    return m;
  }));
}

/* ---------- Стандарты Брайля: перевод без повторного запуска модели ---------- */

function markStd(std) {
  document.querySelectorAll('#stdSeg button').forEach((b) =>
    b.setAttribute('aria-checked', String(b.dataset.std === std)));
  $('stdName').textContent = STANDARDS[std].name;
}

async function applyStandard(std) {
  const r = recPhoto?.result;
  recStd = std;
  recDirty = false;
  markStd(std);
  renderAi();
  if (!r) return;

  const token = recToken;
  const card = document.querySelector('.rec-card');
  card.classList.add('rec-busy');
  let view;
  try {
    view = { std, ...(await translate(r.braille, std, settings)) };
  } catch (err) {
    console.error(err);
    view = std === 'ru'
      ? { std, text: r.text, note: t('rec.louisFallback') }
      : { std, text: '', note: t('rec.translateFail', { msg: err.message }) };
  }
  try { cellLabelFn = await labeler(std); } catch { cellLabelFn = classLabel; }
  card.classList.remove('rec-busy');
  if (token !== recToken || recPhoto?.result !== r || recStd !== std) return;

  recView = view;
  renderText(view, r);
  renderAi();
  drawOverlay();
  if (r.std !== std) {                     // запоминаем выбор для этого снимка
    r.std = std;
    db.put(recPhoto).catch(() => {});
  }
}

document.querySelectorAll('#stdSeg button').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.std === recStd && recView) return;
    stopSpeaking();
    applyStandard(b.dataset.std);
  });
});

function showRecEmpty() {
  recToken++;
  hideProgress();
  $('recResult').hidden = true;
  $('recEmpty').hidden = false;
  $('recStatus').textContent = '';
}

function announce(r) {
  if (!r.cells.length) return toast(t('rec.notFoundToast'));
  toast(t('rec.done', { n: r.cells.length, w: plural(r.cells.length, 'rec.symbols') }));
}

/* ---------- ИИ-агент: исправление и перевод (RU / EN) ---------- */

const otherLang = (std) => (std === 'ru' ? 'en' : 'ru');
let aiBusy = null;   // 'fix' | 'tr' | null

function renderAi() {
  const ok = AI_LANGS.includes(recStd) && !!recPhoto?.result?.cells?.length;
  $('aiRow').hidden = !ok;
  const to = otherLang(recStd);
  $('translateLabel').textContent = t('ai.translateTo', { lang: to.toUpperCase() });
  $('fixBtn').querySelector('span').textContent = aiBusy === 'fix' ? t('ai.fixing') : t('ai.fix');
  $('fixBtn').disabled = aiBusy === 'fix';

  const st = ok ? aiState() : null;
  const fix = st?.fix;
  const base = recView?.text || '';
  // блок предложенного исправления — пока пользователь не принял и не отклонил
  const pending = fix && !fix.accepted && !fix.dismissed && fix.base === base && fix.changes?.length;
  $('fixBlock').hidden = !pending;
  if (pending) {
    renderDiff($('fixText'), fix.base, fix.text);
    $('fixSource').textContent = `· ${t(`ai.src.${fix.source}`)}`;
    $('fixText').lang = STANDARDS[recStd].speech;
    $('fixNote').hidden = false;
    $('fixNote').textContent = t('ai.changes', { n: fix.changes.length });
  }
}

async function runFix({ auto = false } = {}) {
  if (!AI_LANGS.includes(recStd)) return toast(t('ai.onlyRuEn'));
  if (settings.fixMode === 'off') return toast(t('ai.off'));
  const r = recPhoto?.result;
  const base = recView?.text;
  if (!r || !base || aiBusy) return;
  const token = recToken, std = recStd;
  aiBusy = 'fix';
  renderAi();
  try {
    const res = await correct({ result: r, std, text: base, settings });
    if (token !== recToken || std !== recStd) return;
    const changed = res.text.trim() !== base.trim() && res.changes?.length;
    const st = aiState(true);
    st.fix = { ...res, base, accepted: auto && !!changed, dismissed: false, at: Date.now() };
    db.put(recPhoto).catch(() => {});
    if (!changed) toast(t('ai.noChanges'));
    else if (auto) toast(t('ai.changes', { n: res.changes.length }));
    renderText(recView, r);
  } catch (err) {
    console.error(err);
    toast(t('ai.fail', { msg: err.message }));
  } finally {
    aiBusy = null;
    renderAi();
  }
}

/* ---------- Окно «Перевод»: построчно, как оригинал, + Брайль целевого языка ---------- */

let trProgressText = '';

/** Ждёт, пока снимок распознан и текст переведён из Брайля (или выяснилось, что текста нет). */
function waitForText(timeoutMs = 180000) {
  const t0 = Date.now();
  return new Promise((res) => {
    const tick = () => {
      const r = recPhoto?.result;
      if ((r && (!r.cells.length || recView)) || !recPhoto || Date.now() - t0 > timeoutMs) return res();
      setTimeout(tick, 150);
    };
    tick();
  });
}

const trFresh = (tr) => tr && tr.base === displayedText();

function renderTranslateView() {
  const r = recPhoto?.result;
  const ready = r && recView && r.cells.length;
  const empty = !recPhoto || (r && !r.cells.length) ? t('tr.empty')
    : (ready && !AI_LANGS.includes(recStd) ? t('tr.onlyRuEn') : '');
  $('trEmpty').hidden = !empty;
  $('trEmpty').textContent = empty;
  $('trResult').hidden = !!empty;
  $('trRefresh').hidden = !!empty || !ready;
  if (empty) { $('trStatus').textContent = ''; return; }

  const from = recStd, to = otherLang(recStd);
  $('trStatus').textContent = t('tr.dir', { from: STANDARDS[from].label, to: STANDARDS[to].label });
  $('trSrcLang').textContent = `· ${STANDARDS[from].label}`;
  $('trOriginal').textContent = ready ? displayedText() : '';
  $('trOriginal').lang = STANDARDS[from].speech;

  const tr = ready ? aiState()?.tr : null;
  const ok = trFresh(tr);
  $('trTextTitle').textContent = t('tr.text', { lang: STANDARDS[to].label });
  $('trSource').textContent = ok ? `· ${t(`ai.src.${tr.source}`)}` : '';
  $('trText').textContent = ok ? tr.text : '';
  $('trText').lang = STANDARDS[to].speech;
  const grade = to === 'en' ? ` · ${settings.enGrade === 'g1' ? 'Grade 1' : 'Grade 2'}` : '';
  $('trBrailleTitle').textContent = t('tr.braille', { std: STANDARDS[to].name + grade });
  $('trBraille').textContent = ok ? (tr.braille || '') : '';

  const busy = aiBusy === 'tr' || !ready;
  $('trProgress').hidden = !busy;
  $('trProgressText').textContent = !ready ? t('rec.progress') : (trProgressText || t('ai.translating'));
  $('trRefresh').disabled = busy;

  // Брайль перевода пересчитываем, если сменился уровень английского
  if (ok && to === 'en' && tr.grade !== settings.enGrade) refreshTrBraille(tr);
}

async function refreshTrBraille(tr) {
  tr.grade = settings.enGrade;
  try {
    tr.braille = await toBraille(tr.text, tr.to, settings);
    db.put(recPhoto).catch(() => {});
  } catch (err) { console.error(err); }
  if (section === 'translate') renderTranslateView();
}

/** Открывает окно перевода для текущего (или последнего) снимка и переводит, если нужно. */
async function openTranslate({ force = false } = {}) {
  if (!recPhoto) {
    const last = (await db.all()).at(-1);
    if (last) openRecognize(last);           // распознавание идёт, пока открыто окно перевода
  }
  setSection('translate');
  renderTranslateView();
  if (!recPhoto) return;
  await waitForText();
  if (section !== 'translate') return;
  renderTranslateView();
  if (!recPhoto?.result?.cells?.length || !AI_LANGS.includes(recStd)) return;
  if (force || !trFresh(aiState()?.tr)) runTranslate();
}

async function runTranslate() {
  if (!AI_LANGS.includes(recStd)) return toast(t('ai.onlyRuEn'));
  if (settings.trMode === 'off') return toast(t('ai.off'));
  const text = displayedText();
  if (!text || aiBusy) return;
  const token = recToken, std = recStd, to = otherLang(std);
  aiBusy = 'tr';
  trProgressText = '';
  renderTranslateView();
  try {
    const res = await translateText({
      text, from: std, to, settings,
      onProgress: (p) => {
        if (token !== recToken) return;
        trProgressText = t('ai.mtLoading', { p: `${Math.round(p * 100)}%` });
        if (section === 'translate') $('trProgressText').textContent = trProgressText;
      },
    });
    if (token !== recToken || std !== recStd) return;
    const braille = await toBraille(res.text, to, settings).catch(() => '');
    aiState(true).tr = { ...res, to, base: text, braille, grade: settings.enGrade, at: Date.now() };
    db.put(recPhoto).catch(() => {});
  } catch (err) {
    console.error(err);
    toast(t('ai.fail', { msg: err.message }));
  } finally {
    aiBusy = null;
    trProgressText = '';
    if (section === 'translate') renderTranslateView();
  }
}

$('fixBtn').addEventListener('click', () => runFix());
$('translateBtn').addEventListener('click', () => openTranslate());
$('trRefresh').addEventListener('click', () => openTranslate({ force: true }));
$('fixApply').addEventListener('click', () => {
  const fix = aiState()?.fix;
  if (!fix) return;
  fix.accepted = true;
  db.put(recPhoto).catch(() => {});
  renderText(recView);
  renderAi();
  toast(t('ai.applied'));
});
$('fixDismiss').addEventListener('click', () => {
  const fix = aiState()?.fix;
  if (!fix) return;
  fix.dismissed = true;
  db.put(recPhoto).catch(() => {});
  renderAi();
});
$('fixUndo').addEventListener('click', () => {
  const fix = aiState()?.fix;
  if (!fix) return;
  fix.accepted = false;
  fix.dismissed = false;           // снова предлагаем исправление
  db.put(recPhoto).catch(() => {});
  renderText(recView);
  renderAi();
});

/* ---------- Фото с разметкой ---------- */

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

    const label = overlayMode === 'braille' ? brailleChar(cls) : cellLabelFn(cls);
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

document.querySelectorAll('#overlaySeg button').forEach((b) => {
  b.addEventListener('click', () => {
    overlayMode = b.dataset.mode;
    document.querySelectorAll('#overlaySeg button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    drawOverlay();
  });
});

$('recRetry').addEventListener('click', () => recPhoto && runRecognition(recPhoto, ++recToken));
$('newPhotoBtn').addEventListener('click', () => setSection('camera'));

/* ---------- Копирование и озвучивание ---------- */

async function copyText(text) {
  if (!text) return toast(t('rec.noText'));
  try {
    await navigator.clipboard.writeText(text);
    toast(t('rec.copied'));
  } catch {
    toast(t('rec.copyFail'));
  }
}

function stopSpeaking() {
  window.speechSynthesis?.cancel();
  $('speakBtn').setAttribute('aria-pressed', 'false');
}

function speak(text, lang) {
  if (!window.speechSynthesis) return toast(t('rec.ttsNA'));
  if (!text) return toast(t('rec.noText'));
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.onend = u.onerror = () => $('speakBtn').setAttribute('aria-pressed', 'false');
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  $('speakBtn').setAttribute('aria-pressed', 'true');
}

/** Текст и язык для кнопок «Копировать» / «Озвучить»: в окне перевода — перевод. */
function activeText() {
  const tr = aiState()?.tr;
  if (section === 'translate') return trFresh(tr) ? { text: tr.text, lang: STANDARDS[tr.to].speech } : { text: '' };
  return { text: displayedText(), lang: STANDARDS[recStd].speech };
}

$('copyBtn').addEventListener('click', () => copyText(activeText().text));
$('speakBtn').addEventListener('click', () => {
  if ($('speakBtn').getAttribute('aria-pressed') === 'true') return stopSpeaking();
  const { text, lang } = activeText();
  speak(text, lang);
});

/* ================= Раздел «Настройки» ================= */

function bindRadio(name, key, onChange) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((i) => {
    i.checked = i.value === settings[key];
    i.addEventListener('change', () => {
      settings[key] = i.value;
      saveSettings();
      onChange?.(i.value);
    });
  });
}

function bindCheckbox(id, key, onChange) {
  const el = $(id);
  el.checked = !!settings[key];
  el.addEventListener('change', () => {
    settings[key] = el.checked;
    saveSettings();
    onChange?.(el.checked);
  });
}

function initSettingsForm() {
  bindRadio('uiLang', 'uiLang', (l) => applyUiLang(l));
  bindRadio('defStd', 'defaultStd', (v) => toast(t('set.defToast', { std: STANDARDS[v].label })));
  bindRadio('enGrade', 'enGrade', () => { recDirty = true; });
  bindRadio('fixMode', 'fixMode');
  bindRadio('trMode', 'trMode');
  bindCheckbox('zhHanzi', 'zhHanzi', () => { recDirty = true; });
  bindCheckbox('autoFix', 'autoFix');

  for (const [id, key] of [['agentUrl', 'agentUrl'], ['agentToken', 'agentToken']]) {
    const el = $(id);
    el.value = settings[key] || '';
    el.addEventListener('change', () => { settings[key] = el.value.trim(); saveSettings(); });
  }
  $('agentCheck').addEventListener('click', async () => {
    const st = $('agentStatus');
    st.className = 'set-status';
    st.textContent = t('set.checking');
    try {
      const h = await checkAgent(settings);
      st.textContent = h.ok
        ? t('set.agentOk', { provider: h.provider, model: h.model })
        : t('set.agentNoKey', { msg: h.error });
      st.classList.add(h.ok ? 'ok' : 'warn');
    } catch (err) {
      st.textContent = err.message;
      st.classList.add('warn');
    }
  });
}

let louisVer = '';
async function renderAbout() {
  $('aboutText').textContent = t('set.about', { v: louisVer || '' }).replace('  ', ' ');
  if (louisVer) return;
  try {
    louisVer = await louisVersion();
    $('aboutText').textContent = t('set.about', { v: louisVer });
  } catch { /* liblouis ещё не загружен */ }
}

/** Смена языка интерфейса: разметка + все тексты, собранные в коде. */
function applyUiLang(l) {
  setLang(l);
  if (cameraErrorKey) cameraStateText.textContent = t(cameraErrorKey, cameraErrorParams);
  galleryBtn.setAttribute('aria-label', t('cam.galleryN', { n: photoCount }));
  markStd(recStd);
  renderStatus();
  renderAi();
  if (recView) {
    // заметки, сформированные переводчиком Брайля, пересоздаём на новом языке
    if (recView.note) applyStandard(recStd); else renderText(recView);
  }
  if (section === 'settings') renderAbout();
  if (section === 'translate') renderTranslateView();
  $('agentStatus').textContent = '';
}

initSettingsForm();
markStd(recStd);

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
  toast(t('view.deleted'));
});

/** Открывает «Распознать» с текущим или последним снимком. */
async function showRecognizeSection() {
  if (recPhoto) {
    setSection('recognize');
    if (recDirty && recPhoto.result) await applyStandard(recStd);
    return true;
  }
  const last = (await db.all()).at(-1);
  if (last) { await openRecognize(last); return true; }
  setSection('recognize');
  showRecEmpty();
  return false;
}

// Меню приложения
document.querySelectorAll('.menu-item').forEach((item) => {
  item.addEventListener('click', async () => {
    const name = item.dataset.section;
    if (item.dataset.soon !== undefined) return toast(t('menu.soon', { name: item.textContent.trim() }));
    if (name === 'camera') return setSection('camera');
    if (name === 'settings') return setSection('settings');
    if (name === 'recognize') return showRecognizeSection();
    if (name === 'translate') return openTranslate();
  });
});

// Клавиши: пробел — снимок, Esc — закрыть окна
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('viewer').hidden) closeViewer();
    else if (!$('gallery').hidden) closeGallery();
    else if (section !== 'camera') setSection('camera');
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
