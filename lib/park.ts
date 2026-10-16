import bounds from "./park-bounds.json";

export type ParkBounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

/** Rider pins drop off the map after this long. Photos do not. */
export const RIDER_TTL_MS = 48 * 60 * 60 * 1000;

/** Name-only login stays on the phone this long after the app was last opened. */
export const SESSION_MS = 72 * 60 * 60 * 1000;

export const PARK = {
  name: "Boggs & Boulders",
  place: "Andalusia, Alabama",
  overlayUrl: "/trails.json",
  bounds: bounds as ParkBounds,
  /** Satellite zooms cached for the park. 17 is about 2 m/pixel here. */
  prefetchZooms: [14, 15, 16, 17],
  prefetchPad: 0.08,
};

export function expandBounds(b: ParkBounds, pad: number): ParkBounds {
  const lat = (b.north - b.south) * pad;
  const lng = (b.east - b.west) * pad;
  return {
    north: b.north + lat,
    south: b.south - lat,
    east: b.east + lng,
    west: b.west - lng,
  };
}
