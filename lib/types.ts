import type { Crumb } from "./trail";

export type Rider = {
  userId: string;
  name: string;
  group: string;
  lat: number;
  lng: number;
  updatedAt: number;
};

/** Permanent path for one rider. Stored in blob storage until that rider clears it. */
export type StoredTrail = {
  userId: string;
  name: string;
  group: string;
  crumbs: Crumb[];
  /** Points at or before this time were erased by the rider and must not come back. */
  clearedAt?: number;
};

export type PhotoMeta = {
  id: string;
  userId: string;
  name: string;
  group: string;
  lat: number;
  lng: number;
  takenAt: number;
};
