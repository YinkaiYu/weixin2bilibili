"""Render the supplied IOP vector PDF into extension icons without redrawing it.

Install optional build dependencies with:
    python -m pip install -r scripts/requirements-icons.txt
Then run:
    python scripts/build-icons.py
The checked-in PNGs are sufficient to install/build the extension normally.
"""

from pathlib import Path
from io import BytesIO

import pymupdf
from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "iop-logo.pdf"
OUTPUT = ROOT / "extension" / "icons"
SIZES = (16, 32, 48, 128, 256)


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with pymupdf.open(SOURCE) as document:
        if document.page_count != 1:
            raise ValueError("The logo source must contain exactly one page.")
        page = document[0]
        scale = 2048 / max(page.rect.width, page.rect.height)
        pixels = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=True)
        # MuPDF's raw pixels use premultiplied alpha. Its PNG encoder converts
        # them to ordinary RGBA, avoiding dark edges when Pillow scales the seal.
        artwork = Image.open(BytesIO(pixels.tobytes("png"))).convert("RGBA")

    for size in SIZES:
        # Retain the complete seal and its original colors on transparent corners.
        # A narrow inset prevents the circular artwork from touching toolbar edges.
        inset = max(1, round(size / 32))
        edge = size - 2 * inset
        logo = artwork.copy()
        logo.thumbnail((edge, edge), Image.Resampling.LANCZOS)
        icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        icon.alpha_composite(logo, ((size - logo.width) // 2, (size - logo.height) // 2))
        target = OUTPUT / f"icon-{size}.png"
        icon.save(target, optimize=True)
        print(f"{target.relative_to(ROOT)} ({size} x {size})")


if __name__ == "__main__":
    main()
