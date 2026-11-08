import { db } from "@/lib/db";
import { handle, ok, ApiError } from "@/lib/api";
import { addressScope, resolveAddressOwner, validateAddressInput, type AddressOwner } from "../../owner";
import type { Address } from "@prisma/client";
import type { CheckoutAddress, UpdateAddressBody, UpdateAddressData, DeleteAddressData } from "@/lib/types/api-contract";

export const dynamic = "force-dynamic";

function sortAddresses<T extends { isDefault: boolean; updatedAt: Date }>(rows: T[]) {
  return [...rows].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.updatedAt.getTime() - a.updatedAt.getTime());
}

/** Prisma Address row → contract CheckoutAddress (Dates → ISO strings). */
function toCheckoutAddress(row: Address): CheckoutAddress {
  return {
    id: row.id,
    ownerToken: row.ownerToken,
    shopperId: row.shopperId,
    label: row.label,
    name: row.name,
    phone: row.phone,
    line1: row.line1,
    city: row.city,
    state: row.state,
    postcode: row.postcode,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Ownership check — the signed-in shopper may only touch rows owned by their
// ACCOUNT. Account-only scoping: no device-token branch exists any more.
async function requireOwned(owner: AddressOwner, id: string) {
  const row = await db.address.findUnique({ where: { id } });
  if (!row || row.shopperId !== owner.shopperId) throw new ApiError(404, "NOT_FOUND", "Address not found");
  return row;
}

// PATCH /api/checkout/addresses/[id] — edit fields and/or set as default.
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const owner = await resolveAddressOwner();
  await requireOwned(owner, id);

  const body = (await req.json().catch(() => ({}))) as UpdateAddressBody & Record<string, unknown>;

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
  const payload: UpdateAddressData = {
    address: toCheckoutAddress(address),
    addresses: sortAddresses(rows).map(toCheckoutAddress),
  };
  return ok(payload);
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
  const payload: DeleteAddressData = { addresses: sortAddresses(rows).map(toCheckoutAddress) };
  return ok(payload);
});
