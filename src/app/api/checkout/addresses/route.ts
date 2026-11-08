import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { addressScope, resolveAddressOwner, validateAddressInput } from "../owner";
import type { Address } from "@prisma/client";
import type { CheckoutAddress, ListAddressesData, CreateAddressBody, CreateAddressData } from "@/lib/types/api-contract";

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

// GET /api/checkout/addresses — the CURRENT owner's saved addresses.
// Signed-in shopper → account-scoped (shopperId); guest → device-scoped
// (ownerToken, unclaimed rows only). A signed-in owner never sees another
// account's rows, and a guest never sees claimed (account-owned) rows.
export const GET = handle(async () => {
  const owner = await resolveAddressOwner();
  const rows = await db.address.findMany({ where: addressScope(owner) });
  const payload: ListAddressesData = { addresses: sortAddresses(rows).map(toCheckoutAddress) };
  return ok(payload);
});

// POST /api/checkout/addresses — save a new address (first one becomes default).
// Rows store BOTH scopes: the device token (so a later login on this device can
// claim them if they were still guest rows) and the shopperId when signed in.
export const POST = handle(async (req: Request) => {
  const owner = await resolveAddressOwner();
  const body = (await req.json().catch(() => ({}))) as CreateAddressBody & Record<string, unknown>;
  const input = validateAddressInput(body);

  const count = await db.address.count({ where: addressScope(owner) });
  const makeDefault = count === 0 || body.isDefault === true;

  const address = await db.$transaction(async (tx) => {
    if (makeDefault && count > 0) {
      await tx.address.updateMany({ where: addressScope(owner), data: { isDefault: false } });
    }
    return tx.address.create({
      data: { ownerToken: owner.ownerToken, shopperId: owner.shopperId, ...input, isDefault: makeDefault },
    });
  });

  const rows = await db.address.findMany({ where: addressScope(owner) });
  const payload: CreateAddressData = {
    address: toCheckoutAddress(address),
    addresses: sortAddresses(rows).map(toCheckoutAddress),
  };
  return ok(payload, { status: 201 });
});
