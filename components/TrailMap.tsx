"use client";

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import type { ImageOverlay, LayerGroup, Map as LeafletMap, Marker, Polyline } from "leaflet";
import { PARK, expandBounds } from "@/lib/park";
import type { Crumb } from "@/lib/trail";
import type { PhotoMeta, Rider, StoredTrail } from "@/lib/types";

export type MapPhoto = PhotoMeta & { localUrl: string; pending: boolean };

type Command =
  | { type: "me" | "all"; id: number }
  | { type: "focus"; id: number; lat: number; lng: number }
  | null;

type Props = {
  riders: Rider[];
  trails: StoredTrail[];
  photos: MapPhoto[];
  selfId?: string;
  selfFix?: { lat: number; lng: number; at: number } | null;
  selfTrail?: Crumb[];
  showCrumbs?: boolean;
  showPhotos?: boolean;
  selfName?: string;
  opacity: number;
  showSheet?: boolean;
  /** True when the bottom chrome is the short Me/Menu/Camera bar. */
  controlsCollapsed?: boolean;
  /** Bumps when the bottom chrome height changes so tiles reflow. */
  layoutTick?: number;
  command: Command;
  onPhoto: (photo: MapPhoto) => void;
  onRider?: (userId: string) => void;
};

type ParkFeature = {
  properties?: { kind?: string; name?: string };
  geometry?: { type?: string; coordinates?: unknown };
};

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[ch] ?? ch;
  });
}

export function ageLabel(updatedAt: number, now = Date.now()) {
  const sec = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 36) return `${hr} hr ago`;
  return `${Math.round(hr / 24)} d ago`;
}

function fadeFor(updatedAt: number, now = Date.now()) {
  const min = (now - updatedAt) / 60000;
  if (min < 5) return 1;
  if (min < 20) return 0.88;
  if (min < 60) return 0.62;
  if (min < 180) return 0.42;
  return 0.28;
}

const CRUMB_COLORS = ["#2563eb", "#7c3aed", "#0f766e", "#b45309", "#be185d", "#0369a1"];

function crumbColor(userId: string) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return CRUMB_COLORS[hash % CRUMB_COLORS.length];
}

function lineFor(trail: Crumb[] | undefined, lat: number, lng: number): [number, number][] {
  const points: [number, number][] = (trail ?? []).map((crumb) => [crumb.lat, crumb.lng]);
  const last = points[points.length - 1];
  if (!last || Math.abs(last[0] - lat) > 1e-7 || Math.abs(last[1] - lng) > 1e-7) {
    points.push([lat, lng]);
  }
  return points;
}

