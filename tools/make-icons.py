#!/usr/bin/env python3
"""生成扩展图标（纯标准库写 PNG，无需 Pillow）。

风格对齐 Material You：圆角方块（squircle）+ 白色铃铛，
底色用 MD3 基线主色 #6750A4 —— 与扩展默认主题的种子色一致。
"""
import struct
import zlib
from pathlib import Path

BG = (0x67, 0x50, 0xA4, 255)  # MD3 基线主色
FG = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parents[1] / "icons"


def in_squircle(x, y, size, exponent=4.0):
    """超椭圆 |x|^n + |y|^n <= 1，比圆角矩形更接近 Material 的 squircle。"""
    half = size / 2
    dx = abs(x - half) / half
    dy = abs(y - half) / half
    return dx**exponent + dy**exponent <= 1.0


def in_bell(x, y, size):
    """归一化坐标下的铃铛：穹顶 + 外扩身体 + 底座 + 摆锤。"""
    u, v = x / size, y / size

    # 穹顶（半径取大一些，让肩部与下方身体平滑相接，不出现折角）
    if (u - 0.5) ** 2 + (v - 0.43) ** 2 <= 0.225**2:
        return True

    # 身体：从肩部向下外扩
    if 0.43 <= v <= 0.625:
        half_width = 0.225 + (v - 0.43) * 0.30
        if abs(u - 0.5) <= half_width:
            return True

    # 底座横条（两端圆头）
    if 0.625 <= v <= 0.675:
        half_width = 0.30
        dy = v - 0.65
        dx = max(0.0, abs(u - 0.5) - (half_width - 0.025))
        if dx**2 + dy**2 <= 0.025**2 or abs(u - 0.5) <= half_width - 0.025:
            return True

    # 摆锤
    if (u - 0.5) ** 2 + (v - 0.735) ** 2 <= 0.052**2:
        return True

    return False


def render(size):
    rows = []
    ss = 4  # 4x4 超采样抗锯齿
    total = ss * ss
    for y in range(size):
        row = bytearray()
        for x in range(size):
            background_hits = 0
            bell_hits = 0
            for sy in range(ss):
                for sx in range(ss):
                    px = x + (sx + 0.5) / ss
                    py = y + (sy + 0.5) / ss
                    if not in_squircle(px, py, size):
                        continue
                    background_hits += 1
                    if in_bell(px, py, size):
                        bell_hits += 1
            if background_hits == 0:
                row += bytes((0, 0, 0, 0))
                continue
            alpha = int(255 * background_hits / total)
            ratio = bell_hits / background_hits
            color = tuple(int(BG[i] + (FG[i] - BG[i]) * ratio) for i in range(3))
            row += bytes((color[0], color[1], color[2], alpha))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 48, 128):
        write_png(OUT / f"icon{size}.png", render(size), size)
        print(f"wrote {OUT / f'icon{size}.png'}")


if __name__ == "__main__":
    main()
