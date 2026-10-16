import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const store = getStore();
  return NextResponse.json({
    ok: true,
    store: store.kind,
    container: store.container,
  });
}
