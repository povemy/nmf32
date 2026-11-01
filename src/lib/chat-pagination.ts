import { Prisma } from "@prisma/client";
import { db } from "./db";
import { ApiError } from "./api";

// ============================================================================
// Phase 2.4 (C2.x) — bounded chat history.
// Both conversation GETs previously returned EVERY message in the thread
// (`messages: { orderBy: { createdAt: "asc" } }` include, no take) — an
// unbounded payload for long-running support threads. Keyset pagination:
// the latest `limit` messages by default; `?before=<messageId>` returns the
// next older page. Frontends prepend pages under a "Load older messages"
// button, so no page/offset fan-out is ever needed.
// ============================================================================
export const CHAT_PAGE_SIZE = 50;
export const CHAT_PAGE_MAX = 200;

export type ChatMessageRow = {
  id: string;
  senderType: string;
  senderName: string;
  body: string;
  createdAt: Date;
  readAt: Date | null;
};

/**
 * Keyset-paginated chat history for a thread. Ordered by (createdAt desc,
 * id desc) internally and returned ASCENDING so callers can render directly
 * (first load) or prepend (older pages). `hasMore` = older messages exist.
 */
export async function loadChatMessagePage(
  threadId: string,
  req: Request
): Promise<{ messages: ChatMessageRow[]; hasMore: boolean }> {
  const url = new URL(req.url);
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, CHAT_PAGE_MAX) : CHAT_PAGE_SIZE;
  const before = url.searchParams.get("before")?.trim() || null;

  let where: Prisma.ChatMessageWhereInput = { threadId };
  if (before) {
    // Keyset cursor: strictly older than the anchor's (createdAt, id) tuple —
    // id is the tiebreaker for identical timestamps, so pages never overlap
    // or skip rows even when many messages share one createdAt.
    const anchor = await db.chatMessage.findUnique({
      where: { id: before },
      select: { id: true, createdAt: true, threadId: true },
    });
    if (!anchor || anchor.threadId !== threadId) throw new ApiError(400, "VALIDATION", "Invalid pagination cursor");
    where = {
      threadId,
      OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }],
    };
  }

  // take limit+1: the extra row proves older messages exist (hasMore) without
  // a separate COUNT query.
  const desc = await db.chatMessage.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: { id: true, senderType: true, senderName: true, body: true, createdAt: true, readAt: true },
  });
  const hasMore = desc.length > limit;
  return { messages: desc.slice(0, limit).reverse(), hasMore };
}
