"""Build prototypes/t3-simulator.html: the real T3 web UI + a simulated Pi, in one offline HTML file.

The UI files are copied from raspberry_pi/trafficlight/web/static as they are now, so the
simulator always looks and behaves like the Pi's web page. Only prototypes/sim_src/ is
simulator code (mock.js = controller rules + /api/* + hardware panel).

    python tools/build_t3_simulator.py
"""
from __future__ import annotations

import base64
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "raspberry_pi" / "trafficlight" / "web" / "static"
SRC = ROOT / "prototypes" / "sim_src"
OUT = ROOT / "prototypes" / "t3-simulator.html"

# index.html order, with the simulator's mock after led.js (drawLED) and before app.js (fetch override);
# sim.js (admin test drawer on the Pi) is left out: the simulator panel replaces it.
SCRIPTS = ["@example", "rotate.js", "led.js", "@mock.js", "draw.js", "diag.js", "timing.js", "vehicles.js",
           "wizard.js", "app.js", "osk.js", "@avatars.js"]


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8").replace("\r\n", "\n")


def script(body: str) -> str:
    return "<script>\n" + body.replace("</script", "<\\/script") + "\n</script>\n"


def example_js() -> str:
    sys.path.insert(0, str(ROOT / "raspberry_pi"))
    from trafficlight.t3.config import DEFAULTS
    example = json.loads(read(ROOT / "config" / "settings.t3.example.json"))
    fw = re.search(r'FIRMWARE_VERSION=\\"([^"\\]+)', read(ROOT / "esp32_display_t3" / "platformio.ini")).group(1)
    j = lambda o: json.dumps(o, ensure_ascii=False)
    return (f"window.__T3_EXAMPLE__ = {j(example)};\n"
            f"window.__T3_DEFAULTS__ = {j(DEFAULTS)};\n"
            f"window.__T3_FW__ = {j(fw)};\n"
            f"window.__T3_MAP__ = {j(read(STATIC / 'maps' / 'T3.svg'))};")


def main() -> int:
    logo = "data:image/png;base64," + base64.b64encode((STATIC / "logo.png").read_bytes()).decode()
    parts = []
    for name in SCRIPTS:
        if name == "@example":
            body = example_js()
        elif name.startswith("@"):
            body = read(SRC / name[1:])
        else:
            body = read(STATIC / name)
            if name == "app.js":
                body = body.replace("/static/logo.png", logo)
        parts.append(script(body))
    html = ("<!doctype html>\n<html lang=\"th\">\n<head>\n<meta charset=\"utf-8\">\n"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n"
            "<title>T3 Traffic Simulator</title>\n"
            "<meta name=\"description\" content=\"Click-through demo of the T3 junction web UI with a simulated controller\">\n"
            f"<style>\n{read(SRC / 'page.css')}\n</style>\n"
            f"<style>\n{read(STATIC / 'app.css')}\n{read(SRC / 'sim_panel.css')}\n</style>\n"
            "</head>\n<body>\n"
            "<div id=\"app\"><p style=\"padding:24px\">กำลังโหลด…</p></div>\n"
            "<dialog id=\"dlg\"></dialog>\n<div id=\"pop\" role=\"tooltip\"></div>\n"
            "<div id=\"toast\" role=\"status\" aria-live=\"polite\"></div>\n"
            + "".join(parts) + "</body>\n</html>\n")
    OUT.write_bytes(html.encode("utf-8"))
    print(f"{OUT.relative_to(ROOT)}  {len(html.encode('utf-8')) // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
