#!/usr/bin/env python3
"""Trace onX Offroad screenshots into navigation trails for Boggs & Boulders.

The close west screenshot is locked to Google satellite at the campground
pads (about 10 m). The east screenshot is locked the same way, using the pit
pond and clearings across that frame (typical residual under 15 m). Blue
strokes become trails and the thin tan strokes become roads. The wider
screenshot is only a reference; its corners extrapolate and are not traced.

Requires: pillow, numpy, opencv-python-headless, scikit-image.
"""

import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from skimage.morphology import skeletonize

ROOT = Path(__file__).resolve().parents[1]
ONX = ROOT / "scripts" / "onx"
BOUNDS_PATH = ROOT / "lib" / "park-bounds.json"
GEOJSON_PATH = ROOT / "public" / "trails.geojson"

# West screenshot corners after the satellite nudge (east ~34 m, south ~15 m).
WEST_N, WEST_W = 31.25786, -86.75264
WEST_S, WEST_E = 31.23586, -86.73364
# East screenshot, shifted north onto the pit pond. Checked against satellite
# patches across the frame; typical residual is under 15 m.
EAST_N, EAST_W = 31.25837, -86.73564
EAST_S, EAST_E = 31.21937, -86.69664
# West image owns ground west of this meridian; east image owns the rest.
SEAM_LNG = -86.736

RES = 2.0  # meters per grid cell
LAT0 = 31.22
LNG0 = -86.76


def ll_of_rect(x, y, width, height, north, west, south, east):
    lng = west + (x + 0.5) / width * (east - west)
    lat = north + (y + 0.5) / height * (south - north)
    return lat, lng


def to_xy(lat, lng):
    x = (lng - LNG0) * 111_320 * math.cos(math.radians(LAT0))
    y = (lat - LAT0) * 111_320
    return x, y


def meters_to_ll(x, y):
    lat = LAT0 + y / 111_320
    lng = LNG0 + x / (111_320 * math.cos(math.radians(LAT0)))
    return lat, lng


def ink_masks(image):
    red, green, blue = (image[:, :, i].astype(np.int16) for i in range(3))
    trails = (blue > 120) & (blue > red + 60) & (blue > green + 40) & (red < 90) & (green < 140) & (blue < 220)
    dist = np.sqrt(((image.astype(np.int16) - np.array([168, 142, 105])) ** 2).sum(axis=2))
    # The stroke is a tight tan (about 168, 142, 105). Sand and RV pads are
    # much lighter, so a small color radius misses them. Loops at the
    # campground are thicker than a single track, so the density cap has to
    # stay high enough to keep those strokes and still drop a filled pit.
    roads = dist < 11
    density = cv2.blur(roads.astype(np.float32), (17, 17))
    roads = roads & (density < 0.55)

    def punch(mask, core_r, grow):
        binary = mask.astype(np.uint8)
        core = (cv2.distanceTransform(binary, cv2.DIST_L2, 3) >= core_r).astype(np.uint8)
        if core.any():
            kill = cv2.dilate(core, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (grow, grow)))
            binary[kill > 0] = 0
        count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
        keep = np.zeros_like(binary)
        for index, area in enumerate(stats[1:, cv2.CC_STAT_AREA], start=1):
            if int(area) >= 30:
                keep[labels == index] = 1
        return keep.astype(bool)

    return punch(trails, 6, 28), punch(roads, 5, 18)


def similarity(src_bgr, dst_bgr, name):
    sift = cv2.SIFT_create(nfeatures=6000)
    k1, d1 = sift.detectAndCompute(cv2.cvtColor(src_bgr, cv2.COLOR_RGB2GRAY), None)
    k2, d2 = sift.detectAndCompute(cv2.cvtColor(dst_bgr, cv2.COLOR_RGB2GRAY), None)
    pairs = cv2.FlannBasedMatcher(dict(algorithm=1, trees=5), dict(checks=64)).knnMatch(d1, d2, k=2)
    good = [m for m, n in pairs if m.distance < 0.75 * n.distance]
    src = np.float32([k1[m.queryIdx].pt for m in good])
    dst = np.float32([k2[m.trainIdx].pt for m in good])
    matrix, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=5)
    if matrix is None or inliers is None or int(inliers.sum()) < 20:
        raise SystemExit(f"{name} similarity failed ({0 if inliers is None else int(inliers.sum())} inliers)")
    print(name, "inliers", int(inliers.sum()), "of", len(good))
    return matrix


