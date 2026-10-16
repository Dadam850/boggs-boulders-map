#!/usr/bin/env python3
"""Georeference the official Boggs & Boulders trail sheet onto the park.

The sheet is north-up. Its scale bar (bottom right) is divided 0, 1/8, 1/4,
1/2, 1 and measures 322 pixels. Matched to the satellite, that bar is 1 km
(3.106 m/pixel). The entrance ring is the lower-left end of the black road
and sits on the sandy gate at Brooklyn Road, 22 m east of the Google place
pin.

The phone draws the sheet itself: the aerial photo, scale bar, north arrow,
and logo are cleared, and the red loops and black road stay as continuous
ink. Leaflet stretches that transparent image between the sheet's corners.

Requires: pillow, numpy, opencv-python-headless.
"""

import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SHEET = ROOT / "scripts" / "official-map.jpg"
BOUNDS_PATH = ROOT / "lib" / "park-bounds.json"
PNG_PATH = ROOT / "public" / "trail-map.png"

# Entrance ring on the sheet, and where that ring sits on the ground.
ANCHOR_PX = (177, 527)
ANCHOR_LL = (31.2429996, -86.74987265)
# 322 px scale bar = 1 km.
METERS_PER_PIXEL = 1000 / 322

RED = (225, 6, 0, 255)
BLACK = (17, 17, 17, 255)


def to_latlng(x: float, y: float):
    ax, ay = ANCHOR_PX
    alat, alng = ANCHOR_LL
    east = (x - ax) * METERS_PER_PIXEL
    north = (ay - y) * METERS_PER_PIXEL
    lat = alat + north / 111_320
    lng = alng + east / (111_320 * math.cos(math.radians(alat)))
    return lat, lng


def keep_large(mask: np.ndarray, min_area: int) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    if count <= 1:
        return mask
    keep = np.zeros(mask.shape, bool)
    for index, area in enumerate(stats[1:, cv2.CC_STAT_AREA], start=1):
        if int(area) >= min_area:
            keep[labels == index] = True
    return keep


def ink_masks(image: np.ndarray):
    """Red loops and the black road, with the sheet furniture removed."""
    hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
    _hue, sat, val = cv2.split(hsv)
    red_ch, green_ch, blue_ch = (image[:, :, i].astype(np.int16) for i in range(3))
    excess = red_ch - np.maximum(green_ch, blue_ch)
    region = np.ones(val.shape, bool)
    region[745:, 900:] = False  # scale bar
    region[:125, 1160:] = False  # north arrow
    region[720:, :180] = False  # logo
    region[:6, :] = False
    region[-6:, :] = False
    region[:, :6] = False
    region[:, -6:] = False

    red = (excess >= 18) & (red_ch > 110) & (sat > 40) & region
    red = keep_large(red, 40)

    # Close fills the short breaks in the printed road (including the fold
    # line) without swallowing the red loops or the dark tree texture.
    dark = (val < 78) & (sat < 100) & (excess < 22) & (red_ch < 100) & region
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
    closed = cv2.morphologyEx(dark.astype(np.uint8), cv2.MORPH_CLOSE, kernel)
    black = keep_large(closed.astype(bool), 120)
    return red, black


def main():
    image = np.array(Image.open(SHEET).convert("RGB"))
    red, black = ink_masks(image)
    rgba = np.zeros((*image.shape[:2], 4), np.uint8)
    rgba[red] = RED
    rgba[black] = BLACK
    Image.fromarray(rgba, "RGBA").save(PNG_PATH, optimize=True)

    height, width = image.shape[:2]
    north, west = to_latlng(0, 0)
    south, east = to_latlng(width, height)
    raw = json.loads(BOUNDS_PATH.read_text())
    raw["overlay"] = {"north": north, "south": south, "west": west, "east": east}
    BOUNDS_PATH.write_text(json.dumps(raw, indent=2) + "\n")

    print("red px", int(red.sum()), "black px", int(black.sum()))
    print("overlay", json.dumps(raw["overlay"]))
    print("png", PNG_PATH.stat().st_size, "size", width, height)


if __name__ == "__main__":
    main()
