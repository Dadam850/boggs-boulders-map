import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { safeGroup, safeId, safeName, saneTakenAt, validLatLng } from "@/lib/sanitize";
import type { PhotoMeta } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(req: Request) {
  const group = safeGroup(new URL(req.url).searchParams.get("group"));
  try {
    const photos = await getStore().listPhotos(group);
    return json({ photos });
  } catch (error) {
    console.error("list photos", error);
    return json({ error: "Couldn't read photos" }, 500);
  }
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Expected a photo upload" }, 400);
  }
  const file = form.get("file");
  const name = safeName(form.get("name"));
  const userId = safeId(form.get("userId"));
  const id = safeId(form.get("id"));
  const group = safeGroup(form.get("group"));
  const point = validLatLng(Number(form.get("lat")), Number(form.get("lng")));
  const takenAt = saneTakenAt(Number(form.get("takenAt")));

  if (!(file instanceof File)) return json({ error: "Missing photo" }, 400);
  if (!name) return json({ error: "Name required" }, 400);
  if (!userId || !id) return json({ error: "Bad id" }, 400);
  if (!point) return json({ error: "Need a GPS fix to pin a photo" }, 400);

  const jpeg = Buffer.from(await file.arrayBuffer());
  if (jpeg.length < 32) return json({ error: "Empty photo" }, 400);
  if (jpeg.length > 1_800_000) return json({ error: "Photo is too big" }, 413);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return json({ error: "Send a JPEG" }, 400);

  const meta: PhotoMeta = { id, userId, name, group, lat: point.lat, lng: point.lng, takenAt };
  try {
    await getStore().putPhoto(jpeg, meta);
    return json({ photo: meta });
  } catch (error) {
    console.error("put photo", error);
    return json({ error: "Couldn't store the photo" }, 500);
  }
}
