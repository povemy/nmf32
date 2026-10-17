// ============================================================================
// NOMOFEE seed — rich demo dataset consistent with the ledger (M09/M10 math).
// Run: bun prisma/seed.ts
// ============================================================================
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password";
import { computeOrderCommissions } from "../src/lib/commission";
import {
  ensureAccount, ensureWalletAccounts, postOrderPaid, postGatewaySettlement,
  postPayoutInitiated, postPayoutConfirmed, refreshWalletCache, ACCOUNTS,
  buildLedgerStatementFromLedger,
} from "../src/lib/ledger";
import { defaultHomeSections, defaultPageSections } from "../src/lib/sections";
import { toJson } from "../src/lib/json";

const db = new PrismaClient();

const daysAgo = (n: number, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 12, 0, 0);
  return d;
};
const daysAhead = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};

let orderSeq = 100000;
const nextOrderNumber = () => `NM-${++orderSeq}`;

const img = (seed: string, w = 800, h = 800, label?: string) =>
  `/api/img/${seed}?w=${w}&h=${h}${label ? `&label=${encodeURIComponent(label)}` : ""}`;

async function wipe() {
  // Children before parents. Task 10-e/11 schema additions (shipments, chat,
  // vouchers, follows, campaigns, shopper wallet/activity, import jobs) are
  // included so the wipe stays FK-safe against the rebuilt schema.
  const tables = [
    db.ledgerLine, db.ledgerTransaction, db.ledgerAccount,
    db.payout, db.payoutBatch, db.bankAccount, db.wallet,
    db.shipmentEvent, db.shipment,
    db.dispute, db.refund, db.orderStatusHistory, db.orderItem, db.order,
    db.paymentWebhookLog, db.paymentIntent,
    db.couponRedemption, db.cartItem, db.cart,
    db.review, db.collectionProduct, db.collection,
    db.inventoryLog, db.productVariant, db.productImage, db.product, db.category,
    db.userActivity, db.userVoucher, db.shopperWallet, db.notification,
    db.chatMessage, db.chatThread, db.storeFollow,
    db.featuredSlot, db.marketplaceBanner, db.coupon, db.voucher, db.campaign, db.seoMeta,
    db.cmsPage, db.storeDomain, db.storeIntegration, db.webhookDelivery, db.webhookEndpoint, db.apiKey,
    db.marketplaceConnection, db.importJobItem, db.importJob, db.storeClaim,
    db.store, db.sellerNote, db.kycDocument, db.seller,
    db.session, db.adminUser, db.adminAuditLog, db.activityLog,
    db.notificationLog, db.notificationTemplate, db.supportMessage, db.supportTicket,
    db.announcement, db.setting, db.featureFlag, db.commissionOverride, db.feeHoliday,
    db.commissionSetting, db.plan, db.counter, db.exportJob,
  ] as { deleteMany: () => Promise<unknown> }[];
  for (const t of tables) await t.deleteMany();
}

type SeedVariant = { name: string; optionName?: string; optionValue?: string; price: number; compareAt?: number; stock: number; sku?: string };
type SeedProduct = {
  title: string; slug: string; description: string; categorySlug: string;
  status?: string; price: number; compareAt?: number; stock?: number;
  variants?: SeedVariant[]; sales?: number; rating?: [number, number]; featured?: boolean;
  imgSeeds: string[];
};

async function seedProduct(storeId: string, p: SeedProduct, createdAt: Date) {
  const product = await db.product.create({
    data: {
      storeId,
      title: p.title,
      slug: p.slug,
      description: p.description,
      status: p.status ?? "active",
      priceMinor: p.price,
      isFeatured: p.featured ?? false,
      salesCount: p.sales ?? 0,
      ratingAvg: p.rating?.[0] ?? 0,
      ratingCount: p.rating?.[1] ?? 0,
      publishedAt: (p.status ?? "active") === "active" ? createdAt : null,
      createdAt,
      updatedAt: createdAt,
      categoryId: catMap[p.categorySlug] ?? null,
    },
  });
  for (let i = 0; i < p.imgSeeds.length; i++) {
    await db.productImage.create({
      data: { productId: product.id, url: img(p.imgSeeds[i], 900, 900, p.title), sortOrder: i },
    });
  }
  const variants = p.variants ?? [{ name: "Default", price: p.price, stock: p.stock ?? 40 }];
  for (const v of variants) {
    await db.productVariant.create({
      data: {
        productId: product.id,
        name: v.name,
        optionName: v.optionName ?? null,
        optionValue: v.optionValue ?? null,
        priceMinor: v.price,
        compareAtPriceMinor: v.compareAt ?? null,
        stock: v.stock,
        sku: v.sku ?? null,
      },
    });
  }
  return product;
}

const catMap: Record<string, string> = {};

async function seedCategories() {
  const tree: [string, string, string[], number | null][] = [
    ["Electronics", "electronics", ["Audio", "Gadgets"], 6],
    ["Fashion", "fashion", ["Women", "Men"], 10],
    ["Home & Living", "home-living", ["Decor", "Kitchen"], null],
    ["Beauty & Personal Care", "beauty", [], 9],
    ["Sports & Outdoors", "sports-outdoors", ["Camping & Hiking"], null],
    ["Food & Beverage", "food-beverage", ["Snacks", "Coffee & Tea"], 5],
    ["Pet Supplies", "pet-supplies", [], null],
    ["Toys & Games", "toys-games", [], null],
  ];
  for (const [name, slug, children, commission] of tree) {
    const parent = await db.category.create({
      data: { name, slug, imageUrl: img(`cat-${slug}`, 400, 300, name), commissionPercent: commission },
    });
    catMap[slug] = parent.id;
    for (const child of children) {
      const cslug = `${slug}-${child.toLowerCase().replace(/\s+/g, "-")}`;
      const c = await db.category.create({
        data: { name: child, slug: cslug, parentId: parent.id, imageUrl: img(`cat-${cslug}`, 400, 300, child) },
      });
      catMap[cslug] = c.id;
    }
  }
}

