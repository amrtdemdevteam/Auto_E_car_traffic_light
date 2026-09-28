"""Display frame names shared by the controller, the web UI and the ESP32 firmware.

Frame ids (F01..F26) are documented in docs/T3_DESIGN.md section 9.
"""
from __future__ import annotations

START = "START"          # F01
REBOOT = "REBOOT"        # F02
LINKWAIT = "LINKWAIT"    # F03
STOP = "STOP"            # F04
GO = "GO"                # F05
HOLD = "HOLD"            # F06
HAND1 = "HAND1"          # F07
HAND2 = "HAND2"          # F08
HANDOK = "HANDOK"        # F09
SENSOR = "SENSOR"        # F10 (arg = sensor id)
LINKLOST = "LINKLOST"    # F11
CONFIG = "CONFIG"        # F12
MAINT = "MAINT"          # F13
UPDATE = "UPDATE"        # F14
LINKOK = "LINKOK"        # F15 (reserve)
STOPHINT = "STOPHINT"    # F16 (reserve)
ALLSTOP = "ALLSTOP"      # F17 (reserve)
CAUTION = "CAUTION"      # F18 (reserve, disabled in T3)
LEFT = "LEFT"            # F19 (reserve)
RIGHT = "RIGHT"          # F20 (reserve)
GO_N = "GO_N"            # F21-F23 (reserve, arg 3/2/1)
STOP_N = "STOP_N"        # F24-F26 (reserve, arg 3/2/1)
TEST = "TEST"            # F27 identify a display from the web UI (arg = "B<n>")

ALL_FRAMES = {
    START, REBOOT, LINKWAIT, STOP, GO, HOLD, HAND1, HAND2, HANDOK, SENSOR,
    LINKLOST, CONFIG, MAINT, UPDATE, LINKOK, STOPHINT, ALLSTOP, CAUTION,
    LEFT, RIGHT, GO_N, STOP_N, TEST,
}

# Frames that mean "you may go". The firmware only shows these while the
# command is fresh and the controller is online.
GREEN_FRAMES = {GO, LEFT, RIGHT, GO_N}

# Frames a lane may be configured to show while it has the green.
LANE_GREEN_CHOICES = {GO, LEFT, RIGHT}


def is_green(frame: str) -> bool:
    return frame in GREEN_FRAMES
