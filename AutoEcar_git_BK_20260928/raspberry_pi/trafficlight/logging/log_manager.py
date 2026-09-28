from __future__ import annotations
from pathlib import Path
import sys
from loguru import logger

def setup_logging(cfg: dict):
    log_cfg = cfg["log"]
    log_dir = Path(log_cfg["directory"])
    log_dir.mkdir(parents=True, exist_ok=True)
    logger.remove()
    logger.add(sys.stderr, level=log_cfg.get("level", "INFO"), enqueue=True,
               format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level} | {message}")
    logger.add(log_dir / "traffic.log", level=log_cfg.get("level", "INFO"),
               rotation=log_cfg.get("rotation", "100 MB"),
               retention=log_cfg.get("retention", "7 days"),
               enqueue=True,
               format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level} | {message}")
    return logger
