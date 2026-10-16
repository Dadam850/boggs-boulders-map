"use client";

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import type { LayerGroup, Map as LeafletMap, Marker, Polyline } from "leaflet";
import { PARK, expandBounds } from "@/lib/park";
import type { Crumb } from "@/lib/trail";
import type { PhotoMeta, Rider, StoredTrail } from "@/lib/types";

export type MapPhoto = PhotoMeta & { localUrl: string; pending: boolean };

type Command = { type: "me" | "all"; id: number } | null;

type Props = {
  riders: Rider[];
  trails: StoredTrail[];
  photos: MapPhoto[];
  selfId?: string;
  selfFix?: { lat: number; lng: number; at: number } | null;
  selfTrail?: Crumb[];
  showCrumbs?: boolean;
  selfName?: string;
  opacity: number;
  command: Command;
  onPhoto: (photo: MapPhoto) => void;
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

export function TrailMap({ riders, trails, photos, selfId, selfFix, selfTrail, showCrumbs = true, selfName, opacity, command, onPhoto }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const [mapReady, setMapReady] = useState(false);
  const mapRef = useRef<LeafletMap | null>(null);
  const parkLines = useRef<Polyline[]>([]);
  const riderLayer = useRef<LayerGroup | null>(null);
  const photoLayer = useRef<LayerGroup | null>(null);
  const markers = useRef(new globalThis.Map<string, Marker>());
  const crumbs = useRef(new globalThis.Map<string, Polyline>());
  const onPhotoRef = useRef(onPhoto);
  onPhotoRef.current = onPhoto;

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
      L.tileLayer("/api/tiles/{z}/{x}/{y}", {
        maxZoom: 19,
        maxNativeZoom: 17,
        attribution: "Satellite · Esri World Imagery",
      }).addTo(map);

      map.createPane("park-trails");
      const trailPane = map.getPane("park-trails");
      if (trailPane) {
        trailPane.style.zIndex = "410";
        trailPane.style.pointerEvents = "none";
      }
      try {
        const res = await fetch("/trails.json");
        const data = (await res.json()) as { lines?: { road?: boolean; path?: [number, number][] }[] };
        const little: [number, number][][] = [];
        const roads: [number, number][][] = [];
        for (const line of data.lines ?? []) {
          if (!line.path || line.path.length < 2) continue;
          (line.road ? roads : little).push(line.path);
        }
        const add = (parts: [number, number][][], color: string, weight: number) => {
          if (!parts.length || !map) return;
          const drawn = L.polyline(parts, {
            color,
            weight,
            opacity,
            pane: "park-trails",
            interactive: false,
            lineCap: "round",
            lineJoin: "round",
            className: "park-trail",
          });
          drawn.addTo(map);
          parkLines.current.push(drawn);
        };
        // Thin red for the little trails, thin black for the main road — the park
        // map's ink, drawn in screen pixels so it stays readable when you zoom out.
        add(little, "#e10600", 2.5);
        add(roads, "#111111", 4);
      } catch {
        /* the satellite map still works if the trail file is missing */
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
        { paddingTopLeft: [16, 78], paddingBottomRight: [16, 280] },
      );
    })();

    const markerMap = markers.current;
    const crumbMap = crumbs.current;
    return () => {
      alive = false;
      markerMap.clear();
      crumbMap.clear();
      map?.remove();
      mapRef.current = null;
      setMapReady(false);
      parkLines.current = [];
      riderLayer.current = null;
      photoLayer.current = null;
    };
    // Map is created once. Later effects push data in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    for (const line of parkLines.current) line.setStyle({ opacity });
  }, [opacity, mapReady]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const L = await import("leaflet");
      if (!alive || !mapReady || !riderLayer.current) return;
      const layer = riderLayer.current;
      const seen = new Set<string>();
      const now = Date.now();

      const draw = (id: string, lat: number, lng: number, html: string, opacityValue: number, z: number, anchor: [number, number]) => {
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
          selfFix.lat,
          selfFix.lng,
          `<div class="rider-pin self"><span class="dot"></span><span class="tag">${esc(selfName)}<br><small>${fresh ? "you · live" : "you · last fix"}</small></span></div>`,
          1,
          600,
          [13, 13],
        );
      }

      for (const rider of riders) {
        if (rider.userId === selfId) continue;
        draw(
          `rider:${rider.userId}`,
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
  }, [photos, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !command) return;
    if (command.type === "me" && selfFix) {
      map.setView([selfFix.lat, selfFix.lng], 17, { animate: true });
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
          { paddingTopLeft: [16, 78], paddingBottomRight: [16, 280] },
        );
        return;
      }
      if (points.length === 1) {
        map.setView(points[0], 16, { animate: true });
        return;
      }
      map.fitBounds(points, { paddingTopLeft: [24, 86], paddingBottomRight: [24, 280], maxZoom: 17 });
    }
  }, [command, selfFix, selfTrail, showCrumbs, trails, riders, photos, selfId, mapReady]);

  return <div ref={elRef} data-testid="map" className="absolute inset-0 z-0" />;
}
