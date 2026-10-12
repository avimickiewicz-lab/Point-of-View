// Сервис-воркер: офлайн-кэш оболочки приложения (PWA)
const CACHE = 'pov-shell-v2';
const HEAVY = 'pov-heavy-v1';   // модель и ONNX Runtime: большие, меняются редко
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'braille.js', 'recognizer.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== HEAVY).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isHeavy = (url) => url.pathname.endsWith('.onnx') || url.hostname === 'cdn.jsdelivr.net';

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Модель (~40 МБ) и ONNX Runtime: сначала кэш — скачиваются один раз
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
