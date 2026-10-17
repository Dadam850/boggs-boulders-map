import { NextResponse } from "next/server";
import { isAdminGroup } from "@/lib/admin";
import { getStore } from "@/lib/store";
import { safeGroup, safeId, safeName, safeRide, validLatLng } from "@/lib/sanitize";
import { thinCrumbs, type Crumb } from "@/lib/trail";
import type { Rider } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function readTrail(input: unknown): Crumb[] {
  if (!Array.isArray(input)) return [];
  const crumbs: Crumb[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { lat?: unknown; lng?: unknown; at?: unknown };
    const point = validLatLng(rec.lat, rec.lng);
    if (!point) continue;
    const at = typeof rec.at === "number" && Number.isFinite(rec.at) ? rec.at : Date.now();
    crumbs.push({ lat: point.lat, lng: point.lng, at });
  }
  return thinCrumbs(crumbs);
}

function json(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const group = safeGroup(url.searchParams.get("group"));
  const desk = isAdminGroup(url.searchParams.get("desk")) || isAdminGroup(req.headers.get("x-boggs-desk"));
  try {
    const store = getStore();
    const [riders, trails] = await Promise.all([
      store.listRiders(group),
      desk ? store.listAllTrails() : store.listTrails(group),
    ]);
    return json({ riders, trails, desk });
  } catch (error) {
    console.error("list riders", error);
    return json({ error: "Couldn't read the group" }, 500);
  }
}

export async function POST(req: Request) {
  let body: Partial<Rider> & { trail?: unknown; record?: unknown };
  try {
    body = (await req.json()) as Partial<Rider> & { trail?: unknown; record?: unknown };
  } catch {
    return json({ error: "Bad JSON" }, 400);
  }
  const name = safeName(body.name);
  const userId = safeId(body.userId);
  const group = safeGroup(body.group);
  if (!name) return json({ error: "Name required" }, 400);
  if (!userId) return json({ error: "Bad rider id" }, 400);
  const point = validLatLng(body.lat, body.lng);
  if (!point) return json({ error: "Bad location" }, 400);

  const updatedAt = Date.now();
  const vehicle = safeRide(body.vehicle);
  const rider: Rider = {
    userId,
    name,
    group,
    lat: point.lat,
    lng: point.lng,
    updatedAt,
    ...(vehicle ? { vehicle } : {}),
  };
  const record = body.record !== false;
  const desk =
    isAdminGroup((body as { desk?: unknown }).desk) || isAdminGroup(req.headers.get("x-boggs-desk"));
  try {
    const store = getStore();
    await store.upsertRider(rider);
    // Always persist the uploaded breadcrumb path so desk can review and update trails.
    await store.saveTrail(group, userId, name, readTrail(body.trail), record ? { lat: point.lat, lng: point.lng, at: updatedAt } : null);
    const [riders, trails] = await Promise.all([
      store.listRiders(group),
      desk ? store.listAllTrails() : store.listTrails(group),
    ]);
    return json({ riders, trails, desk });
  } catch (error) {
    console.error("upsert rider", error);
    return json({ error: "Couldn't save the location" }, 500);
  }
}
