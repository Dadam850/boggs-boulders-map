import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { safeGroup, safeId, safeName, safeText } from "@/lib/sanitize";
import type { ChatMessage } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function newMessageId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const group = safeGroup(url.searchParams.get("group"));
  const userId = safeId(url.searchParams.get("userId"));
  if (!userId) return json({ error: "Bad rider id" }, 400);
  try {
    const messages = await getStore().listMessages(group, userId);
    return json({ messages });
  } catch (error) {
    console.error("list messages", error);
    return json({ error: "Couldn't read messages" }, 500);
  }
}

export async function POST(req: Request) {
  let body: Partial<ChatMessage>;
  try {
    body = (await req.json()) as Partial<ChatMessage>;
  } catch {
    return json({ error: "Bad JSON" }, 400);
  }
  const fromName = safeName(body.fromName);
  const fromUserId = safeId(body.fromUserId);
  const group = safeGroup(body.group);
  const text = safeText(body.text);
  if (!fromName) return json({ error: "Name required" }, 400);
  if (!fromUserId) return json({ error: "Bad rider id" }, 400);
  if (!text) return json({ error: "Message required" }, 400);

  const rawTo = body.toUserId;
  const toEveryone = rawTo === null || rawTo === undefined || rawTo === "" || rawTo === "everyone";
  const toUserId = toEveryone ? null : safeId(rawTo);
  if (!toEveryone && !toUserId) return json({ error: "Bad friend id" }, 400);
  if (toUserId && toUserId === fromUserId) return json({ error: "Pick a friend" }, 400);

  const toName = toEveryone ? null : safeName(body.toName) || "Friend";
  const id = safeId(body.id) || newMessageId();
  const message: ChatMessage = {
    id,
    group,
    fromUserId,
    fromName,
    toUserId,
    toName,
    text,
    createdAt: Date.now(),
  };

  try {
    const store = getStore();
    const saved = await store.postMessage(message);
    const messages = await store.listMessages(group, fromUserId);
    return json({ message: saved, messages });
  } catch (error) {
    console.error("post message", error);
    return json({ error: "Couldn't send the message" }, 500);
  }
}
