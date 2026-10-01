"""T3 web UI: status, lane/timing config, displays + OTA, users and history.

Runs as its own service (trafficlight-web). If it stops, traffic control is
not affected. Standard library only.

  python -m trafficlight.web.server --data-dir /etc/trafficlight
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import re
import secrets
import subprocess
import threading
import time
import urllib.request
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from loguru import logger

from ..t3.config import validate, with_defaults
from ..t3.flowstats import FlowStats
from ..t3.ports import discover as list_ports
from .flasher import Flasher
from .store import ConfigStore, Users, _atomic_write

SCALE_MIN, SCALE_MAX = 0.4, 4.0
STATIC = Path(__file__).resolve().parent / "static"
TEMPLATE = Path(__file__).resolve().parents[3] / "config" / "settings.t3.example.json"
MAP_TYPES = {"png": "image/png", "jpg": "image/jpeg", "svg": "image/svg+xml"}
MAX_BODY = 4 * 1024 * 1024       # firmware images are ~350 KB
COOKIE = "t3sess"


class StateCache:
    """Latest controller state from MQTT (<base>/state)."""

    def __init__(self, cfg: dict, client=None):
        self.base = f"{cfg['mqtt']['base_topic'].rstrip('/')}/{cfg['junction_id']}"
        self.state: dict | None = None
        self.at = 0.0
        self.results: list[dict] = []
        self.on_state = None                   # callback(state, wall_time) e.g. the flow summary
        self.displays: dict[int, str] = {}     # display id -> "online" / "offline" (retained LWT)
        self.client = client
        if client is None:
            try:
                import paho.mqtt.client as mqtt
                c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"t3-web-{secrets.token_hex(3)}")
                c.on_connect = lambda cl, *_: (cl.subscribe(f"{self.base}/state"),
                                              cl.subscribe(f"{self.base}/control/result"),
                                              cl.subscribe(f"{self.base}/display/+/status"))
                c.on_message = self._on_message
                c.connect_async(cfg["mqtt"]["broker"], int(cfg["mqtt"]["port"]), 30)
                c.loop_start()
                self.client = c
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"WEB mqtt_unavailable {exc}")

    def _on_message(self, client, userdata, msg):
        if msg.topic.endswith("/status") and "/display/" in msg.topic:
            try:
                self.displays[int(msg.topic.split("/")[-2])] = msg.payload.decode("utf-8", "replace")
            except ValueError:
                pass
            return
        try:
            data = json.loads(msg.payload.decode("utf-8"))
        except ValueError:
            return
        if msg.topic.endswith("/state"):
            self.state, self.at = data, time.time()
            if self.on_state:
                try:
                    self.on_state(data, self.at)
                except Exception:  # noqa: BLE001  statistics must never break the state feed
                    logger.exception("WEB flow_stats_error")
        else:
            self.results = (self.results + [data])[-10:]

    def retarget(self, cfg: dict) -> None:
        """Follow a new junction_id / base topic after the config was saved."""
        base = f"{cfg['mqtt']['base_topic'].rstrip('/')}/{cfg['junction_id']}"
        if base == self.base or self.client is None:
            return
        for t in ("state", "control/result", "display/+/status"):
            self.client.unsubscribe(f"{self.base}/{t}")
        self.base, self.state, self.displays = base, None, {}
        for t in ("state", "control/result", "display/+/status"):
            self.client.subscribe(f"{self.base}/{t}")
        logger.info(f"WEB retarget base={base}")

    def publish_control(self, cmd: dict) -> bool:
        if self.client is None:
            return False
        self.client.publish(f"{self.base}/control", json.dumps(cmd, ensure_ascii=False), qos=1)
        return True

    def snapshot(self) -> dict:
        age = time.time() - self.at if self.state else None
        return {"state": self.state, "age_s": None if age is None else round(age, 1),
                "stale": age is None or age > 3.0,
                "displays": {str(k): v for k, v in sorted(self.displays.items())},
                "results": self.results[-3:]}


def _clean_layout(data) -> dict:
    """Map positions of the lane widgets: {"lanes": {"<id>": {"x": 0..1, "y": 0..1, "rot": 0|90|180|270, optional "scale", "dir"}}}."""
    lanes = {}
    for key, v in ((data or {}).get("lanes") or {}).items():
        if not str(key).isdigit() or not isinstance(v, dict):
            raise ValueError("ข้อมูลตำแหน่งไม่ถูกต้อง")
        x, y, rot = v.get("x"), v.get("y"), int(v.get("rot", 0))
        if not all(isinstance(n, (int, float)) and 0 <= n <= 1 for n in (x, y)) or rot not in (0, 90, 180, 270):
            raise ValueError("ข้อมูลตำแหน่งไม่ถูกต้อง")
        item = {"x": round(float(x), 4), "y": round(float(y), 4), "rot": rot}
        sc = v.get("scale")
        if sc is not None:
            if not isinstance(sc, (int, float)) or isinstance(sc, bool) or not (SCALE_MIN <= sc <= SCALE_MAX):
                raise ValueError("ขนาดกล่องเลนไม่ถูกต้อง")
            if abs(sc - 1.0) > 1e-6:
                item["scale"] = round(float(sc), 3)
        d = v.get("dir")                       # heading of the vehicles of this lane in the 3D view (0 = right, 90 = down)
        if d is not None:
            if isinstance(d, bool) or d not in (0, 90, 180, 270):
                raise ValueError("ทิศทางรถไม่ถูกต้อง")
            item["dir"] = int(d)
        lanes[str(int(key))] = item
    return {"lanes": lanes}


# ---- hand drawn site map (docs/T3_DESIGN.md 12.2): shapes in a 1000 x 700 space, colours are theme tokens
DRAW_W, DRAW_H = 1000, 700
DRAW_MAX_ITEMS = 400
DRAW_MAX_HEIGHT = 300
DRAW_TYPES = ("rect", "ellipse", "line", "text", "road", "hatch", "zone", "lanepath")
DRAW_PTS = {"zone": (3, 12), "lanepath": (2, 16)}      # points allowed: safety zone polygon / vehicle path of one lane
DRAW_MAX_LANE = 64
DRAW_COLORS = ("ink", "mut", "faint", "line", "soft", "fill", "panel", "accent", "grn", "red", "amb", "zone", "none")


def _num(v, lo, hi, what):
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not (lo <= v <= hi):
        raise ValueError(f"ข้อมูลแผนที่ไม่ถูกต้อง: {what}")
    return round(float(v), 2)


def _clean_drawing(data) -> dict:
    """{"items": [{"type", ...}]}: rect/road/hatch x y w h · ellipse x y w h · line x1 y1 x2 y2 · text x y text size · rect/ellipse may carry ht (3D height) and z (base)."""
    items_in = (data or {}).get("items") or []
    if not isinstance(items_in, list) or len(items_in) > DRAW_MAX_ITEMS:
        raise ValueError("ข้อมูลแผนที่ไม่ถูกต้อง: จำนวนชิ้นส่วนมากเกินไป")
    out = []
    for i, it in enumerate(items_in):
        if not isinstance(it, dict) or it.get("type") not in DRAW_TYPES:
            raise ValueError("ข้อมูลแผนที่ไม่ถูกต้อง: ชนิดชิ้นส่วน")
        t = it["type"]
        c = {"id": str(it.get("id") or f"i{i}")[:24], "type": t}
        for k in ("stroke", "fill"):
            v = it.get(k, "none" if k == "fill" else "ink")
            if v not in DRAW_COLORS:
                raise ValueError("ข้อมูลแผนที่ไม่ถูกต้อง: สี")
            c[k] = v
        c["sw"] = _num(it.get("sw", 2), 0, 40, "ความหนาเส้น")
        c["rot"] = _num(it.get("rot", 0), -360, 360, "มุมหมุน")
        if t in DRAW_PTS:                    # zone: yellow diamond lattice polygon · lanepath: where the vehicles of a lane drive
            pts = it.get("pts")
            lo, hi = DRAW_PTS[t]
            if not isinstance(pts, list) or not (lo <= len(pts) <= hi):
                raise ValueError("ข้อมูลแผนที่ไม่ถูกต้อง: จำนวนจุด")
            if t == "lanepath":
                c["lane"] = int(_num(it.get("lane"), 1, DRAW_MAX_LANE, "เลน"))
            c["pts"] = []
            for p in pts:
                if not isinstance(p, (list, tuple)) or len(p) != 2:
                    raise ValueError("ข้อมูลแผนที่ไม่ถูกต้อง: จุด")
                c["pts"].append([_num(p[0], -DRAW_W, DRAW_W * 2, "x"), _num(p[1], -DRAW_H, DRAW_H * 2, "y")])
            c.pop("rot")
            out.append(c)
            continue
        if t == "line":
            for k, hi in (("x1", DRAW_W), ("y1", DRAW_H), ("x2", DRAW_W), ("y2", DRAW_H)):
                c[k] = _num(it.get(k), -DRAW_W, DRAW_W * 2, k)
            c["arrow"] = bool(it.get("arrow"))
            c["dash"] = bool(it.get("dash"))
            c.pop("rot")
        elif t == "text":
            c["x"] = _num(it.get("x"), -DRAW_W, DRAW_W * 2, "x")
            c["y"] = _num(it.get("y"), -DRAW_H, DRAW_H * 2, "y")
            c["size"] = _num(it.get("size", 18), 6, 200, "ขนาดตัวอักษร")
            text = it.get("text", "")
            if not isinstance(text, str) or len(text) > 80:
                raise ValueError("ข้อมูลแผนที่ไม่ถูกต้อง: ข้อความยาวเกิน 80 ตัวอักษร")
            c["text"] = text
            c["bold"] = bool(it.get("bold"))
        else:
            for k in ("x", "y"):
                c[k] = _num(it.get(k), -DRAW_W, DRAW_W * 2, k)
            for k in ("w", "h"):
                c[k] = _num(it.get(k), 1, DRAW_W * 2, k)
            if t == "rect":
                c["r"] = _num(it.get("r", 0), 0, 200, "มุมมน")
            if t in ("rect", "ellipse"):          # 3D view: height of the block and its base above the ground
                c["ht"] = _num(it.get("ht", 0), 0, DRAW_MAX_HEIGHT, "ความสูง")
                c["z"] = _num(it.get("z", 0), 0, DRAW_MAX_HEIGHT, "ยกจากพื้น")
        out.append(c)
    return {"items": out}


def _map_kind(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    head = data[:512].lstrip().lower()
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in data[:4096].lower()):
        return "svg"
    return None


class App:
    def __init__(self, data_dir: Path, settings: Path | None = None, state: StateCache | None = None,
                 run_cmd=subprocess.run, ota_post=None, flash_kw=None):
        self.store = ConfigStore(data_dir, settings)
        self.users = Users(data_dir / "users.json")
        cfg = with_defaults(self.store.current())
        self.cfg = cfg
        self.flasher = Flasher(cfg, data_dir, **(flash_kw or {}))   # tests inject popen / ports_fn / root
        self.state = state or StateCache(cfg)
        self.sessions: dict[str, tuple[str, str, float]] = {}
        self.session_s = float(cfg["web"].get("session_hours", 8)) * 3600
        self.run_cmd = run_cmd
        self.ota_post = ota_post or self._ota_post
        self.ota_jobs: dict[int, dict] = {}
        self._fail: dict[str, list[float]] = {}
        self.data_dir = Path(data_dir)
        w = cfg["web"]
        self.flow = FlowStats(float(w.get("flow_gap_s", 5)), float(w.get("flow_save_s", 30)), self.data_dir / "flow.json")
        self.flow.load_file()
        if not self.flow.since:
            self.flow.since = time.time()
        self.flow_lock = threading.Lock()
        if hasattr(self.state, "on_state"):
            self.state.on_state = self._flow_feed

    def _flow_feed(self, st: dict, at: float) -> None:
        with self.flow_lock:
            self.flow.feed(st, at)

    def flow_summary(self) -> dict:
        with self.flow_lock:
            return self.flow.summary()

    def flow_reset(self, user: str) -> dict:
        with self.flow_lock:
            self.flow.reset(time.time())
            self.flow.save(time.time())
        self.store.audit(user, "flow_reset")
        return self.flow_summary()

    def config_changed(self) -> None:
        """apply_config went out on the old topics; now follow the new ones."""
        self.cfg = with_defaults(self.store.current())
        if hasattr(self.state, "retarget"):
            self.state.retarget(self.cfg)

    # ------------------------------------------------------------ layout / map
    def layout(self) -> dict:
        try:
            return _clean_layout(json.loads((self.data_dir / "layout.json").read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return {"lanes": {}}

    def save_layout(self, data, user: str) -> dict:
        clean = _clean_layout(data)
        _atomic_write(self.data_dir / "layout.json", json.dumps(clean, indent=2))
        self.store.audit(user, "layout_saved", {"lanes": sorted(clean["lanes"])})
        return clean

    def drawing(self) -> dict:
        try:
            return _clean_drawing(json.loads((self.data_dir / "drawing.json").read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return {"items": []}

    def save_drawing(self, data, user: str) -> dict:
        clean = _clean_drawing(data)
        _atomic_write(self.data_dir / "drawing.json", json.dumps(clean, ensure_ascii=False))
        self.store.audit(user, "drawing_saved", {"items": len(clean["items"])})
        return clean

    def map_file(self) -> Path | None:
        for ext in MAP_TYPES:
            p = self.data_dir / f"map.{ext}"
            if p.is_file():
                return p
        return None

    def save_map(self, data: bytes, user: str) -> None:
        kind = _map_kind(data)
        if kind is None:
            raise ValueError("รองรับเฉพาะรูป PNG, JPG หรือ SVG")
        for ext in MAP_TYPES:
            (self.data_dir / f"map.{ext}").unlink(missing_ok=True)
        (self.data_dir / f"map.{kind}").write_bytes(data)
        self.store.audit(user, "map_uploaded", {"type": kind, "bytes": len(data)})

    def reset_map(self, user: str) -> None:
        for ext in MAP_TYPES:
            (self.data_dir / f"map.{ext}").unlink(missing_ok=True)
        self.store.audit(user, "map_reset")

    @staticmethod
    def template() -> dict:
        """Reference T3 lanes (docs/T3_DESIGN.md) with ports left empty."""
        raw = json.loads(TEMPLATE.read_text(encoding="utf-8"))
        return {"lanes": raw.get("lanes", []), "displays": raw.get("displays", {}),
                "sensors": {k: {"port": ""} for k in raw.get("sensors", {})}}

    # ------------------------------------------------------------ sessions
    def login(self, name: str, password: str, ip: str) -> str | None:
        recent = [t for t in self._fail.get(ip, []) if time.time() - t < 300]
        if len(recent) >= 10:
            return None
        role = self.users.check(name, password)
        if role is None:
            self._fail[ip] = recent + [time.time()]
            self.store.audit(name, "login_failed", {"ip": ip})
            return None
        token = secrets.token_urlsafe(32)
        self.sessions[token] = (name, role, time.time() + self.session_s)
        self.store.audit(name, "login", {"ip": ip})
        return token

    def session(self, token: str | None):
        s = self.sessions.get(token or "")
        if not s or s[2] < time.time():
            self.sessions.pop(token or "", None)
            return None
        return s

    # ------------------------------------------------------------ OTA
    def _ota_post(self, ip: str, port: int, password: str, data: bytes) -> tuple[int, str]:
        req = urllib.request.Request(f"http://{ip}:{port}/sketch", data=data, method="POST")
        req.add_header("Authorization", "Basic " + base64.b64encode(f"arduino:{password}".encode()).decode())
        req.add_header("Content-Type", "application/octet-stream")
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read().decode("utf-8", "replace")

    def start_ota(self, display: int, data: bytes, user: str) -> str:
        cfg = with_defaults(self.store.current())
        ip = cfg["displays"].get(str(display), {}).get("ip")
        if not ip:
            raise ValueError(f"ไม่รู้จักจอ B{display}")
        if not data.startswith(b"\xe9"):
            raise ValueError("ไฟล์ไม่ใช่เฟิร์มแวร์ ESP32 (.bin)")
        tag = re.search(rb"T3-DISPLAY-ID:(\d+);", data)
        if tag is None:
            raise ValueError("ไฟล์ไม่มีเลขจอ (build ด้วยเวอร์ชันเก่า) ให้ build ใหม่ด้วย tools/build_t3_firmware")
        if int(tag.group(1)) != int(display):
            raise ValueError(f"ไฟล์นี้เป็นของจอ B{int(tag.group(1))} แต่เลือกอัปเดตจอ B{display}")
        if any(j.get("running") for j in self.ota_jobs.values()):
            raise ValueError("อัปเดตได้ทีละจอ")
        lane = next((l["id"] for l in cfg["lanes"] if l.get("display") == display), None)
        job = {"running": True, "display": display, "step": "ปิดเลนก่อนอัปเดต", "ok": None, "user": user}
        self.ota_jobs[display] = job
        threading.Thread(target=self._ota_job, args=(job, cfg, ip, lane, data), daemon=True).start()
        self.store.audit(user, "ota_start", {"display": display, "bytes": len(data)})
        return "เริ่มอัปเดตแล้ว"

    def _ota_job(self, job, cfg, ip, lane, data):
        try:
            if lane is not None:
                # the lane is closed after its current green, but the upload does NOT wait for it:
                # a display being updated drops green at once (START frame, then reboot), the
                # controller sees the lost ACK, ends that green and runs the all-red barrier
                self.state.publish_control({"cmd": "maintenance", "lane": lane, "on": True, "user": job["user"]})
            job["step"] = "กำลังส่งไฟล์ไปที่จอ"
            status, text = self.ota_post(ip, int(cfg["ota"]["port"]), cfg["ota"]["password"], data)
            if status != 200:
                raise RuntimeError(f"จอตอบ {status}: {text[:80]}")
            job["step"] = "จอกำลังรีบูตด้วยเฟิร์มแวร์ใหม่"
            time.sleep(20)
            job["step"] = "เสร็จ · เลนยังปิดอยู่ ตรวจภาพบนจอแล้วเปิดเลนจากหน้าสถานะ"
            job["ok"] = True
            self.store.audit(job["user"], "ota_done", {"display": job["display"]})
        except Exception as exc:  # noqa: BLE001
            job["step"] = f"ไม่สำเร็จ: {exc}"
            job["ok"] = False
            self.store.audit(job["user"], "ota_failed", {"display": job["display"], "error": str(exc)})
        finally:
            job["running"] = False


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = "T3Web/1.0"

        def log_message(self, fmt, *args):  # route to loguru
            logger.debug("WEB " + fmt % args)

        # -------------------------------------------------------- helpers
        def _send(self, code: int, body: bytes, ctype: str, headers: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, data, headers: dict | None = None):
            self._send(code, json.dumps(data, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8", headers)

        def _err(self, code: int, msg: str):
            self._json(code, {"error": msg})

        def _token(self):
            c = SimpleCookie(self.headers.get("Cookie", ""))
            return c[COOKIE].value if COOKIE in c else None

        def _user(self, editor: bool = False):
            s = app.session(self._token())
            if not s:
                self._err(401, "กรุณาเข้าสู่ระบบ")
                return None
            if editor and s[1] != "editor":
                self._err(403, "บัญชีนี้ดูได้อย่างเดียว")
                return None
            return s

        def _body(self) -> bytes:
            n = int(self.headers.get("Content-Length", 0))
            if n > MAX_BODY:
                raise ValueError("ไฟล์ใหญ่เกินไป")
            return self.rfile.read(n) if n else b""

        def _jbody(self) -> dict:
            return json.loads(self._body() or b"{}")

        def _csrf_ok(self) -> bool:
            if self.headers.get("X-T3") != "1":
                self._err(400, "คำขอไม่ถูกต้อง")
                return False
            return True

        # -------------------------------------------------------- GET
        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/" or path == "/index.html":
                return self._static("index.html")
            if path.startswith("/static/"):
                return self._static(path[len("/static/"):])
            if path == "/api/me":
                s = app.session(self._token())
                return self._json(200, {"user": s[0], "role": s[1], "icon": app.users.icon(s[0])} if s else {"user": None,
                                  "setup_needed": app.users.count() == 0})
            s = self._user()
            if not s:
                return
            if path == "/api/state":
                snap = app.state.snapshot()
                snap["ota"] = list(app.ota_jobs.values())
                return self._json(200, snap)
            if path == "/api/config":
                cfg = app.store.current()
                return self._json(200, {"config": cfg, "errors": validate(with_defaults(cfg)),
                                        "defaults": with_defaults({})})
            if path == "/api/versions":
                return self._json(200, {"versions": app.store.list_versions()})
            if path.startswith("/api/versions/"):
                return self._json(200, app.store.get_version(int(path.rsplit("/", 1)[1])))
            if path == "/api/setup/status":
                if not self._user():
                    return
                return self._json(200, app.flasher.status(bool(app.cfg.get("lanes"))))
            if path == "/api/ports":
                return self._json(200, {"ports": list_ports()})
            if path == "/api/flow":
                return self._json(200, app.flow_summary())
            if path == "/api/layout":
                return self._json(200, app.layout())
            if path == "/api/drawing":
                return self._json(200, app.drawing())
            if path == "/api/template":
                return self._json(200, app.template())
            if path == "/api/map":
                p = app.map_file()
                if p is None:
                    return self._err(404, "ไม่มีรูปพื้นหลัง")
                return self._send(200, p.read_bytes(), MAP_TYPES[p.suffix[1:]],
                                  {"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:"})
            if path == "/api/users":
                if s[1] != "editor":
                    return self._err(403, "บัญชีนี้ดูได้อย่างเดียว")
                return self._json(200, {"users": app.users.list(), "audit": app.store.audit_tail(40)})
            return self._err(404, "ไม่พบ")

        def _static(self, rel: str):
            p = (STATIC / rel).resolve()
            if STATIC not in p.parents and p != STATIC or not p.is_file():
                return self._err(404, "ไม่พบ")
            ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
                ctype += "; charset=utf-8"
            self._send(200, p.read_bytes(), ctype)

        # -------------------------------------------------------- POST
        def do_POST(self):
            path = self.path.split("?", 1)[0]
            try:
                if not self._csrf_ok():
                    return
                if path == "/api/login":
                    b = self._jbody()
                    token = app.login(b.get("user", ""), b.get("password", ""), self.client_address[0])
                    if not token:
                        return self._err(401, "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง")
                    cookie = f"{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={int(app.session_s)}"
                    return self._json(200, {"ok": True}, {"Set-Cookie": cookie})
                if path == "/api/setup/first-user":    # first account, from the Pi's own touch screen only
                    if app.users.count() != 0:
                        return self._err(403, "มีบัญชีผู้ใช้แล้ว")
                    if self.client_address[0] not in ("127.0.0.1", "::1"):
                        return self._err(403, "สร้างบัญชีแรกได้จากหน้าจอของ Pi เท่านั้น")
                    b = self._jbody()
                    name, pw = str(b.get("user", "")).strip(), str(b.get("password", ""))
                    try:
                        app.users.set(name, pw, "editor")
                    except ValueError as e:
                        return self._err(400, str(e))
                    app.store.audit(name, "first_user_created", {"ip": self.client_address[0]})
                    token = app.login(name, pw, self.client_address[0])
                    cookie = f"{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={int(app.session_s)}"
                    return self._json(200, {"ok": True}, {"Set-Cookie": cookie})
                if path == "/api/logout":
                    app.sessions.pop(self._token() or "", None)
                    return self._json(200, {"ok": True}, {"Set-Cookie": f"{COOKIE}=; Max-Age=0; Path=/"})
                if path == "/api/me/icon":            # everybody may change their own icon
                    s = self._user()
                    if not s:
                        return
                    app.users.set_icon(s[0], self._jbody().get("icon", ""))
                    return self._json(200, {"ok": True, "icon": app.users.icon(s[0])})
                s = self._user(editor=True)
                if not s:
                    return
                user = s[0]
                if path == "/api/config":
                    b = self._jbody()
                    cfg = b.get("config")
                    if not isinstance(cfg, dict):
                        return self._err(400, "ไม่มีข้อมูล config")
                    errors = validate(with_defaults(cfg))
                    if errors:
                        return self._json(422, {"error": "ค่าไม่ถูกต้อง", "errors": errors})
                    n = app.store.save(cfg, user, b.get("note", ""))
                    app.state.publish_control({"cmd": "apply_config", "user": user})
                    app.config_changed()
                    return self._json(200, {"version": n})
                if path == "/api/rollback":
                    n = int(self._jbody().get("version"))
                    cfg = app.store.get_version(n)
                    n2 = app.store.save(cfg, user, f"ย้อนกลับไป v{n}")
                    app.state.publish_control({"cmd": "apply_config", "user": user})
                    app.config_changed()
                    return self._json(200, {"version": n2})
                if path == "/api/control":
                    b = self._jbody()
                    if b.get("cmd") not in ("maintenance", "clear_queue", "test_display", "identify", "restart"):
                        return self._err(400, "ไม่รู้จักคำสั่ง")
                    if b["cmd"] == "identify" and not (isinstance(b.get("display"), int) and 1 <= b["display"] <= 7):
                        return self._err(400, "ไม่รู้จักจอ")
                    b["user"] = user
                    app.store.audit(user, "control", b)
                    ok = app.state.publish_control(b)
                    return self._json(200 if ok else 503, {"ok": ok})
                if path == "/api/setup/flash":
                    b = self._jbody()
                    try:
                        job = app.flasher.start(int(b.get("display", 0)), str(b.get("port", "")))
                    except ValueError as e:
                        return self._err(400, str(e))
                    except RuntimeError as e:
                        return self._err(409, str(e))
                    app.store.audit(user, f"flash_display_{job['display']}")
                    return self._json(202, {"job": job})
                if path == "/api/setup/done":
                    app.flasher.mark_done()
                    return self._json(200, {"ok": True})
                if path == "/api/reboot":
                    st = app.state.snapshot()["state"] or {}
                    if st.get("active_lane") is not None:
                        return self._err(409, "มีเลนเขียวอยู่ รอให้แยกว่างแล้วกดอีกครั้ง")
                    app.store.audit(user, "reboot_pi")
                    app.run_cmd(["sudo", "-n", "/usr/bin/systemctl", "reboot"], check=False)
                    return self._json(200, {"ok": True})
                if path == "/api/flow/reset":
                    return self._json(200, app.flow_reset(user))
                if path == "/api/layout":
                    return self._json(200, app.save_layout(self._jbody(), user))
                if path == "/api/drawing":
                    return self._json(200, app.save_drawing(self._jbody(), user))
                if path == "/api/map":
                    app.save_map(self._body(), user)
                    return self._json(200, {"ok": True})
                if path == "/api/map/reset":
                    app.reset_map(user)
                    return self._json(200, {"ok": True})
                if path.startswith("/api/ota/"):
                    disp = int(path.rsplit("/", 1)[1])
                    return self._json(202, {"message": app.start_ota(disp, self._body(), user)})
                if path == "/api/users":
                    b = self._jbody()
                    app.users.set(b.get("name", ""), b.get("password") or None, b.get("role") or None)
                    if "icon" in b:
                        app.users.set_icon(b.get("name", ""), b.get("icon") or "")
                    app.store.audit(user, "user_set", {"name": b.get("name"), "role": b.get("role"),
                                                       "password_changed": bool(b.get("password"))})
                    return self._json(200, {"ok": True})
                if path == "/api/users/delete":
                    name = self._jbody().get("name")
                    if name == user:
                        return self._err(400, "ลบบัญชีตัวเองไม่ได้")
                    app.users.delete(name)
                    app.store.audit(user, "user_delete", {"name": name})
                    return self._json(200, {"ok": True})
                return self._err(404, "ไม่พบ")
            except ValueError as exc:
                return self._err(400, str(exc))
            except Exception as exc:  # noqa: BLE001
                logger.exception("WEB error")
                return self._err(500, f"ผิดพลาด: {exc}")

    return Handler


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="/etc/trafficlight")
    ap.add_argument("--config", default=None)
    args = ap.parse_args(argv)
    data_dir = Path(args.data_dir)
    app = App(data_dir, Path(args.config) if args.config else None)
    bind, port = app.cfg["web"]["bind"], int(app.cfg["web"]["port"])
    srv = ThreadingHTTPServer((bind, port), make_handler(app))
    logger.info(f"WEB listening on http://{bind}:{port}")
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
