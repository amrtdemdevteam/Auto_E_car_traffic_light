from __future__ import annotations
from dataclasses import dataclass
import serial
from loguru import logger

@dataclass(frozen=True)
class TFMiniFrame:
    distance_cm: int
    strength: int
    temperature_raw: int
    raw_hex: str = ""

class TFMiniReader:
    HEADER = b"\x59\x59"

    def __init__(self, port: str, baudrate: int = 115200, timeout: float = 0.05):
        self.port = port
        self.serial = serial.Serial(port, baudrate=baudrate, timeout=timeout)
        self.buffer = bytearray()

    def close(self):
        if self.serial and self.serial.is_open:
            self.serial.close()

    def read_available(self) -> list[TFMiniFrame]:
        waiting = self.serial.in_waiting
        chunk = self.serial.read(waiting or 1)
        if chunk:
            self.buffer.extend(chunk)
        frames: list[TFMiniFrame] = []
        while True:
            idx = self.buffer.find(self.HEADER)
            if idx < 0:
                if len(self.buffer) > 1:
                    del self.buffer[:-1]
                break
            if idx:
                del self.buffer[:idx]
            if len(self.buffer) < 9:
                break
            raw = bytes(self.buffer[:9])
            if (sum(raw[:8]) & 0xFF) != raw[8]:
                logger.debug(f"TFMINI {self.port} checksum_error raw={raw.hex(' ')}")
                del self.buffer[0]
                continue
            dist = raw[2] | (raw[3] << 8)
            strength = raw[4] | (raw[5] << 8)
            temp = raw[6] | (raw[7] << 8)
            frames.append(TFMiniFrame(dist, strength, temp, raw.hex(" ")))
            del self.buffer[:9]
        return frames
