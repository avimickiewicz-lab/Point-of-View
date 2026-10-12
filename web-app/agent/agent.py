"""ИИ-агент Point of view: исправление ошибок распознавания Брайля и перевод RU <-> EN.

Работает на стандартной библиотеке Python (без pip). Ключ API хранится только на сервере,
в браузер не попадает. Провайдеры:
  * "anthropic" — Claude API (https://api.anthropic.com), модель по умолчанию claude-haiku-5-5;
  * "openai"    — любой OpenAI-совместимый сервер: Ollama, LM Studio, vLLM, OpenAI.

Настройки: agent/config.json (образец — config.example.json) и переменные окружения
ANTHROPIC_API_KEY / OPENAI_API_KEY (или поле api_key в config.json).
"""
import json
import os
import re
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(HERE, "config.json")

DEFAULTS = {
    "provider": "anthropic",
    "model": "claude-haiku-5-5",
    "base_url": "",                 # пусто — стандартный адрес провайдера
    "api_key": "",                  # лучше задавать через переменную окружения
    "api_key_env": "",              # имя переменной; пусто — ANTHROPIC_API_KEY / OPENAI_API_KEY
    "timeout": 90,
    "max_chars": 6000,              # ограничение длины текста в одном запросе
    "max_tokens": 4096,
    "temperature": 0,
    "no_think": True,               # для Qwen3 в Ollama: отключить «размышления» (/no_think)
    "access_token": "",             # если задан, клиент должен прислать его в заголовке X-POV-Token
}

LANG_NAME = {"ru": "Russian", "en": "English"}
STD_NAME = {
    "ru": "Russian literary braille (6-dot; capital sign dots 4-5, number sign dots 3-4-5-6)",
    "en_g2": "Unified English Braille, grade 2 (contracted: single cells and short groups stand for whole words "
             "or letter groups, e.g. ⠮ = the, ⠯ = and, ⠿ = for, ⠷ = of)",
    "en_g1": "Unified English Braille, grade 1 (uncontracted, letter by letter)",
}


class AgentError(Exception):
    def __init__(self, message, status=500):
        super().__init__(message)
        self.status = status


def load_config():
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, encoding="utf-8") as f:
            cfg.update(json.load(f))
    provider = cfg["provider"]
    if not cfg["base_url"]:
        cfg["base_url"] = "https://api.anthropic.com" if provider == "anthropic" else "http://localhost:11434/v1"
    env = cfg["api_key_env"] or ("ANTHROPIC_API_KEY" if provider == "anthropic" else "OPENAI_API_KEY")
    cfg["api_key"] = cfg["api_key"] or os.environ.get(env, "")
    cfg["_key_env"] = env
    return cfg


# ---------------------------------------------------------------- вызов модели

def _post(url, headers, body, timeout):
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                 headers={"content-type": "application/json", **headers}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise AgentError(f"{e.code} от провайдера: {detail}", 502)
    except urllib.error.URLError as e:
        raise AgentError(f"нет связи с {url}: {e.reason}", 502)
    except TimeoutError:
        raise AgentError("провайдер не ответил вовремя", 504)


def call_llm(cfg, system, user):
    provider = cfg["provider"]
    if provider == "anthropic":
        if not cfg["api_key"]:
            raise AgentError(f"не задан ключ API: переменная {cfg['_key_env']} или api_key в agent/config.json", 503)
        data = _post(
            cfg["base_url"].rstrip("/") + "/v1/messages",
            {"x-api-key": cfg["api_key"], "anthropic-version": "2023-06-01"},
            {
                "model": cfg["model"],
                "max_tokens": cfg["max_tokens"],
                "temperature": cfg["temperature"],
                "system": system,
                "messages": [{"role": "user", "content": user}],
            },
            cfg["timeout"],
        )
        return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")

    if provider == "openai":
        headers = {"authorization": f"Bearer {cfg['api_key']}"} if cfg["api_key"] else {}
        if cfg.get("no_think"):
            user = user + "\n/no_think"
        data = _post(
            cfg["base_url"].rstrip("/") + "/chat/completions",
            headers,
            {
                "model": cfg["model"],
                "temperature": cfg["temperature"],
                "max_tokens": cfg["max_tokens"],
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            },
            cfg["timeout"],
        )
        text = data["choices"][0]["message"].get("content") or ""
        return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()

    raise AgentError(f"неизвестный провайдер «{provider}» (нужно anthropic или openai)", 500)


def parse_json(text):
    """Достаёт JSON-объект из ответа модели (даже если он обёрнут в ```json ... ```)."""
    m = re.search(r"\{.*\}", text, flags=re.S)
    if not m:
        raise AgentError("модель вернула ответ не в формате JSON", 502)
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError as e:
        raise AgentError(f"не удалось разобрать JSON модели: {e}", 502)


# ---------------------------------------------------------------- задачи