def apply_affine(matrix, xs, ys):
    out_x = matrix[0, 0] * xs + matrix[0, 1] * ys + matrix[0, 2]
    out_y = matrix[1, 0] * xs + matrix[1, 1] * ys + matrix[1, 2]
    return out_x, out_y


def paint(mask, lat, lng, grid, radius_cells):
    xs, ys = to_xy(lat, lng)
    ix = np.rint(xs / RES).astype(np.int32)
    iy = np.rint(ys / RES).astype(np.int32)
    height, width = grid.shape
    ok = (ix >= 0) & (iy >= 0) & (ix < width) & (iy < height)
    grid[iy[ok], ix[ok]] = 255
    if radius_cells > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius_cells * 2 + 1, radius_cells * 2 + 1))
        grown = cv2.dilate(grid, kernel)
        grid[:] = grown


def trace(mask):
    """Walk each skeleton edge once, splitting only at junctions."""
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

    unused = {edge(p, q) for p, nbs in neighbors.items() for q in nbs}
    print("  graph nodes", len(points), "edges", len(unused), "deg3", sum(1 for n in neighbors.values() if len(n) >= 3))
    paths = []

    def walk(start, nxt):
        path = [start, nxt]
        unused.discard(edge(start, nxt))
        prev, cur = start, nxt
        while True:
            onward = [n for n in neighbors[cur] if n != prev and edge(cur, n) in unused]
            if len(neighbors[cur]) != 2 or not onward:
                break
            nxt = onward[0]
            unused.discard(edge(cur, nxt))
            path.append(nxt)
            prev, cur = cur, nxt
        return path

    for point, nbs in neighbors.items():
        if len(nbs) == 2:
            continue
        for nxt in nbs:
            if edge(point, nxt) in unused:
                paths.append(walk(point, nxt))
    # Closed loops have no junction to start from.
    while unused:
        a, b = unused.pop()
        unused.add((a, b))
        paths.append(walk(a, b))
    return paths


def path_len_m(path):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(path, path[1:])) * RES


def keep_road(coords):
    """Drop pit-sand squiggles and small closed rings around clearings."""
    lngs = [p[0] for p in coords]
    lats = [p[1] for p in coords]
    length = 0.0
    for (lng1, lat1), (lng2, lat2) in zip(coords, coords[1:]):
        dx = (lng2 - lng1) * 111_320 * math.cos(math.radians(LAT0))
        dy = (lat2 - lat1) * 111_320
        length += math.hypot(dx, dy)
    end_dx = (lngs[-1] - lngs[0]) * 111_320 * math.cos(math.radians(LAT0))
    end_dy = (lats[-1] - lats[0]) * 111_320
    if length < 250 and math.hypot(end_dx, end_dy) < 18:
        return False
    lat = sum(lats) / len(lats)
    lng = sum(lngs) / len(lngs)
    in_pit = 31.244 <= lat <= 31.252 and -86.7305 <= lng <= -86.719
    if in_pit and length < 80:
        return False
    # Open sand east of the Mounds reads as tan speckles. The haul roads
    # sit on the pit rim, farther west and on the east edge.
    in_pit_sand = 31.2465 <= lat <= 31.2512 and -86.7268 <= lng <= -86.7225
    if in_pit_sand and length < 200:
        return False
    return True


def simplify(points, eps):
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


