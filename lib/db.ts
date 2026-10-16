import type { PhotoMeta, Rider } from "./types";

const DB_NAME = "boggs-trail";
const DB_VERSION = 1;

export type PendingPhoto = PhotoMeta & { blob: Blob };
export type CachedPhoto = PhotoMeta & { blob: Blob };

type StoreName = "pendingPhotos" | "photoCache" | "kv";

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("pendingPhotos")) {
        db.createObjectStore("pendingPhotos", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("photoCache")) {
        db.createObjectStore("photoCache", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Couldn't open on-phone storage"));
  });
}

function run<T>(name: StoreName, mode: IDBTransactionMode, make: (store: IDBObjectStore) => IDBRequest<T>) {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(name, mode);
        const req = make(tx.objectStore(name));
        let value: T;
        req.onsuccess = () => {
          value = req.result;
        };
        req.onerror = () => {
          db.close();
          reject(req.error ?? new Error("Storage request failed"));
        };
        tx.oncomplete = () => {
          db.close();
          resolve(value);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error("Storage transaction failed"));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("Storage transaction aborted"));
        };
      }),
  );
}

export function idbPutPending(photo: PendingPhoto) {
  return run("pendingPhotos", "readwrite", (store) => store.put(photo));
}

export function idbDeletePending(id: string) {
  return run("pendingPhotos", "readwrite", (store) => store.delete(id));
}

export function idbAllPending() {
  return run("pendingPhotos", "readonly", (store) => store.getAll() as IDBRequest<PendingPhoto[]>);
}

export function idbPutCache(photo: CachedPhoto) {
  return run("photoCache", "readwrite", (store) => store.put(photo));
}

export function idbAllCache() {
  return run("photoCache", "readonly", (store) => store.getAll() as IDBRequest<CachedPhoto[]>);
}

export async function idbGetKv<T>(key: string): Promise<T | undefined> {
  const value = await run("kv", "readonly", (store) => store.get(key));
  return value as T | undefined;
}

export function idbSetKv(key: string, value: unknown) {
  return run("kv", "readwrite", (store) => store.put(value, key));
}

export function idbSetRiders(group: string, riders: Rider[]) {
  return idbSetKv(`riders:${group}`, riders);
}

export async function idbGetRiders(group: string) {
  return (await idbGetKv<Rider[]>(`riders:${group}`)) ?? [];
}
