import { PARK, expandBounds, type ParkBounds } from "./park";

export type Tile = { z: number; x: number; y: number };

export function latLngToTile(lat: number, lng: number, z: number) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x, y };
}

export function tilesCovering(bounds: ParkBounds, zooms: number[]): Tile[] {
  const tiles: Tile[] = [];
  for (const z of zooms) {
    const nw = latLngToTile(bounds.north, bounds.west, z);
    const se = latLngToTile(bounds.south, bounds.east, z);
    const x0 = Math.min(nw.x, se.x);
    const x1 = Math.max(nw.x, se.x);
    const y0 = Math.min(nw.y, se.y);
    const y1 = Math.max(nw.y, se.y);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) tiles.push({ z, x, y });
    }
  }
  return tiles;
}

/** Park tiles to store on the phone. Drops the closest zoom if the set is huge. */
export function offlineTiles(): Tile[] {
  const area = expandBounds(PARK.bounds, PARK.prefetchPad);
  let zooms = [...PARK.prefetchZooms];
  let tiles = tilesCovering(area, zooms);
  while (tiles.length > 700 && zooms.length > 2) {
    zooms = zooms.slice(0, -1);
    tiles = tilesCovering(area, zooms);
  }
  return tiles;
}
