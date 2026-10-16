import { getStore } from "@/lib/store";
import { safeId } from "@/lib/sanitize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: raw } = await ctx.params;
  const id = safeId(raw);
  if (!id) return new Response("Bad id", { status: 400 });
  try {
    const photo = await getStore().getPhoto(id);
    if (!photo) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(photo.jpeg), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("get photo", error);
    return new Response("Couldn't read the photo", { status: 500 });
  }
}
