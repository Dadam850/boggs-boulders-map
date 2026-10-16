#!/usr/bin/env python3
"""Build a north-up transparent trail overlay locked to Web Mercator tiles.

The official park map marks little trails in red and the main road in black.
This draws those same ground tracks from satellite imagery. Little trails are
thin black lines. The main road is a heavier black line. Bounds in
lib/park-bounds.json are rewritten to the exact tile corners the image covers.
"""

import json
import math
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
BOUNDS_PATH = ROOT / "lib" / "park-bounds.json"
OUT = ROOT / "public" / "trail-map.png"
LINES = ROOT / "public" / "trails.json"
Z = 17


def latlng_to_tile(lat: float, lng: float, z: int):
    n = 2**z
    x = (lng + 180) / 360 * n
    latr = math.radians(lat)
    y = (1 - math.log(math.tan(latr) + 1 / math.cos(latr)) / math.pi) / 2 * n
    return x, y


def tile_nw(x: float, y: float, z: int):
    n = 2**z
    lng = x / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lat, lng


def fetch(x: int, y: int, dest: Path):
    if dest.exists() and dest.stat().st_size > 800:
        return True
    url = f"https://maps.googleapis.com/maps/vt?lyrs=s&x={x}&y={y}&z={Z}"
    try:
        urllib.request.urlretrieve(url, dest)
        return dest.stat().st_size > 800
    except Exception:
        return False


def skeleton(mask, w: int, h: int):
    """Zhang-Suen thinning so a wide dirt cut becomes a one-pixel centerline."""
    grid = bytearray(w * h)
    for y in range(h):
        row = mask[y]
        base = y * w
        for x in range(w):
            if row[x]:
                grid[base + x] = 1

    def step(pass_id: int) -> int:
        remove = []
        for y in range(1, h - 1):
            base = y * w
            for x in range(1, w - 1):
                i = base + x
                if not grid[i]:
                    continue
                p2 = grid[i - w]
                p3 = grid[i - w + 1]
                p4 = grid[i + 1]
                p5 = grid[i + w + 1]
                p6 = grid[i + w]
                p7 = grid[i + w - 1]
                p8 = grid[i - 1]
                p9 = grid[i - w - 1]
                neighbors = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
                if neighbors < 2 or neighbors > 6:
                    continue
                ring = (p2, p3, p4, p5, p6, p7, p8, p9, p2)
                transitions = 0
                for a, b in zip(ring, ring[1:]):
                    if a == 0 and b == 1:
                        transitions += 1
                if transitions != 1:
                    continue
                if pass_id == 0:
                    if p2 * p4 * p6 != 0 or p4 * p6 * p8 != 0:
                        continue
                elif p2 * p4 * p8 != 0 or p2 * p6 * p8 != 0:
                    continue
                remove.append(i)
        for i in remove:
            grid[i] = 0
        return len(remove)

    for _ in range(16):
        if step(0) + step(1) == 0:
            break

    out = [[False] * w for _ in range(h)]
    for y in range(h):
        base = y * w
        row = out[y]
        for x in range(w):
            if grid[base + x]:
                row[x] = True
    return out


def dilate(mask, w: int, h: int, rad: int):
    out = [[False] * w for _ in range(h)]
    r2 = rad * rad
    for y in range(h):
        row = mask[y]
        for x in range(w):
            if not row[x]:
                continue
            y1 = max(0, y - rad)
            y2 = min(h - 1, y + rad)
            x1 = max(0, x - rad)
            x2 = min(w - 1, x + rad)
            for yy in range(y1, y2 + 1):
                orow = out[yy]
                for xx in range(x1, x2 + 1):
                    if (xx - x) * (xx - x) + (yy - y) * (yy - y) <= r2:
                        orow[xx] = True
    return out


def trace_paths(mask, w: int, h: int):
    neigh = {}
    for y in range(h):
        row = mask[y]
        for x in range(w):
            if not row[x]:
                continue
            nbs = []
            for dy in (-1, 0, 1):
                yy = y + dy
                if yy < 0 or yy >= h:
                    continue
                nrow = mask[yy]
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    xx = x + dx
                    if 0 <= xx < w and nrow[xx]:
                        nbs.append((xx, yy))
            neigh[(x, y)] = nbs

    def edge(a, b):
        return (a, b) if a <= b else (b, a)

    used = set()

    def walk(start, nxt):
        path = [start]
        prev = start
        cur = nxt
        used.add(edge(prev, cur))
        while True:
            path.append(cur)
            onward = [n for n in neigh[cur] if n != prev]
            if len(neigh[cur]) != 2 or not onward:
                break
            nxt = onward[0]
            link = edge(cur, nxt)
            if link in used:
                break
            used.add(link)
            prev, cur = cur, nxt
        return path

    paths = []
    for point, nbs in neigh.items():
        if len(nbs) == 2:
            continue
        for nxt in nbs:
            if edge(point, nxt) not in used:
                paths.append(walk(point, nxt))
    for point, nbs in neigh.items():
        if len(nbs) != 2:
            continue
        for nxt in nbs:
            if edge(point, nxt) not in used:
                paths.append(walk(point, nxt))
    return paths


