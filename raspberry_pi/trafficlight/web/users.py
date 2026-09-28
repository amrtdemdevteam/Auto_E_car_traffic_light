"""Command line account management for the web UI.

  trafficlight-user add engineer01 --role editor
  trafficlight-user passwd engineer01
  trafficlight-user list
  trafficlight-user delete operator01
"""
from __future__ import annotations

import argparse
import getpass
from pathlib import Path

from .store import Users


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="trafficlight-user")
    ap.add_argument("--data-dir", default="/etc/trafficlight")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("name")
    a.add_argument("--role", choices=("editor", "viewer"), default="viewer")
    p = sub.add_parser("passwd")
    p.add_argument("name")
    sub.add_parser("list")
    d = sub.add_parser("delete")
    d.add_argument("name")
    args = ap.parse_args(argv)
    users = Users(Path(args.data_dir) / "users.json")

    if args.cmd == "list":
        for u in users.list():
            print(f"{u['name']:<20} {u['role']:<8} {u.get('created') or ''}")
        return 0
    if args.cmd == "delete":
        users.delete(args.name)
        print(f"ลบ {args.name} แล้ว")
        return 0
    pw = getpass.getpass("รหัสผ่าน (อย่างน้อย 8 ตัว): ")
    if pw != getpass.getpass("ยืนยันรหัสผ่าน: "):
        print("รหัสผ่านไม่ตรงกัน")
        return 1
    try:
        users.set(args.name, pw, args.role if args.cmd == "add" else None)
    except ValueError as exc:
        print(exc)
        return 1
    print(f"บันทึก {args.name} แล้ว")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
