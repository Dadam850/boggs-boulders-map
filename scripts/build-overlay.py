#!/usr/bin/env python3
"""Georeference the official Boggs & Boulders trail sheet onto the park.

The sheet scale bar is 322 pixels = 1 km. The entrance ring (the lower-left
end of the thick black road) is the anchor, on the sandy gate at Brooklyn
Road. That north-up placement is still too big for the tan onX main loop.

The black centerline is fitted to those roads with a similarity around the
anchor: scale 0.8, rotate 1 degree clockwise, then shift 120 m east and
120 m north. Median distance to the nearest onX road drops from about 64 m
to about 25 m. An extra affine on top of that similarity does not sit
closer, so it is not applied.

Leaflet image overlays cannot rotate, so the rotation is baked into the
PNG. The phone still stretches a north-up transparent image between the
corners written into lib/park-bounds.json. The onX lines are not touched.

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
GEOJSON_PATH = ROOT / "public" / "trails.geojson"
PNG_PATH = ROOT / "public" / "trail-map.png"

# Entrance ring on the sheet, and where that ring sat before this fit.
ANCHOR_PX = (177.0, 527.0)
ANCHOR_LL = (31.2429996, -86.74987265)
# 322 px scale bar = 1 km, before the loop fit.
METERS_PER_PIXEL = 1000 / 322

# Similarity that seats the black loop on the onX roads. Meters are east
# and north of ANCHOR_LL, applied after scaling around the anchor.
SCALE = 0.8
ROT_DEG = -1.0
TX = 120.0
TY = 120.0
PAD_M = 8.0

RED = (225, 6, 0, 255)
BLACK = (17, 17, 17, 255)


def meters_to_ll(east: float, north: float):
    alat, alng = ANCHOR_LL
    lat = alat + north / 111_320
    lng = alng + east / (111_320 * math.cos(math.radians(alat)))
    return lat, lng


def ll_to_meters(lat: float, lng: float):
    alat, alng = ANCHOR_LL
    north = (lat - alat) * 111_320
    east = (lng - alng) * (111_320 * math.cos(math.radians(alat)))
    return east, north


def forward_meters(x, y, scale, rot_deg, tx, ty):
    """Sheet pixel -> meters east/north of the anchor."""
    rot = math.radians(rot_deg)
    c, s = math.cos(rot), math.sin(rot)
    east0 = (x - ANCHOR_PX[0]) * METERS_PER_PIXEL
    north0 = (ANCHOR_PX[1] - y) * METERS_PER_PIXEL
    east = scale * east0
    north = scale * north0
    return c * east - s * north + tx, s * east + c * north + ty


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


def skeletonize(mask: np.ndarray) -> np.ndarray:
    img = (mask.astype(np.uint8)) * 255
    skel = np.zeros(img.shape, np.uint8)
    element = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    while cv2.countNonZero(img):
        opened = cv2.morphologyEx(img, cv2.MORPH_OPEN, element)
        skel = cv2.bitwise_or(skel, cv2.subtract(img, opened))
        img = cv2.erode(img, element)
    return skel > 0


def road_segments(step: float = 6.0):
    """onX road samples and the segments that join them. Segments never cross features."""
    raw = json.loads(GEOJSON_PATH.read_text())
    pts = []
    segments = []
    for feature in raw["features"]:
        if feature.get("properties", {}).get("kind") != "road":
            continue
        coords = feature["geometry"]["coordinates"]
        for (lng0, lat0), (lng1, lat1) in zip(coords, coords[1:]):
            e0, n0 = ll_to_meters(lat0, lng0)
            e1, n1 = ll_to_meters(lat1, lng1)
            length = math.hypot(e1 - e0, n1 - n0)
            pieces = max(1, int(math.ceil(length / step)))
            start = len(pts)
            for index in range(pieces + 1):
                t = index / pieces
                pts.append((e0 + (e1 - e0) * t, n0 + (n1 - n0) * t))
            segments.append((start, len(pts) - 1))
    return np.asarray(pts, np.float64), segments


def loop_samples(black: np.ndarray):
    skel = skeletonize(black)
    ys, xs = np.nonzero(skel)
    ys = ys[::3].astype(np.float64)
    xs = xs[::3].astype(np.float64)
    return xs, ys, int(skel.sum())


def distance_to_roads(samples: list, roads: np.ndarray, segments: list, cell: float = 6.0):
    """Meters from each sample cloud to the nearest road pixel. One grid."""
    stacked = np.vstack(samples + [roads])
    margin = 400.0
    e0 = float(stacked[:, 0].min()) - margin
    n0 = float(stacked[:, 1].min()) - margin
    e1 = float(stacked[:, 0].max()) + margin
    n1 = float(stacked[:, 1].max()) + margin
    width = int(math.ceil((e1 - e0) / cell)) + 2
    height = int(math.ceil((n1 - n0) / cell)) + 2
    grid = np.full((height, width), 255, np.uint8)

    def pix(east, north):
        col = int(round((east - e0) / cell))
        row = int(round((n1 - north) / cell))
        return col, row

    for start, end in segments:
        cv2.line(grid, pix(*roads[start]), pix(*roads[end]), 0, 1)

    dist = cv2.distanceTransform(grid, cv2.DIST_L2, 5) * cell
    out = []
    for pts in samples:
        col = np.rint((pts[:, 0] - e0) / cell).astype(int)
        row = np.rint((n1 - pts[:, 1]) / cell).astype(int)
        inside = (col >= 0) & (col < width) & (row >= 0) & (row < height)
        vals = np.full(len(pts), 1e6)
        vals[inside] = dist[row[inside], col[inside]]
        if not inside.all():
            print("points outside road grid", int((~inside).sum()))
        out.append(vals)
    return out


def summarize(label: str, vals: np.ndarray):
    stats = {
        "med": float(np.median(vals)),
        "mean": float(np.mean(vals)),
        "p90": float(np.percentile(vals, 90)),
        "within25": float(np.mean(vals <= 25)),
        "within40": float(np.mean(vals <= 40)),
    }
    print(
        label,
        " ".join(f"{key}={value:.3f}" if key.startswith("within") else f"{key}={value:.2f}" for key, value in stats.items()),
    )
    return stats


def affine_residual(pts: np.ndarray, roads: np.ndarray):
    """ICP affine on top of the similarity. Reported only; not applied."""
    current = pts.copy()
    for _ in range(6):
        delta = current[:, None, :] - roads[None, :, :]
        nearest = roads[np.argmin(np.sum(delta * delta, axis=2), axis=1)]
        design = np.c_[current, np.ones(len(current))]
        solved, *_ = np.linalg.lstsq(design, nearest, rcond=None)
        current = design @ solved
    delta = current[:, None, :] - roads[None, :, :]
    dist = np.sqrt(np.min(np.sum(delta * delta, axis=2), axis=1))
    print(
        "affine-on-similarity",
        f"med={float(np.median(dist)):.2f}",
        f"mean={float(np.mean(dist)):.2f}",
        f"p90={float(np.percentile(dist, 90)):.2f}",
    )


def warp_masks(red: np.ndarray, black: np.ndarray):
    height, width = red.shape
    corners = [(0, 0), (width, 0), (0, height), (width, height)]
    placed = [forward_meters(x, y, SCALE, ROT_DEG, TX, TY) for x, y in corners]
    east = [p[0] for p in placed]
    north = [p[1] for p in placed]
    out_mpp = METERS_PER_PIXEL * SCALE
    e_min = math.floor((min(east) - PAD_M) / out_mpp) * out_mpp
    n_min = math.floor((min(north) - PAD_M) / out_mpp) * out_mpp
    e_max = math.ceil((max(east) + PAD_M) / out_mpp) * out_mpp
    n_max = math.ceil((max(north) + PAD_M) / out_mpp) * out_mpp
    out_w = int(round((e_max - e_min) / out_mpp))
    out_h = int(round((n_max - n_min) / out_mpp))

    cols = np.arange(out_w, dtype=np.float64)
    rows = np.arange(out_h, dtype=np.float64)
    ee = e_min + (cols + 0.5) * out_mpp
    nn = n_max - (rows + 0.5) * out_mpp
    east_grid, north_grid = np.meshgrid(ee, nn)

    rot = math.radians(ROT_DEG)
    c, s = math.cos(rot), math.sin(rot)
    e_adj = east_grid - TX
    n_adj = north_grid - TY
    east_s = c * e_adj + s * n_adj
    north_s = -s * e_adj + c * n_adj
    map_x = (east_s / SCALE / METERS_PER_PIXEL + ANCHOR_PX[0]).astype(np.float32)
    map_y = (ANCHOR_PX[1] - north_s / SCALE / METERS_PER_PIXEL).astype(np.float32)

    def sample(mask: np.ndarray) -> np.ndarray:
        warped = cv2.remap(
            (mask.astype(np.uint8) * 255),
            map_x,
            map_y,
            interpolation=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )
        return warped >= 40

    north_ll, west_ll = meters_to_ll(e_min, n_max)
    south_ll, east_ll = meters_to_ll(e_max, n_min)
    overlay = {"north": north_ll, "south": south_ll, "west": west_ll, "east": east_ll}
    return sample(red), sample(black), overlay, (out_w, out_h)


def main():
    image = np.array(Image.open(SHEET).convert("RGB"))
    red, black = ink_masks(image)
    xs, ys, skel_count = loop_samples(black)
    roads, segments = road_segments()
    before = np.column_stack(forward_meters(xs, ys, 1.0, 0.0, 0.0, 0.0))
    after = np.column_stack(forward_meters(xs, ys, SCALE, ROT_DEG, TX, TY))
    before_d, after_d = distance_to_roads([before, after], roads, segments)
    print("skeleton px", skel_count, "samples", len(xs), "road pts", len(roads))
    summarize("before", before_d)
    summarize("similarity", after_d)
    affine_residual(after, roads)

    # Anchor pixel must land on the translation, and the inverse must return it.
    landed = forward_meters(ANCHOR_PX[0], ANCHOR_PX[1], SCALE, ROT_DEG, TX, TY)
    if abs(landed[0] - TX) > 1e-6 or abs(landed[1] - TY) > 1e-6:
        raise SystemExit(f"anchor transform drifted: {landed}")

    red_out, black_out, overlay, size = warp_masks(red, black)
    rgba = np.zeros((size[1], size[0], 4), np.uint8)
    rgba[red_out] = RED
    rgba[black_out] = BLACK
    Image.fromarray(rgba, "RGBA").save(PNG_PATH, optimize=True)

    raw = json.loads(BOUNDS_PATH.read_text())
    view = {key: raw[key] for key in ("north", "south", "west", "east")}
    raw["overlay"] = overlay
    BOUNDS_PATH.write_text(json.dumps(raw, indent=2) + "\n")
    written = json.loads(BOUNDS_PATH.read_text())
    for key, value in view.items():
        if written[key] != value:
            raise SystemExit(f"view box changed: {key}")

    print("red px", int(red_out.sum()), "black px", int(black_out.sum()))
    print("overlay", json.dumps(overlay))
    print("png", PNG_PATH.stat().st_size, "size", size[0], size[1])


if __name__ == "__main__":
    main()
