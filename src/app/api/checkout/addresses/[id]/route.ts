import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { addressScope, resolveAddressOwner, validateAddressInput, type AddressOwner } from "../../owner";

export const dynamic = "force-dynamic";

function sortAddresses<T extends { isDefault: boolean; updatedAt: Date }>(rows: T[]) {
  return [...rows].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.updatedAt.getTime() - a.updatedAt.getTime());
}

// Ownership check — a signed-in shopper may only touch rows claimed by their
// ACCOUNT; a guest may only touch unclaimed rows minted on their own device.
async function requireOwned(owner: AddressOwner, id: string) {
  const row = await db.address.findUnique({ where: { id } });
  const owns =
    row &&
    (owner.shopperId
      ? row.shopperId === owner.shopperId
      : row.ownerToken === owner.ownerToken && row.shopperId === null);
  if (!owns) throw new ApiError(404, "NOT_FOUND", "Address not found");
  return row;
}

// PATCH /api/checkout/addresses/[id] — edit fields and/or set as default.
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const owner = await resolveAddressOwner();
  await requireOwned(owner, id);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // Setting default only (no field edits).
  const hasFieldEdits = ["label", "name", "phone", "line1", "city", "state", "postcode"].some((k) => k in body);
  const existing = await db.address.findUniqueOrThrow({ where: { id } });
  const input = hasFieldEdits ? validateAddressInput({ ...existing, ...body }) : null;
  const makeDefault = body.isDefault === true;

  const address = await db.$transaction(async (tx) => {
    if (makeDefault && !existing.isDefault) {
      await tx.address.updateMany({ where: addressScope(owner), data: { isDefault: false } });
    }
    return tx.address.update({
      where: { id },
      data: { ...(input ?? {}), ...(makeDefault ? { isDefault: true } : {}) },
    });
  });

  const rows = await db.address.findMany({ where: addressScope(owner) });
  return ok({ address, addresses: sortAddresses(rows) });
});

// DELETE /api/checkout/addresses/[id] — remove; promote the newest remaining one if the default went away.
export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const owner = await resolveAddressOwner();
  const existing = await requireOwned(owner, id);

  await db.address.delete({ where: { id } });

  if (existing.isDefault) {
    const remaining = await db.address.findMany({ where: addressScope(owner) });
    const next = sortAddresses(remaining)[0];
    if (next) {
      await db.address.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  }

  const rows = await db.address.findMany({ where: addressScope(owner) });
  return ok({ addresses: sortAddresses(rows) });
});
