#!/usr/bin/env python3
"""
Generates the Racha app icon — no image libraries, just zlib and math.

The mark is the product in one shape: a plate seen from above, cut into three
unequal wedges. Unequal because that is the whole point — an equal split is the
lazy case, and Racha exists for the other one.

Palette is the app's own (warm white ground, burgundy, amber, sienna) so the
icon belongs to the same system as everything inside it.

    python3 scripts/make-icon.py path/to/icon.png [size]
"""
import math
import struct
import zlib
import sys
from pathlib import Path

SIZE = 1024

WARM_WHITE = (0xFA, 0xFA, 0xF9)
BURGUNDY = (0x9F, 0x12, 0x39)
AMBER = (0xD9, 0x77, 0x06)
SIENNA = (0x78, 0x35, 0x0F)
CHARCOAL = (0x1C, 0x19, 0x17)

# The three wedges, as (start_angle, end_angle, colour). Deliberately uneven.
WEDGES = [
    (-90.0, 40.0, BURGUNDY),
    (40.0, 165.0, AMBER),
    (165.0, 270.0, SIENNA),
]

GAP_DEGREES = 3.2          # the cut between wedges
PLATE_RADIUS = 0.34        # as a fraction of the icon side
RING_RADIUS = 0.415
AA = 2                     # supersampling factor


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def ground(nx, ny):
    """The warm four-orb background, in miniature."""
    r, g, b = WARM_WHITE
    orbs = [
        ((0.12, 0.18), 0.55, (0xD9, 0x77, 0x06), 0.20),
        ((0.88, 0.22), 0.48, (0xF5, 0x9E, 0x0B), 0.16),
        ((0.50, 0.95), 0.62, (0x9F, 0x12, 0x39), 0.13),
    ]
    for (cx, cy), radius, colour, alpha in orbs:
        d = math.hypot(nx - cx, ny - cy) / radius
        if d >= 1.0:
            continue
        falloff = (1.0 - d) ** 2
        r, g, b = lerp((r, g, b), colour, falloff * alpha)
    return (r, g, b)


def sample(nx, ny):
    """Colour at one normalised point."""
    dx, dy = nx - 0.5, ny - 0.5
    dist = math.hypot(dx, dy)

    if dist > RING_RADIUS:
        return ground(nx, ny)

    # A thin plate rim, so the disc reads as ceramic rather than as a pie chart.
    if dist > PLATE_RADIUS:
        t = (dist - PLATE_RADIUS) / (RING_RADIUS - PLATE_RADIUS)
        base = lerp((0xFF, 0xFF, 0xFF), ground(nx, ny), t)
        if 0.10 < t < 0.24:
            base = lerp(base, CHARCOAL, 0.10)
        return base

    angle = math.degrees(math.atan2(dy, dx)) % 360.0
    for start, end, colour in WEDGES:
        s, e = start % 360.0, end % 360.0
        inside = (s <= angle < e) if s < e else (angle >= s or angle < e)
        if not inside:
            continue
        # Gaps widen toward the rim, so the cuts read as knife strokes rather
        # than as a stroke of constant width.
        to_start = (angle - s) % 360.0
        to_end = (e - angle) % 360.0
        gap = GAP_DEGREES * (0.5 + 0.5 * (dist / PLATE_RADIUS))
        if to_start < gap or to_end < gap:
            return (0xFF, 0xFF, 0xFF)
        shade = 0.86 + 0.14 * (dist / PLATE_RADIUS)
        return tuple(min(255, int(c * shade)) for c in colour)
    return (0xFF, 0xFF, 0xFF)


def render(size):
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0, 0, 0]
            for sy in range(AA):
                for sx in range(AA):
                    nx = (px + (sx + 0.5) / AA) / size
                    ny = (py + (sy + 0.5) / AA) / size
                    r, g, b = sample(nx, ny)
                    acc[0] += r
                    acc[1] += g
                    acc[2] += b
            n = AA * AA
            row += bytes((acc[0] // n, acc[1] // n, acc[2] // n))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)   # 8-bit truecolour
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", header)
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    Path(path).write_bytes(png)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "icon.png"
    size = int(sys.argv[2]) if len(sys.argv) > 2 else SIZE
    write_png(out, render(size), size)
    print(f"wrote {out} ({size}x{size})")