async function seedSeller(opts: {
  email: string; password: string; fullName: string; displayName: string;
  storeName: string; slug: string; tagline: string; status: string;
  theme?: object; kyc: "approved" | "pending"; bank?: { holder: string; bank: string; last4: string; verified: boolean };
  commissionOverride?: number; holdOverride?: number; createdAt: Date; approvedAt?: Date;
}) {
  const seller = await db.seller.create({
    data: {
      email: opts.email,
      passwordHash: hashPassword(opts.password),
      fullName: opts.fullName,
      displayName: opts.displayName,
      countryCode: "MY",
      phone: "6012" + Math.floor(1000000 + Math.random() * 8999999),
      status: opts.status,
      kycStatus: opts.kyc,
      commissionOverridePercent: opts.commissionOverride ?? null,
      holdDaysOverride: opts.holdOverride ?? null,
      submittedAt: opts.status === "onboarding" ? null : opts.createdAt,
      approvedAt: opts.approvedAt ?? null,
      createdAt: opts.createdAt,
      updatedAt: opts.createdAt,
    },
  });
  const store = await db.store.create({
    data: {
      sellerId: seller.id,
      name: opts.storeName,
      slug: opts.slug,
      tagline: opts.tagline,
      description: `${opts.storeName} — curated goods shipped from Malaysia.`,
      status: opts.status === "active" ? "live" : "draft",
      themeJson: toJson({ primaryColor: "#0f766e", ...(opts.theme ?? {}) }),
      supportEmail: opts.email,
      whatsapp: "60123456789",
      socialJson: toJson({ instagram: `https://instagram.com/${opts.slug}` }),
      createdAt: opts.createdAt,
      updatedAt: opts.createdAt,
    },
  });
  const wallet = await db.wallet.create({ data: { sellerId: seller.id } });
  await ensureWalletAccounts(wallet.id);

  await db.cmsPage.create({
    data: {
      storeId: store.id, slug: "home", title: "Home", pageType: "home",
      draftJson: toJson({ sections: defaultHomeSections(opts.storeName, opts.tagline), version: 1 }),
      publishedJson: opts.status === "active" ? toJson({ sections: defaultHomeSections(opts.storeName, opts.tagline), version: 1 }) : null,
      draftVersion: 1,
      publishedVersion: opts.status === "active" ? 1 : 0,
    },
  });
  for (const p of [
    { slug: "about", title: "About Us", pageType: "about" },
    { slug: "contact", title: "Contact", pageType: "contact" },
    { slug: "policies", title: "Policies", pageType: "policy" },
  ]) {
    const doc = { sections: defaultPageSections(p.pageType, opts.storeName), version: 1 };
    await db.cmsPage.create({
      data: {
        storeId: store.id, slug: p.slug, title: p.title, pageType: p.pageType,
        draftJson: toJson(doc),
        publishedJson: opts.status === "active" ? toJson(doc) : null,
        draftVersion: 1, publishedVersion: opts.status === "active" ? 1 : 0,
      },
    });
  }

  if (opts.kyc === "approved") {
    for (const docType of ["ic_front", "ic_selfie", "business_reg"]) {
      await db.kycDocument.create({
        data: {
          sellerId: seller.id, docType, fileName: `${docType}_${opts.slug}.jpg`,
          status: "approved", reviewedBy: "admin@nomofee.io", reviewedAt: new Date(opts.createdAt.getTime() + 86400000),
        },
      });
    }
  } else {
    for (const docType of ["ic_front", "business_reg"]) {
      await db.kycDocument.create({
        data: { sellerId: seller.id, docType, fileName: `${docType}_${opts.slug}.jpg`, status: "pending" },
      });
    }
  }
  if (opts.bank) {
    await db.bankAccount.create({
      data: {
        sellerId: seller.id,
        holderName: opts.bank.holder,
        bankName: opts.bank.bank,
        accountNumberMasked: `****${opts.bank.last4}`,
        accountNumberEnc: "enc:" + opts.bank.last4,
        verified: opts.bank.verified,
        verifiedAt: opts.bank.verified ? opts.createdAt : null,
      },
    });
  }
  return { seller, store, wallet };
}

type SeedOrderItem = { product: { title: string; id: string; categoryId: string | null }; variantId: string; title: string; variantLabel?: string; unitPrice: number; qty: number };

