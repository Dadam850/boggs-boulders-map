import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { safeGroup, safeId } from "@/lib/sanitize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function DELETE(req: Request) {
  let body: { userId?: unknown; group?: unknown };
  try {
    body = (await req.json()) as { userId?: unknown; group?: unknown };
  } catch {
    return json({ error: "Bad JSON" }, 400);
  }
  const userId = safeId(body.userId);
  const group = safeGroup(body.group);
  if (!userId) return json({ error: "Bad rider id" }, 400);
  try {
    await getStore().clearTrail(group, userId);
    const trails = await getStore().listTrails(group);
    return json({ trails });
  } catch (error) {
    console.error("clear trail", error);
    return json({ error: "Couldn't clear the path" }, 500);
  }
}
