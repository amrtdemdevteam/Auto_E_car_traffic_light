#!/usr/bin/env python3
"""Build the T3 display firmware once on a development PC and collect the files the Pi burns.

    python tools/build_t3_firmware.py            # build every t3_displayN env in esp32_display_t3/platformio.ini
    python tools/build_t3_firmware.py 1 3        # only displays 1 and 3

Needs PlatformIO (the `pio` command) and internet the first time. Output goes to
firmware/t3/display<N>/{bootloader,partitions,boot_app0,firmware}.bin  -> commit these files,
then the Pi can burn any display from the setup wizard with no internet and no PC.
Nothing here is hard-coded per display: the list of displays comes from platformio.ini.
"""
import os
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROJ = ROOT / "esp32_display_t3"
OUT = ROOT / "firmware" / "t3"
FILES = ["bootloader.bin", "partitions.bin", "firmware.bin"]


def envs() -> list[int]:
    ini = (PROJ / "platformio.ini").read_text(encoding="utf-8")
    return sorted(int(n) for n in re.findall(r"^\[env:t3_display(\d+)\]", ini, re.M))


def boot_app0() -> pathlib.Path:
    cands = list(pathlib.Path.home().glob(".platformio/packages/framework-arduinoespressif32*/tools/partitions/boot_app0.bin"))
    if not cands:
        sys.exit("boot_app0.bin not found: run one `pio run` first so PlatformIO downloads the framework")
    return cands[0]


def main() -> None:
    want = [int(a) for a in sys.argv[1:]] or envs()
    penv = pathlib.Path.home() / ".platformio" / "penv" / ("Scripts" if os.name == "nt" else "bin")
    pio = (os.environ.get("PIO") or shutil.which("pio") or shutil.which("platformio")
           or next((str(p) for p in (penv / "pio.exe", penv / "pio") if p.is_file()), None))
    if not pio:
        sys.exit("PlatformIO not found (pip install platformio, or use the VS Code extension's terminal)")
    for n in want:
        print(f"== building t3_display{n} ==", flush=True)
        subprocess.run([pio, "run", "-e", f"t3_display{n}"], cwd=PROJ, check=True)
        src = PROJ / ".pio" / "build" / f"t3_display{n}"
        dst = OUT / f"display{n}"
        dst.mkdir(parents=True, exist_ok=True)
        for f in FILES:
            shutil.copy2(src / f, dst / f)
        shutil.copy2(boot_app0(), dst / "boot_app0.bin")
        print(f"   -> {dst}")
    print("\nDone. Commit firmware/t3/ and push; the Pi burns these from the setup wizard.")


if __name__ == "__main__":
    main()
