#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""读取 Word 97-2003 二进制 .doc（OLE 复合文档 + FIB + piece table），
输出纯文本段落列表，供 crawl_local.py 的 structure() 复用。

flk.npc.gov.cn 的部分地方性法规只提供 .doc（没有 docx），
所以下载链路必须同时支持两种格式。
"""
from __future__ import annotations

import struct

import olefile


class DocError(RuntimeError):
    pass


def _fib(wd: bytes):
    """返回 (table_name, fcClx, lcbClx)"""
    if len(wd) < 0x01AA:
        raise DocError("WordDocument 流过短")
    w_ident = struct.unpack_from("<H", wd, 0)[0]
    if w_ident != 0xA5EC:
        raise DocError(f"不是 Word 文件（wIdent=0x{w_ident:04X}）")
    flags = struct.unpack_from("<H", wd, 0x0A)[0]
    table_name = "1Table" if (flags & 0x0200) else "0Table"
    fc_clx, lcb_clx = struct.unpack_from("<II", wd, 0x01A2)
    return table_name, fc_clx, lcb_clx


def _pieces(wd: bytes, table: bytes, fc_clx: int, lcb_clx: int):
    clx = table[fc_clx:fc_clx + lcb_clx]
    if not clx:
        raise DocError("Clx 为空")
    i = 0
    while i < len(clx) and clx[i] == 0x01:          # 跳过 Prc（快速保存的格式增量）
        cb = struct.unpack_from("<h", clx, i + 1)[0]
        i += 3 + cb
    if i >= len(clx) or clx[i] != 0x02:
        raise DocError("找不到 Pcdt")
    lcb = struct.unpack_from("<I", clx, i + 1)[0]
    plc = clx[i + 5:i + 5 + lcb]
    n = (lcb - 4) // 12
    if n <= 0:
        raise DocError("piece 数为 0")
    cps = [struct.unpack_from("<I", plc, 4 * k)[0] for k in range(n + 1)]
    for k in range(n):
        off = 4 * (n + 1) + 8 * k
        fc = struct.unpack_from("<I", plc, off + 2)[0]
        compressed = bool(fc & 0x40000000)
        fc &= 0x3FFFFFFF
        ln = cps[k + 1] - cps[k]
        if ln <= 0 or ln > 5_000_000:
            continue
        if compressed:
            raw = wd[fc // 2: fc // 2 + ln]
            yield raw.decode("cp1252", "ignore")
        else:
            raw = wd[fc: fc + ln * 2]
            yield raw.decode("utf-16-le", "ignore")


CLEAN = {
    "\r": "\n",      # 段落结束
    "\x0b": "\n",    # 软换行
    "\x0c": "\n",    # 分页
    "\x07": "\t",    # 单元格 / 行结束
    "\x1e": "-",     # 不间断连字符
    "\x1f": "",      # 可选连字符
    "\x13": "", "\x14": "", "\x15": "",   # 域代码标记
    "\x01": "", "\x02": "", "\x08": "",   # 图片 / 脚注锚点
    "\x00": "",
}


def doc_paragraphs(path: str) -> list[str]:
    """返回按段落切好的纯文本行"""
    with olefile.OleFileIO(path) as ole:
        if not ole.exists("WordDocument"):
            raise DocError("没有 WordDocument 流")
        wd = ole.openstream("WordDocument").read()
        table_name, fc_clx, lcb_clx = _fib(wd)
        if not ole.exists(table_name):
            table_name = "1Table" if ole.exists("1Table") else "0Table"
        if not ole.exists(table_name):
            raise DocError("没有 Table 流")
        table = ole.openstream(table_name).read()
        text = "".join(_pieces(wd, table, fc_clx, lcb_clx))
    for k, v in CLEAN.items():
        text = text.replace(k, v)
    out = []
    for line in text.split("\n"):
        line = line.replace("\u3000", "　").strip()
        if line:
            out.append(line)
    return out


if __name__ == "__main__":
    import sys
    for p in sys.argv[1:]:
        paras = doc_paragraphs(p)
        print(f"== {p} lines={len(paras)} chars={sum(len(x) for x in paras)}")
        for x in paras[:8]:
            print("   ", x[:70])
