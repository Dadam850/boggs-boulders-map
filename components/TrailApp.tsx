"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { MapPhoto } from "@/components/TrailMap";
import { ageLabel } from "@/components/TrailMap";
import {
  idbAllCache,
  idbAllPending,
  idbDeletePending,
  idbGetKv,
  idbGetRiders,
  idbPutCache,
  idbPutPending,
  idbSetKv,
  idbSetRiders,
} from "@/lib/db";
import { adminCode, isAdminGroup } from "@/lib/admin";
import { clearSession, loadSession, saveSession, type Session } from "@/lib/session";
import { offlineTiles } from "@/lib/tiles";
import { safeGroup, safeName, safeRide } from "@/lib/sanitize";
import { appendCrumb, thinCrumbs, type Crumb } from "@/lib/trail";
import type { PhotoMeta, Rider, StoredTrail } from "@/lib/types";

const TrailMap = dynamic(() => import("@/components/TrailMap").then((m) => m.TrailMap), {
  ssr: false,
});

type Fix = { lat: number; lng: number; at: number };
type Command = { type: "me" | "all"; id: number };
type DeviceKind = "ios" | "android" | "other";
type GpsPhase = "checking" | "need-tap" | "watching" | "denied" | "unavailable";

const GPS_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 1000,
  timeout: 20000,
};

