import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { ensureOwnerToken, validateAddressInput } from "../owner";

export const dynamic = "force-dynamic";

function sortAddresses<T extends { isDefault: boolean; updatedAt: Date }>(rows: T[]) {
  return [...rows].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.updatedAt.getTime() - a.updatedAt.getTime());
}

// GET /api/checkout/addresses — this device's saved addresses (ownership via cookie token).
export const GET = handle(async () => {
  const ownerToken = await ensureOwnerToken();
  const rows = await db.address.findMany({ where: { ownerToken } });
  return ok({ addresses: sortAddresses(rows) });
});

// POST /api/checkout/addresses — save a new address (first one becomes default).
export const POST = handle(async (req: Request) => {
  const ownerToken = await ensureOwnerToken();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = validateAddressInput(body);

  const count = await db.address.count({ where: { ownerToken } });
  const makeDefault = count === 0 || body.isDefault === true;

  const address = await db.$transaction(async (tx) => {
    if (makeDefault && count > 0) {
      await tx.address.updateMany({ where: { ownerToken, isDefault: true }, data: { isDefault: false } });
    }
    return tx.address.create({
      data: { ownerToken, ...input, isDefault: makeDefault },
    });
  });

  const rows = await db.address.findMany({ where: { ownerToken } });
  return ok({ address, addresses: sortAddresses(rows) }, { status: 201 });
});
