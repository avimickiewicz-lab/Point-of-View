// Сервис-воркер: офлайн-кэш оболочки приложения (PWA)
const CACHE = 'pov-shell-v5';
const HEAVY = 'pov-heavy-v2';   // модель и ONNX Runtime: большие, меняются редко
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'braille.js', 'recognizer.js', 'standards.js', 'zh.js', 'i18n.js', 'agent.js', 'corrector.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== HEAVY).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Модель, ONNX Runtime, liblouis и словарь иероглифов: большие и меняются редко
const isHeavy = (url) => url.pathname.endsWith('.onnx') || url.hostname === 'cdn.jsdelivr.net' ||
  url.pathname.includes('/vendor/') || url.pathname.includes('/data/');

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // агент и чужие сайты (Hugging Face — у transformers.js свой кэш) — мимо сервис-воркера
  if (url.pathname.includes('/api/') || url.pathname.includes('/models/Xenova/')) return;
  if (url.origin !== location.origin && url.hostname !== 'cdn.jsdelivr.net') return;

  // Тяжёлые файлы: сначала кэш — скачиваются один раз
  if (isHeavy(url)) {
    e.respondWith(caches.open(HEAVY).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }

  // Остальное: сеть в приоритете (удобно при разработке), кэш — запасной вариант офлайн
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
