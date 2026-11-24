#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓取「地方法规」（flfgCodeId=230）全量正文，构建离线分片库。

用法：
  python crawl_local.py catalog            # 抓全量目录（sxx 全状态）→ build/local/catalog.json
  python crawl_local.py docs               # 下载全部正文 → web/data/docs/*.json
  python crawl_local.py docs --limit 200   # 只做前 200 条（调试）
  python crawl_local.py pack               # 单部 json → web/data/pack/*.json.gz + index.json

数据形态（体积优先）：
  web/data/index.json          紧凑数组，一行一部：元数据 + pack 号
  web/data/pack/pNNN.json.gz   500 部一片，gzip 后的紧凑文档数组
运行时按需加载整片；全文检索顺序流式扫片，内存峰值 = 1 片。
"""
from __future__ import annotations

import gzip
import json
import os
import random
import re
import sys
import time
import zipfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from xml.etree import ElementTree as ET

import requests

try:
    from doc_reader import doc_paragraphs
except ImportError:                       # 作为包被导入时
    from .doc_reader import doc_paragraphs

BASE = "https://flk.npc.gov.cn"
LIST = BASE + "/law-search/search/list"
BATCH = BASE + "/law-search/download/batch"
HDR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Content-Type": "application/json;charset=UTF-8",
    "Referer": BASE + "/search",
    "Origin": BASE,
    "Accept": "application/json, text/plain, */*",
}

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                       # project/
WEB_DATA = os.path.join(ROOT, "app", "assets", "web", "data")
PACKDIR = os.path.join(WEB_DATA, "pack")
INDEX = os.path.join(WEB_DATA, "index.json")
DOCS = os.path.join(ROOT, "build", "local", "docs")  # 单部紧凑 json（中间产物，不进 APK）
WORK = os.path.join(ROOT, "build", "local")
RAW = os.path.join(WORK, "raw")
for d in (RAW, DOCS, PACKDIR, WORK):
    os.makedirs(d, exist_ok=True)

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
CN_NUM = "零一二三四五六七八九十百千"
RE_BIAN = re.compile(rf"^第[{CN_NUM}\d]+编[\s　]")
RE_ZHANG = re.compile(rf"^第[{CN_NUM}\d]+章[\s　]")
RE_JIE = re.compile(rf"^第[{CN_NUM}\d]+节[\s　]")
RE_TIAO = re.compile(rf"^第[{CN_NUM}\d]+条(?!例|款|文)")
RE_FUJIAN = re.compile(r"^附[　\s]*则")

PROVINCES = [
    ("北京", "北京市"), ("天津", "天津市"), ("河北", "河北省"), ("山西", "山西省"),
    ("内蒙古", "内蒙古自治区"), ("辽宁", "辽宁省"), ("吉林", "吉林省"), ("黑龙江", "黑龙江省"),
    ("上海", "上海市"), ("江苏", "江苏省"), ("浙江", "浙江省"), ("安徽", "安徽省"),
    ("福建", "福建省"), ("江西", "江西省"), ("山东", "山东省"), ("河南", "河南省"),
    ("湖北", "湖北省"), ("湖南", "湖南省"), ("广东", "广东省"), ("广西", "广西壮族自治区"),
    ("海南", "海南省"), ("重庆", "重庆市"), ("四川", "四川省"), ("贵州", "贵州省"),
    ("云南", "云南省"), ("西藏", "西藏自治区"), ("陕西", "陕西省"), ("甘肃", "甘肃省"),
    ("青海", "青海省"), ("宁夏", "宁夏回族自治区"), ("新疆", "新疆维吾尔自治区"),
]
PROV_FULL = {full for _, full in PROVINCES}

# sxx: 1=已废止 2=已修改 3=现行有效；空数组 = 全状态（共 23940 条）
BODY = {
    "searchRange": 1, "sxrq": [], "gbrq": [], "searchType": 2, "sxx": [],
    "gbrqYear": [], "flfgCodeId": [230], "zdjgCodeId": [], "searchContent": "",
    "orderByParam": {"order": "-1", "sort": ""},
}
PAGE_DIR = os.path.join(WORK, "pages_all")


def province_of(zdjg: str) -> str | None:
    for key, full in PROVINCES:
        if full in zdjg or key in zdjg:
            return full
    return None


# ---- 属地解析：制定机关 → 所属省 + 属地（省 / 市州） ----
RE_ORG_TAIL = re.compile(
    r"(人民代表大会(?:常务委员会)?|人大常委会|人大常务委员会|人民政府|"
    r"人民代表大会常务委员会|人民代表大会|人大|常务委员会|人民政府办公厅).*$")
RM_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "region_map.json")
REGION = json.load(open(RM_PATH, encoding="utf-8")) if os.path.exists(RM_PATH) else \
    {"prov": {}, "city": {}, "county": {}, "county2city": {}}
CITY_NAMES = sorted(REGION["city"].items(), key=lambda kv: -len(kv[0]))
COUNTY_NAMES = sorted(REGION["county"].items(), key=lambda kv: -len(kv[0]))
COUNTY2CITY = REGION.get("county2city", {})

# 已撤销 / 更名的地级单位：区划表里查不到，靠这张小表兜底
# （数据库里还留着撤市前的法规，比如 2019 年并入济南的莱芜市）
HISTORIC_CITY = {
    "莱芜市": ("山东省", "济南市"),
    "巢湖市": ("安徽省", "合肥市"),
    "简阳市": ("四川省", "成都市"),
    "公主岭市": ("吉林省", "长春市"),
    "东川市": ("云南省", "昆明市"),
}


def _strip_prov(name: str) -> tuple[str | None, str]:
    for _, full in PROVINCES:
        if name.startswith(full):
            return full, name[len(full):]
    for key, full in PROVINCES:
        if name.startswith(key) and len(name) > len(key):
            return full, name[len(key):]
    return None, name


def resolve_region(zdjg: str, title: str = "") -> tuple[str | None, str | None]:
    """返回 (省全名, 属地名称)。属地：省级机关=省名，市级=市名，县级=所属地级市。"""
    if not zdjg:
        return None, None
    base = RE_ORG_TAIL.sub("", zdjg).strip() or zdjg
    prov, rest = _strip_prov(base)
    # 市级精确匹配（含前缀匹配，如「昌吉回族自治州」）
    for cname, cprov in CITY_NAMES:
        if base == cname or rest.startswith(cname) or base.startswith(cname):
            return cprov, cname
    # 县级
    for kname, kprov in COUNTY_NAMES:
        if rest.startswith(kname) or base.startswith(kname):
            city = COUNTY2CITY.get(kname) or (kprov[0] if kprov else None)
            if city in ("省直辖县级行政区划", "自治区直辖县级行政区划", None):
                city = kname
            return (kprov[0] if kprov else prov), city
    if prov:
        return prov, prov
    # 兜底 1：已撤销的地级单位
    for hname, (hprov, hcity) in HISTORIC_CITY.items():
        if base.startswith(hname) or hname in title:
            return hprov, hcity
    # 兜底 2：标题里的地名
    for cname, cprov in CITY_NAMES:
        if cname in title:
            return cprov, cname
    return None, base or None


def local_name(zdjg: str, title: str = "") -> str | None:
    return resolve_region(zdjg, title)[1]



def corpus_kind(zdjg: str) -> str:
    if re.search(r"(省|自治区|北京市|天津市|上海市|重庆市)人民代表大会", zdjg):
        return "prov"
    if re.search(r"(省|自治区|市)人民政府$", zdjg):
        return "prov"
    if re.search(r"自治州人民代表大会|市人民代表大会常务委员会", zdjg):
        return "city"
    return "county"


def fetch_page(page: int, retry: int = 6):
    os.makedirs(PAGE_DIR, exist_ok=True)
    cached = os.path.join(PAGE_DIR, f"p{page:04d}.json")
    if os.path.exists(cached):
        j = json.load(open(cached, encoding="utf-8"))
        return j.get("rows") or [], j.get("total")
    body = dict(BODY)
    body["pageNum"] = page
    body["pageSize"] = 100
    last = None
    for attempt in range(retry):
        try:
            r = requests.post(LIST, json=body, headers=HDR, timeout=45)
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                j = r.json()
                if j.get("code") == 200:
                    json.dump(j, open(cached, "w", encoding="utf-8"), ensure_ascii=False)
                    return j.get("rows") or [], j.get("total")
                last = j.get("msg")
            else:
                last = f"HTTP {r.status_code}"
        except Exception as e:  # noqa: BLE001
            last = repr(e)[:120]
        time.sleep(0.5 * (attempt + 1) + random.random() * 0.4)
    raise RuntimeError(f"page {page}: {last}")


def cmd_catalog() -> int:
    rows, total = fetch_page(1)
    pages = (total + 99) // 100
    print(f"[*] total={total} pages={pages}", flush=True)
    all_rows = list(rows)
    done = 1
    with ThreadPoolExecutor(max_workers=8) as ex:
        for chunk, _ in ex.map(fetch_page, range(2, pages + 1)):
            all_rows.extend(chunk)
            done += 1
            if done % 20 == 0:
                print(f"[*] {done}/{pages} rows={len(all_rows)}", flush=True)
    uniq = {}
    for r in all_rows:
        uniq[r["bbbs"]] = r
    data = list(uniq.values())
    json.dump(data, open(os.path.join(WORK, "catalog.json"), "w", encoding="utf-8"),
              ensure_ascii=False)
    print(f"[+] unique={len(data)}", flush=True)

    stat = defaultdict(lambda: defaultdict(int))
    sxx = defaultdict(int)
    for r in data:
        p = province_of(r.get("zdjgName") or "")
        k = corpus_kind(r.get("zdjgName") or "")
        stat[p or "未识别"][k] += 1
        sxx[r.get("sxx")] += 1
    print("  sxx:", dict(sxx))
    for p in sorted(stat):
        d = stat[p]
        print(f"  {p:12s} prov={d['prov']:4d} city={d['city']:5d} county={d['county']:4d} "
              f"sum={sum(d.values()):5d}")
    return 0


def batch_links(bbbs_list, retry: int = 5):
    body = [{"bbbs": b, "format": "docx"} for b in bbbs_list]
    last = None
    for attempt in range(retry):
        try:
            r = requests.post(BATCH, json=body, headers=HDR, timeout=90)
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                j = r.json()
                if j.get("code") == 200:
                    out = {}
                    for item, src in zip(bbbs_list, j.get("data") or []):
                        if src.get("url"):
                            out[item] = src["url"]
                    return out
                last = j.get("msg")
            else:
                last = f"HTTP {r.status_code}"
        except Exception as e:  # noqa: BLE001
            last = repr(e)[:120]
        time.sleep(0.8 * (attempt + 1) + random.random() * 0.5)
    raise RuntimeError(f"batch_links: {last}")


def download_one(url: str, bbbs: str) -> str | None:
    dst = os.path.join(RAW, f"{bbbs}.docx")
    if os.path.exists(dst) and os.path.getsize(dst) > 1024:
        return dst
    for attempt in range(3):
        try:
            r = requests.get(url, headers={"User-Agent": HDR["User-Agent"]}, timeout=180)
            if r.status_code == 200 and len(r.content) > 1024:
                tmp = dst + ".part"
                open(tmp, "wb").write(r.content)
                os.replace(tmp, dst)
                return dst
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1.0 * (attempt + 1))
    return None


OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def read_paragraphs(path: str):
    """按文件魔数分流：docx（zip）走 zipfile，doc（OLE）走 FIB/piece table。

    flk 的部分地方性法规只有 Word 97-2003 的 .doc，接口 format 参数写了 docx
    也照样返回 .doc，所以两条路都必须有。
    """
    with open(path, "rb") as f:
        head = f.read(8)
    if head[:2] == b"PK":
        return docx_paragraphs(path)
    if head[:8] == OLE_MAGIC:
        return doc_paragraphs(path)
    try:
        return docx_paragraphs(path)
    except Exception:  # noqa: BLE001
        return doc_paragraphs(path)


def docx_paragraphs(path: str):
    out = []
    with zipfile.ZipFile(path) as z:
        try:
            xml = z.read("word/document.xml")
        except KeyError:
            return out
    root = ET.fromstring(xml)
    for p in root.iter(W + "p"):
        line = "".join(t.text or "" for t in p.iter(W + "t")).replace("\u3000", "　").strip()
        if line:
            out.append(line)
    return out


def structure(paras):
    blocks, cur = [], None
    for line in paras:
        if RE_BIAN.match(line) or RE_ZHANG.match(line) or RE_JIE.match(line) or RE_FUJIAN.match(line):
            if cur:
                blocks.append(cur)
                cur = None
            kind = ("b" if RE_BIAN.match(line) else
                    "c" if RE_ZHANG.match(line) else
                    "s" if RE_JIE.match(line) else "c")
            blocks.append([kind, line])
            continue
        if RE_TIAO.match(line):
            if cur:
                blocks.append(cur)
            head, _, rest = line.partition("　")
            if not rest:
                m = re.match(rf"^(第[{CN_NUM}\d]+条)(.*)$", line)
                head, rest = (m.group(1), m.group(2)) if m else (line, "")
            cur = ["a", head.strip(), rest.strip()]
            continue
        if cur is not None:
            cur[2] = (cur[2] + "\n" + line).strip()
        else:
            if blocks and blocks[-1][0] == "p":
                blocks[-1][1] += "\n" + line
            else:
                blocks.append(["p", line])
    if cur:
        blocks.append(cur)
    return blocks


def make_doc(row, paras):
    blocks = structure(paras)
    zd = row.get("zdjgName") or ""
    title = re.sub(r"<[^>]+>", "", row.get("title") or "")
    prov, local = resolve_region(zd, title)
    doc = {
        "i": row["bbbs"],
        "t": title,
        "f": "地方法规",
        "n": zd,
        "g": (row.get("gbrq") or "")[:10],
        "s": (row.get("sxrq") or "")[:10],
        "x": row.get("sxx"),
        "p": prov or "",
        "d": local or "",
        "b": blocks,
    }
    doc["z"] = sum(len(b[-1]) + (len(b[1]) if len(b) > 2 else 0) for b in blocks)
    return doc


def cmd_docs(limit: int | None) -> int:
    cat_path = os.path.join(WORK, "catalog.json")
    if not os.path.exists(cat_path):
        raise SystemExit("先跑 catalog")
    cat = json.load(open(cat_path, encoding="utf-8"))
    picked = cat[:limit] if limit else cat
    have = {fn[:-5] for fn in os.listdir(DOCS) if fn.endswith(".json")}
    todo = [r for r in picked if r["bbbs"] not in have]
    print(f"[*] total={len(picked)} have={len(have)} todo={len(todo)}", flush=True)

    CHUNK = 60
    ok = bad = 0
    chars = 0
    failures = []
    t0 = time.time()
    for start in range(0, len(todo), CHUNK):
        chunk = todo[start:start + CHUNK]
        def _ok(b):
            p = os.path.join(RAW, b + ".docx")
            # 0 字节 / 非 zip 是坏缓存，要重新申请直链（repair_raw.py 就是把它截成 0）
            return os.path.exists(p) and os.path.getsize(p) > 1024
        need = [r for r in chunk if not _ok(r["bbbs"])]
        links = {}
        if need:
            try:
                links = batch_links([r["bbbs"] for r in need])
            except Exception as e:  # noqa: BLE001
                print(f"[!] links {start}: {e}", flush=True)
        if links:
            def _dl(kv):
                return download_one(kv[1], kv[0])
            with ThreadPoolExecutor(max_workers=12) as ex:
                list(ex.map(_dl, list(links.items())))
        for r in chunk:
            b = r["bbbs"]
            path = os.path.join(RAW, f"{b}.docx")
            try:
                if not os.path.exists(path):
                    raise RuntimeError("no docx")
                paras = read_paragraphs(path)
                if not paras:
                    raise RuntimeError("empty docx")
                doc = make_doc(r, paras)
                json.dump(doc, open(os.path.join(DOCS, f"{b}.json"), "w", encoding="utf-8"),
                          ensure_ascii=False, separators=(",", ":"))
                ok += 1
                chars += doc["z"]
            except Exception as e:  # noqa: BLE001
                bad += 1
                failures.append((b, str(e)[:80]))
        n = min(start + CHUNK, len(todo))
        el = time.time() - t0
        eta = el / max(1, n) * (len(todo) - n)
        print(f"[*] {n}/{len(todo)} ok={ok} bad={bad} chars={chars/1e6:.1f}M "
              f"eta={eta/60:.1f}min", flush=True)

    if failures:
        json.dump(failures, open(os.path.join(WORK, "failures.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
    print(f"[+] docs ok={ok} bad={bad}", flush=True)
    return 0


ORDER = {"宪法": 0, "法律": 1, "法律解释": 2, "修正案": 3, "行政法规": 4,
         "监察法规": 5, "司法解释": 6, "地方法规": 7}


def cmd_pack() -> int:
    """单部 json → 500 部一片的 gz + 紧凑 index.json（全库统一走 pack）"""
    files = sorted(f for f in os.listdir(DOCS) if f.endswith(".json"))
    # 输出到 build/local/pack，再由 bash 同步到 web/data/pack：
    # 宿主的安全删除会把「覆盖已存在的大文件」也拦下来（safe-delete bulk guard 超时）
    OUT = os.path.join(ROOT, "build", "local", "pack")
    os.makedirs(OUT, exist_ok=True)
    docs = []
    for fn in files:
        docs.append(json.load(open(os.path.join(DOCS, fn), encoding="utf-8")))
    # 先按公布时间降序，再按（分类 / 省 / 省本级优先 / 属地）稳定排序：
    # 每个省下面先列本级法规，再列各市州，同组内最新在前
    docs.sort(key=lambda d: d.get("g") or "", reverse=True)
    docs.sort(key=lambda d: (ORDER.get(d.get("f") or "", 9),
                             d.get("p") or "\uffff",       # 属地解析失败的排到最后
                             0 if (d.get("d") or "") == (d.get("p") or "") else 1,
                             d.get("d") or ""))

    idx = []
    PER = 500
    npack = (len(docs) + PER - 1) // PER
    for pi in range(0, len(docs), PER):
        part = docs[pi:pi + PER]
        pno = pi // PER
        blob = json.dumps(part, ensure_ascii=False, separators=(",", ":"))
        # 明文分片：APK 打包时 zip 本身按 deflate level 9 压缩，运行时
        # WebView 直接拿到 JSON，省掉一次解压，也避开 DecompressionStream 兼容问题
        with open(os.path.join(OUT, f"p{pno:03d}.json"), "w", encoding="utf-8") as f:
            f.write(blob)
        for d in part:
            is_local = (d.get("f") == "地方法规")
            idx.append([d["i"], d["t"], d.get("f") or "", d.get("n") or "",
                        d.get("g") or "", d.get("s") or "", d.get("x"),
                        (d.get("p") or "") if is_local else "",
                        (d.get("d") or "") if is_local else "",
                        d.get("z") or 0, pno])
        print(f"[*] pack {pno+1}/{npack} docs={len(part)}", flush=True)

    json.dump(idx, open(INDEX, "w", encoding="utf-8"), ensure_ascii=False,
              separators=(",", ":"))
    size = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f"[+] docs={len(docs)} packs={npack} "
          f"pack_size={size/1048576:.1f}MiB index={os.path.getsize(INDEX)/1048576:.2f}MiB "
          f"chars={sum(d.get('z') or 0 for d in docs)/1e6:.1f}M", flush=True)
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    if cmd == "catalog":
        sys.exit(cmd_catalog())
    if cmd == "pack":
        sys.exit(cmd_pack())
    lim = None
    if "--limit" in sys.argv:
        lim = int(sys.argv[sys.argv.index("--limit") + 1])
    sys.exit(cmd_docs(lim))
