#!/usr/bin/env python3
"""Generate the plugin's PNG icons.

No third-party deps: writes PNGs straight out with zlib + struct so the icons
can be regenerated on any machine with a stock Python 3.

    python3 tools/make-icons.py
"""

import os
import struct
import zlib

# A 4x4 nearest-neighbour downsample of a disc: reads as "mosaic" at 24px.
GLYPH = [
    [0.16, 0.46, 0.46, 0.16],
    [0.46, 1.00, 1.00, 0.46],
    [0.46, 1.00, 1.00, 0.46],
    [0.16, 0.46, 0.46, 0.16],
]

THEMES = {
    "dark": (255, 255, 255),   # light glyph for dark UI themes
    "light": (34, 34, 34),     # dark glyph for light UI themes
}

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)


def write_png(path, width, height, pixels):
    """pixels: flat bytearray of width*height*4 RGBA."""
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0
        raw.extend(pixels[y * stride:(y + 1) * stride])

    def chunk(tag, payload):
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    with open(path, "wb") as handle:
        handle.write(
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b"")
        )


def render(size, rgb):
    """Draw the glyph as a 4x4 grid of blocks with one-unit gutters."""
    unit = size // 24
    block = 5 * unit
    gap = 1 * unit
    span = 4 * block + 3 * gap
    origin = (size - span) // 2

    pixels = bytearray(size * size * 4)
    red, green, blue = rgb

    for row in range(4):
        for col in range(4):
            alpha = int(round(GLYPH[row][col] * 255))
            x0 = origin + col * (block + gap)
            y0 = origin + row * (block + gap)
            for y in range(y0, y0 + block):
                for x in range(x0, x0 + block):
                    offset = (y * size + x) * 4
                    pixels[offset] = red
                    pixels[offset + 1] = green
                    pixels[offset + 2] = blue
                    pixels[offset + 3] = alpha
    return pixels


def main():
    out_dir = os.path.join(ROOT, "icons")
    os.makedirs(out_dir, exist_ok=True)
    for name, rgb in THEMES.items():
        for size, suffix in ((24, ""), (48, "@2x")):
            path = os.path.join(out_dir, f"{name}{suffix}.png")
            write_png(path, size, size, render(size, rgb))
            print(f"wrote {os.path.relpath(path, ROOT)} ({size}x{size})")


if __name__ == "__main__":
    main()
