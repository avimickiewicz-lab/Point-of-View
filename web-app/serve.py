"""Локальный сервер для макета Point of view.

  python serve.py            -> http://0.0.0.0:8000  (камера работает на http://localhost:8000)
  python serve.py --https    -> https://0.0.0.0:8443 (нужны cert.pem и key.pem рядом со скриптом)

Модель: /model/braile.onnx берётся из web-app/model/, а если её там нет —
из ../app/src/main/assets/braile.onnx (та же модель, что в Android-проекте).

Сертификат для теста с телефона (openssl есть в Git for Windows):
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout key.pem -out cert.pem -subj "/CN=pov-local"
"""
import http.server, os, socket, ssl, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.normpath(os.path.join(ROOT, "..", "app", "src", "main", "assets"))
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
        super().end_headers()

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

model = os.path.join(ROOT, "model", "braile.onnx")
print("Модель:", model if os.path.exists(model) else os.path.join(ASSETS, "braile.onnx"))
print(f"На компьютере: {scheme}://localhost:{port}")
print(f"С телефона:    {scheme}://{lan_ip()}:{port}" + ("" if https else "  (камера потребует HTTPS, см. README)"))
try:
    httpd.serve_forever()
except KeyboardInterrupt:
    pass