def main():
    west = np.array(Image.open(ONX / "west.jpg").convert("RGB"))
    east = np.array(Image.open(ONX / "east.jpg").convert("RGB"))

    def west_ll(xs, ys):
        return ll_of_rect(xs, ys, west.shape[1], west.shape[0], WEST_N, WEST_W, WEST_S, WEST_E)

    def east_ll(xs, ys):
        return ll_of_rect(xs, ys, east.shape[1], east.shape[0], EAST_N, EAST_W, EAST_S, EAST_E)

    frames = (
        (WEST_N, WEST_W),
        (WEST_S, WEST_E),
        (EAST_N, EAST_W),
        (EAST_S, EAST_E),
    )
    lats = np.array([p[0] for p in frames])
    lngs = np.array([p[1] for p in frames])
    print("frame", float(lats.max()), float(lats.min()), float(lngs.min()), float(lngs.max()))

    min_x, min_y = to_xy(float(lats.min()) - 0.002, float(lngs.min()) - 0.002)
    max_x, max_y = to_xy(float(lats.max()) + 0.002, float(lngs.max()) + 0.002)
    # y increases north, so min_y is south
    origin_x, origin_y = min_x, min_y
    gw = int((max_x - min_x) / RES) + 4
    gh = int((max_y - min_y) / RES) + 4
    print("grid", gw, gh)
    trail_grid = np.zeros((gh, gw), np.uint8)
    road_grid = np.zeros((gh, gw), np.uint8)

    def stamp(kind, lats_a, lngs_a, radius):
        xs, ys = to_xy(lats_a, lngs_a)
        ix = np.rint((xs - origin_x) / RES).astype(np.int32)
        iy = np.rint((ys - origin_y) / RES).astype(np.int32)
        ok = (ix >= 1) & (iy >= 1) & (ix < gw - 1) & (iy < gh - 1)
        layer = np.zeros_like(trail_grid)
        layer[iy[ok], ix[ok]] = 255
        if radius:
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1))
            layer = cv2.dilate(layer, kernel)
        grid = trail_grid if kind == "trail" else road_grid
        np.maximum(grid, layer, out=grid)

    # Each screenshot owns its side of the property so the two tracings
    # don't draw the same trail twice. A short overlap keeps the seam joined.
    for name, image, project, clip_bottom, keep in (
        ("east", east, east_ll, 0, lambda lng: lng > SEAM_LNG - 0.00035),
        ("west", west, west_ll, 170, lambda lng: lng < SEAM_LNG + 0.00035),
    ):
        trails, roads = ink_masks(image)
        if clip_bottom:
            trails[-clip_bottom:, :] = False
            roads[-clip_bottom:, :] = False
        for kind, mask in (("trail", trails), ("road", roads)):
            ys, xs = np.where(mask)
            if len(xs) == 0:
                continue
            lat, lng = project(xs.astype(float), ys.astype(float))
            use = keep(lng)
            stamp(kind, lat[use], lng[use], 1)
            print(name, kind, int(use.sum()), "lat", float(np.min(lat[use])), float(np.max(lat[use])), "lng", float(np.min(lng[use])), float(np.max(lng[use])))

    # Roads keep their own ink where a trail was painted across the same cell.
    print("trail cells", int((trail_grid > 0).sum()), "road cells", int((road_grid > 0).sum()))
    cols = np.where(trail_grid > 0)[1]
    rows = np.where(trail_grid > 0)[0]
    if len(cols):
        i = int(np.argmax(cols))
        print("eastern trail cell", int(cols[i]), int(rows[i]), meters_to_ll(origin_x + cols[i] * RES, origin_y + rows[i] * RES))
        i = int(np.argmin(cols))
        print("western trail cell", int(cols[i]), int(rows[i]), meters_to_ll(origin_x + cols[i] * RES, origin_y + rows[i] * RES))
    # Sampling leaves pinholes. Close them so the skeleton is a centerline.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    trail_grid[:] = cv2.morphologyEx(trail_grid, cv2.MORPH_CLOSE, kernel)
    road_grid[:] = cv2.morphologyEx(road_grid, cv2.MORPH_CLOSE, kernel)
    both = (trail_grid > 0) & (road_grid > 0)
    trail_grid[both] = 0
    cols = np.where(trail_grid > 0)[1]
    if len(cols):
        i = int(np.argmax(cols))
        rows = np.where(trail_grid > 0)[0]
        print("after seam removal eastern", meters_to_ll(origin_x + int(cols[i]) * RES, origin_y + int(rows[i]) * RES))

    features = []
    for kind, grid in (("trail", trail_grid), ("road", road_grid)):
        if kind == "trail":
            cut = int((to_xy(LAT0, -86.72)[0] - origin_x) / RES)
            Image.fromarray((grid[:, cut:] > 0).astype(np.uint8) * 255).save("/tmp/east-trail-grid.png")
        east_part = np.zeros_like(grid)
        # columns east of about -86.72
        cut = int((to_xy(LAT0, -86.72)[0] - origin_x) / RES)
        east_part[:, cut:] = grid[:, cut:]
        ncomp, _, stats, _ = cv2.connectedComponentsWithStats((east_part > 0).astype(np.uint8), 8)
        areas = stats[1:, cv2.CC_STAT_AREA] if ncomp > 1 else []
        print(kind, "east comps", ncomp - 1, "largest", int(areas.max()) if len(areas) else 0)
        skel = skeletonize(grid > 0)
        scol = np.where(skel)[1]
        if len(scol):
            print(kind, "skel lng", meters_to_ll(origin_x + int(scol.max()) * RES, origin_y))
        raw = trace(skel)
        xs = [p[0] for path in raw for p in path]
        ys = [p[1] for path in raw for p in path]
        print(kind, "traced", len(raw), "longest", max((len(p) for p in raw), default=0), "xmax", max(xs) if xs else None, "ymax", max(ys) if ys else None)
        kept = 0
        for path in raw:
            if path_len_m(path) < (16 if kind == "road" else 12):
                continue
            simple = simplify(path, 1.6)
            if len(simple) < 2:
                continue
            coords = []
            for x, y in simple:
                lat, lng = meters_to_ll(origin_x + x * RES, origin_y + y * RES)
                coords.append([round(float(lng), 6), round(float(lat), 6)])
            # Short squiggles inside the sand pit are tan texture, not roads.
            # A closed ring under 250 m is the rim of a clearing, not a road.
            if kind == "road" and not keep_road(coords):
                continue
            features.append(
                {
                    "type": "Feature",
                    "properties": {"kind": kind},
                    "geometry": {"type": "LineString", "coordinates": coords},
                }
            )
            kept += 1
        print(kind, "skeleton px", int(skel.sum()), "paths", kept)

    lats, lngs = [], []
    for feature in features:
        for lng, lat in feature["geometry"]["coordinates"]:
            lats.append(lat)
            lngs.append(lng)
    pad_lat = 80 / 111_320
    pad_lng = 80 / (111_320 * math.cos(math.radians(LAT0)))
    raw = json.loads(BOUNDS_PATH.read_text())
    raw["north"] = max(lats) + pad_lat
    raw["south"] = min(lats) - pad_lat
    raw["west"] = min(lngs) - pad_lng
    raw["east"] = max(lngs) + pad_lng
    BOUNDS_PATH.write_text(json.dumps(raw, indent=2) + "\n")
    # Named places. Campground and Redneck Waterfall are the icon tips measured
    # on the west screenshot. The others sit on the clearings and ponds those
    # names mark in the onX screenshots. Pier and Cave #1 share one pin there,
    # and so do Conex Bridge and the cattle-gate crossing.
    pois = [
        ("Campground/Cabins", 31.24637, -86.74767),
        ("Cool Pool", 31.24800, -86.74800),
        ("Callaway shed", 31.25200, -86.74300),
        ("WTF Bounty Course", 31.25300, -86.73900),
        ("Redneck Waterfall", 31.25269, -86.73386),
        ("Mounds", 31.25000, -86.72800),
        ("New Cool Pool", 31.24630, -86.72840),
        ("Pond", 31.24100, -86.73000),
        ("Pier", 31.25020, -86.72100),
        ("Cave #1", 31.25055, -86.72070),
        ("Conex Bridge", 31.24020, -86.71720),
        ("Cattle Gate crossing", 31.23980, -86.71680),
    ]
    for name, lat, lng in pois:
        features.append(
            {
                "type": "Feature",
                "properties": {"kind": "poi", "name": name},
                "geometry": {"type": "Point", "coordinates": [round(lng, 6), round(lat, 6)]},
            }
        )
    collection = {"type": "FeatureCollection", "features": features}
    GEOJSON_PATH.write_text(json.dumps(collection, separators=(",", ":")))
    print("features", len(features), "bytes", GEOJSON_PATH.stat().st_size)
    print("bounds", raw["north"], raw["south"], raw["west"], raw["east"])


if __name__ == "__main__":
    main()