async function seedOrder(opts: {
  storeId: string; storeName: string; walletId: string;
  customer: { name: string; email: string; phone?: string };
  items: SeedOrderItem[];
  status: string; provider: string; daysBack: number;
  discountMinor?: number; couponCode?: string; shippingMinor?: number;
  withLedger?: boolean; withSettlement?: boolean;
}) {
  const createdAt = daysAgo(opts.daysBack, 9 + (opts.daysBack % 6));
  const settings = await db.commissionSetting.findUnique({ where: { id: 1 } });
  const holdDays = settings?.payoutHoldDays ?? 7;
  const subtotal = opts.items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
  const discount = opts.discountMinor ?? 0;
  const shipping = opts.shippingMinor ?? (subtotal >= 10000 ? 0 : 800);
  const total = subtotal - discount + shipping;

  const computed = await computeOrderCommissions({
    sellerId: (await db.store.findUnique({ where: { id: opts.storeId } }))!.sellerId,
    items: opts.items.map((i) => ({
      title: i.title, unitPriceMinor: i.unitPrice, qty: i.qty,
      productId: i.product.id, categoryId: i.product.categoryId, variantLabel: i.variantLabel ?? null,
    })),
    orderDiscountMinor: discount,
    shippingMinorTotal: shipping,
    now: createdAt,
  });

  const paid = !["payment_pending", "cancelled"].includes(opts.status);
  const paidAt = paid ? createdAt : null;
  const shippedAt = ["shipped", "delivered", "completed"].includes(opts.status) ? new Date(createdAt.getTime() + 86400000) : null;
  const deliveredAt = ["delivered", "completed"].includes(opts.status) ? new Date(createdAt.getTime() + 3 * 86400000) : null;
  const completedAt = opts.status === "completed" ? new Date(createdAt.getTime() + 9 * 86400000) : null;

  const order = await db.order.create({
    data: {
      storeId: opts.storeId,
      orderNumber: nextOrderNumber(),
      customerName: opts.customer.name,
      customerEmail: opts.customer.email,
      customerPhone: opts.customer.phone ?? "60125550011",
      status: opts.status,
      channel: "storefront",
      subtotalMinor: subtotal,
      discountMinor: discount,
      shippingMinor: shipping,
      totalMinor: total,
      couponCode: opts.couponCode ?? null,
      shippingAddressJson: toJson({
        line1: "42 Jalan Merdeka", city: "Kuala Lumpur", state: "Selangor", postcode: "43650", country: "MY",
      }),
      paymentProvider: opts.provider,
      paidAt,
      fulfilledAt: ["processing", "shipped", "delivered", "completed"].includes(opts.status) ? new Date(createdAt.getTime() + 43200000) : null,
      shippedAt,
      deliveredAt,
      completedAt,
      createdAt,
      updatedAt: createdAt,
    },
  });

  for (let i = 0; i < opts.items.length; i++) {
    const item = opts.items[i];
    const c = computed.items[i];
    await db.orderItem.create({
      data: {
        orderId: order.id,
        productId: item.product.id,
        variantId: item.variantId,
        title: item.title,
        variantLabel: item.variantLabel ?? null,
        unitPriceMinor: item.unitPrice,
        qty: item.qty,
        lineSubtotalMinor: item.unitPrice * item.qty,
        discountMinor: c.discountMinor,
        shippingMinor: c.shippingMinor,
        commissionPercent: c.percent,
        commissionMinor: c.commissionMinor,
        fixedFeeMinor: c.fixedFeeMinor,
        sellerNetMinor: c.sellerNetMinor,
        breakdownJson: toJson(c.breakdown),
      },
    });
    await db.product.update({ where: { id: item.product.id }, data: { salesCount: { increment: item.qty } } });
    await db.productVariant.update({ where: { id: item.variantId }, data: { stock: { decrement: item.qty } } });
  }

  const historyTo: string[] = [];
  if (paid) historyTo.push("paid");
  if (["processing", "shipped", "delivered", "completed"].includes(opts.status)) historyTo.push("processing");
  if (shippedAt) historyTo.push("shipped");
  if (deliveredAt) historyTo.push("delivered");
  if (completedAt) historyTo.push("completed");
  let prev = "payment_pending";
  for (const st of historyTo) {
    await db.orderStatusHistory.create({
      data: { orderId: order.id, fromStatus: prev, toStatus: st, actor: st === "paid" ? "system" : "seller", createdAt: paidAt ?? createdAt },
    });
    prev = st;
  }

  if (opts.withLedger && paid) {
    await db.paymentIntent.create({
      data: {
        orderId: order.id, provider: opts.provider,
        providerRef: `ref_${order.orderNumber.toLowerCase()}`,
        amountMinor: total, status: "succeeded", expiresAt: daysAhead(1), createdAt, updatedAt: createdAt,
      },
    });
    await postOrderPaid({
      orderId: order.id, orderNumber: order.orderNumber, walletId: opts.walletId,
      provider: opts.provider, totalMinor: total,
      sellerNetMinor: computed.orderSellerNetMinor, commissionMinor: computed.orderCommissionMinor,
      holdUntil: new Date((paidAt as Date).getTime() + holdDays * 86400000),
      occurredAt: paidAt as Date,
    });
    if (opts.withSettlement && completedAt) {
      await postGatewaySettlement({
        provider: opts.provider, amountMinor: total,
        ref: `stl_${order.orderNumber.toLowerCase()}`, occurredAt: new Date((paidAt as Date).getTime() + 172800000),
      });
    }
  } else if (opts.status === "payment_pending") {
    await db.paymentIntent.create({
      data: {
        orderId: order.id, provider: opts.provider,
        providerRef: `ref_${order.orderNumber.toLowerCase()}`,
        amountMinor: total, status: "requires_payment", expiresAt: new Date(createdAt.getTime() + 1800000),
        redirectUrl: `/pay/${`ref_${order.orderNumber.toLowerCase()}`}`,
      },
    });
  }
  return order;
}

