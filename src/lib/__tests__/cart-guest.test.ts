// ============================================================================
// WORK ORDER 2 unit tests — PURE logic coverage for the guest-cart contracts
// of src/app/api/cart/cart.ts (bun:test). NO database: shapeCart is a pure
// function; only its typed input shape is constructed here. The DB- and
// browser-backed regressions (guest add-to-cart rendering in the drawer,
// cookie/header identity sync, login merge, reload persistence, remove,
// stock rejection, false-success suppression) were verified live against the
// running dev server with the agent browser — see the work-order report.
// ============================================================================
import { describe, expect, test } from "bun:test";
import { isValidCartToken, shapeCart, type ShapedCart } from "@/app/api/cart/cart";

// Minimal structural stand-in for Prisma's CartWithItems (shapeCart only
// reads these fields — the include-tree types collapse to the same shape).
interface FakeStore {
  id: string;
  name: string;
  slug: string;
  status: string;
}
interface FakeCart {
  id: string;
  token: string;
  shopperId: string | null;
  storeId: string | null;
  items: FakeItem[];
}
interface FakeItem {
  id: string;
  variantId: string;
  qty: number;
  selected: boolean;
  createdAt: Date;
  variant: {
    id: string;
    name: string;
    optionName: string;
    optionValue: string;
    priceMinor: number;
    compareAtPriceMinor: null;
    stock: number;
    moq: number;
    isActive: boolean;
    product: {
      id: string;
      title: string;
      slug: string;
      status: string;
      images: { url: string; sortOrder: number }[];
      store: FakeStore;
    };
  };
}

const LUMINA: FakeStore = { id: "store_1", name: "Lumina Living", slug: "lumina-living", status: "live" };

function fakeItem(i: number, store: FakeStore): FakeItem {
  return {
    id: `item_${i}`,
    variantId: `variant_${i}`,
    qty: 1,
    selected: true,
    createdAt: new Date(0),
    variant: {
      id: `variant_${i}`,
      name: `Variant ${i}`,
      optionName: "Size",
      optionValue: "M",
      priceMinor: 8900,
      compareAtPriceMinor: null,
      stock: 10,
      moq: 1,
      isActive: true,
      product: {
        id: `product_${i}`,
        title: "Aurora Ceramic Vase",
        slug: "aurora-ceramic-vase",
        status: "active",
        images: [{ url: "/img.png", sortOrder: 0 }],
        store,
      },
    },
  };
}

function fakeCart(shopperId: string | null, token: string, items: FakeItem[]): FakeCart {
  return { id: "cart_1", token, shopperId, storeId: null, items };
}

/** Bridge into shapeCart's Prisma-derived parameter type (structural match). */
const asShapeInput = (c: FakeCart | null) => c as unknown as Parameters<typeof shapeCart>[0];

describe("shapeCart — guest-token echo rule (login-merge contract)", () => {
  test("a GUEST cart (shopperId null) echoes its token so the client adopts it", () => {
    const shaped: ShapedCart = shapeCart(asShapeInput(fakeCart(null, "a".repeat(32), [fakeItem(0, LUMINA)])));
    expect(shaped.token).toBe("a".repeat(32));
    expect(shaped.items).toHaveLength(1);
    expect(shaped.items[0].title).toBe("Aurora Ceramic Vase");
    expect(shaped.stores[0].storeName).toBe("Lumina Living");
  });

  test("an ACCOUNT cart (shopperId set) NEVER echoes its token", () => {
    const shaped = shapeCart(asShapeInput(fakeCart("shopper_1", "b".repeat(32), [fakeItem(0, LUMINA)])));
    expect(shaped.token).toBeNull();
    expect(shaped.items).toHaveLength(1);
  });

  test("no cart at all shapes to the empty cart (id/items null-or-empty, no token)", () => {
    const shaped = shapeCart(null);
    expect(shaped.id).toBeNull();
    expect(shaped.token).toBeNull();
    expect(shaped.items).toEqual([]);
    expect(shaped.stores).toEqual([]);
  });

  test("multi-seller carts group one section per store with correct subtotals", () => {
    const bytebazaar: FakeStore = { id: "store_2", name: "ByteBazaar", slug: "bytebazaar", status: "live" };
    const cart = fakeCart(null, "c".repeat(32), [fakeItem(0, LUMINA), fakeItem(1, bytebazaar)]);
    const shaped = shapeCart(asShapeInput(cart));
    expect(shaped.stores).toHaveLength(2);
    expect(shaped.stores.map((s) => s.storeName)).toEqual(["Lumina Living", "ByteBazaar"]);
    for (const s of shaped.stores) {
      expect(s.itemCount).toBe(1);
      expect(s.subtotalMinor).toBe(8900);
    }
    // Multi-store carts carry no legacy single-store fields.
    expect(shaped.storeName).toBeNull();
  });
});

describe("isValidCartToken — guest identity charset discipline", () => {
  test("accepts 8–64 hex chars (server randomToken output class)", () => {
    expect(isValidCartToken("a".repeat(8))).toBe(true);
    expect(isValidCartToken("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isValidCartToken("A".repeat(64))).toBe(true); // hex, case-insensitive
  });

  test("rejects short, long, non-hex and empty tokens", () => {
    expect(isValidCartToken(null)).toBe(false);
    expect(isValidCartToken("")).toBe(false);
    expect(isValidCartToken("abc123")).toBe(false); // 6 chars — too short
    expect(isValidCartToken("g".repeat(32))).toBe(false); // non-hex
    expect(isValidCartToken("a".repeat(65))).toBe(false); // too long
    expect(isValidCartToken("xyz-_.")).toBe(false); // base64-ish garbage
  });
});