def perp_dist(p, a, b):
    x, y = p
    x1, y1 = a
    x2, y2 = b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def simplify(points, eps: float):
    if len(points) < 3:
        return points
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        idx, dist = i, 0.0
        for k in range(i + 1, j):
            d = perp_dist(points[k], points[i], points[j])
            if d > dist:
                idx, dist = k, d
        if dist > eps:
            keep.add(idx)
            stack.append((i, idx))
            stack.append((idx, j))
    return [points[i] for i in sorted(keep)]


def mask_image(mask, w, h):
    im = Image.new("L", (w, h), 0)
    pix = im.load()
    for y in range(h):
        row = mask[y]
        for x in range(w):
            if row[x]:
                pix[x, y] = 255
    return im


def image_mask(im, w, h):
    pix = im.load()
    mask = [[False] * w for _ in range(h)]
    for y in range(h):
        row = mask[y]
        for x in range(w):
            if pix[x, y]:
                row[x] = True
    return mask


def merge_ends(paths, max_gap: float):
    """Join trail ends that sit a short distance apart so a broken track becomes one line."""
    paths = [list(path) for path in paths if len(path) >= 2]
    n = len(paths)
    if n < 2:
        return paths
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    cell = max(max_gap, 1)
    buckets = {}
    ends = []
    for i, path in enumerate(paths):
        for side, point in ((0, path[0]), (1, path[-1])):
            ends.append((i, side, point[0], point[1]))
            key = (int(point[0] // cell), int(point[1] // cell))
            buckets.setdefault(key, []).append(len(ends) - 1)
    pairs = []
    for ei, (i, side, x, y) in enumerate(ends):
        cx, cy = int(x // cell), int(y // cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for ej in buckets.get((cx + dx, cy + dy), ()):
                    if ej <= ei:
                        continue
                    j, side2, x2, y2 = ends[ej]
                    if i == j:
                        continue
                    gap = math.hypot(x - x2, y - y2)
                    if gap <= max_gap:
                        pairs.append((gap, i, side, j, side2))
    pairs.sort()
    # Each path can gain at most one join on each end.
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
    for start in range(n):
        if start in seen:
            continue
        # Walk to one leaf, then follow links the other way.
        node, side = start, 0
        while (node, side) in links and links[(node, side)][0] not in seen:
            nxt, nside = links[(node, side)]
            if nxt in seen:
                break
            node, side = nxt, 1 - nside
            if node == start:
                break
        order = []
        flips = []
        guard = 0
        while node not in seen and guard <= n:
            seen.add(node)
            order.append(node)
            flips.append(side == 1)
            guard += 1
            link = links.get((node, 1 if side == 0 else 0))
            if not link:
                break
            node, nside = link
            side = 1 - nside
        if not order:
            continue
        chain = []
        for idx, flip in zip(order, flips):
            part = paths[idx]
            if flip:
                part = list(reversed(part))
            chain.extend(part)
        merged.append(chain)
    return merged


def path_length(points):
    total = 0.0
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        total += math.hypot(x2 - x1, y2 - y1)
    return total


def main():
    wanted = json.loads(BOUNDS_PATH.read_text())
    x0f, y0f = latlng_to_tile(wanted["north"], wanted["west"], Z)
    x1f, y1f = latlng_to_tile(wanted["south"], wanted["east"], Z)

    def start_index(value: float) -> int:
        nearest = round(value)
        if abs(value - nearest) < 1e-4:
            return nearest
        return math.floor(value)

    def end_index(value: float) -> int:
        # The southeast corner is the northwest corner of the next tile.
        nearest = round(value)
        if abs(value - nearest) < 1e-4:
            return nearest - 1
        return math.floor(value)

    x0, x1 = start_index(min(x0f, x1f)), end_index(max(x0f, x1f))
    y0, y1 = start_index(min(y0f, y1f)), end_index(max(y0f, y1f))
    print(f"tiles z{Z} x {x0}-{x1} y {y0}-{y1} count {(x1-x0+1)*(y1-y0+1)}")

    cache = Path("/tmp/tiles/overlay")
    cache.mkdir(parents=True, exist_ok=True)
    jobs = []
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            jobs.append((x, y, cache / f"{Z}_{x}_{y}.jpg"))

    ok = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = [pool.submit(fetch, x, y, path) for x, y, path in jobs]
        for fut in as_completed(futs):
            ok += 1 if fut.result() else 0
    print("downloaded", ok, "of", len(jobs))
    if ok < len(jobs) * 0.9:
        raise SystemExit("too many tile failures")

    cols, rows = x1 - x0 + 1, y1 - y0 + 1
    sheet = Image.new("RGB", (cols * 256, rows * 256))
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            path = cache / f"{Z}_{x}_{y}.jpg"
            try:
                tile = Image.open(path).convert("RGB")
            except Exception:
                tile = Image.new("RGB", (256, 256), (40, 50, 40))
            sheet.paste(tile, ((x - x0) * 256, (y - y0) * 256))

    # Shrink for a phone-sized overlay. Corners stay the tile corners.
    sheet_w, sheet_h = sheet.size
    max_w = 2000
    if sheet.width > max_w:
        scale = max_w / sheet.width
        sheet = sheet.resize((max_w, max(1, round(sheet.height * scale))), Image.Resampling.LANCZOS)

    lum = sheet.convert("L")
    blur = lum.filter(ImageFilter.BoxBlur(6))
    src = lum.load()
    base = blur.load()
    w, h = lum.size
    trail = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            c = src[x, y]
            m = base[x, y]
            # A track is a bright cut through darker woods, not a pale field.
            if m > 168:
                continue
            if 28 <= (c - m) <= 90 and 90 <= c <= 210:
                trail[y][x] = True

    # Drop specks. Keep pixels with a neighbor so field edges and canopy noise fade.
    keep = [[False] * w for _ in range(h)]
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            if not trail[y][x]:
                continue
            n = (
                trail[y][x - 1]
                + trail[y][x + 1]
                + trail[y - 1][x]
                + trail[y + 1][x]
            )
            if n >= 1:
                keep[y][x] = True

    fine = skeleton(keep, w, h)
    road_px = [[False] * w for _ in range(h)]
    for y in range(2, h - 2):
        row = fine[y]
        for x in range(2, w - 2):
            if not row[x]:
                continue
            wide = 0
            for dy in range(-2, 3):
                band = keep[y + dy]
                for dx in range(-2, 3):
                    if band[x + dx]:
                        wide += 1
            if wide >= 18:
                road_px[y][x] = True

    def to_latlng(x, y):
        # Map back onto the Web Mercator tile sheet, not a linear lat/lng stretch.
        sx = (x + 0.5) * sheet_w / w
        sy = (y + 0.5) * sheet_h / h
        lat, lng = tile_nw(x0 + sx / 256, y0 + sy / 256, Z)
        return [round(lat, 6), round(lng, 6)]

    lines = []
    preview_paths = []
    traced_raw = trace_paths(fine, w, h)
    print("traced pieces", len(traced_raw), flush=True)
    # Only close hairline breaks (~20 m). A wider gap draws a straight chord
    # across the woods and the line leaves the dirt track.
    traced = merge_ends(traced_raw, 12)
    print("joined pieces", len(traced), flush=True)
    for raw in traced:
        if path_length(raw) < 10:
            continue
        simple = simplify(raw, 0.8)
        if len(simple) < 2:
            continue
        road = sum(1 for x, y in raw if road_px[y][x]) > len(raw) * 0.45
        lines.append({"road": road, "path": [to_latlng(x, y) for x, y in simple]})
        preview_paths.append((road, simple))
    LINES.write_text(json.dumps({"lines": lines}, separators=(",", ":")) + "\n")
    little = sum(1 for line in lines if not line["road"])
    print("trail vectors", "little", little, "roads", len(lines) - little, "bytes", LINES.stat().st_size)

    rgba = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ink = ImageDraw.Draw(rgba)
    for road, simple in preview_paths:
        if road:
            ink.line(simple, fill=(17, 17, 17, 255), width=4, joint="curve")
        else:
            ink.line(simple, fill=(225, 6, 0, 255), width=2, joint="curve")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    rgba.save(OUT, optimize=True)

    north, west = tile_nw(x0, y0, Z)
    south, east = tile_nw(x1 + 1, y1 + 1, Z)
    bounds = {"north": north, "south": south, "west": west, "east": east}
    BOUNDS_PATH.write_text(json.dumps(bounds, indent=2) + "\n")
    print("bounds", bounds)
    print("overlay", OUT, OUT.stat().st_size, rgba.size)

    # Preview for alignment checks: satellite with the lines on top.
    preview = sheet.convert("RGBA")
    preview.alpha_composite(rgba)
    preview.convert("RGB").save("/tmp/mosaic/overlay-check.jpg", quality=82)
    sheet.save("/tmp/mosaic/overlay-satellite.jpg", quality=82)


if __name__ == "__main__":
    main()
