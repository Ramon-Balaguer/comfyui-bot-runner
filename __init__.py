"""ComfyUI Bot Runner.

Keeps one captured workflow re-queued from the ComfyUI server itself, so
listener-style workflows (Telegram, Discord, folder watchers...) keep running
with no browser tab open. Optionally frees VRAM after a period without real
generation work, so other GPU apps (e.g. llama.cpp) can use it.
"""
import asyncio
import copy
import json
import logging
import os
import random
import time

import aiohttp
from aiohttp import web

import folder_paths
import server
from comfy.cli_args import args

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

LOG = logging.getLogger("bot-runner")
CLIENT_ID = "bot-runner"
SEED_KEYS = ("seed", "noise_seed")
MAX_CONSECUTIVE_ERRORS = 3
START_DELAY = 10  # seconds after startup before the first submission
TICK = 1.0

CONFIG_PATH = os.path.join(folder_paths.get_user_directory(), "default", "bot-runner.json")
DEFAULT_CONFIG = {
    "enabled": False,
    "workflow_name": None,
    "captured_at": None,
    "prompt": None,       # API-format prompt captured from the frontend
    "workflow": None,     # UI-format workflow, embedded in output metadata
    "randomize_seeds": True,
    "idle_free_minutes": 5,
}

_state = {
    "current_prompt_id": None,
    "current_generated": False,
    "runs": 0,
    "generations": 0,
    "last_generation": None,
    "last_activity": None,
    "vram_freed_at": None,
    "freed": True,
    "last_error": None,
    "consecutive_errors": 0,
    "started_at": time.time(),
}


def _load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    except FileNotFoundError:
        pass
    except Exception as e:
        LOG.warning("[bot-runner] could not read %s: %s", CONFIG_PATH, e)
    return cfg


def _save_config():
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(_cfg, f)
    os.replace(tmp, CONFIG_PATH)


_cfg = _load_config()


def _server_url():
    host = "127.0.0.1"
    listen = (getattr(args, "listen", None) or "127.0.0.1").split(",")[0].strip()
    if listen not in ("0.0.0.0", "::", "", "127.0.0.1", "localhost"):
        host = listen
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    scheme = "https" if getattr(args, "tls_keyfile", None) else "http"
    return f"{scheme}://{host}:{args.port}"


def _prepare_prompt():
    prompt = copy.deepcopy(_cfg["prompt"])
    if _cfg.get("randomize_seeds", True):
        for node in prompt.values():
            inputs = node.get("inputs", {})
            for key in SEED_KEYS:
                if isinstance(inputs.get(key), int):
                    inputs[key] = random.randint(0, 2**50)
    return prompt


def _public_status():
    out = {k: v for k, v in _cfg.items() if k not in ("prompt", "workflow")}
    out["has_prompt"] = _cfg.get("prompt") is not None
    out["node_count"] = len(_cfg["prompt"]) if _cfg.get("prompt") else 0
    out.update({k: v for k, v in _state.items()})
    out["busy"] = _state["current_prompt_id"] is not None
    out["queue_remaining"] = server.PromptServer.instance.prompt_queue.get_tasks_remaining()
    out["vram_allocated"] = out["vram_reserved"] = None
    try:
        import torch
        if torch.cuda.is_available():
            out["vram_allocated"] = torch.cuda.memory_allocated()
            out["vram_reserved"] = torch.cuda.memory_reserved()
    except Exception:
        pass
    return out


def _set_error(msg):
    _state["last_error"] = {"time": time.time(), "message": str(msg)[:500]}
    LOG.warning("[bot-runner] %s", msg)


# --- activity tracking -------------------------------------------------------
# "progress" is only sent by samplers / VAE / long node work, never by a
# listener that is just waiting, so it is a good "real work" signal. It also
# counts work queued by people using the UI, so VRAM is not freed under them.
_srv = server.PromptServer.instance
_orig_send_sync = _srv.send_sync


def _send_sync(event, data, sid=None):
    if event == "progress":
        now = time.time()
        _state["last_activity"] = now
        _state["freed"] = False
        if isinstance(data, dict) and data.get("prompt_id") == _state["current_prompt_id"]:
            _state["current_generated"] = True
    return _orig_send_sync(event, data, sid)


_srv.send_sync = _send_sync


# --- main loop -----------------------------------------------------------------
async def _submit(session):
    payload = {
        "prompt": _prepare_prompt(),
        "client_id": CLIENT_ID,
        "extra_data": {"extra_pnginfo": {"workflow": _cfg["workflow"]}} if _cfg.get("workflow") else {},
    }
    async with session.post(_server_url() + "/prompt", json=payload) as resp:
        body = await resp.json(content_type=None)
        if resp.status != 200:
            err = body.get("error", body) if isinstance(body, dict) else body
            details = body.get("node_errors") if isinstance(body, dict) else None
            _set_error(f"workflow rejected by ComfyUI: {err} {json.dumps(details)[:300] if details else ''}")
            _cfg["enabled"] = False
            _save_config()
            return
        _state["current_prompt_id"] = body["prompt_id"]
        _state["current_generated"] = False
        _state["runs"] += 1


