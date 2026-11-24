#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建「制定机关 → 省 / 市州」映射表，供 crawl_local.py 与前端两级菜单使用。

数据源：modood/Administrative-divisions-of-China 的 provinces/cities/areas.json
（已下载到 project/build/）
输出：project/tool/region_map.json

  prov  省全名 → 省全名（恒等）
  city  地级市名 → 省全名
  county 区县名 → [省全名, ...]（重名多解）
"""
from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD = os.path.join(ROOT, "build")
OUT = os.path.join(HERE, "region_map.json")

MUNI = {"11": "北京市", "12": "天津市", "31": "上海市", "50": "重庆市"}
SKIP_CITY = {"市辖区", "县", "省直辖县级行政区划", "自治区直辖县级行政区划"}


def load(fn):
    p = os.path.join(BUILD, fn)
    if not os.path.exists(p):
        # 区划数据未随仓库分发（region_map.json 已内置，一般无需重跑本脚本）；
        # 需要重新生成时自动下载
        import urllib.request
        os.makedirs(BUILD, exist_ok=True)
        url = "https://raw.githubusercontent.com/modood/Administrative-divisions-of-China/master/dist/" + fn
        print(f"  [下载] {url}")
        urllib.request.urlretrieve(url, p)
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def main() -> int:
    provs = load("provinces.json")
    cities = load("cities.json")
    areas = load("areas.json")

    pname = {p["code"]: p["name"] for p in provs}
    cname = {}
    city2prov = {}
    for c in cities:
        pc = c["provinceCode"]
        prov = MUNI.get(pc) or pname.get(pc)
        if not prov:
            continue
        if c["name"] in SKIP_CITY:
            # 直辖市 / 直辖县级：市名直接用省名
            cname[c["code"]] = MUNI.get(pc, c["name"])
        else:
            cname[c["code"]] = c["name"]
        city2prov[c["code"]] = prov

    county_map: dict[str, list[str]] = {}
    county2city: dict[str, str] = {}
    for a in areas:
        prov = MUNI.get(a["provinceCode"]) or pname.get(a["provinceCode"])
        if not prov:
            continue
        city = cname.get(a["cityCode"]) or prov
        county_map.setdefault(a["name"], [])
        if prov not in county_map[a["name"]]:
            county_map[a["name"]].append(prov)
        county2city.setdefault(a["name"], city)

    city_map = {}
    for code, name in cname.items():
        prov = city2prov[code]
        city_map.setdefault(name, prov)

    out = {
        "prov": {name: name for name in pname.values()},
        "city": city_map,
        "county2city": county2city,
        "county": county_map,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[+] prov={len(out['prov'])} city={len(out['city'])} "
          f"county={len(out['county'])} -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