export function TrailMap({ riders, trails, photos, selfId, selfFix, selfTrail, showCrumbs = true, showPhotos = true, selfName, opacity, showSheet = false, controlsCollapsed = false, layoutTick = 0, command, onPhoto, onRider }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const [mapReady, setMapReady] = useState(false);
  const mapRef = useRef<LeafletMap | null>(null);
  const tilesRef = useRef<{ redraw: () => void } | null>(null);
  const sheetRef = useRef<ImageOverlay | null>(null);
  const parkLines = useRef<Polyline[]>([]);
  const poiLayer = useRef<LayerGroup | null>(null);
  const opacityRef = useRef(opacity);
  opacityRef.current = opacity;
  const collapsedRef = useRef(controlsCollapsed);
  collapsedRef.current = controlsCollapsed;
  const userMoved = useRef(false);
  const riderLayer = useRef<LayerGroup | null>(null);
  const photoLayer = useRef<LayerGroup | null>(null);
  const markers = useRef(new globalThis.Map<string, Marker>());
  const crumbs = useRef(new globalThis.Map<string, Polyline>());
  const onPhotoRef = useRef(onPhoto);
  onPhotoRef.current = onPhoto;
  const onRiderRef = useRef(onRider);
  onRiderRef.current = onRider;

  useEffect(() => {
    let map: LeafletMap | undefined;
    let alive = true;
    const host = elRef.current;
    if (!host) return;

    (async () => {
      const L = await import("leaflet");
      if (!alive || !host) return;
      const fence = expandBounds(PARK.bounds, 0.35);
      map = L.map(host, {
        zoomControl: false,
        attributionControl: true,
        maxZoom: 19,
        minZoom: 13,
        maxBounds: [
          [fence.south, fence.west],
          [fence.north, fence.east],
        ],
        maxBoundsViscosity: 0.85,
      });
      L.control.zoom({ position: "topright" }).addTo(map);
      const tiles = L.tileLayer("/api/tiles/{z}/{x}/{y}", {
        maxZoom: 19,
        maxNativeZoom: 17,
        attribution: "Satellite · Esri World Imagery",
      }).addTo(map);
      tilesRef.current = tiles;

      map.createPane("park-sheet");
      const sheetPane = map.getPane("park-sheet");
      if (sheetPane) {
        sheetPane.style.zIndex = "405";
        sheetPane.style.pointerEvents = "none";
      }
      map.createPane("park-trails");
      const trailPane = map.getPane("park-trails");
      if (trailPane) {
        trailPane.style.zIndex = "410";
        trailPane.style.pointerEvents = "none";
      }
      map.createPane("crumbs");
      const crumbPane = map.getPane("crumbs");
      if (crumbPane) crumbPane.style.zIndex = "450";
      riderLayer.current = L.layerGroup().addTo(map);
      photoLayer.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      setMapReady(true);
      const view = expandBounds(PARK.bounds, 0.04);
      map.fitBounds(
        [
          [view.south, view.west],
          [view.north, view.east],
        ],
        { paddingTopLeft: [16, 78], paddingBottomRight: [16, collapsedRef.current ? 108 : 280] },
      );
      map.on("dragstart", () => {
        userMoved.current = true;
      });
    })();

    const markerMap = markers.current;
    const crumbMap = crumbs.current;
    return () => {
      alive = false;
      markerMap.clear();
      crumbMap.clear();
      map?.remove();
      mapRef.current = null;
      tilesRef.current = null;
      setMapReady(false);
      sheetRef.current = null;
      parkLines.current = [];
      poiLayer.current = null;
      riderLayer.current = null;
      photoLayer.current = null;
    };
    // Map is created once. Later effects push data in.
  }, []);

  useEffect(() => {
    for (const line of parkLines.current) line.setStyle({ opacity });
    sheetRef.current?.setOpacity(opacity);
  }, [opacity, mapReady]);

  useEffect(() => {
    // Toggle via classList so React never rewrites the host className and
    // wipes Leaflet's leaflet-container / touch / grab classes (blank map).
    elRef.current?.classList.toggle("compact-controls", controlsCollapsed);
  }, [controlsCollapsed]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    // Bottom chrome open/close changes usable size; without this tiles stay blank
    // until a full page refresh. Wait a frame so layout has settled first.
    let alive = true;
    let timeout = 0;
    const refresh = () => {
      if (!alive) return;
      map.invalidateSize({ animate: false });
      tilesRef.current?.redraw();
    };
    const raf = window.requestAnimationFrame(() => {
      refresh();
      timeout = window.setTimeout(refresh, 160);
    });
    return () => {
      alive = false;
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timeout);
    };
  }, [controlsCollapsed, layoutTick, mapReady]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    let alive = true;
    const map = mapRef.current;
    (async () => {
      const L = await import("leaflet");
      const res = await fetch("/trails.geojson");
      if (!res.ok || !alive) return;
      const data = (await res.json()) as { features?: ParkFeature[] };
      if (!alive) return;
      const trailsRings: [number, number][][] = [];
      const roadRings: [number, number][][] = [];
      const pois = L.layerGroup();
      const placed = new Set<string>();
      for (const feature of data.features ?? []) {
        const kind = feature.properties?.kind;
        const geometry = feature.geometry;
        if (geometry?.type === "LineString" && Array.isArray(geometry.coordinates)) {
          const ring = (geometry.coordinates as [number, number][])
            .filter((pair) => Array.isArray(pair) && pair.length >= 2)
            .map(([lng, lat]) => [lat, lng] as [number, number]);
          if (ring.length < 2) continue;
          if (kind === "road") roadRings.push(ring);
          else if (kind === "trail") trailsRings.push(ring);
        } else if (kind === "poi" && geometry?.type === "Point" && Array.isArray(geometry.coordinates)) {
          const [lng, lat] = geometry.coordinates as [number, number];
          const name = feature.properties?.name ?? "";
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) continue;
          const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
          const stacked = placed.has(key);
          placed.add(key);
          L.marker([lat, lng], {
            icon: L.divIcon({
              className: "boggs-divicon",
              html: `<div class="poi-pin${stacked ? " stacked" : ""}"><span class="poi-dot"></span><span class="poi-tag">${esc(name)}</span></div>`,
              iconSize: [8, 8],
              iconAnchor: [6, 6],
            }),
            interactive: false,
            keyboard: false,
            zIndexOffset: 120,
          }).addTo(pois);
        }
      }
      if (!alive) return;
      const draw = (rings: [number, number][][], color: string, weight: number) => {
        if (!rings.length) return;
        const line = L.polyline(rings, {
          color,
          weight,
          opacity: opacityRef.current,
          lineCap: "round",
          lineJoin: "round",
          pane: "park-trails",
          interactive: false,
          className: "park-trail",
        });
        line.addTo(map);
        parkLines.current.push(line);
      };
      draw(trailsRings, "#1a1208", 6);
      draw(roadRings, "#3a2a12", 6.5);
      draw(trailsRings, "#2f6fe0", 3.2);
      draw(roadRings, "#e0b15a", 3.6);
      pois.addTo(map);
      poiLayer.current = pois;
    })();
    return () => {
      alive = false;
      for (const line of parkLines.current) line.remove();
      parkLines.current = [];
      poiLayer.current?.remove();
      poiLayer.current = null;
    };
    // Drawn once. Opacity is applied by the effect above.
  }, [mapReady]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    let alive = true;
    const map = mapRef.current;
    if (!showSheet) {
      sheetRef.current?.remove();
      sheetRef.current = null;
      return;
    }
    (async () => {
      const L = await import("leaflet");
      if (!alive || sheetRef.current) return;
      const sheetBounds = PARK.sheet;
      const sheet = L.imageOverlay(
        PARK.overlayUrl,
        [
          [sheetBounds.south, sheetBounds.west],
          [sheetBounds.north, sheetBounds.east],
        ],
        {
          opacity,
          pane: "park-sheet",
          interactive: false,
          className: "park-trail",
        },
      );
      sheet.addTo(map);
      sheetRef.current = sheet;
    })();
    return () => {
      alive = false;
    };
  }, [showSheet, mapReady, opacity]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const L = await import("leaflet");
      if (!alive || !mapReady || !riderLayer.current) return;
      const layer = riderLayer.current;
      const seen = new Set<string>();
      const now = Date.now();

      const draw = (id: string, userId: string, lat: number, lng: number, html: string, opacityValue: number, z: number, anchor: [number, number]) => {
        seen.add(id);
        let marker = markers.current.get(id);
        if (!marker) {
          marker = L.marker([lat, lng], {
            icon: L.divIcon({
              className: "boggs-divicon",
              html,
              iconSize: [200, 48],
              iconAnchor: anchor,
            }),
            opacity: opacityValue,
            zIndexOffset: z,
            keyboard: true,
            title: selfName,
          });
          marker.on("click", () => onRiderRef.current?.(userId));
          marker.addTo(layer);
          markers.current.set(id, marker);
        } else {
          marker.setLatLng([lat, lng]);
          marker.setOpacity(opacityValue);
          marker.setIcon(
            L.divIcon({
              className: "boggs-divicon",
              html,
              iconSize: [200, 48],
              iconAnchor: anchor,
            }),
          );
          marker.setZIndexOffset(z);
        }
      };

      if (selfFix && selfId && selfName) {
        const fresh = now - selfFix.at < 20000;
        draw(
          `self:${selfId}`,
          selfId,
          selfFix.lat,
          selfFix.lng,
          `<div class="rider-pin self" data-testid="self-pin"><span class="dot"></span><span class="tag">${esc(selfName)}<br><small>${fresh ? "you · live" : "you · last fix"}</small></span></div>`,
          1,
          600,
          [13, 13],
        );
      }

      for (const rider of riders) {
        if (rider.userId === selfId) continue;
        draw(
          `rider:${rider.userId}`,
          rider.userId,
          rider.lat,
          rider.lng,
          `<div class="rider-pin" data-testid="rider-pin"><span class="dot"></span><span class="tag">${esc(rider.name)}<br><small>last seen ${esc(ageLabel(rider.updatedAt, now))}</small></span></div>`,
          fadeFor(rider.updatedAt, now),
          300,
          [11, 11],
        );
      }

      for (const [id, marker] of markers.current) {
        if (id.startsWith("self:") || id.startsWith("rider:")) {
          if (!seen.has(id)) {
            marker.remove();
            markers.current.delete(id);
          }
        }
      }

      const drawn = new Set<string>();
      const paintCrumb = (id: string, points: [number, number][], color: string, self: boolean) => {
        if (points.length < 2) {
          const old = crumbs.current.get(id);
          if (old) {
            old.remove();
            crumbs.current.delete(id);
          }
          return;
        }
        drawn.add(id);
        let line = crumbs.current.get(id);
        if (!line) {
          line = L.polyline(points, {
            color,
            weight: self ? 5 : 4,
            opacity: 0.95,
            lineCap: "round",
            lineJoin: "round",
            pane: "crumbs",
            className: self ? "crumb-line self" : "crumb-line",
          });
          line.addTo(layer);
          crumbs.current.set(id, line);
        } else {
          line.setLatLngs(points);
          line.setStyle({ color, weight: self ? 5 : 4 });
        }
      };

      if (showCrumbs && selfFix && selfId) {
        paintCrumb(`self:${selfId}`, lineFor(selfTrail, selfFix.lat, selfFix.lng), "#ea580c", true);
      }
      if (showCrumbs) {
        for (const trail of trails) {
          if (trail.userId === selfId) continue;
          const live = riders.find((rider) => rider.userId === trail.userId);
          const points = lineFor(trail.crumbs, live?.lat ?? trail.crumbs.at(-1)?.lat ?? 0, live?.lng ?? trail.crumbs.at(-1)?.lng ?? 0);
          const usable = trail.crumbs.length ? points : [];
          paintCrumb(`rider:${trail.userId}`, usable, crumbColor(trail.userId), false);
        }
      }
      for (const [id, line] of crumbs.current) {
        if (!drawn.has(id)) {
          line.remove();
          crumbs.current.delete(id);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [riders, trails, selfFix, selfId, selfName, selfTrail, showCrumbs, mapReady]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const L = await import("leaflet");
      if (!alive || !mapReady || !photoLayer.current) return;
      const layer = photoLayer.current;
      if (!showPhotos) {
        for (const [id, marker] of markers.current) {
          if (id.startsWith("photo:")) {
            marker.remove();
            markers.current.delete(id);
          }
        }
        return;
      }
      const seen = new Set<string>();
      for (const photo of photos) {
        const id = `photo:${photo.id}`;
        seen.add(id);
        const html = `<div class="photo-pin${photo.pending ? " pending" : ""}" data-testid="photo-pin" data-pending="${photo.pending ? "1" : "0"}" title="${esc(photo.name)}"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#111" stroke-width="2.4"><path d="M4 8h3l2-2h6l2 2h3v11H4V8z"/><circle cx="12" cy="13" r="3.2"/></svg></div>`;
        let marker = markers.current.get(id);
        if (!marker) {
          marker = L.marker([photo.lat, photo.lng], {
            icon: L.divIcon({ className: "boggs-divicon", html, iconSize: [56, 56], iconAnchor: [28, 62] }),
            zIndexOffset: 800,
            title: `${photo.name} photo`,
          });
          marker.on("click", () => onPhotoRef.current(photo));
          marker.addTo(layer);
          markers.current.set(id, marker);
        } else {
          marker.setLatLng([photo.lat, photo.lng]);
          marker.setIcon(L.divIcon({ className: "boggs-divicon", html, iconSize: [56, 56], iconAnchor: [28, 62] }));
          marker.setZIndexOffset(800);
          marker.off("click");
          marker.on("click", () => onPhotoRef.current(photo));
        }
      }
      for (const [id, marker] of markers.current) {
        if (id.startsWith("photo:") && !seen.has(id)) {
          marker.remove();
          markers.current.delete(id);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [photos, mapReady, showPhotos]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !command) return;
    if (command.type === "me" && selfFix) {
      map.setView([selfFix.lat, selfFix.lng], 17, { animate: true });
      return;
    }
    if (command.type === "focus") {
      map.setView([command.lat, command.lng], 17, { animate: true });
      return;
    }
    if (command.type === "all") {
      const points: [number, number][] = [];
      if (selfFix) points.push([selfFix.lat, selfFix.lng]);
      if (showCrumbs) {
        for (const crumb of selfTrail ?? []) points.push([crumb.lat, crumb.lng]);
        for (const trail of trails) {
          if (trail.userId === selfId) continue;
          for (const crumb of trail.crumbs) points.push([crumb.lat, crumb.lng]);
        }
      }
      for (const rider of riders) {
        if (rider.userId !== selfId) points.push([rider.lat, rider.lng]);
      }
      for (const photo of photos) points.push([photo.lat, photo.lng]);
      if (points.length === 0) {
        const b = PARK.bounds;
        map.fitBounds(
          [
            [b.south, b.west],
            [b.north, b.east],
          ],
          { paddingTopLeft: [16, 78], paddingBottomRight: [16, controlsCollapsed ? 108 : 280] },
        );
        return;
      }
      if (points.length === 1) {
        map.setView(points[0], 16, { animate: true });
        return;
      }
      map.fitBounds(points, { paddingTopLeft: [24, 86], paddingBottomRight: [24, controlsCollapsed ? 108 : 280], maxZoom: 17 });
    }
  }, [command, selfFix, selfTrail, showCrumbs, trails, riders, photos, selfId, mapReady, controlsCollapsed]);

  return <div ref={elRef} data-testid="map" className="absolute inset-0 z-0" />;
}
