#!/usr/bin/env python3
"""Georeference the official Boggs & Boulders trail map onto the park.

The sheet is north-up. Its scale bar (bottom right) is divided 0, 1/8, 1/4,
1/2, 1 and measures 322 pixels. Matched to the satellite, that bar is 1 km
(3.106 m/pixel). The entrance ring is the lower-left end of the black road.

That ring sits on the sandy gate at Brooklyn Road, 22 m east of the Google
place pin (the campground building). From there the sheet covers the pads,
the pit, and the trails north and east: about 3.5 km by 2.1 km, a 2,000 acre
bounding box.

Requires: pillow, numpy, opencv-python-headless, scikit-image.
"""

import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw
from skimage.morphology import skeletonize

ROOT = Path(__file__).resolve().parents[1]
SHEET = ROOT / "scripts" / "official-map.jpg"
BOUNDS_PATH = ROOT / "lib" / "park-bounds.json"
LINES_PATH = ROOT / "public" / "trails.json"
PNG_PATH = ROOT / "public" / "trail-map.png"

# Entrance ring on the sheet, and where that ring sits on the ground.
ANCHOR_PX = (177, 527)
ANCHOR_LL = (31.2429996, -86.74987265)
# 322 px scale bar = 1 km.
METERS_PER_PIXEL = 1000 / 322


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


def to_latlng(x: float, y: float):
    ax, ay = ANCHOR_PX
    alat, alng = ANCHOR_LL
    east = (x - ax) * METERS_PER_PIXEL
    north = (ay - y) * METERS_PER_PIXEL
    lat = alat + north / 111_320
    lng = alng + east / (111_320 * math.cos(math.radians(alat)))
    return [round(lat, 7), round(lng, 7)]


def masks(image: np.ndarray):
    hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
    hue, sat, val = cv2.split(hsv)
    red_ch, green_ch, blue_ch = (image[:, :, i].astype(np.int16) for i in range(3))
    excess = red_ch - np.maximum(green_ch, blue_ch)
    region = np.zeros(val.shape, bool)
    region[12:785, 20:1295] = True
    region[745:, 900:] = False  # scale bar
    region[:110, 1180:] = False  # north arrow
    region[740:, :120] = False  # logo
    red = ((excess > 34) & (red_ch > 100) & (sat > 30) & region).astype(np.uint8) * 255
    black = ((val < 60) & (sat < 90) & (np.abs(red_ch - green_ch) < 30) & region).astype(np.uint8) * 255
    red = cv2.morphologyEx(red, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2, 2)))
    black = cv2.morphologyEx(black, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    return red > 0, black > 0


def trace(mask: np.ndarray):
    ys, xs = np.where(mask)
    points = {(int(x), int(y)) for x, y in zip(xs, ys)}
    neighbors = {}
    for x, y in points:
        nbs = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                q = (x + dx, y + dy)
                if q in points:
                    nbs.append(q)
        neighbors[(x, y)] = nbs

    def edge(a, b):
        return (a, b) if a <= b else (b, a)

    used = set()
    paths = []

    def walk(start, nxt):
        path = [start]
        prev, cur = start, nxt
        used.add(edge(prev, cur))
        while True:
            path.append(cur)
            onward = [n for n in neighbors[cur] if n != prev]
            if len(neighbors[cur]) != 2 or not onward:
                break
            nxt = onward[0]
            link = edge(cur, nxt)
            if link in used:
                break
            used.add(link)
            prev, cur = cur, nxt
        return path

    for point, nbs in neighbors.items():
        if len(nbs) == 2:
            continue
        for nxt in nbs:
            if edge(point, nxt) not in used:
                paths.append(walk(point, nxt))
    for point, nbs in neighbors.items():
        if len(nbs) != 2:
            continue
        for nxt in nbs:
            if edge(point, nxt) not in used:
                paths.append(walk(point, nxt))
    return paths


def path_length(path):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(path, path[1:]))


def simplify(points, eps: float):
    if len(points) < 3:
        return points
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]

    def perp(p, a, b):
        x, y = p
        x1, y1 = a
        x2, y2 = b
        dx, dy = x2 - x1, y2 - y1
        if dx == 0 and dy == 0:
            return math.hypot(x - x1, y - y1)
        t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
        return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))

    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        idx, dist = i, 0.0
        for k in range(i + 1, j):
            d = perp(points[k], points[i], points[j])
            if d > dist:
                idx, dist = k, d
        if dist > eps:
            keep.add(idx)
            stack.append((i, idx))
            stack.append((idx, j))
    return [points[i] for i in sorted(keep)]