def task_correct(cfg, p):
    lang = p.get("lang")
    if lang not in LANG_NAME:
        raise AgentError("lang должен быть ru или en", 400)
    text = p.get("text") or ""
    std = "ru" if lang == "ru" else ("en_g1" if p.get("grade") == "g1" else "en_g2")
    uncertain = [w for w in (p.get("uncertain") or []) if isinstance(w, str)][:200]

    system = (
        f"You proofread {LANG_NAME[lang]} text that was produced by optical recognition of a photo of "
        f"{STD_NAME[std]}, then transcribed with braille tables.\n"
        "Typical recognition errors: a dot missed or added in one cell (so one letter turns into another letter or "
        "punctuation mark that differs by a single dot), a lost or spurious cell, a lost capital or number indicator, "
        "two words glued together or one word split.\n"
        "Rules:\n"
        "- Fix only such recognition errors. Do not rephrase, do not modernise spelling, do not change style, "
        "word order or meaning, do not add or remove sentences.\n"
        "- Keep line breaks exactly as in the input.\n"
        "- Proper names and rare words that look plausible must stay unchanged.\n"
        "- If unsure, keep the original word.\n"
        'Reply with JSON only: {"text": "<corrected text>", "changes": [{"from": "<wrong>", "to": "<fixed>"}]}'
    )
    user = json.dumps({
        "text": text,
        "braille_unicode": p.get("braille") or "",
        "uncertain_words": uncertain,
    }, ensure_ascii=False)
    out = parse_json(call_llm(cfg, system, user))
    fixed = str(out.get("text", text))
    if text.count("\n") != fixed.count("\n"):          # модель потеряла строки — не доверяем
        fixed_lines, src_lines = fixed.split("\n"), text.split("\n")
        if len(fixed_lines) < len(src_lines):
            fixed = text
    changes = [c for c in out.get("changes", []) if isinstance(c, dict) and "from" in c and "to" in c]
    return {"text": fixed, "changes": changes}


def task_translate(cfg, p):
    src, dst = p.get("from"), p.get("to")
    if src not in LANG_NAME or dst not in LANG_NAME or src == dst:
        raise AgentError("нужны from и to: ru или en, разные", 400)
    lines = (p.get("text") or "").split("\n")
    system = (
        f"You are a professional translator from {LANG_NAME[src]} to {LANG_NAME[dst]}. "
        "The text was read from a braille page by a blind or visually impaired user, so accuracy matters more "
        "than style. The input is a JSON array of the page lines; a sentence may continue on the next line. "
        "Translate line by line so that the layout of the page is preserved: the output array must have exactly "
        "the same number of elements, element i is the translation of line i (split sentences across lines "
        "the same way as the original; an empty line stays empty). Keep numbers and names. "
        'Reply with JSON only: {"lines": ["...", "..."]}'
    )
    out = parse_json(call_llm(cfg, system, json.dumps({"lines": lines}, ensure_ascii=False)))
    res = out.get("lines")
    if not isinstance(res, list):                      # модель вернула текстом
        res = str(out.get("text", "")).split("\n")
    res = [str(x) for x in res]
    if len(res) != len(lines):                         # выравниваем число строк под оригинал
        res = (res + [""] * len(lines))[: len(lines)] if len(res) < len(lines) else \
            res[: len(lines) - 1] + [" ".join(res[len(lines) - 1:])]
    return {"text": "\n".join(res), "lines_ok": len(out.get("lines") or []) == len(lines)}


TASKS = {"correct": task_correct, "translate": task_translate}


def handle(payload, token=""):
    """Обработка POST /api/agent. Возвращает (http_status, dict)."""
    cfg = load_config()
    if cfg["access_token"] and token != cfg["access_token"]:
        return 401, {"error": "неверный ключ доступа (X-POV-Token)"}
    task = TASKS.get(payload.get("task"))
    if not task:
        return 400, {"error": "task должен быть correct или translate"}
    if len(payload.get("text") or "") > cfg["max_chars"]:
        return 413, {"error": f"текст длиннее {cfg['max_chars']} символов"}
    t0 = time.time()
    try:
        result = task(cfg, payload)
    except AgentError as e:
        return e.status, {"error": str(e)}
    result.update({"provider": cfg["provider"], "model": cfg["model"], "ms": int((time.time() - t0) * 1000)})
    return 200, result


def health(token=""):
    """GET /api/agent/health — без обращения к модели."""
    cfg = load_config()
    info = {"provider": cfg["provider"], "model": cfg["model"]}
    if cfg["access_token"] and token != cfg["access_token"]:
        return 401, {**info, "ok": False, "error": "неверный ключ доступа (X-POV-Token)"}
    if cfg["provider"] == "anthropic" and not cfg["api_key"]:
        return 200, {**info, "ok": False, "error": f"не задан ключ API ({cfg['_key_env']})"}
    return 200, {**info, "ok": True}