function detectDevice(): DeviceKind {
  const ua = navigator.userAgent || "";
  const touchMac = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  if (/iPad|iPhone|iPod/.test(ua) || touchMac) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

function gpsMessage(code: number) {
  if (code === 1) return "Location is blocked for this site.";
  if (code === 2) return "Location is off, or GPS has no fix yet.";
  return "GPS is taking too long. Stay in the open and try again.";
}

function formatWhen(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function compressPhoto(file: File) {
  const bitmap = await createImageBitmap(file);
  const max = 1280;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't compress the photo");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.72));
  if (!blob) throw new Error("Couldn't compress the photo");
  return blob;
}

export function TrailApp() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [name, setName] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [group, setGroup] = useState("boggs");
  const [loginError, setLoginError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [online, setOnline] = useState(true);
  const [fix, setFix] = useState<Fix | null>(null);
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [gpsError, setGpsError] = useState("");
  const [gpsPhase, setGpsPhase] = useState<GpsPhase>("checking");
  const [deviceKind, setDeviceKind] = useState<DeviceKind>("other");
  const [compact, setCompact] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [layoutTick, setLayoutTick] = useState(0);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [trails, setTrails] = useState<StoredTrail[]>([]);
  const [showCrumbs, setShowCrumbs] = useState(true);
  const [showPhotos, setShowPhotos] = useState(true);
  const [profile, setProfile] = useState<{ name: string; vehicle: string; detail: string } | null>(null);
  const [recordCrumbs, setRecordCrumbs] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [photos, setPhotos] = useState<MapPhoto[]>([]);
  const [syncNote, setSyncNote] = useState("");
  const [opacity, setOpacity] = useState(1);
  const [showSheet, setShowSheet] = useState(false);
  const [command, setCommand] = useState<Command | null>(null);
  const [openPhoto, setOpenPhoto] = useState<MapPhoto | null>(null);
  const [tileProgress, setTileProgress] = useState<{ done: number; total: number } | null>(null);
  const [mapSaved, setMapSaved] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [deskPanel, setDeskPanel] = useState(false);
  const [deskTarget, setDeskTarget] = useState<StoredTrail | null>(null);
  const [deskBusy, setDeskBusy] = useState(false);
  const [hideLocationCard, setHideLocationCard] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const urls = useRef(new Set<string>());
  const fixRef = useRef<Fix | null>(null);
  const trailRef = useRef<Crumb[]>([]);
  const recordRef = useRef(true);
  const trailEpoch = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  const watchRef = useRef<number | null>(null);
  recordRef.current = recordCrumbs;
  sessionRef.current = session;
  fixRef.current = fix;

  const controlsCollapsed = compact && !menuOpen;

  const bumpLayout = useCallback(() => {
    setLayoutTick((n) => n + 1);
  }, []);

  const minimizeControls = useCallback(() => {
    setMenuOpen(false);
    setConfirmClear(false);
    setDeskPanel(false);
    setDeskTarget(null);
    bumpLayout();
  }, [bumpLayout]);

  const deskHeaders = useCallback((): HeadersInit => {
    if (!sessionRef.current?.desk) return {};
    return { "x-boggs-desk": adminCode() };
  }, []);

  const rememberUrl = useCallback((url: string) => {
    urls.current.add(url);
    return url;
  }, []);

  const rebuildPhotos = useCallback(async () => {
    const [pending, cached] = await Promise.all([idbAllPending(), idbAllCache()]);
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
    const byId = new Map<string, MapPhoto>();
    for (const photo of cached) {
      byId.set(photo.id, {
        ...photo,
        localUrl: rememberUrl(URL.createObjectURL(photo.blob)),
        pending: false,
      });
    }
    for (const photo of pending) {
      byId.set(photo.id, {
        ...photo,
        localUrl: rememberUrl(URL.createObjectURL(photo.blob)),
        pending: true,
      });
    }
    const list = [...byId.values()].sort((a, b) => b.takenAt - a.takenAt);
    setPhotos(list);
    setOpenPhoto((current) => (current ? list.find((photo) => photo.id === current.id) ?? current : null));
    return list;
  }, [rememberUrl]);

  const uploadPending = useCallback(async () => {
    const pending = await idbAllPending();
    for (const photo of pending) {
      const body = new FormData();
      body.set("id", photo.id);
      body.set("userId", photo.userId);
      body.set("name", photo.name);
      body.set("group", photo.group);
      body.set("lat", String(photo.lat));
      body.set("lng", String(photo.lng));
      body.set("takenAt", String(photo.takenAt));
      body.set("file", photo.blob, "photo.jpg");
      try {
        const res = await fetch("/api/photos", { method: "POST", body });
        if (!res.ok) {
          setSyncNote("Photo saved on this phone. It sends when you have signal.");
          return;
        }
        await idbPutCache(photo);
        await idbDeletePending(photo.id);
        setOnline(true);
      } catch {
        setSyncNote("Photo saved on this phone. It sends when you have signal.");
        return;
      }
    }
    await rebuildPhotos();
  }, [rebuildPhotos]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = loadSession();
        if (!cancelled && existing) {
          // Older sessions may have stored the desk code as the group itself.
          if (isAdminGroup(existing.group) && !existing.desk) {
            const migrated = saveSession({
              name: existing.name,
              userId: existing.userId,
              group: "boggs",
              vehicle: existing.vehicle,
              desk: true,
            });
            setSession(migrated);
          } else {
            setSession(existing);
          }
        }
        const savedOpacityRaw = localStorage.getItem("boggs.opacity");
        const savedOpacity = savedOpacityRaw === null ? Number.NaN : Number(savedOpacityRaw);
        if (!cancelled && Number.isFinite(savedOpacity)) setOpacity(Math.min(1, Math.max(0, savedOpacity)));
        if (!cancelled && localStorage.getItem("boggs.sheet") === "1") setShowSheet(true);
        if (!cancelled && localStorage.getItem("boggs.crumbs.show") === "0") setShowCrumbs(false);
        if (!cancelled && localStorage.getItem("boggs.photos") === "0") setShowPhotos(false);
        if (!cancelled && localStorage.getItem("boggs.crumbs.record") === "0") setRecordCrumbs(false);
        // Default to the short button bar so the map stays usable. Only expand when they ask.
        if (!cancelled && localStorage.getItem("boggs.compact") === "0") setCompact(false);
        else if (!cancelled) setCompact(true);
        if (!cancelled) setDeviceKind(detectDevice());
        await rebuildPhotos();
        const savedFlag = await idbGetKv<string>("tilesSaved");
        if (!cancelled) setMapSaved(savedFlag === "1");
      } catch {
        if (!cancelled) setStorageError("This phone is blocking saved photos. Allow site data, then reload.");
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rebuildPhotos]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    let stopped = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("/sw.js").then(async () => {
      await navigator.serviceWorker.ready;
      if (stopped) return;
      if (!hadController && navigator.serviceWorker.controller && !sessionStorage.getItem("boggs-sw-once")) {
        sessionStorage.setItem("boggs-sw-once", "1");
        window.location.reload();
      }
    });
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    const tick = () => {
      void uploadPending();
    };
    tick();
    const id = window.setInterval(tick, 8000);
    window.addEventListener("online", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("online", tick);
    };
  }, [uploadPending]);

  const stopWatch = useCallback(() => {
    if (watchRef.current != null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    watchRef.current = null;
  }, []);

  const beginWatch = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setGpsPhase("unavailable");
      setGpsError("This phone has no GPS.");
      return;
    }
    stopWatch();
    setGpsPhase("watching");
    setGpsError("");
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const next = { lat: pos.coords.latitude, lng: pos.coords.longitude, at: Date.now() };
        fixRef.current = next;
        setFix(next);
        setGpsError("");
        setGpsPhase("watching");
        const who = sessionRef.current;
        if (recordRef.current) {
          const updated = appendCrumb(trailRef.current, next);
          if (updated.length !== trailRef.current.length) {
            trailRef.current = updated;
            setTrail(updated);
            if (who) void idbSetKv(`trail:${who.userId}`, updated).catch(() => undefined);
          }
        }
        void idbSetKv("lastFix", next).catch(() => undefined);
      },
      (err) => {
        const denied = err.code === err.PERMISSION_DENIED;
        const unavailable = err.code === err.POSITION_UNAVAILABLE;
        if (denied) {
          stopWatch();
          setGpsPhase("denied");
        } else if (unavailable) {
          setGpsPhase("unavailable");
        }
        setGpsError(gpsMessage(err.code));
      },
      GPS_OPTIONS,
    );
  }, [stopWatch]);

  useEffect(() => {
    if (!session) {
      stopWatch();
      return;
    }
    let cancelled = false;
    let status: PermissionStatus | null = null;
    const onPerm = () => {
      if (!status || cancelled) return;
      if (status.state === "granted") beginWatch();
      if (status.state === "denied") {
        stopWatch();
        setGpsPhase("denied");
        setGpsError(gpsMessage(1));
      }
    };
    (async () => {
      let perm: PermissionState | "unknown" = "unknown";
      try {
        if (navigator.permissions?.query) {
          status = await navigator.permissions.query({ name: "geolocation" });
          perm = status.state;
          status.addEventListener("change", onPerm);
        }
      } catch {
        perm = "unknown";
      }
      if (cancelled || watchRef.current != null) return;
      if (perm === "granted" || perm === "unknown") beginWatch();
      else if (perm === "denied") {
        setGpsPhase("denied");
        setGpsError(gpsMessage(1));
      } else {
        setGpsPhase("need-tap");
        setGpsError("Location is off. Tap Turn on location.");
      }
    })();
    void idbGetKv<Fix>("lastFix").then((saved) => {
      if (cancelled || !saved || fixRef.current) return;
      fixRef.current = saved;
      setFix(saved);
    });
    const userId = session.userId;
    void idbGetKv<Crumb[]>(`trail:${userId}`).then((saved) => {
      if (cancelled || !saved?.length || trailRef.current.length) return;
      const kept = thinCrumbs(saved);
      trailRef.current = kept;
      setTrail(kept);
    });
    return () => {
      cancelled = true;
      status?.removeEventListener("change", onPerm);
      stopWatch();
    };
  }, [session, beginWatch, stopWatch]);

  const pullGroup = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    try {
      const cached = await idbGetRiders(current.group);
      setRiders(cached);
      const cachedTrails = await idbGetKv<StoredTrail[]>(`trails:${current.group}`);
      if (cachedTrails) setTrails(cachedTrails);
    } catch {
      /* shown from the latest successful sync */
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void pullGroup();
  }, [session, pullGroup]);

  const sync = useCallback(async () => {
    const current = sessionRef.current;
    const here = fixRef.current;
    if (!current) return;
    const epoch = trailEpoch.current;
    try {
      let riderRes: Response;
      const desk = deskHeaders();
      if (here) {
        riderRes = await fetch("/api/riders", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...desk },
          body: JSON.stringify({
            userId: current.userId,
            name: current.name,
            vehicle: current.vehicle || "",
            group: current.group,
            lat: here.lat,
            lng: here.lng,
            trail: trailRef.current,
            record: recordRef.current,
            ...(current.desk ? { desk: adminCode() } : {}),
          }),
        });
      } else {
        const q = new URLSearchParams({ group: current.group });
        if (current.desk) q.set("desk", adminCode());
        riderRes = await fetch(`/api/riders?${q}`, { headers: desk });
      }
      if (riderRes.ok) {
        const data = (await riderRes.json()) as { riders: Rider[]; trails?: StoredTrail[]; desk?: boolean };
        setRiders(data.riders);
        await idbSetRiders(current.group, data.riders);
        const nextTrails = data.trails ?? [];
        setTrails(nextTrails);
        await idbSetKv(`trails:${current.group}`, nextTrails);
        if (current.desk && data.desk) {
          await idbSetKv("trails:desk-all", nextTrails);
        }
        if (epoch === trailEpoch.current) {
          const mine = nextTrails.find((item) => item.userId === current.userId && item.group === current.group);
          if (mine) {
            const keptLocal = trailRef.current.filter((crumb) => !mine.clearedAt || crumb.at > mine.clearedAt);
            const merged = thinCrumbs([...mine.crumbs, ...keptLocal]);
            trailRef.current = merged;
            setTrail(merged);
            await idbSetKv(`trail:${current.userId}`, merged);
          }
        }
        setSyncNote("");
        setOnline(true);
      } else {
        setSyncNote("Can't reach the group. Your spot is saved on this phone.");
      }

      const photoRes = await fetch(`/api/photos?group=${encodeURIComponent(current.group)}`);
      if (photoRes.ok) {
        const data = (await photoRes.json()) as { photos: PhotoMeta[] };
        const cached = await idbAllCache();
        const pending = await idbAllPending();
        const have = new Set([...cached, ...pending].map((photo) => photo.id));
        for (const meta of data.photos) {
          if (have.has(meta.id)) continue;
          const img = await fetch(`/api/photos/${meta.id}`);
          if (!img.ok) continue;
          const blob = await img.blob();
          await idbPutCache({ ...meta, blob });
          have.add(meta.id);
        }
        await rebuildPhotos();
      }
    } catch {
      setSyncNote("Can't reach the group. Your spot is saved on this phone.");
    }
  }, [rebuildPhotos, deskHeaders]);

  useEffect(() => {
    if (!session) return;
    void sync();
    const id = window.setInterval(() => void sync(), 10000);
    window.addEventListener("online", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("online", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [session, sync]);

  useEffect(() => {
    if (!session || !online || mapSaved) return;
    let cancelled = false;
    const tiles = offlineTiles();
    setTileProgress({ done: 0, total: tiles.length });
    const queue = [...tiles];
    let done = 0;
    const workers = Array.from({ length: 6 }, async () => {
      while (queue.length && !cancelled) {
        const tile = queue.shift();
        if (!tile) break;
        try {
          await fetch(`/api/tiles/${tile.z}/${tile.x}/${tile.y}`);
        } catch {
          /* a missed tile can load later */
        }
        done += 1;
        if (!cancelled) setTileProgress({ done, total: tiles.length });
      }
    });
    void Promise.all(workers).then(async () => {
      if (cancelled) return;
      await idbSetKv("tilesSaved", "1");
      setMapSaved(true);
      setTileProgress(null);
    });
    return () => {
      cancelled = true;
    };
  }, [session, online, mapSaved]);

  async function clearMyPath() {
    const current = sessionRef.current;
    trailEpoch.current += 1;
    trailRef.current = [];
    setTrail([]);
    setConfirmClear(false);
    if (!current) return;
    try {
      await idbSetKv(`trail:${current.userId}`, []);
      const res = await fetch("/api/trails", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...deskHeaders() },
        body: JSON.stringify({
          userId: current.userId,
          group: current.group,
          ...(current.desk ? { desk: adminCode() } : {}),
        }),
      });
      if (!res.ok) {
        setSyncNote("Couldn't erase the saved path. Try again when you have signal.");
        return;
      }
      const data = (await res.json()) as { trails?: StoredTrail[] };
      const nextTrails = data.trails ?? [];
      setTrails(nextTrails);
      await idbSetKv(`trails:${current.group}`, nextTrails);
      setSyncNote("Path erased from storage.");
    } catch {
      setSyncNote("Couldn't erase the saved path. Try again when you have signal.");
    }
  }

  async function deskClearTrail(target: StoredTrail) {
    setDeskBusy(true);
    try {
      const res = await fetch("/api/trails", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...deskHeaders() },
        body: JSON.stringify({ userId: target.userId, group: target.group, desk: adminCode() }),
      });
      if (!res.ok) {
        setSyncNote("Couldn't update that path.");
        return;
      }
      const data = (await res.json()) as { trails?: StoredTrail[] };
      setTrails(data.trails ?? []);
      setDeskTarget(null);
      setSyncNote(`Cleared ${target.name}'s path.`);
    } catch {
      setSyncNote("Couldn't update that path.");
    } finally {
      setDeskBusy(false);
    }
  }

  async function deskKeepTrail(target: StoredTrail) {
    setDeskBusy(true);
    try {
      const res = await fetch("/api/trails", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...deskHeaders() },
        body: JSON.stringify({
          userId: target.userId,
          group: target.group,
          name: target.name,
          crumbs: target.crumbs,
          desk: adminCode(),
        }),
      });
      if (!res.ok) {
        setSyncNote("Couldn't save that path.");
        return;
      }
      const data = (await res.json()) as { trails?: StoredTrail[] };
      setTrails(data.trails ?? []);
      setDeskTarget(null);
      setSyncNote(`Saved ${target.name}'s path (${target.crumbs.length} points).`);
    } catch {
      setSyncNote("Couldn't save that path.");
    } finally {
      setDeskBusy(false);
    }
  }

  async function onLogin(event: React.FormEvent) {
    event.preventDefault();
    const clean = safeName(name);
    if (!clean) {
      setLoginError("Type your name. That's the whole login.");
      return;
    }
    const typedGroup = safeGroup(group);
    const desk = isAdminGroup(typedGroup);
    const next = saveSession({
      name: clean,
      userId: crypto.randomUUID(),
      // Desk code rides with the main park group so live pins still match everyone else.
      group: desk ? "boggs" : typedGroup,
      vehicle: safeRide(vehicle),
      ...(desk ? { desk: true } : {}),
    });
    setSession(next);
    setLoginError("");
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !session) return;
    const here = fixRef.current;
    if (!here || Date.now() - here.at > 120000) {
      setGpsError("Need a GPS fix before a photo can be pinned.");
      return;
    }
    try {
      const blob = await compressPhoto(file);
      const photo = {
        id: crypto.randomUUID(),
        userId: session.userId,
        name: session.name,
        group: session.group,
        lat: here.lat,
        lng: here.lng,
        takenAt: Date.now(),
        blob,
      };
      await idbPutPending(photo);
      await rebuildPhotos();
      setSyncNote("Photo saved on this phone.");
      void uploadPending();
    } catch {
      setStorageError("Couldn't save that photo on this phone.");
    }
  }

  const others = useMemo(
    () => riders.filter((rider) => rider.userId !== session?.userId),
    [riders, session],
  );

  const showLocationCard =
    !hideLocationCard &&
    (gpsPhase === "need-tap" ||
      gpsPhase === "denied" ||
      gpsPhase === "unavailable" ||
      (!fix && gpsPhase === "watching" && !!gpsError));
  const showLocationSteps = gpsPhase === "denied" || gpsPhase === "unavailable";

  const status = !online
    ? mapSaved
      ? "No signal · map saved"
      : "No signal · map not on phone yet"
    : tileProgress
      ? `Saving map ${tileProgress.done}/${tileProgress.total}`
      : mapSaved
        ? others.length
          ? `Live · ${others.length + (fix ? 1 : 0)} riding`
          : "Live · map saved"
        : "Live";

  if (!ready) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[#f6f1e6] text-zinc-950">
        <div className="text-center">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-orange-700">Andalusia</p>
          <h1 className="mt-2 text-4xl font-black">Boggs & Boulders</h1>
        </div>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="min-h-dvh bg-[#f6f1e6] px-5 py-10 text-zinc-950">
        <div className="mx-auto flex min-h-[80dvh] w-full max-w-md flex-col justify-center">
          <p className="text-sm font-bold uppercase tracking-[0.22em] text-orange-700">Off-road park</p>
          <h1 className="mt-2 text-5xl font-black leading-none">Boggs & Boulders</h1>
          <p className="mt-4 text-xl font-semibold leading-snug">
            See your group on the trail map. It keeps working when the woods eat the signal.
          </p>
          <form onSubmit={onLogin} className="mt-8 space-y-4">
            <label className="block text-lg font-extrabold" htmlFor="rider-name">
              Your name
            </label>
            <input
              id="rider-name"
              data-testid="rider-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="nickname"
              enterKeyHint="go"
              maxLength={24}
              className="h-16 w-full rounded-2xl border-[3px] border-zinc-950 bg-white px-4 text-2xl font-bold outline-none focus:ring-4 focus:ring-orange-400"
              placeholder="Adam"
            />
            <label className="block text-lg font-extrabold" htmlFor="rider-ride">
              Ride
            </label>
            <div className="grid grid-cols-3 gap-2">
              {["Buggy", "ATV", "UTV"].map((ride) => (
                <button
                  key={ride}
                  type="button"
                  data-testid={`ride-${ride.toLowerCase()}`}
                  className={`min-h-14 rounded-2xl border-[3px] border-zinc-950 text-lg font-extrabold ${vehicle === ride ? "bg-orange-600 text-white" : "bg-white"}`}
                  onClick={() => setVehicle(ride)}
                >
                  {ride}
                </button>
              ))}
            </div>
            <input
              id="rider-ride"
              data-testid="rider-ride"
              value={vehicle}
              onChange={(event) => setVehicle(event.target.value)}
              autoCapitalize="words"
              maxLength={32}
              className="h-16 w-full rounded-2xl border-[3px] border-zinc-950 bg-white px-4 text-2xl font-bold outline-none focus:ring-4 focus:ring-orange-400"
              placeholder="Or type it"
            />
            <label className="block text-lg font-extrabold" htmlFor="group-code">
              Group code
            </label>
            <input
              id="group-code"
              data-testid="group-code"
              value={group}
              onChange={(event) => setGroup(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              maxLength={24}
              className="h-16 w-full rounded-2xl border-[3px] border-zinc-950 bg-white px-4 text-2xl font-bold outline-none focus:ring-4 focus:ring-orange-400"
            />
            <p className="text-base font-semibold text-zinc-700">Friends using the same code see each other. Leave it as boggs unless you picked another.</p>
            {loginError ? <p className="text-lg font-bold text-red-700">{loginError}</p> : null}
            {storageError ? <p className="text-lg font-bold text-red-700">{storageError}</p> : null}
            <Button type="submit" data-testid="start" className="w-full text-2xl">
              Start riding
            </Button>
          </form>
          {installEvent ? (
            <Button
              type="button"
              variant="dark"
              className="mt-4 w-full"
              onClick={() => {
                void installEvent.prompt();
              }}
            >
              Install on this phone
            </Button>
          ) : (
            <p className="mt-6 text-base font-semibold text-zinc-700">
              Add it to your home screen so it opens like an app. On iPhone: Share, then Add to Home Screen.
            </p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="fixed inset-0 overflow-hidden bg-[#d7dece] text-zinc-950">
      <TrailMap
        riders={riders}
        trails={trails}
        photos={photos}
        selfId={session.userId}
        selfName={session.name}
        selfFix={fix}
        selfTrail={trail}
        showCrumbs={showCrumbs}
        showPhotos={showPhotos}
        opacity={opacity}
        showSheet={showSheet}
        controlsCollapsed={controlsCollapsed}
        layoutTick={layoutTick}
        command={command}
        onPhoto={setOpenPhoto}
        onRider={(userId) => {
          if (userId === session.userId) {
            setProfile({
              name: session.name,
              vehicle: session.vehicle || "",
              detail: "You",
            });
            return;
          }
          const rider = riders.find((item) => item.userId === userId);
          if (!rider) return;
          setProfile({
            name: rider.name,
            vehicle: rider.vehicle || "",
            detail: `Last seen ${ageLabel(rider.updatedAt)}`,
          });
        }}
      />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-[2000] flex items-start justify-between gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="pointer-events-auto max-w-[70%] rounded-2xl border-[3px] border-zinc-950 bg-white px-3 py-2 shadow-[3px_3px_0_#111]">
          <p className="truncate text-lg font-black leading-none">
            {session.name}
            <span className="font-bold text-zinc-600"> · {session.group}</span>
          </p>
          <p data-testid="status" className="mt-1 text-sm font-extrabold uppercase tracking-wide text-orange-700">
            {status}
          </p>
        </div>
        <Button
          type="button"
          variant="light"
          size="glove"
          className={`pointer-events-auto px-3 ${compact ? "min-h-11 text-sm" : "min-h-14 text-base"}`}
          onClick={() => {
            clearSession();
            setSession(null);
            setFix(null);
          }}
        >
          Switch
        </Button>
      </header>

      {(storageError || syncNote || (!showLocationCard && gpsError)) && (
        <div className="pointer-events-none absolute inset-x-3 top-24 z-[2000]">
          <p className="pointer-events-auto rounded-2xl border-[3px] border-zinc-950 bg-amber-200 px-3 py-2 text-base font-extrabold shadow-[3px_3px_0_#111]">
            {storageError || syncNote || gpsError}
          </p>
        </div>
      )}

      {showLocationCard ? (
        <div className="pointer-events-none absolute inset-x-3 top-24 z-[2100]">
          <div
            data-testid="location-prompt"
            className="pointer-events-auto mx-auto max-w-lg rounded-3xl border-[3px] border-zinc-950 bg-white p-4 shadow-[4px_4px_0_#111]"
          >
            <p className="text-2xl font-black leading-none">Location is off</p>
            <p data-testid="gps-error" className="mt-2 text-base font-bold text-zinc-800">
              {gpsError || "Tap the button so this phone can ask for GPS."}
            </p>
            <Button type="button" data-testid="turn-on-location" className="mt-3 w-full" onClick={beginWatch}>
              Turn on location
            </Button>
            <Button
              type="button"
              variant="light"
              data-testid="location-dismiss"
              className="mt-2 w-full min-h-12 text-base"
              onClick={() => setHideLocationCard(true)}
            >
              Hide for now
            </Button>
            {showLocationSteps ? <LocationSteps kind={deviceKind} /> : null}
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[2000] border-t-[3px] border-zinc-950 bg-[#fffdf6] p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="pointer-events-auto mx-auto flex max-w-lg flex-col gap-2">
          {controlsCollapsed ? (
            <div className="grid grid-cols-[1fr_1fr_3.25rem] gap-2">
              <Button
                type="button"
                data-testid="center"
                className="min-h-12 px-2 text-base"
                onClick={() => {
                  if (!fix) setGpsError("Still waiting for GPS.");
                  setCommand({ type: "me", id: Date.now() });
                }}
              >
                Me
              </Button>
              <Button
                type="button"
                variant="dark"
                data-testid="controls-menu"
                className="min-h-12 px-2 text-base"
                onClick={() => {
                  setMenuOpen(true);
                  bumpLayout();
                }}
              >
                Menu
              </Button>
              <Button
                type="button"
                variant="light"
                data-testid="camera"
                aria-label="Take a photo and pin it here"
                className="h-12 w-full min-h-12 px-0"
                onClick={() => fileRef.current?.click()}
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.4">
                  <path d="M4 8h3l2-2h6l2 2h3v11H4V8z" />
                  <circle cx="12" cy="13" r="3.2" />
                </svg>
              </Button>
            </div>
          ) : (
            <>
          <div className="flex gap-2">
            {compact ? (
              <Button
                type="button"
                variant="dark"
                data-testid="controls-done"
                className="min-h-11 flex-1 px-3 text-sm"
                onClick={minimizeControls}
              >
                Done
              </Button>
            ) : null}
            <Button
              type="button"
              variant="light"
              data-testid="compact-toggle"
              className={`min-h-11 px-3 text-sm ${compact ? "" : "ml-auto"}`}
              onClick={() => {
                setCompact((current) => {
                  const next = !current;
                  localStorage.setItem("boggs.compact", next ? "1" : "0");
                  return next;
                });
                setMenuOpen(false);
                setConfirmClear(false);
                bumpLayout();
              }}
            >
              {compact ? "Bigger buttons" : "Smaller buttons"}
            </Button>
          </div>
          <div className="grid grid-cols-[1fr_1fr_4.5rem] gap-2">
            <Button
              type="button"
              data-testid="center"
              onClick={() => {
                if (!fix) setGpsError("Still waiting for GPS.");
                setCommand({ type: "me", id: Date.now() });
                if (compact) minimizeControls();
              }}
            >
              Me
            </Button>
            <Button
              type="button"
              variant="dark"
              data-testid="everyone"
              onClick={() => {
                setCommand({ type: "all", id: Date.now() });
                if (compact) minimizeControls();
              }}
            >
              Everyone
            </Button>
            <Button
              type="button"
              variant="light"
              size="icon"
              data-testid="camera"
              aria-label="Take a photo and pin it here"
              onClick={() => {
                fileRef.current?.click();
                if (compact) minimizeControls();
              }}
            >
              <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M4 8h3l2-2h6l2 2h3v11H4V8z" />
                <circle cx="12" cy="13" r="3.2" />
              </svg>
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Button
              type="button"
              variant={showCrumbs ? "default" : "light"}
              data-testid="crumbs-show"
              className="min-h-14 px-2 text-base"
              onClick={() => {
                setConfirmClear(false);
                setShowCrumbs((current) => {
                  const next = !current;
                  localStorage.setItem("boggs.crumbs.show", next ? "1" : "0");
                  return next;
                });
              }}
            >
              {showCrumbs ? "Paths on" : "Paths off"}
            </Button>
            <Button
              type="button"
              variant={recordCrumbs ? "dark" : "light"}
              data-testid="crumbs-record"
              className="min-h-14 px-2 text-base"
              onClick={() => {
                setConfirmClear(false);
                setRecordCrumbs((current) => {
                  const next = !current;
                  localStorage.setItem("boggs.crumbs.record", next ? "1" : "0");
                  return next;
                });
              }}
            >
              {recordCrumbs ? "Recording" : "Paused"}
            </Button>
            <Button
              type="button"
              variant="light"
              data-testid="crumbs-clear"
              className="min-h-14 px-2 text-base"
              onClick={() => {
                if (!confirmClear) {
                  setConfirmClear(true);
                  return;
                }
                void clearMyPath().then(() => {
                  if (compact) minimizeControls();
                });
              }}
            >
              {confirmClear ? "Erase path?" : "Clear"}
            </Button>
          </div>
          <p className="text-center text-sm font-bold text-zinc-700">
            {recordCrumbs
              ? "Your path is kept in storage until you clear it."
              : "Recording is paused. The saved path stays put."}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={showPhotos ? "default" : "light"}
              data-testid="photos-show"
              className="min-h-12 px-2 text-base"
              onClick={() => {
                setShowPhotos((current) => {
                  const next = !current;
                  localStorage.setItem("boggs.photos", next ? "1" : "0");
                  return next;
                });
              }}
            >
              {showPhotos ? "Photos on" : "Photos off"}
            </Button>
            <div className="flex items-center justify-between gap-2 rounded-2xl border-[3px] border-zinc-950 bg-white px-3">
            <span className="text-sm font-extrabold uppercase tracking-wide">Sheet</span>
            <Button
              type="button"
              variant={showSheet ? "default" : "light"}
              data-testid="printed-map"
              className="min-h-12 px-3 text-base"
              onClick={() => {
                setShowSheet((current) => {
                  const next = !current;
                  localStorage.setItem("boggs.sheet", next ? "1" : "0");
                  return next;
                });
              }}
            >
              {showSheet ? "On" : "Off"}
            </Button>
            </div>
          </div>
          {session.desk ? (
            <Button
              type="button"
              variant="dark"
              data-testid="desk-paths"
              className="min-h-12 w-full text-base"
              onClick={() => {
                // Collapse the control bar first so the map keeps full height under the panel.
                setMenuOpen(false);
                setConfirmClear(false);
                setDeskPanel(true);
                setDeskTarget(null);
              }}
            >
              All rider paths ({trails.length})
            </Button>
          ) : null}
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-sm font-extrabold uppercase tracking-wide">
              Trail map
              <span>{Math.round(opacity * 100)}%</span>
            </span>
            <input
              data-testid="opacity"
              className="glove-range w-full"
              type="range"
              min={0}
              max={100}
              value={Math.round(opacity * 100)}
              onChange={(event) => {
                const next = Number(event.target.value) / 100;
                setOpacity(next);
                localStorage.setItem("boggs.opacity", String(next));
              }}
            />
          </label>
          <p data-testid="offline-status" className="text-center text-sm font-bold text-zinc-700">
            {mapSaved ? "Map saved on this phone" : online ? "Saving the park map for no-signal riding" : "Open this once on wifi before you roll out"}
          </p>
            </>
          )}
        </div>
      </div>

      <input
        ref={fileRef}
        data-testid="camera-input"
        className="hidden"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onFile}
      />

      {profile ? (
        <div className="pointer-events-none absolute inset-x-3 bottom-28 z-[2500]" data-testid="rider-profile">
          <div className="pointer-events-auto mx-auto max-w-lg rounded-3xl border-[3px] border-zinc-950 bg-white p-4 shadow-[4px_4px_0_#111]">
            <p className="text-3xl font-black leading-none">{profile.name}</p>
            <p className="mt-2 text-xl font-extrabold text-orange-700">{profile.vehicle || "No ride set"}</p>
            <p className="mt-1 text-base font-bold text-zinc-700">{profile.detail}</p>
            <Button type="button" variant="dark" className="mt-3 w-full" onClick={() => setProfile(null)}>
              Close
            </Button>
          </div>
        </div>
      ) : null}

      {deskPanel && session.desk ? (
        <div className="pointer-events-none absolute inset-0 z-[2600] flex flex-col justify-end p-3 pb-[max(4.5rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]" data-testid="desk-panel">
          <div className="pointer-events-auto mx-auto flex max-h-[70dvh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border-[3px] border-zinc-950 bg-[#fffdf6] shadow-[4px_4px_0_#111]">
            <div className="border-b-[3px] border-zinc-950 p-4">
              <p className="text-2xl font-black leading-none">Rider paths</p>
              <p className="mt-2 text-sm font-bold text-zinc-700">
                Every group&apos;s breadcrumbs stay in storage. Open one to keep it or clear it when you update the trails.
              </p>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {trails.length === 0 ? (
                <p className="p-2 text-base font-bold text-zinc-700">No stored paths yet. They show up as riders record.</p>
              ) : (
                trails.map((item) => (
                  <button
                    key={`${item.group}:${item.userId}`}
                    type="button"
                    data-testid="desk-trail"
                    className={`w-full rounded-2xl border-[3px] border-zinc-950 px-3 py-3 text-left ${deskTarget?.userId === item.userId && deskTarget.group === item.group ? "bg-orange-100" : "bg-white"}`}
                    onClick={() => setDeskTarget(item)}
                  >
                    <p className="text-lg font-black leading-none">{item.name}</p>
                    <p className="mt-1 text-sm font-bold text-zinc-700">
                      {item.group} · {item.crumbs.length} points
                    </p>
                  </button>
                ))
              )}
            </div>
            <div className="space-y-2 border-t-[3px] border-zinc-950 p-3">
              {deskTarget ? (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    data-testid="desk-keep"
                    disabled={deskBusy || deskTarget.crumbs.length === 0}
                    onClick={() => void deskKeepTrail(deskTarget)}
                  >
                    Keep path
                  </Button>
                  <Button
                    type="button"
                    variant="light"
                    data-testid="desk-clear"
                    disabled={deskBusy}
                    onClick={() => void deskClearTrail(deskTarget)}
                  >
                    Clear path
                  </Button>
                </div>
              ) : null}
              <Button
                type="button"
                variant="dark"
                className="w-full"
                onClick={() => {
                  setDeskPanel(false);
                  setDeskTarget(null);
                  minimizeControls();
                }}
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {openPhoto ? (
        <div className="absolute inset-0 z-[3000] flex flex-col bg-zinc-950/80 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]" data-testid="photo-viewer">
          <div className="mx-auto flex h-full w-full max-w-lg flex-col overflow-hidden rounded-3xl border-[3px] border-white bg-[#fffdf6]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={openPhoto.localUrl} alt={`Photo by ${openPhoto.name}`} className="min-h-0 flex-1 bg-black object-contain" />
            <div className="space-y-3 p-4">
              <p className="text-2xl font-black">{openPhoto.name}</p>
              <p className="text-lg font-bold">
                {formatWhen(openPhoto.takenAt)} · {ageLabel(openPhoto.takenAt)}
              </p>
              {openPhoto.pending ? (
                <p className="text-base font-extrabold text-orange-700">On this phone. It sends when you have signal.</p>
              ) : (
                <p className="text-base font-semibold text-zinc-700">Pinned where it was taken. The group keeps this one.</p>
              )}
              <Button type="button" variant="dark" className="w-full" onClick={() => setOpenPhoto(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function LocationSteps({ kind }: { kind: DeviceKind }) {
  if (kind === "ios") {
    return (
      <ol data-testid="location-steps" className="mt-3 list-decimal space-y-1 pl-5 text-sm font-bold leading-snug text-zinc-800">
        <li>Settings, Privacy &amp; Security, Location Services, On.</li>
        <li>Safari, Websites, Location, While Using.</li>
        <li>In Safari tap aA, Website Settings, Location, Allow.</li>
      </ol>
    );
  }
  if (kind === "android") {
    return (
      <div data-testid="location-steps" className="mt-3 space-y-2 text-sm font-bold leading-snug text-zinc-800">
        <ol className="list-decimal space-y-1 pl-5">
          <li>Tap the lock icon, Permissions, Location, Allow.</li>
          <li>Settings, Location, On.</li>
        </ol>
        <a
          href="intent:#Intent;action=android.settings.LOCATION_SOURCE_SETTINGS;end"
          className="inline-flex min-h-11 items-center rounded-2xl border-[3px] border-zinc-950 bg-white px-3 text-sm font-extrabold text-zinc-950"
        >
          Open Location settings
        </a>
      </div>
    );
  }
  return (
    <p data-testid="location-steps" className="mt-3 text-sm font-bold leading-snug text-zinc-800">
      Allow location for this site in the address bar, then tap Turn on location again.
    </p>
  );
}

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
};
