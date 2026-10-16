import fs from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const cacheRoot = path.resolve(process.env.TILE_CACHE_DIR || path.join(process.cwd(), "data", "tiles"));

function tilePath(z: number, x: number, y: number) {
  return path.join(cacheRoot, String(z), String(x), `${y}.jpg`);
}

async function readCache(z: number, x: number, y: number) {
  try {
    const buf = await fs.readFile(tilePath(z, x, y));
    if (buf.length > 500) return buf;
  } catch {
    /* miss */
  }
  return null;
}

async function writeCache(z: number, x: number, y: number, buf: Buffer) {
  try {
    const file = tilePath(z, x, y);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buf);
  } catch {
    /* serverless disks are often read-only; the phone cache still holds the tile */
  }
}

async function fetchJpeg(url: string, timeoutMs: number) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "BoggsBouldersTrailMap/1.0" },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const type = res.headers.get("content-type") || "";
  if (!type.includes("image")) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) return null;
  return buf;
}

export async function GET(_req: Request, ctx: { params: Promise<{ z: string; x: string; y: string }> }) {
  const { z: zs, x: xs, y: ys } = await ctx.params;
  const z = Number(zs);
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return new Response("Bad tile", { status: 400 });
  }
  if (z < 0 || z > 19 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    return new Response("Bad tile", { status: 400 });
  }

  const cached = await readCache(z, x, y);
  if (cached) return jpeg(cached);

  const esri = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  const google = `https://maps.googleapis.com/maps/vt?lyrs=s&x=${x}&y=${y}&z=${z}`;

  let buf: Buffer | null = null;
  try {
    buf = await fetchJpeg(esri, 5000);
  } catch {
    buf = null;
  }
  if (!buf) {
    try {
      buf = await fetchJpeg(google, 8000);
    } catch {
      buf = null;
    }
  }
  if (!buf) return new Response("Tile unavailable", { status: 502 });
  await writeCache(z, x, y, buf);
  return jpeg(buf);
}

function jpeg(buf: Buffer) {
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=2592000",
    },
  });
}
