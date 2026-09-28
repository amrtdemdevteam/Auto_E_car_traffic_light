from __future__ import annotations
import json
from pathlib import Path

DEFAULT_CONFIG = Path("/etc/trafficlight/settings.json")

def load_config(path: str | Path = DEFAULT_CONFIG) -> dict:
    p = Path(path)
    with p.open("r", encoding="utf-8") as f:
        return json.load(f)
