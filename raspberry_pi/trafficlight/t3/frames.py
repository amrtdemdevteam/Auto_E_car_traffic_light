"""Display frame names shared by the controller, the web UI and the ESP32 firmware.

Frame ids (F01..F26) are documented in docs/T3_DESIGN.md section 9.
"""
from __future__ import annotations

START = "START"          # F01
REBOOT = "REBOOT"        # F02
LINKWAIT = "LINKWAIT"    # F03
STOP = "STOP"            # F04 (arg "Q" = X + blue dot: the lane is in the queue, firmware t3-1.4.0+)
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
GO_RIGHT = "GO_RIGHT"    # F28 green: one arrow, straight + right branch
GO_LEFT = "GO_LEFT"      # F29 green: one arrow, straight + left branch
LEFT_RIGHT = "LEFT_RIGHT"  # F30 green: one T arrow, left + right
GO_3WAY = "GO_3WAY"      # F31 green: one T arrow with a straight stem, straight + left + right
ARROW = "ARROW"          # F32 green: arrow built from a direction mask (arg = "1".."31")

STOP_QUEUED = "Q"        # STOP arg: the lane has a ticket and waits its turn

# Direction bits for ARROW. A lane's green_mask is the sum of the bits it shows.
DIR_BITS = {"L": 1, "UL": 2, "U": 4, "UR": 8, "R": 16}
MASK_MIN, MASK_MAX = 1, 31

ALL_FRAMES = {
    START, REBOOT, LINKWAIT, STOP, GO, HOLD, HAND1, HAND2, HANDOK, SENSOR,
    LINKLOST, CONFIG, MAINT, UPDATE, LINKOK, STOPHINT, ALLSTOP, CAUTION,
    LEFT, RIGHT, GO_N, STOP_N, TEST, GO_RIGHT, GO_LEFT,
    LEFT_RIGHT, GO_3WAY, ARROW,
}

# Frames that mean "you may go". The firmware only shows these while the
# command is fresh and the controller is online.
GREEN_FRAMES = {GO, LEFT, RIGHT, GO_N, GO_RIGHT, GO_LEFT, LEFT_RIGHT, GO_3WAY, ARROW}

# Frames a lane may be configured to show while it has the green.
LANE_GREEN_CHOICES = {GO, LEFT, RIGHT, GO_RIGHT, GO_LEFT, LEFT_RIGHT, GO_3WAY}


def is_green(frame: str) -> bool:
    return frame in GREEN_FRAMES


def valid_mask(mask) -> bool:
    """True for a direction mask with at least one direction (1..31)."""
    return isinstance(mask, int) and not isinstance(mask, bool) and MASK_MIN <= mask <= MASK_MAX


def mask_of(frame: str) -> int:
    """Direction mask that a legacy green_frame name shows (used by the web UI)."""
    return {
        GO: DIR_BITS["U"], LEFT: DIR_BITS["L"], RIGHT: DIR_BITS["R"],
        GO_RIGHT: DIR_BITS["U"] | DIR_BITS["R"], GO_LEFT: DIR_BITS["U"] | DIR_BITS["L"],
        LEFT_RIGHT: DIR_BITS["L"] | DIR_BITS["R"],
        GO_3WAY: DIR_BITS["L"] | DIR_BITS["U"] | DIR_BITS["R"],
    }.get(frame, DIR_BITS["U"])
