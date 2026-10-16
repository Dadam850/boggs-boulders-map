import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import fs from "fs/promises";
import path from "path";
import { RIDER_TTL_MS } from "./park";
import { thinCrumbs, type Crumb } from "./trail";
import type { PhotoMeta, Rider, StoredTrail } from "./types";

export type PhotoBlob = { jpeg: Buffer; meta: PhotoMeta };

export interface GroupStore {
  kind: "azure" | "local";
  container: string;
  upsertRider(rider: Rider): Promise<void>;
  listRiders(group: string): Promise<Rider[]>;
  saveTrail(group: string, userId: string, name: string, incoming: Crumb[], current: Crumb | null): Promise<StoredTrail>;
  listTrails(group: string): Promise<StoredTrail[]>;
  clearTrail(group: string, userId: string): Promise<void>;
  putPhoto(jpeg: Buffer, meta: PhotoMeta): Promise<void>;
  getPhoto(id: string): Promise<PhotoBlob | null>;
  listPhotos(group: string): Promise<PhotoMeta[]>;
}

async function readStream(stream: NodeJS.ReadableStream | undefined) {
  if (!stream) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function riderKey(group: string, userId: string) {
  return `riders/${group}/${userId}.json`;
}
function trailKey(group: string, userId: string) {
  return `trails/${group}/${userId}.json`;
}

type LegacyRider = Rider & { trail?: Crumb[] };

function cleanRider(rider: LegacyRider): Rider {
  const vehicle = typeof rider.vehicle === "string" ? rider.vehicle.trim().slice(0, 32) : "";
  return {
    userId: rider.userId,
    name: rider.name,
    group: rider.group,
    lat: rider.lat,
    lng: rider.lng,
    updatedAt: rider.updatedAt,
    ...(vehicle ? { vehicle } : {}),
  };
}

function combineCrumbs(existing: Crumb[] | undefined, incoming: Crumb[] | undefined, current: Crumb | null, clearedAt?: number) {
  const points = [...(existing ?? []), ...(incoming ?? [])];
  if (current) points.push(current);
  const kept = clearedAt ? points.filter((point) => point.at > clearedAt) : points;
  return thinCrumbs(kept);
}
function photoMetaKey(group: string, id: string) {
  return `photos/${group}/${id}.json`;
}
function photoJpegKey(group: string, id: string) {
  return `photos/${group}/${id}.jpg`;
}

class AzureGroupStore implements GroupStore {
  kind = "azure" as const;
  private containerPromise: Promise<ContainerClient> | null = null;

  constructor(
    private connectionString: string,
    readonly container: string,
  ) {}

  private client() {
    if (!this.containerPromise) {
      this.containerPromise = (async () => {
        const service = BlobServiceClient.fromConnectionString(this.connectionString);
        const container = service.getContainerClient(this.container);
        await container.createIfNotExists();
        return container;
      })();
    }
    return this.containerPromise;
  }

  private async putJson(key: string, value: unknown) {
    const container = await this.client();
    const blob = container.getBlockBlobClient(key);
    const body = Buffer.from(JSON.stringify(value));
    await blob.uploadData(body, {
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
  }

  private async getJson<T>(key: string): Promise<T | null> {
    const container = await this.client();
    const blob = container.getBlobClient(key);
    if (!(await blob.exists())) return null;
    const dl = await blob.download();
    const buf = await readStream(dl.readableStreamBody);
    return JSON.parse(buf.toString("utf8")) as T;
  }

  async upsertRider(rider: Rider) {
    const legacy = rider as LegacyRider;
    if (legacy.trail?.length) {
      await this.saveTrail(rider.group, rider.userId, rider.name, legacy.trail, null);
    }
    await this.putJson(riderKey(rider.group, rider.userId), cleanRider(legacy));
  }

  async listRiders(group: string) {
    const container = await this.client();
    const fresh: Rider[] = [];
    const now = Date.now();
    for await (const item of container.listBlobsFlat({ prefix: `riders/${group}/` })) {
      if (!item.name.endsWith(".json")) continue;
      const rider = await this.getJson<LegacyRider>(item.name);
      if (!rider?.userId) continue;
      if (rider.trail?.length) {
        await this.saveTrail(rider.group || group, rider.userId, rider.name, rider.trail, null);
        await this.putJson(item.name, cleanRider(rider));
      }
      if (now - rider.updatedAt > RIDER_TTL_MS) {
        await container.getBlobClient(item.name).deleteIfExists();
        continue;
      }
      fresh.push(cleanRider(rider));
    }
    fresh.sort((a, b) => b.updatedAt - a.updatedAt);
    return fresh;
  }

  async saveTrail(group: string, userId: string, name: string, incoming: Crumb[], current: Crumb | null) {
    const key = trailKey(group, userId);
    const existing = await this.getJson<StoredTrail>(key);
    let clearedAt = existing?.clearedAt;
    let crumbs = combineCrumbs(existing?.crumbs, incoming, current, clearedAt);
    const again = await this.getJson<StoredTrail>(key);
    if (again?.clearedAt && (!clearedAt || again.clearedAt > clearedAt)) {
      clearedAt = again.clearedAt;
      crumbs = combineCrumbs(again.crumbs, incoming, current, clearedAt);
    }
    const saved: StoredTrail = {
      userId,
      name: name || existing?.name || "Rider",
      group,
      crumbs,
      ...(clearedAt ? { clearedAt } : {}),
    };
    await this.putJson(key, saved);
    return saved;
  }

  async listTrails(group: string) {
    const container = await this.client();
    const trails: StoredTrail[] = [];
    for await (const item of container.listBlobsFlat({ prefix: `trails/${group}/` })) {
      if (!item.name.endsWith(".json")) continue;
      const trail = await this.getJson<StoredTrail>(item.name);
      if (!trail?.userId) continue;
      trails.push({ ...trail, crumbs: Array.isArray(trail.crumbs) ? trail.crumbs : [] });
    }
    return trails;
  }

  async clearTrail(group: string, userId: string) {
    const key = trailKey(group, userId);
    const existing = await this.getJson<StoredTrail>(key);
    const saved: StoredTrail = {
      userId,
      name: existing?.name || "Rider",
      group,
      crumbs: [],
      clearedAt: Date.now(),
    };
    await this.putJson(key, saved);
  }

  async putPhoto(jpeg: Buffer, meta: PhotoMeta) {
    const container = await this.client();
    const image = container.getBlockBlobClient(photoJpegKey(meta.group, meta.id));
    await image.uploadData(jpeg, {
      blobHTTPHeaders: { blobContentType: "image/jpeg" },
    });
    await this.putJson(photoMetaKey(meta.group, meta.id), meta);
  }

  async getPhoto(id: string) {
    const container = await this.client();
    for await (const item of container.listBlobsFlat({ prefix: "photos/" })) {
      if (!item.name.endsWith(`/${id}.json`)) continue;
      const meta = await this.getJson<PhotoMeta>(item.name);
      if (!meta) return null;
      const jpegBlob = container.getBlobClient(photoJpegKey(meta.group, meta.id));
      if (!(await jpegBlob.exists())) return null;
      const dl = await jpegBlob.download();
      const jpeg = await readStream(dl.readableStreamBody);
      return { jpeg, meta };
    }
    return null;
  }

  async listPhotos(group: string) {
    const container = await this.client();
    const photos: PhotoMeta[] = [];
    for await (const item of container.listBlobsFlat({ prefix: `photos/${group}/` })) {
      if (!item.name.endsWith(".json")) continue;
      const meta = await this.getJson<PhotoMeta>(item.name);
      if (meta) photos.push(meta);
    }
    photos.sort((a, b) => b.takenAt - a.takenAt);
    return photos;
  }
}

class LocalGroupStore implements GroupStore {
  kind = "local" as const;
  readonly container = "local-disk";
  private root: string;

  constructor() {
    this.root = path.resolve(process.cwd(), "data", "local-blob");
  }

  private file(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error("Bad storage key");
    return full;
  }

  private async putJson(key: string, value: unknown) {
    const file = this.file(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
  }

  private async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(this.file(key), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async upsertRider(rider: Rider) {
    const legacy = rider as LegacyRider;
    if (legacy.trail?.length) {
      await this.saveTrail(rider.group, rider.userId, rider.name, legacy.trail, null);
    }
    await this.putJson(riderKey(rider.group, rider.userId), cleanRider(legacy));
  }

  async listRiders(group: string) {
    const dir = this.file(`riders/${group}`);
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const now = Date.now();
    const fresh: Rider[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const key = `riders/${group}/${name}`;
      const rider = await this.getJson<LegacyRider>(key);
      if (!rider?.userId) continue;
      if (rider.trail?.length) {
        await this.saveTrail(rider.group || group, rider.userId, rider.name, rider.trail, null);
        await this.putJson(key, cleanRider(rider));
      }
      if (now - rider.updatedAt > RIDER_TTL_MS) {
        await fs.rm(this.file(key), { force: true });
        continue;
      }
      fresh.push(cleanRider(rider));
    }
    fresh.sort((a, b) => b.updatedAt - a.updatedAt);
    return fresh;
  }

  async saveTrail(group: string, userId: string, name: string, incoming: Crumb[], current: Crumb | null) {
    const key = trailKey(group, userId);
    const existing = await this.getJson<StoredTrail>(key);
    let clearedAt = existing?.clearedAt;
    let crumbs = combineCrumbs(existing?.crumbs, incoming, current, clearedAt);
    const again = await this.getJson<StoredTrail>(key);
    if (again?.clearedAt && (!clearedAt || again.clearedAt > clearedAt)) {
      clearedAt = again.clearedAt;
      crumbs = combineCrumbs(again.crumbs, incoming, current, clearedAt);
    }
    const saved: StoredTrail = {
      userId,
      name: name || existing?.name || "Rider",
      group,
      crumbs,
      ...(clearedAt ? { clearedAt } : {}),
    };
    await this.putJson(key, saved);
    return saved;
  }

  async listTrails(group: string) {
    const dir = this.file(`trails/${group}`);
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const trails: StoredTrail[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const trail = await this.getJson<StoredTrail>(`trails/${group}/${name}`);
      if (!trail?.userId) continue;
      trails.push({ ...trail, crumbs: Array.isArray(trail.crumbs) ? trail.crumbs : [] });
    }
    return trails;
  }

  async clearTrail(group: string, userId: string) {
    const key = trailKey(group, userId);
    const existing = await this.getJson<StoredTrail>(key);
    const saved: StoredTrail = {
      userId,
      name: existing?.name || "Rider",
      group,
      crumbs: [],
      clearedAt: Date.now(),
    };
    await this.putJson(key, saved);
  }

  async putPhoto(jpeg: Buffer, meta: PhotoMeta) {
    const image = this.file(photoJpegKey(meta.group, meta.id));
    await fs.mkdir(path.dirname(image), { recursive: true });
    await fs.writeFile(image, jpeg);
    await this.putJson(photoMetaKey(meta.group, meta.id), meta);
  }

  async getPhoto(id: string) {
    const root = this.file("photos");
    let groups: string[] = [];
    try {
      groups = await fs.readdir(root);
    } catch {
      return null;
    }
    for (const group of groups) {
      const meta = await this.getJson<PhotoMeta>(photoMetaKey(group, id));
      if (!meta) continue;
      try {
        const jpeg = await fs.readFile(this.file(photoJpegKey(group, id)));
        return { jpeg, meta };
      } catch {
        return null;
      }
    }
    return null;
  }

  async listPhotos(group: string) {
    const dir = this.file(`photos/${group}`);
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const photos: PhotoMeta[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const meta = await this.getJson<PhotoMeta>(`photos/${group}/${name}`);
      if (meta) photos.push(meta);
    }
    photos.sort((a, b) => b.takenAt - a.takenAt);
    return photos;
  }
}

let singleton: GroupStore | null = null;

export function getStore(): GroupStore {
  if (singleton) return singleton;
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING?.trim();
  const container = process.env.AZURE_STORAGE_CONTAINER?.trim();
  if (connectionString && container) {
    singleton = new AzureGroupStore(connectionString, container);
  } else {
    singleton = new LocalGroupStore();
  }
  return singleton;
}
