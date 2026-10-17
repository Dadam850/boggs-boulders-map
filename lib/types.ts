import type { Crumb } from "./trail";

export type Rider = {
  userId: string;
  name: string;
  group: string;
  /** Buggy, ATV, or whatever they typed at login. */
  vehicle?: string;
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

/** Group chat or a one-to-one note. `toUserId` null means everyone in the group. */
export type ChatMessage = {
  id: string;
  group: string;
  fromUserId: string;
  fromName: string;
  /** Null or omitted = message everyone in the group. */
  toUserId?: string | null;
  toName?: string | null;
  text: string;
  createdAt: number;
};
