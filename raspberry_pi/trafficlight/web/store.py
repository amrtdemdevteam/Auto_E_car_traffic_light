"""Persistent data of the web UI: users, config versions, audit log.

Everything lives in one directory (default /etc/trafficlight):
  settings.json         active config read by the controller
  versions/vNNNN.json   every saved config (with meta: user, time, note, changes)
  users.json            accounts: PBKDF2-SHA256 hashes, role editor | viewer
  audit.log             one JSON line per action
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path

ROLES = ("editor", "viewer")
PBKDF2_ROUNDS = 200_000


def _atomic_write(path: Path, data: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(data, encoding="utf-8")
    os.replace(tmp, path)


ICON_IMG_MAX = 90000     # characters of a data URL (a 256 px JPEG is ~ 25 KB)
ICON_MAX_LEN = 8       # characters (one emoji can be several code points)


class Users:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def _load(self) -> dict:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text(encoding="utf-8")).get("users", {})

    def _save(self, users: dict) -> None:
        _atomic_write(self.path, json.dumps({"users": users}, ensure_ascii=False, indent=2))
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    @staticmethod
    def _hash(password: str, salt: bytes) -> str:
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS).hex()

    def list(self) -> list[dict]:
        return [{"name": n, "role": u["role"], "created": u.get("created"), "icon": u.get("icon", "")}
                for n, u in sorted(self._load().items())]

    def icon(self, name: str) -> str:
        return self._load().get(name, {}).get("icon", "")

    def set_icon(self, name: str, icon: str) -> None:
        """A short emoji / symbol shown next to the user name. Empty = none (the UI shows the initial)."""
        icon = (icon or "").strip()
        if icon.startswith("data:image/jpeg;base64,"):          # own picture, already shrunk by the browser
            body = icon.split(",", 1)[1]
            if len(icon) > ICON_IMG_MAX or not re.fullmatch(r"[A-Za-z0-9+/=]+", body):
                raise ValueError("รูปโปรไฟล์ไม่ถูกต้องหรือใหญ่เกินไป")
        elif len(icon) > ICON_MAX_LEN or any(c in icon for c in "<>&\"'") or any(ord(c) < 32 for c in icon):
            raise ValueError("ไอคอนไม่ถูกต้อง")
        with self._lock:
            users = self._load()
            if name not in users:
                raise ValueError("ไม่พบผู้ใช้")
            users[name]["icon"] = icon
            self._save(users)

    def count(self) -> int:
        return len(self._load())

    def set(self, name: str, password: str | None, role: str | None) -> None:
        if not name or not name.replace("_", "").replace("-", "").replace(".", "").isalnum():
            raise ValueError("ชื่อผู้ใช้ใช้ได้เฉพาะตัวอักษรอังกฤษ ตัวเลข - _ .")
        with self._lock:
            users = self._load()
            u = users.get(name, {"created": time.strftime("%Y-%m-%d %H:%M")})
            if role is not None:
                if role not in ROLES:
                    raise ValueError("สิทธิ์ต้องเป็น editor หรือ viewer")
                u["role"] = role
            if password is not None:
                if len(password) < 8:
                    raise ValueError("รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร")
                salt = secrets.token_bytes(16)
                u["salt"] = salt.hex()
                u["hash"] = self._hash(password, salt)
            if "hash" not in u or "role" not in u:
                raise ValueError("ผู้ใช้ใหม่ต้องมีรหัสผ่านและสิทธิ์")
            users[name] = u
            self._save(users)

    def delete(self, name: str) -> None:
        with self._lock:
            users = self._load()
            users.pop(name, None)
            self._save(users)

    def check(self, name: str, password: str) -> str | None:
        """Return the role if the password is right, else None."""
        u = self._load().get(name)
        if not u:
            self._hash(password, b"x" * 16)  # same cost for unknown users
            return None
        ok = hmac.compare_digest(u["hash"], self._hash(password, bytes.fromhex(u["salt"])))
        return u["role"] if ok else None


def _flatten(d, prefix="") -> dict:
    out = {}
    if isinstance(d, dict):
        for k, v in d.items():
            if k.startswith("_"):
                continue
            out.update(_flatten(v, f"{prefix}{k}."))
    elif isinstance(d, list):
        for i, v in enumerate(d):
            key = f"{prefix}{v.get('id', i)}." if isinstance(v, dict) else f"{prefix}{i}."
            out.update(_flatten(v, key))
    else:
        out[prefix[:-1]] = d
    return out


def diff(old: dict, new: dict) -> list[dict]:
    a, b = _flatten(old), _flatten(new)
    return [{"key": k, "from": a.get(k), "to": b.get(k)} for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)]


class ConfigStore:
    def __init__(self, data_dir: Path, settings_path: Path | None = None):
        self.dir = data_dir
        self.settings = settings_path or data_dir / "settings.json"
        self.versions = data_dir / "versions"
        self.audit_path = data_dir / "audit.log"
        self._lock = threading.Lock()

    def current(self) -> dict:
        return json.loads(self.settings.read_text(encoding="utf-8"))

    def _numbers(self) -> list[int]:
        if not self.versions.exists():
            return []
        return sorted(int(p.stem[1:]) for p in self.versions.glob("v*.json") if p.stem[1:].isdigit())

    def list_versions(self) -> list[dict]:
        out = []
        for n in reversed(self._numbers()):
            meta = json.loads((self.versions / f"v{n:04d}.json").read_text(encoding="utf-8")).get("_meta", {})
            out.append({"version": n, **meta})
        return out

    def get_version(self, n: int) -> dict:
        return json.loads((self.versions / f"v{n:04d}.json").read_text(encoding="utf-8"))

    def save(self, cfg: dict, user: str, note: str = "") -> int:
        with self._lock:
            self.versions.mkdir(parents=True, exist_ok=True)
            try:
                old = self.current()
            except FileNotFoundError:
                old = {}
            nums = self._numbers()
            if not nums and old:
                # keep the config that was there before the first web save as v1
                first = dict(old)
                first["_meta"] = {"user": "system", "time": time.strftime("%Y-%m-%d %H:%M:%S"),
                                  "note": "ค่าก่อนแก้ไขครั้งแรกจากหน้าเว็บ", "changes": []}
                first["_version"] = 1
                _atomic_write(self.versions / "v0001.json", json.dumps(first, ensure_ascii=False, indent=2))
                nums = [1]
            n = (nums[-1] if nums else 0) + 1
            clean = {k: v for k, v in cfg.items() if not k.startswith("_")}
            changes = diff(old, clean)
            clean["_version"] = n
            stored = dict(clean)
            stored["_meta"] = {"user": user, "time": time.strftime("%Y-%m-%d %H:%M:%S"),
                               "note": note, "changes": changes[:50]}
            _atomic_write(self.versions / f"v{n:04d}.json", json.dumps(stored, ensure_ascii=False, indent=2))
            _atomic_write(self.settings, json.dumps(clean, ensure_ascii=False, indent=2))
            self.audit(user, "config_save", {"version": n, "changes": len(changes), "note": note})
            return n

    def audit(self, user: str, action: str, detail: dict | None = None) -> None:
        line = json.dumps({"t": time.strftime("%Y-%m-%d %H:%M:%S"), "user": user, "action": action,
                           "detail": detail or {}}, ensure_ascii=False)
        try:
            with self.audit_path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass

    def audit_tail(self, n: int = 50) -> list[dict]:
        if not self.audit_path.exists():
            return []
        lines = self.audit_path.read_text(encoding="utf-8").splitlines()[-n:]
        return [json.loads(x) for x in reversed(lines) if x.strip()]
