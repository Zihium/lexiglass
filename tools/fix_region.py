#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按新规则重算全部 doc 的 p / d（属地），并重写单部 json。

用在修改 region_map / HISTORIC_CITY 之后，不必重新下载正文：
  python tool/fix_region.py            # 只改 p 为空的
  python tool/fix_region.py --all      # 全量重算
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from crawl_local import DOCS, resolve_region  # noqa: E402


def main() -> int:
    only_empty = "--all" not in sys.argv
    changed = 0
    total = 0
    with os.scandir(DOCS) as it:
        for e in it:
            if not e.name.endswith(".json"):
                continue
            total += 1
            with open(e.path, encoding="utf-8") as f:
                d = json.load(f)
            if d.get("f") != "地方法规":
                continue
            if only_empty and d.get("p"):
                continue
            prov, local = resolve_region(d.get("n") or "", d.get("t") or "")
            if (prov or "") == (d.get("p") or "") and (local or "") == (d.get("d") or ""):
                continue
            d["p"] = prov or ""
            d["d"] = local or ""
            with open(e.path, "w", encoding="utf-8") as f:
                json.dump(d, f, ensure_ascii=False, separators=(",", ":"))
            changed += 1
    print(f"total={total} changed={changed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
