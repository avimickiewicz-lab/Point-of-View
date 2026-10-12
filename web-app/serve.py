"""Локальный сервер для макета Point of view.

  python serve.py            -> http://0.0.0.0:8000  (камера работает на http://localhost:8000)
  python serve.py --https    -> https://0.0.0.0:8443 (нужны cert.pem и key.pem рядом со скриптом)

Модель: /model/braile.onnx берётся из web-app/model/, а если её там нет —
из ../app/src/main/assets/braile.onnx (та же модель, что в Android-проекте).

ИИ-агент (исправление и перевод RU <-> EN): POST /api/agent, GET /api/agent/health.
Настройка — agent/config.json и переменная окружения с ключом (см. README).

Сертификат для теста с телефона (openssl есть в Git for Windows):
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout key.pem -out cert.pem -subj "/CN=pov-local"
"""
import http.server, json, os, socket, ssl, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent import agent  # noqa: E402  (agent/agent.py)

ROOT = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.normpath(os.path.join(ROOT, "..", "web-app", "models"))
https = "--https" in sys.argv
port = 8443 if https else 8000

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".webmanifest": "application/manifest+json", ".js": "text/javascript",
                      ".onnx": "application/octet-stream", ".wasm": "application/wasm"}
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)
    def translate_path(self, path):
        local = super().translate_path(path)
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/model/") and not os.path.exists(local):
            fallback = os.path.join(ASSETS, os.path.basename(clean))
            if os.path.exists(fallback):
                return fallback
        return local

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        if self.path.startswith("/api/"):
            # агент можно вызывать и со страницы, открытой с другого адреса (например, с хостинга)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "content-type, x-pov-token")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        super().end_headers()

    # ---------- ИИ-агент ----------
    def _json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if self.path.startswith("/api/"):
            self.send_response(204)
            self.end_headers()
        else:
            self.send_error(405)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/agent/health":
            return self._json(*agent.health(self.headers.get("X-POV-Token", "")))
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/agent":
            return self.send_error(404)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(min(n, 1_000_000)).decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            return self._json(400, {"error": "некорректный JSON"})
        return self._json(*agent.handle(payload, self.headers.get("X-POV-Token", "")))

def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80)); return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()

httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
scheme = "http"
if https:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(os.path.join(ROOT, "cert.pem"), os.path.join(ROOT, "key.pem"))
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    scheme = "https"

model = os.path.join(ROOT, "models", "braile.onnx")
print("Модель:", model if os.path.exists(model) else "НЕ НАЙДЕНА: положите braile.onnx в web-app/models/")
_, h = agent.health()
print("ИИ-агент:", f"{h['provider']} · {h['model']}" + ("" if h.get("ok") else f"  (не настроен: {h.get('error')})"))
print(f"На компьютере: {scheme}://localhost:{port}")
print(f"С телефона:    {scheme}://{lan_ip()}:{port}" + ("" if https else "  (камера потребует HTTPS, см. README)"))
try:
    httpd.serve_forever()
except KeyboardInterrupt:
    pass
