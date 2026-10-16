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
import { clearSession, loadSession, saveSession, type Session } from "@/lib/session";
import { offlineTiles } from "@/lib/tiles";
import { safeGroup, safeName } from "@/lib/sanitize";
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
  const [group, setGroup] = useState("boggs");
  const [loginError, setLoginError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [online, setOnline] = useState(true);
  const [fix, setFix] = useState<Fix | null>(null);
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [gpsError, setGpsError] = useState("");
  const [gpsPhase, setGpsPhase] = useState<GpsPhase>("checking");
  const [deviceKind, setDeviceKind] = useState<DeviceKind>("other");
  const [compact, setCompact] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [trails, setTrails] = useState<StoredTrail[]>([]);
  const [showCrumbs, setShowCrumbs] = useState(true);
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
        if (!cancelled) setSession(existing);
        const savedOpacityRaw = localStorage.getItem("boggs.opacity");
        const savedOpacity = savedOpacityRaw === null ? Number.NaN : Number(savedOpacityRaw);
        if (!cancelled && Number.isFinite(savedOpacity)) setOpacity(Math.min(1, Math.max(0, savedOpacity)));
        if (!cancelled && localStorage.getItem("boggs.sheet") === "1") setShowSheet(true);
        if (!cancelled && localStorage.getItem("boggs.crumbs.show") === "0") setShowCrumbs(false);
        if (!cancelled && localStorage.getItem("boggs.crumbs.record") === "0") setRecordCrumbs(false);
        if (!cancelled && localStorage.getItem("boggs.compact") === "1") setCompact(true);
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
      if (here) {
        riderRes = await fetch("/api/riders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: current.userId,
            name: current.name,
            group: current.group,
            lat: here.lat,
            lng: here.lng,
            trail: trailRef.current,
            record: recordRef.current,
          }),
        });
      } else {
        riderRes = await fetch(`/api/riders?group=${encodeURIComponent(current.group)}`);
      }
      if (riderRes.ok) {
        const data = (await riderRes.json()) as { riders: Rider[]; trails?: StoredTrail[] };
        setRiders(data.riders);
        await idbSetRiders(current.group, data.riders);
        const nextTrails = data.trails ?? [];
        setTrails(nextTrails);
        await idbSetKv(`trails:${current.group}`, nextTrails);
        if (epoch === trailEpoch.current) {
          const mine = nextTrails.find((item) => item.userId === current.userId);
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
  }, [rebuildPhotos]);

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: current.userId, group: current.group }),
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

  async function onLogin(event: React.FormEvent) {
    event.preventDefault();
    const clean = safeName(name);
    if (!clean) {
      setLoginError("Type your name. That's the whole login.");
      return;
    }
    const next = saveSession({
      name: clean,
      userId: crypto.randomUUID(),
      group: safeGroup(group),
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
    gpsPhase === "need-tap" ||
    gpsPhase === "denied" ||
    gpsPhase === "unavailable" ||
    (!fix && gpsPhase === "watching" && !!gpsError);
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
        opacity={opacity}
        showSheet={showSheet}
        compact={compact}
        command={command}
        onPhoto={setOpenPhoto}
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
            {showLocationSteps ? <LocationSteps kind={deviceKind} /> : null}
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[2000] border-t-[3px] border-zinc-950 bg-[#fffdf6]/95 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur">
        <div className="pointer-events-auto mx-auto flex max-w-lg flex-col gap-2">
          {compact && !menuOpen ? (
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
                onClick={() => setMenuOpen(true)}
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
          ) : null}
          {!compact || menuOpen ? (
            <>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="light"
              data-testid="compact-toggle"
              className="min-h-11 px-3 text-sm"
              onClick={() => {
                setCompact((current) => {
                  const next = !current;
                  localStorage.setItem("boggs.compact", next ? "1" : "0");
                  if (!next) setMenuOpen(false);
                  return next;
                });
                if (compact) setMenuOpen(false);
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
              }}
            >
              Me
            </Button>
            <Button
              type="button"
              variant="dark"
              data-testid="everyone"
              onClick={() => setCommand({ type: "all", id: Date.now() })}
            >
              Everyone
            </Button>
            <Button
              type="button"
              variant="light"
              size="icon"
              data-testid="camera"
              aria-label="Take a photo and pin it here"
              onClick={() => fileRef.current?.click()}
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
                void clearMyPath();
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
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-extrabold uppercase tracking-wide">Printed sheet</span>
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
          ) : null}
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
