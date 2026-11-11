"""Resize assets/logo.png into extension icons without cropping or redrawing it.

Install optional build dependencies with:
    python -m pip install -r scripts/requirements-icons.txt
Then run:
    python scripts/build-icons.py
The checked-in PNGs are sufficient to install/build the extension normally.
"""

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "logo.png"
OUTPUT = ROOT / "extension" / "icons"
SIZES = (16, 32, 48, 128, 256)


def main():
    with Image.open(SOURCE) as source:
        if source.format != "PNG":
            raise ValueError("The logo source must be a PNG image.")
        if source.width != source.height:
            raise ValueError("The logo source must be square.")
        artwork = source.convert("RGBA")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        icon = artwork.resize((size, size), Image.Resampling.LANCZOS)
        target = OUTPUT / f"icon-{size}.png"
        icon.save(target, optimize=True)
        print(f"{target.relative_to(ROOT)} ({size} x {size})")


if __name__ == "__main__":
    main()
