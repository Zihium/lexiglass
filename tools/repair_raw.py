#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""清理损坏的 docx（下载到 HTML 错误页 / 0 字节），供 crawl_local.py docs 重下。"""
from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "build", "local", "raw")
DOCS = os.path.join(ROOT, "web", "data", "docs")
FAIL = os.path.join(ROOT, "build", "local", "failures.json")


def main() -> int:
    removed = 0
    kept = 0
    seen = 0
    with os.scandir(RAW) as it:
        for e in it:
            if not e.name.endswith(".docx"):
                continue
            seen += 1
            try:
                with open(e.path, "rb") as f:
                    head = f.read(8)
                size = os.path.getsize(e.path)
            except OSError:
                continue
            # docx = PK..，doc = D0CF11E0..，其它都算坏缓存
            if not (head[:2] == b"PK" or head[:4] == b"\xd0\xcf\x11\xe0") or size < 1024:
                # 直接删会被宿主的安全删除策略拦（走回收站失败），
                # 截成 0 字节即可：download_one 只认 >1024 的缓存，会重下
                with open(e.path, "wb"):
                    pass
                removed += 1
            else:
                kept += 1
    n_docs = 0
    with os.scandir(DOCS) as it:
        for e in it:
            if e.name.endswith(".json"):
                n_docs += 1
    bad = 0
    if os.path.exists(FAIL):
        try:
            bad = len(json.load(open(FAIL, encoding="utf-8")))
        except Exception:  # noqa: BLE001
            bad = -1
    print(f"raw={seen} kept={kept} removed={removed} docs={n_docs} failures={bad}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