def merge_ends(paths, max_gap: float):
    """Join breaks of a few pixels so a trail stays one line."""
    paths = [list(p) for p in paths if len(p) >= 2]
    if len(paths) < 2:
        return paths
    parent = list(range(len(paths)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    ends = []
    for i, path in enumerate(paths):
        ends.append((i, 0, path[0]))
        ends.append((i, 1, path[-1]))
    pairs = []
    for a in range(len(ends)):
        i, side, p = ends[a]
        for b in range(a + 1, len(ends)):
            j, side2, q = ends[b]
            if i == j:
                continue
            gap = math.hypot(p[0] - q[0], p[1] - q[1])
            if gap <= max_gap:
                pairs.append((gap, i, side, j, side2))
    pairs.sort()
    used = set()
    links = {}
    for gap, i, side, j, side2 in pairs:
        if find(i) == find(j):
            continue
        if (i, side) in used or (j, side2) in used:
            continue
        used.add((i, side))
        used.add((j, side2))
        parent[find(i)] = find(j)
        links[(i, side)] = (j, side2)
        links[(j, side2)] = (i, side)
    seen = set()
    merged = []
    for start in range(len(paths)):
        if start in seen:
            continue
        node, side = start, 0
        while (node, side) in links and links[(node, side)][0] not in seen:
            nxt, nside = links[(node, side)]
            node, side = nxt, 1 - nside
            if node == start:
                break
        order, flips = [], []
        guard = 0
        while node not in seen and guard <= len(paths):
            seen.add(node)
            order.append(node)
            flips.append(side == 1)
            guard += 1
            link = links.get((node, 1 if side == 0 else 0))
            if not link:
                break
            node, nside = link
            side = 1 - nside
        chain = []
        for idx, flip in zip(order, flips):
            part = paths[idx]
            if flip:
                part = list(reversed(part))
            chain.extend(part)
        if chain:
            merged.append(chain)
    return merged


def ink_paths(mask: np.ndarray, min_len: float, eps: float, gap: float):
    skel = skeletonize(mask)
    raw = [p for p in trace(skel) if path_length(p) >= min_len]
    joined = merge_ends(raw, gap)
    out = []
    for path in joined:
        if path_length(path) < min_len:
            continue
        simple = simplify(path, eps)
        if len(simple) >= 2:
            out.append(simple)
    return out, int(skel.sum())


def main():
    image = np.array(Image.open(SHEET).convert("RGB"))
    red_mask, black_mask = masks(image)
    red_paths, red_px = ink_paths(red_mask, 6, 0.9, 7)
    black_paths, black_px = ink_paths(black_mask, 10, 1.1, 8)
    lines = [{"road": False, "path": [to_latlng(x, y) for x, y in path]} for path in red_paths]
    lines += [{"road": True, "path": [to_latlng(x, y) for x, y in path]} for path in black_paths]
    lats = [pt[0] for line in lines for pt in line["path"]]
    lngs = [pt[1] for line in lines for pt in line["path"]]
    # A little sand around the ink so the default view shows the whole sheet.
    pad_lat = 60 / 111_320
    pad_lng = 60 / (111_320 * math.cos(math.radians(ANCHOR_LL[0])))
    bounds = {
        "north": max(lats) + pad_lat,
        "south": min(lats) - pad_lat,
        "west": min(lngs) - pad_lng,
        "east": max(lngs) + pad_lng,
    }
    BOUNDS_PATH.write_text(json.dumps(bounds, indent=2) + "\n")
    LINES_PATH.write_text(json.dumps({"lines": lines}, separators=(",", ":")) + "\n")

    width = 1600
    x0, y0 = latlng_to_tile(bounds["north"], bounds["west"], 18)
    x1, y1 = latlng_to_tile(bounds["south"], bounds["east"], 18)
    height = max(1, round(width * (y1 - y0) / (x1 - x0)))
    png = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(png)

    def project(lat, lng):
        x, y = latlng_to_tile(lat, lng, 18)
        return ((x - x0) / (x1 - x0) * (width - 1), (y - y0) / (y1 - y0) * (height - 1))

    for line in lines:
        pts = [project(lat, lng) for lat, lng in line["path"]]
        if line["road"]:
            draw.line(pts, fill=(17, 17, 17, 255), width=5, joint="curve")
        else:
            draw.line(pts, fill=(225, 6, 0, 255), width=3, joint="curve")
    png.save(PNG_PATH, optimize=True)

    cos = math.cos(math.radians(ANCHOR_LL[0]))
    north_m = (bounds["north"] - bounds["south"]) * 111_320
    east_m = (bounds["east"] - bounds["west"]) * 111_320 * cos
    print("red skeleton px", red_px, "paths", len(red_paths))
    print("black skeleton px", black_px, "paths", len(black_paths))
    print("bounds", json.dumps(bounds))
    print("span m", round(east_m), "E-W", round(north_m), "N-S", "bbox acres", round(north_m * east_m / 4046.86))
    print("png", png.size, PNG_PATH.stat().st_size, "json", LINES_PATH.stat().st_size)


if __name__ == "__main__":
    main()
