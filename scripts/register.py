#!/usr/bin/env python3
"""Register (or unregister) p2m-auto-formalization in the OpenCode config.

Usage:
  register.py            # add the plugin entry if missing
  register.py --remove   # remove the plugin entry
  register.py --check    # report only

The config is JSON (opencode.json). A timestamped backup is written before any
change. The plugin path is the deployed copy, not the source checkout.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time

CONFIG = os.path.expanduser("~/.opencode2/config/opencode/opencode.json")
PACKAGE = os.path.expanduser("~/.opencode2/plugins/p2m-auto-formalization")


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def find(plugins: list[dict]) -> int:
    for i, item in enumerate(plugins):
        if item.get("package") == PACKAGE:
            return i
    return -1


def main() -> int:
    ap = argparse.ArgumentParser()
    grp = ap.add_mutually_exclusive_group()
    grp.add_argument("--remove", action="store_true")
    grp.add_argument("--check", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(CONFIG):
        print(f"missing config: {CONFIG}", file=sys.stderr)
        return 1

    cfg = load(CONFIG)
    plugins = cfg.setdefault("plugins", [])
    idx = find(plugins)

    if args.check:
        print(json.dumps({"registered": idx >= 0, "index": idx, "package": PACKAGE}))
        return 0

    if args.remove:
        if idx < 0:
            print(json.dumps({"registered": False, "changed": False}))
            return 0
        plugins.pop(idx)
    else:
        options = {"booksDir": "./books"}
        if idx >= 0:
            current = plugins[idx].setdefault("options", {})
            if current.get("booksDir") == options["booksDir"]:
                print(json.dumps({"registered": True, "changed": False, "index": idx}))
                return 0
            current["booksDir"] = options["booksDir"]
        else:
            plugins.append({"package": PACKAGE, "options": options})

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"{CONFIG}.bak-{stamp}-pre-p2m-af"
    shutil.copy2(CONFIG, backup)

    tmp = f"{CONFIG}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, CONFIG)

    # Re-parse to prove the file is still valid JSON.
    load(CONFIG)
    print(json.dumps({"registered": not args.remove, "changed": True,
                      "index": find(cfg["plugins"]), "backup": backup}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