def _check_finished():
    pid = _state["current_prompt_id"]
    q = _srv.prompt_queue
    history = q.get_history(prompt_id=pid)
    if pid in history:
        status = history[pid].get("status") or {}
        if status.get("status_str") == "error":
            msg = next((m[1].get("exception_message") for m in status.get("messages", [])
                        if m[0] == "execution_error"), "execution error")
            _state["consecutive_errors"] += 1
            _set_error(msg)
            if _state["consecutive_errors"] >= MAX_CONSECUTIVE_ERRORS:
                _cfg["enabled"] = False
                _save_config()
                _set_error(f"stopped after {MAX_CONSECUTIVE_ERRORS} consecutive errors: {msg}")
        else:
            _state["consecutive_errors"] = 0
        if _state["current_generated"]:
            _state["generations"] += 1
            _state["last_generation"] = time.time()
        _state["current_prompt_id"] = None
        return
    running, queued = q.get_current_queue_volatile()
    if not any(item[1] == pid for item in list(running) + list(queued)):
        # deleted / interrupted from the UI without a history entry
        _state["current_prompt_id"] = None


async def _free_vram(session, reason):
    """Ask ComfyUI to unload models and drop its caches.

    The prompt worker applies these flags only after it finishes a queue item,
    so when nothing else is queued a tiny prompt is sent to flush them. With
    --highvram this is what really releases the memory: unloading alone keeps
    the weights on the GPU, it is the cache reset that lets them be freed.
    """
    _srv.prompt_queue.set_flag("unload_models", True)
    _srv.prompt_queue.set_flag("free_memory", True)
    _state["freed"] = True
    _state["vram_freed_at"] = time.time()
    LOG.info("[bot-runner] freeing VRAM (%s)", reason)
    if not _state["current_prompt_id"] and _srv.prompt_queue.get_tasks_remaining() == 0:
        flush = {
            "1": {"class_type": "PrimitiveInt", "inputs": {"value": random.randint(0, 2**31)}},
            "2": {"class_type": "PreviewAny", "inputs": {"source": ["1", 0]}},
        }
        async with session.post(_server_url() + "/prompt", json={"prompt": flush, "client_id": CLIENT_ID}) as resp:
            if resp.status != 200:
                _set_error(f"could not queue the VRAM flush prompt: HTTP {resp.status}")


async def _maybe_free_vram(session):
    minutes = _cfg.get("idle_free_minutes") or 0
    last = _state["last_activity"]
    if minutes <= 0 or last is None or _state["freed"]:
        return
    if time.time() - last >= minutes * 60:
        await _free_vram(session, f"no generation for {minutes} min")


async def _loop():
    await asyncio.sleep(START_DELAY)
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        while True:
            try:
                if _state["current_prompt_id"]:
                    _check_finished()
                await _maybe_free_vram(session)
                if (_cfg["enabled"] and _cfg.get("prompt") and not _state["current_prompt_id"]
                        and _srv.prompt_queue.get_tasks_remaining() == 0):
                    await _submit(session)
            except Exception as e:
                _set_error(f"loop error: {e}")
                await asyncio.sleep(5)
            await asyncio.sleep(TICK)


# --- HTTP API used by the sidebar panel -----------------------------------------
routes = _srv.routes


@routes.get("/bot-runner/status")
async def _status(request):
    return web.json_response(_public_status())


@routes.post("/bot-runner/capture")
async def _capture(request):
    data = await request.json()
    prompt = data.get("prompt")
    if not isinstance(prompt, dict) or not prompt:
        return web.json_response({"error": "empty prompt"}, status=400)
    _cfg["prompt"] = prompt
    _cfg["workflow"] = data.get("workflow")
    _cfg["workflow_name"] = str(data.get("name") or "workflow")[:200]
    _cfg["captured_at"] = time.time()
    _state["consecutive_errors"] = 0
    _state["last_error"] = None
    _save_config()
    LOG.info("[bot-runner] captured workflow '%s' (%d nodes)", _cfg["workflow_name"], len(prompt))
    return web.json_response(_public_status())


@routes.post("/bot-runner/config")
async def _config(request):
    data = await request.json()
    if "enabled" in data:
        enabled = bool(data["enabled"])
        if enabled and not _cfg.get("prompt"):
            return web.json_response({"error": "capture a workflow first"}, status=400)
        _cfg["enabled"] = enabled
        if enabled:
            _state["consecutive_errors"] = 0
            _state["last_error"] = None
        LOG.info("[bot-runner] %s", "enabled" if enabled else "disabled")
    if "randomize_seeds" in data:
        _cfg["randomize_seeds"] = bool(data["randomize_seeds"])
    if "idle_free_minutes" in data:
        try:
            _cfg["idle_free_minutes"] = max(0, int(data["idle_free_minutes"]))
        except (TypeError, ValueError):
            return web.json_response({"error": "idle_free_minutes must be an integer"}, status=400)
    _save_config()
    return web.json_response(_public_status())


@routes.post("/bot-runner/free")
async def _free_now(request):
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        await _free_vram(session, "requested from the panel")
    return web.json_response(_public_status())


_srv.loop.create_task(_loop())
LOG.info("[bot-runner] loaded (config: %s, enabled=%s)", CONFIG_PATH, _cfg["enabled"])