async function main() {
  console.log("Seeding NOMOFEE…");
  await wipe();

  // ------------------------------------------------ plans & platform config
  await db.plan.create({ data: { code: "free", name: "Free Forever", commissionPercent: 8, productLimit: 100, mediaLimitMb: 512, staffLimit: 2 } });
  await db.commissionSetting.create({
    data: {
      id: 1, defaultPercent: 8, appliesToShipping: false, basePriceRule: "paid_price",
      fixedFeeMinor: 0, minCommissionMinor: 0, payoutHoldDays: 7, holdReleaseRule: "days_after_paid", graceDaysAfterDelivered: 2,
    },
  });
  const seedOverridePlaceholder = await db.commissionSetting.findUnique({ where: { id: 1 } });
  void seedOverridePlaceholder;

  for (const s of [
    { key: "moderation.first_n", valueJson: "5", description: "New sellers' first N products require moderation" },
    { key: "payout.schedule.day", valueJson: "\"monday\"", description: "Weekly payout run day" },
    { key: "payout.min_minor", valueJson: "1000", description: "Minimum payout amount (RM 10.00)" },
    { key: "payout.mode", valueJson: "\"manual_csv\"", description: "manual_csv | bank_transfer" },
    { key: "payments.providers", valueJson: '["fpx_toyyibpay","tng","grabpay","card_stripe"]', description: "Enabled payment providers" },
    { key: "ranking.weights", valueJson: '{"recency":0.4,"sales":0.3,"rating":0.2,"ctr":0.1}', description: "Marketplace ranking weights" },
    { key: "maintenance.mode", valueJson: "false", description: "Storefront maintenance mode" },
  ]) {
    await db.setting.create({ data: s });
  }
  for (const f of [
    { key: "marketplace.cross_sell", description: "Marketplace strip on storefronts", isEnabled: true },
    { key: "builder.countdown", description: "Countdown section", isEnabled: true },
    { key: "checkout.guest", description: "Guest checkout", isEnabled: true },
    { key: "integrations.webhooks", description: "Outbound webhooks", isEnabled: true },
    { key: "ai.product_enrichment", description: "AI product copy assist (v2)", isEnabled: false },
  ]) {
    await db.featureFlag.create({ data: f });
  }

  // ------------------------------------------------ admin users
  const admin = await db.adminUser.create({
    data: { email: "admin@nomofee.io", name: "Aisyah Rahman", role: "superadmin", passwordHash: hashPassword("Admin123!"), lastLoginAt: daysAgo(0, 8) },
  });
  await db.adminUser.create({ data: { email: "ops@nomofee.io", name: "Wani Operations", role: "ops", passwordHash: hashPassword("Ops12345!") } });
  await db.adminUser.create({ data: { email: "finance@nomofee.io", name: "Kumar Finance", role: "finance", passwordHash: hashPassword("Finance123!") } });
  await db.adminUser.create({ data: { email: "moderator@nomofee.io", name: "Rina Moderator", role: "moderator", passwordHash: hashPassword("Mod12345!") } });

  await seedCategories();

  // ------------------------------------------------ sellers & stores
  const lumina = await seedSeller({
    email: "lumina@nomofee.io", password: "Seller123!", fullName: "Sofia Lim", displayName: "Sofia",
    storeName: "Lumina Living", slug: "lumina-living", tagline: "Calm, functional objects for better days.",
    status: "active", kyc: "approved",
    bank: { holder: "Lumina Living Sdn Bhd", bank: "Maybank", last4: "4821", verified: true },
    createdAt: daysAgo(45), approvedAt: daysAgo(43),
  });
  const byte = await seedSeller({
    email: "byte@nomofee.io", password: "Seller123!", fullName: "Wei Jian Tan", displayName: "WeiJian",
    storeName: "ByteBazaar", slug: "bytebazaar", tagline: "Gadgets & audio for people who tinker.",
    status: "active", kyc: "approved", theme: { primaryColor: "#7c2d12" },
    bank: { holder: "Tan Wei Jian", bank: "CIMB", last4: "9032", verified: true },
    createdAt: daysAgo(38), approvedAt: daysAgo(36),
  });
  const glow = await seedSeller({
    email: "glow@nomofee.io", password: "Seller123!", fullName: "Mei Ling Ng", displayName: "MeiLing",
    storeName: "Glow Theory", slug: "glow-theory", tagline: "Science-backed skincare, gentle by design.",
    status: "active", kyc: "approved", theme: { primaryColor: "#831843" },
    bank: { holder: "Ng Mei Ling", bank: "Public Bank", last4: "1170", verified: true },
    createdAt: daysAgo(30), approvedAt: daysAgo(28),
  });
  const warung = await seedSeller({
    email: "warung@nomofee.io", password: "Seller123!", fullName: "Ahmad Faizal", displayName: "Faizal",
    storeName: "Warung Satu", slug: "warung-satu", tagline: "Traditional kuih & snacks, modern packing.",
    status: "pending_review", kyc: "pending",
    bank: { holder: "Ahmad Faizal", bank: "Bank Rakyat", last4: "7712", verified: false },
    createdAt: daysAgo(2), submittedAt: daysAgo(1),
  });
  await seedSeller({
    email: "trail@nomofee.io", password: "Seller123!", fullName: "Nurul Huda", displayName: "Nurul",
    storeName: "TrailKit Outdoors", slug: "trailkit-outdoors", tagline: "Gear for Malaysian trails.",
    status: "onboarding", kyc: "pending", createdAt: daysAgo(0, 7),
  });

  // commission override for Glow Theory (10%) + hold override for ByteBazaar (10 days)
  await db.commissionOverride.create({
    data: { scope: "seller", sellerId: glow.seller.id, percent: 10, isActive: true, createdBy: "finance@nomofee.io", createdAt: daysAgo(20) },
  });
  await db.seller.update({ where: { id: byte.seller.id }, data: { holdDaysOverride: 10 } });
  await db.category.update({ where: { id: catMap["electronics-audio"] }, data: {} });

  // fee holiday example (active): Food & Beverage 0% for a week
  await db.feeHoliday.create({
    data: {
      name: "Merdeka F&B Fee Holiday", scope: "categories",
      scopeIds: toJson([catMap["food-beverage"]]), percent: 0,
      startsAt: daysAgo(2), endsAt: daysAhead(5), isActive: true,
    },
  });

  // ------------------------------------------------ products
  const luminaProducts: SeedProduct[] = [
    { title: "Aurora Ceramic Vase", slug: "aurora-ceramic-vase", description: "Hand-thrown stoneware vase with a matte glaze. Each piece is unique.", categorySlug: "home-living-decor", price: 8900, compareAt: 10900, stock: 32, sales: 41, rating: [4.8, 12], featured: true, imgSeeds: ["vase-1", "vase-2"] },
    { title: "Linen Cushion Cover — Sand", slug: "linen-cushion-sand", description: "Stonewashed linen cushion cover, 45×45cm, hidden zip.", categorySlug: "home-living-decor", price: 4500, stock: 58, sales: 66, rating: [4.7, 24], imgSeeds: ["cushion-1"] },
    { title: "Teak Serving Board", slug: "teak-serving-board", description: "Reclaimed teak serving board, food-safe oil finish.", categorySlug: "home-living-kitchen", price: 12900, stock: 14, sales: 22, rating: [4.9, 9], featured: true, imgSeeds: ["teak-1", "teak-2"] },
    { title: "Soy Wax Candle — Neroli", slug: "candle-neroli", description: "40-hour burn, neroli & cedar. Poured in small batches.", categorySlug: "home-living-decor", price: 3900, stock: 4, sales: 88, rating: [4.6, 31], imgSeeds: ["candle-1"] },
    { title: "Rattan Wall Mirror", slug: "rattan-wall-mirror", description: "60cm handwoven rattan mirror frame.", categorySlug: "home-living-decor", price: 15900, stock: 9, sales: 17, rating: [4.8, 7], imgSeeds: ["mirror-1"] },
    { title: "Stoneware Mug Set (2)", slug: "stoneware-mug-set", description: "Two 300ml mugs, speckled glaze, dishwasher safe.", categorySlug: "home-living-kitchen", price: 6900, stock: 27, sales: 54, rating: [4.7, 19], imgSeeds: ["mug-1"] },
    { title: "Waffle Hand Towel Set", slug: "waffle-towel-set", description: "Two waffle-weave cotton hand towels, quick dry.", categorySlug: "home-living-kitchen", price: 3500, stock: 73, sales: 39, rating: [4.5, 15], imgSeeds: ["towel-1"] },
    { title: "Jute Storage Basket", slug: "jute-basket", description: "Handwoven jute basket with handles, 40cm.", categorySlug: "home-living-decor", price: 5900, stock: 21, sales: 28, rating: [4.6, 11], imgSeeds: ["basket-1"] },
    { title: "Brass Incense Holder", slug: "brass-incense-holder", description: "Solid brass holder with ash catch tray.", categorySlug: "home-living-decor", price: 2900, stock: 45, sales: 47, rating: [4.4, 13], imgSeeds: ["incense-1"] },
    { title: "Olive Wood Spoons (Set of 3)", slug: "olive-wood-spoons", description: "Carved olive wood kitchen utensil trio.", categorySlug: "home-living-kitchen", price: 4900, stock: 33, sales: 35, rating: [4.7, 10], imgSeeds: ["spoons-1"] },
  ];
  const byteProducts: SeedProduct[] = [
    { title: "Pulse ANC Earbuds", slug: "pulse-anc-earbuds", description: "Hybrid ANC earbuds, 28h battery, USB-C.", categorySlug: "electronics-audio", price: 19900, compareAt: 24900, stock: 61, sales: 132, rating: [4.5, 47], featured: true, imgSeeds: ["earbuds-1", "earbuds-2"] },
    { title: "Mechanical Keyboard 65% — Tactile", slug: "mk65-tactile", description: "Gasket-mounted 65% board, hot-swap, tactile switches.", categorySlug: "electronics-gadgets", price: 29900, stock: 18, sales: 44, rating: [4.8, 21], featured: true, imgSeeds: ["keyboard-1"] },
    { title: "USB-C Hub 8-in-1", slug: "usbc-hub-8in1", description: "HDMI 4K60, 100W PD, ethernet, SD/microSD.", categorySlug: "electronics-gadgets", price: 12900, stock: 40, sales: 77, rating: [4.4, 33], imgSeeds: ["hub-1"] },
    { title: "Desk Mat — Felt & Cork", slug: "desk-mat-felt", description: "90×40cm natural felt desk mat with cork base.", categorySlug: "electronics-gadgets", price: 6900, stock: 52, sales: 61, rating: [4.6, 18], imgSeeds: ["deskmat-1"] },
    { title: "Bluetooth Bookshelf Speakers", slug: "bt-bookshelf-speakers", description: "Pair of 4\" powered speakers with BT 5.3 & optical.", categorySlug: "electronics-audio", price: 44900, stock: 7, sales: 12, rating: [4.9, 8], imgSeeds: ["speakers-1"] },
    { title: "4K Action Cam Lite", slug: "action-cam-lite", description: "4K30, waterproof case, 2 batteries included.", categorySlug: "electronics-gadgets", price: 24900, stock: 23, sales: 29, rating: [4.3, 14], imgSeeds: ["actioncam-1"] },
    { title: "Smart RGB Light Bars (2)", slug: "rgb-light-bars", description: "Sync lighting bars, app + voice control.", categorySlug: "electronics-gadgets", price: 15900, stock: 35, sales: 48, rating: [4.5, 26], imgSeeds: ["lightbars-1"] },
    { title: "Portable Espresso Maker", slug: "portable-espresso", description: "Manual 18-bar espresso maker for travel.", categorySlug: "electronics-gadgets", price: 21900, stock: 16, sales: 19, rating: [4.2, 9], imgSeeds: ["espresso-1"] },
  ];
  const glowProducts: SeedProduct[] = [
    { title: "Barrier Repair Serum 30ml", slug: "barrier-repair-serum", description: "Ceramide + panthenol serum for compromised skin.", categorySlug: "beauty", price: 15900, compareAt: 18900, stock: 44, sales: 92, rating: [4.9, 58], featured: true, imgSeeds: ["serum-1", "serum-2"] },
    { title: "Gentle Gel Cleanser 150ml", slug: "gentle-gel-cleanser", description: "pH 5.5 daily cleanser, sulfate-free.", categorySlug: "beauty", price: 7900, stock: 66, sales: 121, rating: [4.8, 71], imgSeeds: ["cleanser-1"] },
    { title: "Mineral SPF50 Sunscreen", slug: "mineral-spf50", description: "Non-greasy zinc oxide sunscreen, no white cast.", categorySlug: "beauty", price: 11900, stock: 58, sales: 140, rating: [4.7, 66], featured: true, imgSeeds: ["sunscreen-1"] },
    { title: "Hydrating Sheet Mask (5)", slug: "sheet-mask-5", description: "Five bio-cellulose masks with hyaluronic acid.", categorySlug: "beauty", price: 4500, stock: 90, sales: 210, rating: [4.6, 88], imgSeeds: ["mask-1"] },
    { title: "Overnight Sleeping Mask", slug: "sleeping-mask", description: "Gel-cream sleeping mask with squalane.", categorySlug: "beauty", price: 9900, stock: 37, sales: 44, rating: [4.7, 22], imgSeeds: ["sleepmask-1"] },
    { title: "Vitamin C Brightening Ampoules", slug: "vitc-ampoules", description: "7-day brightening course, 5% THD ascorbate.", categorySlug: "beauty", price: 13900, stock: 25, sales: 30, rating: [4.5, 17], imgSeeds: ["vitc-1"] },
  ];

  const pMap: Record<string, { product: { id: string; title: string; categoryId: string | null }; variants: { id: string; name: string; priceMinor: number }[] }> = {};

  async function addProducts(storeSlug: string, storeId: string, list: SeedProduct[], baseDays: number) {
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const product = await seedProduct(storeId, p, daysAgo(baseDays - i, 11));
      const variants = await db.productVariant.findMany({ where: { productId: product.id } });
      pMap[`${storeSlug}:${p.slug}`] = {
        product: { id: product.id, title: p.title, categoryId: catMap[p.categorySlug] ?? null },
        variants: variants.map((v) => ({ id: v.id, name: v.name, priceMinor: v.priceMinor })),
      };
    }
  }
  await addProducts("lumina-living", lumina.store.id, luminaProducts, 40);
  await addProducts("bytebazaar", byte.store.id, byteProducts, 33);
  await addProducts("glow-theory", glow.store.id, glowProducts.slice(0, 6), 25);

  // pending_review products for moderation queue
  await seedProduct(warung.store.id, {
    title: "Kuih Raya Gift Tin", slug: "kuih-raya-tin", description: "Assorted traditional kuih in a reusable tin.",
    categorySlug: "food-beverage-snacks", price: 4900, stock: 60, imgSeeds: ["kuih-1"],
  }, daysAgo(1));
  await seedProduct(warung.store.id, {
    title: "Sambal Bundle (3 jars)", slug: "sambal-bundle", description: "Homemade sambal trio: biasa, hijau, extra pedas.",
    categorySlug: "food-beverage-snacks", price: 5400, stock: 30, imgSeeds: ["sambal-1"],
  }, daysAgo(1));
  const glowPending = await seedProduct(glow.store.id, {
    title: "Peptide Eye Complex", slug: "peptide-eye-complex", description: "Caffeine + peptide gel for tired eyes.",
    categorySlug: "beauty", price: 8900, stock: 30, imgSeeds: ["eye-1"],
  }, daysAgo(0, 8));
  await db.product.update({ where: { id: glowPending.id }, data: { status: "pending_review" } });
  pMap["glow-theory:peptide-eye-complex"] = {
    product: { id: glowPending.id, title: glowPending.title, categoryId: catMap["beauty"] },
    variants: (await db.productVariant.findMany({ where: { productId: glowPending.id } })).map((v) => ({ id: v.id, name: v.name, priceMinor: v.priceMinor })),
  };

  // Warung products get pending_review status
  await db.product.updateMany({ where: { storeId: warung.store.id }, data: { status: "pending_review" } });

  // reviews
  const luminaDbProducts = await db.product.findMany({ where: { storeId: lumina.store.id }, include: { variants: true } });
  for (const [i, p] of luminaDbProducts.slice(0, 5).entries()) {
    await db.review.create({
      data: {
        productId: p.id,
        customerName: ["Aina", "Daniel", "Farah", "Jun", "Melati"][i],
        rating: [5, 4, 5, 5, 4][i],
        title: ["Lovely quality", "Good buy", "Beautiful", "Exceeded expectations", "Solid"][i],
        body: "Arrived quickly and the packaging was gorgeous. Would recommend to friends.",
        createdAt: daysAgo(6 + i),
      },
    });
  }

  // ------------------------------------------------ orders + ledger
  const pick = (key: string, variantIdx = 0, qty = 1): SeedOrderItem => {
    const e = pMap[key];
    const v = e.variants[variantIdx];
    return {
      product: e.product, variantId: v.id, title: e.product.title,
      variantLabel: v.name === "Default" ? undefined : v.name, unitPrice: v.priceMinor, qty,
    };
  };

  await seedOrder({
    storeId: lumina.store.id, storeName: "Lumina Living", walletId: lumina.wallet.id,
    customer: { name: "Aina Zulkifli", email: "aina@example.com" },
    items: [pick("lumina-living:aurora-ceramic-vase", 0, 1), pick("lumina-living:stoneware-mug-set", 0, 2)],
    status: "completed", provider: "fpx_toyyibpay", daysBack: 21, withLedger: true, withSettlement: true,
  });
  await seedOrder({
    storeId: lumina.store.id, storeName: "Lumina Living", walletId: lumina.wallet.id,
    customer: { name: "Daniel Ooi", email: "daniel@example.com" },
    items: [pick("lumina-living:teak-serving-board", 0, 1)],
    status: "completed", provider: "card_stripe", daysBack: 18, withLedger: true, withSettlement: true,
  });
  await seedOrder({
    storeId: lumina.store.id, storeName: "Lumina Living", walletId: lumina.wallet.id,
    customer: { name: "Farah Iman", email: "farah@example.com" },
    items: [pick("lumina-living:rattan-wall-mirror", 0, 1), pick("lumina-living:linen-cushion-sand", 0, 2)],
    status: "delivered", provider: "tng", daysBack: 9, withLedger: true,
  });
  await seedOrder({
    storeId: lumina.store.id, storeName: "Lumina Living", walletId: lumina.wallet.id,
    customer: { name: "Jun Lee", email: "jun@example.com" },
    items: [pick("lumina-living:candle-neroli", 0, 3)],
    status: "shipped", provider: "grabpay", daysBack: 5, withLedger: true,
  });
  await seedOrder({
    storeId: lumina.store.id, storeName: "Lumina Living", walletId: lumina.wallet.id,
    customer: { name: "Melati Putri", email: "melati@example.com" },
    items: [pick("lumina-living:jute-basket", 0, 1), pick("lumina-living:olive-wood-spoons", 0, 1)],
    status: "processing", provider: "fpx_toyyibpay", daysBack: 3, withLedger: true,
  });
  await seedOrder({
    storeId: lumina.store.id, storeName: "Lumina Living", walletId: lumina.wallet.id,
    customer: { name: "Sara Lim", email: "sara@example.com" },
    items: [pick("lumina-living:waffle-towel-set", 0, 2)],
    status: "paid", provider: "tng", daysBack: 1, withLedger: true,
  });

  await seedOrder({
    storeId: byte.store.id, storeName: "ByteBazaar", walletId: byte.wallet.id,
    customer: { name: "Wei Ming", email: "weiming@example.com" },
    items: [pick("bytebazaar:pulse-anc-earbuds", 0, 1)],
    status: "delivered", provider: "fpx_curlec" as string, daysBack: 12, withLedger: true, withSettlement: true,
  });
  await seedOrder({
    storeId: byte.store.id, storeName: "ByteBazaar", walletId: byte.wallet.id,
    customer: { name: "Hafiz Rahman", email: "hafiz@example.com" },
    items: [pick("bytebazaar:mk65-tactile", 0, 1), pick("bytebazaar:desk-mat-felt", 0, 1)],
    status: "paid", provider: "grabpay", daysBack: 2, withLedger: true,
  });
  await seedOrder({
    storeId: byte.store.id, storeName: "ByteBazaar", walletId: byte.wallet.id,
    customer: { name: "Chloe Tan", email: "chloe@example.com" },
    items: [pick("bytebazaar:usbc-hub-8in1", 0, 2)],
    status: "processing", provider: "fpx_toyyibpay", daysBack: 4, withLedger: true,
  });
  await seedOrder({
    storeId: byte.store.id, storeName: "ByteBazaar", walletId: byte.wallet.id,
    customer: { name: "Gan Zhi Hao", email: "zhihao@example.com" },
    items: [pick("bytebazaar:bt-bookshelf-speakers", 0, 1)],
    status: "paid", provider: "card_stripe", daysBack: 1, withLedger: true, discountMinor: 2000, couponCode: "WELCOME10",
  });
  const pendingOrder = await seedOrder({
    storeId: byte.store.id, storeName: "ByteBazaar", walletId: byte.wallet.id,
    customer: { name: "Nadia Karim", email: "nadia@example.com" },
    items: [pick("bytebazaar:rgb-light-bars", 0, 1)],
    status: "payment_pending", provider: "fpx_toyyibpay", daysBack: 0, withLedger: false,
  });

  await seedOrder({
    storeId: glow.store.id, storeName: "Glow Theory", walletId: glow.wallet.id,
    customer: { name: "Priya Nair", email: "priya@example.com" },
    items: [pick("glow-theory:mineral-spf50", 0, 2), pick("glow-theory:gentle-gel-cleanser", 0, 1)],
    status: "completed", provider: "tng", daysBack: 16, withLedger: true, withSettlement: true,
  });
  const glowRefundOrder = await seedOrder({
    storeId: glow.store.id, storeName: "Glow Theory", walletId: glow.wallet.id,
    customer: { name: "Emma Lau", email: "emma@example.com" },
    items: [pick("glow-theory:barrier-repair-serum", 0, 1), pick("glow-theory:sheet-mask-5", 0, 1)],
    status: "delivered", provider: "grabpay", daysBack: 8, withLedger: true,
  });
  await seedOrder({
    storeId: glow.store.id, storeName: "Glow Theory", walletId: glow.wallet.id,
    customer: { name: "Tan Mei Kwan", email: "meikwan@example.com" },
    items: [pick("glow-theory:sleeping-mask", 0, 1)],
    status: "paid", provider: "fpx_toyyibpay", daysBack: 1, withLedger: true,
  });

  // refund request (pending admin approval) — 1 of 2 items
  await db.refund.create({
    data: {
      orderId: glowRefundOrder.id, amountMinor: 4500, reason: "Customer received wrong variant",
      status: "requested", requestedBy: "seller", restock: true,
    },
  });

  // dispute on a ByteBazaar delivered order
  const byteDelivered = await db.order.findFirst({ where: { storeId: byte.store.id, status: "delivered" } });
  if (byteDelivered) {
    await db.order.update({ where: { id: byteDelivered.id }, data: { disputedFlag: true } });
    await db.dispute.create({
      data: {
        orderId: byteDelivered.id, reason: "Item not as described — left earbud crackles",
        status: "open", openedBy: "shopper",
      },
    });
  }

  // ------------------------------------------------ payouts (T3 + T4 for Lumina)
  const luminaTruth = await refreshWalletCache(lumina.wallet.id);
  if (luminaTruth.availableMinor > 0) {
    const payoutAmount = Math.min(luminaTruth.availableMinor, 200000);
    const batch = await db.payoutBatch.create({
      data: { runType: "manual", status: "completed", totalMinor: payoutAmount, payoutCount: 1, startedAt: daysAgo(6, 7), finishedAt: daysAgo(6, 7) },
    });
    const bank = await db.bankAccount.findFirst({ where: { sellerId: lumina.seller.id } });
    // Statement is DERIVED from ledger truth for the period (INTEGRITY RULE) —
    // never decorated numbers. Period: 30 days back → the payout moment.
    const statementJson = await buildLedgerStatementFromLedger({
      walletId: lumina.wallet.id,
      sellerName: "Lumina Living",
      payoutAmountMinor: payoutAmount,
      orderCount: await db.order.count({ where: { storeId: lumina.store.id, paidAt: { not: null, gte: daysAgo(30), lte: daysAgo(6, 8) } } }),
      periodFrom: daysAgo(30),
      periodTo: daysAgo(6, 8),
    });
    const payout = await db.payout.create({
      data: {
        batchId: batch.id, sellerId: lumina.seller.id, walletId: lumina.wallet.id,
        referenceNo: "PO-100001", amountMinor: payoutAmount, status: "paid",
        method: "manual_csv", bankAccountId: bank?.id ?? null, paidAt: daysAgo(6, 8),
        statementJson,
      },
    });
    await postPayoutInitiated({ walletId: lumina.wallet.id, payoutId: payout.id, referenceNo: payout.referenceNo, amountMinor: payoutAmount });
    await postPayoutConfirmed({ walletId: lumina.wallet.id, payoutId: payout.id, referenceNo: payout.referenceNo, amountMinor: payoutAmount });
  }

  // ------------------------------------------------ coupons / banners / featured
  await db.coupon.create({ data: { scope: "platform", code: "WELCOME10", description: "10% off first order (min RM 50)", type: "percent", percent: 10, minSpendMinor: 5000, perCustomerLimit: 1, timesUsed: 1 } });
  await db.coupon.create({ data: { scope: "platform", code: "FREESHIP", description: "Free shipping, no minimum", type: "freeship", perCustomerLimit: 5, timesUsed: 0 } });
  await db.coupon.create({ data: { scope: "store", storeId: lumina.store.id, code: "LUMINA15", description: "15% off Lumina Living", type: "percent", percent: 15, minSpendMinor: 10000, timesUsed: 0 } });

  await db.marketplaceBanner.create({
    data: { title: "Merdeka Mega Sale — up to 40% off", imageUrl: img("banner-merdeka", 1600, 520, "Merdeka Mega Sale"), linkUrl: "/market?sort=discount", sortOrder: 0 },
  });
  await db.marketplaceBanner.create({
    data: { title: "New sellers: zero commission this week", imageUrl: img("banner-zero", 1600, 520, "0% Commission Week"), linkUrl: "/market", sortOrder: 1 },
  });

  const featuredTitles = ["pulse-anc-earbuds", "barrier-repair-serum", "aurora-ceramic-vase", "mk65-tactile"];
  void featuredTitles;
  let slot = 0;
  for (const [key] of [
    ["bytebazaar:pulse-anc-earbuds"],
    ["glow-theory:barrier-repair-serum"],
    ["lumina-living:aurora-ceramic-vase"],
    ["bytebazaar:mk65-tactile"],
  ] as const) {
    const e = pMap[key];
    if (e) {
      await db.featuredSlot.create({ data: { productId: e.product.id, slot: "home_grid", sortOrder: slot++ } });
    }
  }

  // ------------------------------------------------ notifications, integrations, support
  for (const t of [
    { event: "order.paid", channel: "email", subject: "You have a new paid order 🎉", body: "Order {{order_number}} was paid. Fulfil it from your dashboard." },
    { event: "order.paid", channel: "inapp", subject: null, body: "Order {{order_number}} paid — {{total}}" },
    { event: "order.shipped", channel: "email", subject: "Your order is on the way", body: "Order {{order_number}} has shipped. Tracking: {{tracking}}" },
    { event: "order.delivered", channel: "email", subject: "Enjoy your order! Leave a review", body: "Your order {{order_number}} was delivered." },
    { event: "kyc.approved", channel: "email", subject: "You're approved — your store is live!", body: "Congratulations! Your store {{store_name}} is now live." },
    { event: "payout.paid", channel: "email", subject: "Payout on the way", body: "Payout {{reference_no}} for {{amount}} has been sent." },
    { event: "stock.low", channel: "inapp", subject: null, body: "{{product}} is running low ({{stock}} left)." },
    { event: "refund.approved", channel: "email", subject: "Refund approved", body: "Refund for order {{order_number}} approved." },
    { event: "dispute.opened", channel: "email", subject: "New dispute opened", body: "Dispute for order {{order_number}}: {{reason}}" },
    { event: "seller.registered", channel: "email", subject: "New seller registered", body: "{{seller_name}} just signed up." },
  ] as const) {
    await db.notificationTemplate.create({ data: { event: t.event, channel: t.channel, subject: t.subject, body: t.body } });
  }

  await db.storeIntegration.create({ data: { storeId: lumina.store.id, provider: "meta_pixel", configJson: toJson({ pixelId: "1029384756" }), isEnabled: true } });
  await db.storeIntegration.create({ data: { storeId: glow.store.id, provider: "ga4", configJson: toJson({ measurementId: "G-GL0W7HE0RY" }), isEnabled: true } });
  await db.storeIntegration.create({ data: { storeId: byte.store.id, provider: "tiktok_pixel", configJson: toJson({ pixelId: "TIKTOK123" }), isEnabled: false } });

  const hook = await db.webhookEndpoint.create({
    data: { storeId: lumina.store.id, url: "https://hooks.lumina.example/nomofee", secret: "whsec_demo_9f8e7d6c5b4a", eventsJson: toJson(["order.paid", "order.shipped"]) },
  });
  for (const ev of ["order.paid", "order.paid", "order.shipped"]) {
    await db.webhookDelivery.create({
      data: {
        endpointId: hook.id, event: ev, payloadJson: toJson({ demo: true, event: ev, orderNumber: "SM-100003" }),
        status: "success", attempts: 1, responseCode: 200, lastAttemptAt: daysAgo(3),
      },
    });
  }

  const t1 = await db.supportTicket.create({
    data: {
      storeId: lumina.store.id, sellerEmail: "lumina@nomofee.io",
      subject: "Payout timing for Raya season", status: "open", priority: "normal", contextType: "payout",
    },
  });
  await db.supportMessage.create({ data: { ticketId: t1.id, authorType: "seller", authorLabel: "Sofia (Lumina Living)", body: "Hi! When is the next payout run before Raya?" } });
  await db.supportMessage.create({ data: { ticketId: t1.id, authorType: "admin", authorLabel: "Wani (Ops)", body: "Hi Sofia! Next run is Monday; Raya week we're pulling it forward to Friday." } });
  const t2 = await db.supportTicket.create({
    data: {
      storeId: byte.store.id, sellerEmail: "byte@nomofee.io",
      subject: "How do variants affect marketplace listing?", status: "closed", priority: "low",
    },
  });
  await db.supportMessage.create({ data: { ticketId: t2.id, authorType: "seller", authorLabel: "WeiJian (ByteBazaar)", body: "Do all variants show on the marketplace?" } });
  await db.supportMessage.create({ data: { ticketId: t2.id, authorType: "admin", authorLabel: "Rina (Support)", body: "Yes — the cheapest variant price is shown, buyers pick variants on the product page." } });

  await db.announcement.create({
    data: { title: "Welcome to NOMOFEE v1", body: "Marketplace + instant storefronts + transparent commissions. Feedback welcome!", audience: "all", isActive: true },
  });

  // ------------------------------------------------ audit / activity logs
  await db.adminAuditLog.create({
    data: {
      adminId: admin.id, adminEmail: "admin@nomofee.io", action: "seller.approve",
      entityType: "seller", entityId: lumina.seller.id,
      afterJson: toJson({ status: "active" }), createdAt: daysAgo(43),
    },
  });
  await db.adminAuditLog.create({
    data: {
      adminId: admin.id, adminEmail: "admin@nomofee.io", action: "commission.override.create",
      entityType: "commission_override",
      afterJson: toJson({ scope: "seller", percent: 10, seller: "Glow Theory" }), createdAt: daysAgo(20),
    },
  });
  await db.activityLog.create({
    data: { actorType: "system", action: "payout.batch.completed", entityType: "payout_batch", metaJson: toJson({ totalMinor: 200000 }), createdAt: daysAgo(6, 7) },
  });
  await db.activityLog.create({
    data: { actorType: "seller", actorId: lumina.seller.id, actorLabel: "lumina@nomofee.io", action: "store.theme.updated", entityType: "store", entityId: lumina.store.id, createdAt: daysAgo(10) },
  });

  // ------------------------------------------------ finalize
  await db.counter.upsert({ where: { key: "order_number" }, create: { key: "order_number", value: orderSeq }, update: { value: orderSeq } });
  for (const w of [lumina.wallet.id, byte.wallet.id, glow.wallet.id, warung.wallet.id]) {
    await refreshWalletCache(w);
  }
  // seed remaining platform accounts for the ledger explorer
  await ensureAccount(ACCOUNTS.BANK_MAIN);
  await ensureAccount(ACCOUNTS.payoutClearing());
  await ensureAccount(ACCOUNTS.revenueCommission());
  await ensureAccount(ACCOUNTS.revenueAdjust());

  console.log("Seed complete:");
  console.log(`  sellers: ${await db.seller.count()}, stores: ${await db.store.count()}, products: ${await db.product.count()}`);
  console.log(`  orders: ${await db.order.count()}, ledger txns: ${await db.ledgerTransaction.count()}`);
  const wallets = await db.wallet.findMany({ include: { seller: true } });
  for (const w of wallets) {
    console.log(`  wallet ${w.seller.displayName}: pending=${w.pendingMinor} available=${w.availableMinor}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
