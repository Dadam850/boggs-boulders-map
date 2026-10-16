#!/usr/bin/env python3
"""Lock the trail overlay to Boggs & Boulders on Brooklyn Road.

The riding property is the sandy ground at 20133 Brooklyn Rd, Andalusia, AL
36421 (Google place pin 31.2429996, -86.7501038). An earlier box near
31.416, -86.572 is a different woods-road network about 15 miles northeast.

Control polylines below were digitized on a north-up z18 satellite mosaic
whose northwest tile is (67900, 107092). Preview pixels are on the 1400-wide
rendering of that 2048×3584 sheet. They convert through the Web Mercator tile
grid, so the lines sit on Esri World Imagery and on the Google satellite
fallback the same way.

Little tracks are red. The two pieces of the main sandy road are black.
"""

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
BOUNDS_PATH = ROOT / "lib" / "park-bounds.json"
LINES_PATH = ROOT / "public" / "trails.json"
PNG_PATH = ROOT / "public" / "trail-map.png"

Z = 18
TILE_X0 = 67900
TILE_Y0 = 107092
# Full mosaic is 8 × 14 tiles. The digitizing view was 1400 px wide.
PREVIEW_PER_FULL = 2048 / 1400

# Preview-pixel polylines. road=True is the main sandy road.
TRACKS = [
    {
        "road": True,
        "points": [
            [380, 1898], [410, 1878], [450, 1848], [490, 1810], [520, 1770],
            [532, 1725], [542, 1680], [555, 1635], [572, 1585], [592, 1535],
            [604, 1488], [616, 1445], [626, 1400], [628, 1376], [648, 1360],
            [664, 1348], [670, 1342], [676, 1336], [688, 1328], [688, 1320],
        ],
    },
    {
        "road": False,
        "points": [[720, 1288], [716, 1272], [708, 1248], [707, 1224], [703, 1208]],
    },
    {
        "road": True,
        "points": [
            [522, 780], [523, 762], [525, 748], [531, 733], [546, 719],
            [560, 703], [567, 688], [578, 673], [589, 657], [604, 643],
            [644, 628], [659, 599],
        ],
    },
    {
        "road": False,
        "points": [
            [578, 1195], [574, 1172], [570, 1150], [566, 1128], [562, 1105],
            [548, 1080], [532, 1055], [520, 1032], [512, 1010], [498, 988],
            [478, 966], [458, 946], [440, 930],
        ],
    },
    {
        "road": False,
        "points": [
            [712, 1178], [700, 1158], [690, 1138], [678, 1115], [666, 1092],
            [655, 1070], [650, 1050], [656, 1032], [665, 1015],
        ],
    },
    {
        "road": False,
        "points": [
            [835, 1100], [828, 1080], [818, 1055], [805, 1030], [795, 1005],
            [788, 980], [782, 955], [785, 930], [788, 905],
        ],
    },
    {
        "road": False,
        "points": [
            [940, 1168], [968, 1186], [990, 1204], [1002, 1222], [996, 1240],
            [1016, 1260], [1036, 1280], [1050, 1300],
        ],
    },
    {
        # Outer sandy rim of the berm bowl. The south notch that dipped into
        # the trees is left out; the chord stays on the rim.
        "road": False,
        "points": [
            [790, 1655], [806, 1688], [812, 1722], [800, 1743], [784, 1764],
            [760, 1778], [748, 1782], [736, 1781], [612, 1782], [596, 1758],
            [584, 1730], [578, 1700], [582, 1672],
        ],
    },
]


def tile_nw(x: float, y: float, z: int):
    n = 2**z
    lng = x / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lat, lng


def latlng_to_tile(lat: float, lng: float, z: int):
    n = 2**z
    x = (lng + 180) / 360 * n
    latr = math.radians(lat)
    y = (1 - math.log(math.tan(latr) + 1 / math.cos(latr)) / math.pi) / 2 * n
    return x, y


def preview_to_latlng(px: float, py: float):
    fx = px * PREVIEW_PER_FULL
    fy = py * PREVIEW_PER_FULL
    lat, lng = tile_nw(TILE_X0 + fx / 256, TILE_Y0 + fy / 256, Z)
    return [round(lat, 7), round(lng, 7)]


def main():
    lines = []
    lats = []
    lngs = []
    for track in TRACKS:
        path = [preview_to_latlng(x, y) for x, y in track["points"]]
        lines.append({"road": track["road"], "path": path})
        for lat, lng in path:
            lats.append(lat)
            lngs.append(lng)

    # About 80 m of sand and entrance road around the ink.
    pad_lat = 80 / 111_320
    pad_lng = 80 / (111_320 * math.cos(math.radians(sum(lats) / len(lats))))
    bounds = {
        "north": max(lats) + pad_lat,
        "south": min(lats) - pad_lat,
        "west": min(lngs) - pad_lng,
        "east": max(lngs) + pad_lng,
    }
    BOUNDS_PATH.write_text(json.dumps(bounds, indent=2) + "\n")
    LINES_PATH.write_text(json.dumps({"lines": lines}, separators=(",", ":")) + "\n")

    # Transparent preview locked to the same bounds, north up.
    width = 1400
    height = max(1, round(width * (bounds["north"] - bounds["south"]) / (bounds["east"] - bounds["west"]) * math.cos(math.radians(31.246))))
    # Web mercator y, not linear latitude, so the png matches the tile grid.
    x0, y0 = latlng_to_tile(bounds["north"], bounds["west"], Z)
    x1, y1 = latlng_to_tile(bounds["south"], bounds["east"], Z)
    png = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(png)

    def project(lat, lng):
        x, y = latlng_to_tile(lat, lng, Z)
        px = (x - x0) / (x1 - x0) * (width - 1)
        py = (y - y0) / (y1 - y0) * (height - 1)
        return px, py

    for line in lines:
        pts = [project(lat, lng) for lat, lng in line["path"]]
        if line["road"]:
            draw.line(pts, fill=(17, 17, 17, 255), width=6, joint="curve")
        else:
            draw.line(pts, fill=(225, 6, 0, 255), width=4, joint="curve")
    PNG_PATH.parent.mkdir(parents=True, exist_ok=True)
    png.save(PNG_PATH, optimize=True)
    print("bounds", json.dumps(bounds))
    print("lines", len(lines), "png", png.size, PNG_PATH.stat().st_size)


if __name__ == "__main__":
    main()
