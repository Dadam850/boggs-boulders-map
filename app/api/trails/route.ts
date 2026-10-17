import { NextResponse } from "next/server";
import { isAdminGroup } from "@/lib/admin";
import { getStore } from "@/lib/store";
import { safeGroup, safeId, safeName, validLatLng } from "@/lib/sanitize";
import { thinCrumbs, type Crumb } from "@/lib/trail";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

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

function deskFrom(req: Request, bodyGroup?: unknown) {
  const header = req.headers.get("x-boggs-desk");
  if (isAdminGroup(header)) return true;
  if (isAdminGroup(bodyGroup)) return true;
  const url = new URL(req.url);
  if (isAdminGroup(url.searchParams.get("desk"))) return true;
  return false;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const group = safeGroup(url.searchParams.get("group"));
  const desk = deskFrom(req, url.searchParams.get("desk"));
  try {
    const store = getStore();
    if (desk) {
      const trails = await store.listAllTrails();
      return json({ trails, desk: true });
    }
    const trails = await store.listTrails(group);
    return json({ trails, desk: false });
  } catch (error) {
    console.error("list trails", error);
    return json({ error: "Couldn't read the paths" }, 500);
  }
}

/** Replace a stored rider path (desk only). Keeps breadcrumbs editable for trail work. */
export async function PUT(req: Request) {
  let body: { userId?: unknown; group?: unknown; name?: unknown; crumbs?: unknown; desk?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "Bad JSON" }, 400);
  }
  if (!deskFrom(req, body.desk)) return json({ error: "Not allowed" }, 403);
  const userId = safeId(body.userId);
  const group = safeGroup(body.group);
  const name = safeName(body.name) || "Rider";
  if (!userId) return json({ error: "Bad rider id" }, 400);
  try {
    const store = getStore();
    await store.replaceTrail(group, userId, name, readTrail(body.crumbs));
    const trails = await store.listAllTrails();
    return json({ trails, desk: true });
  } catch (error) {
    console.error("replace trail", error);
    return json({ error: "Couldn't update the path" }, 500);
  }
}

export async function DELETE(req: Request) {
  let body: { userId?: unknown; group?: unknown; desk?: unknown };
  try {
    body = (await req.json()) as { userId?: unknown; group?: unknown; desk?: unknown };
  } catch {
    return json({ error: "Bad JSON" }, 400);
  }
  const userId = safeId(body.userId);
  const group = safeGroup(body.group);
  const desk = deskFrom(req, body.desk);
  if (!userId) return json({ error: "Bad rider id" }, 400);
  try {
    const store = getStore();
    await store.clearTrail(group, userId);
    const trails = desk ? await store.listAllTrails() : await store.listTrails(group);
    return json({ trails, desk });
  } catch (error) {
    console.error("clear trail", error);
    return json({ error: "Couldn't clear the path" }, 500);
  }
}
