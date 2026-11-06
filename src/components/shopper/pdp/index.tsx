"use client";
// ============================================================================
// Shopper — PRODUCT DETAIL PAGE (PDP makeover: conversion-first rebuild).
//
// Composition only — presentation lives in ./gallery, ./variant-sheet,
// ./vouchers, ./sections and ./sticky-bar. Data source is UNCHANGED:
// GET /api/sf/{store}/products/{slug} (server-authoritative pricing, stock,
// SKUs, reviews, seller). Cart + Buy Now ride the EXISTING architecture:
// POST /api/cart/items → applyServerCart (guest token carts supported),
// Buy Now = same validated add + view-nav into checkout. Guest shopping,
// auth intent-resume and the Shopify-style cart drawer are preserved.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, PackageX, ShoppingCart, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApp } from "@/lib/app-store";
import { breadcrumbJsonLd, injectJsonLd, productJsonLd, setMeta } from "@/lib/seo";
import {
  applyServerCart,
  discountPercent,
  fetchJson,
  openProduct,
  postJson,
  ApiFail,
  EmptyState,
  ProductCard,
  QtyStepper,
  type CartT,
  type ShopperCtx,
} from "../ui-bits";
import { pdpTrack, setPdpAnalyticsContext } from "./analytics";
import { PdpGallery } from "./gallery";
import { PdpCtaBar } from "./cta-bar";
import { PdpStickyBar } from "./sticky-bar";
import { PDP_SHIPPING_DISPLAY } from "@/lib/shipping-display";
import {
  PdpDescriptionBlock,
  PdpIdentityBlock,
  PdpPriceBlock,
  PdpReviewsBlock,
  PdpSellerBlock,
  PdpShippingBlock,
  PdpVariantPreview,
} from "./sections";
import { PdpVoucherCentre } from "./vouchers";
import { PdpVariantSheet } from "./variant-sheet";
import type { PdpPayloadT } from "./types";

export default function PdpView({ ctx, slug, pSlug }: { ctx: ShopperCtx; slug: string; pSlug: string }) {
  const [data, setData] = useState<PdpPayloadT | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [adding, setAdding] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Sticky-bar anchor = the in-flow purchase controls; reviews anchor for
  // the identity block's rating link.
  const anchorRef = useRef<HTMLDivElement>(null);
  const reviewsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(null);
    setVariantId(null);
    setQty(1);
    setSheetOpen(false);
    fetchJson<PdpPayloadT>(`/api/sf/${encodeURIComponent(slug)}/products/${encodeURIComponent(pSlug)}`)
      .then((d) => {
        if (!alive) return;
        setData(d);
        // Selection policy: a product with exactly ONE option row is
        // preselected (zero friction); a multi-option product starts
        // UNSELECTED so the variant preview/sheet drive the choice — the
        // conversion flow the makeover specifies.
        setVariantId(d.product.variants.length === 1 ? d.product.variants[0].id : null);
      })
      .catch((e: Error) => alive && setFailed(e.message));
    return () => {
      alive = false;
    };
  }, [slug, pSlug]);

  // Funnel analytics context (product_view itself is already recorded
  // server-side by the PDP route — once per session per product per hour).
  useEffect(() => {
    if (data) setPdpAnalyticsContext(data.store.id, data.product.id);
  }, [data]);

  // SEO: meta tags + Product/Breadcrumb JSON-LD from real stored data (Phase 9)
  useEffect(() => {
    if (!data) return;
    const { product, store } = data;
    const seoTitle = `${product.title} | ${store.name}`;
    setMeta(seoTitle, product.description?.slice(0, 155) ?? null, `/?sf=${store.slug}&sp=${product.slug}`);
    injectJsonLd(
      "sm-jsonld-product",
      productJsonLd({
        title: product.title,
        description: product.description,
        image: product.images[0] ?? null,
        priceMinor: product.priceMinor,
        currency: "MYR",
        storeName: store.name,
        storeSlug: store.slug,
        productSlug: product.slug,
        ratingAvg: product.ratingAvg,
        ratingCount: product.ratingCount,
        urlPath: `/?sf=${store.slug}&sp=${product.slug}`,
      })
    );
    injectJsonLd(
      "sm-jsonld-breadcrumb",
      breadcrumbJsonLd([
        { name: "Market", urlPath: "/" },
        { name: store.name, urlPath: `/?sf=${store.slug}` },
        { name: product.title, urlPath: `/?sf=${store.slug}&sp=${product.slug}` },
      ])
    );
    return () => {
      injectJsonLd("sm-jsonld-product", null);
      injectJsonLd("sm-jsonld-breadcrumb", null);
    };
  }, [data]);

  const me = useApp((s) => s.me);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const shopper = me.loaded ? me.shopper : null;
  const [chatBusy, setChatBusy] = useState(false);

  // ---- derived purchase state ------------------------------------------------
  const variant = useMemo(() => data?.product.variants.find((v) => v.id === variantId) ?? null, [data, variantId]);
  const variants = data?.product.variants ?? [];
  const requiresVariant = variants.length > 1;
  const price = variant?.priceMinor ?? data?.product.priceMinor ?? 0;
  const compareAt = variant?.compareAtPriceMinor ?? data?.product.compareAtPriceMinor ?? null;
  const off = discountPercent(price, compareAt);
  const canPurchase = Boolean(variant && variant.stock > 0);
  const outOfStock = requiresVariant ? false : !canPurchase; // multi-option unselected → CTAs open the sheet instead
  const moq = Math.max(1, variant?.moq ?? 1);
  const effectiveQty = Math.max(qty, moq);
  const lowStock =
    variant && variant.stock > 0 && variant.stock <= Math.max(1, variant.lowStockThreshold) ? variant.stock : null;
  const optionLabel = variants[0]?.optionName ?? "Option";
  const lineTotalMinor = price * effectiveQty;

  /** PDP entry point for the chat: stamps the thread with THIS product so the
   *  conversation shows a clickable product bubble on both sides.
   *  NOTE: the action itself must NOT check the login state — after sign-in
   *  the stored callback still runs THIS closure, so re-checking here would
   *  just re-open the auth dialog (stale closure). The guard lives in
   *  onMessageSeller instead. */
  const beginProductChat = useCallback(async () => {
    if (!data) return;
    setChatBusy(true);
    try {
      const res = await postJson<{ thread: { id: string } }>("/api/chat/threads", {
        storeId: data.store.id,
        productId: data.product.id,
        message: `Hi ${data.store.name}! I'd like to ask about “${data.product.title}”.`,
      });
      toast.success("Chat opened", { description: `You're now chatting with ${data.store.name} about this product.` });
      ctx.nav({ name: "messages", threadId: res.thread.id });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open the chat");
    } finally {
      setChatBusy(false);
    }
  }, [data, ctx]);

  const onMessageSeller = () => {
    if (!shopper) {
      openShopperAuth(() => void beginProductChat());
      return;
    }
    void beginProductChat();
  };

  // ---- buyer dashboard activity: VIEWED + LIKE -------------------------------
  const [liked, setLiked] = useState(false);
  const productId = data?.product.id ?? null;

  useEffect(() => {
    if (!shopper || !productId) return;
    // VIEWED — fire-and-forget; recency powers Recently Viewed + recommendations.
    postJson("/api/me/activity", { productId, activityType: "VIEWED" }).catch(() => {});
    fetchJson<{ liked: boolean }>(`/api/me/activity?productId=${encodeURIComponent(productId)}`)
      .then((d) => setLiked(Boolean(d.liked)))
      .catch(() => {});
  }, [shopper, productId]);

  const setLike = useCallback(
    async (target: boolean) => {
      if (!productId) return;
      setLiked(target); // optimistic
      try {
        if (target) {
          await postJson("/api/me/activity", { productId, activityType: "LIKE" });
          toast.success("Saved to My Likes");
        } else {
          await fetchJson("/api/me/activity", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ productId, activityType: "LIKE" }),
          });
        }
      } catch {
        setLiked(!target); // revert on failure
      }
    },
    [productId]
  );

  const onHeartTap = () => {
    if (!shopper) {
      openShopperAuth(() => void setLike(true));
      return;
    }
    void setLike(!liked);
  };

  // ---- variant sheet + interaction analytics ---------------------------------
  const openSheet = useCallback(() => {
    setSheetOpen(true);
    pdpTrack("variant_modal_open", {});
  }, []);

  const onSheetOpenChange = useCallback((open: boolean) => {
    if (!open) pdpTrack("variant_modal_dismiss", {});
    setSheetOpen(open);
  }, []);

  const selectVariant = useCallback((id: string) => {
    setVariantId(id);
    pdpTrack("select_variant", { variantId: id });
  }, []);

  const changeQty = useCallback(
    (v: number) => {
      setQty(Math.max(moq, v));
      pdpTrack("qty_changed", { variantId, qty: Math.max(moq, v) });
    },
    [moq, variantId]
  );

  const onOosInteraction = useCallback((id: string) => {
    pdpTrack("oos_option_interaction", { variantId: id });
  }, []);

  const onImageChange = useCallback(() => {
    pdpTrack("view_item_gallery", {});
  }, []);

  // ---- add to cart / buy now (EXISTING server-validated architecture) --------
  async function addToCart(openDrawer = true): Promise<boolean> {
    if (!variant || variant.stock <= 0) {
      pdpTrack("add_to_cart_failure", { variantId: variant?.id ?? null });
      toast.error("This option is unavailable", { description: "Pick another option — the cart re-checks stock on every add." });
      return false;
    }
    // PHASE 2.2 GUEST CHECKOUT RESTORATION: guests add straight to a
    // token-keyed cart ("sm_cart" cookie — minted server-side on the first
    // add); NO auth dialog. Signed-in shoppers keep the account cart exactly
    // as before, and a guest who later signs in gets this cart merged into
    // their account (lib/shopper-merge.ts).
    setAdding(true);
    try {
      const res = await postJson<{ cart: CartT; notice: string | null }>("/api/cart/items", { variantId: variant.id, qty: Math.max(moq, qty) });
      applyServerCart(res.cart); // same-frame badge/drawer update, zero refetch
      if (res.notice) {
        toast.warning("Cart updated", { description: res.notice });
      } else {
        toast.success("Added to cart", { description: `${data?.product.title}${qty > 1 ? ` × ${qty}` : ""}` });
      }
      // Shopify-style: pop the cart drawer open after a regular add so the
      // shopper immediately sees what's in the cart (with the seller's
      // customized cart experience for THIS store). Buy Now passes false —
      // it navigates straight into checkout instead.
      if (openDrawer && data?.store?.slug) ctx.openCart(data.store.slug);
      return true;
    } catch (e) {
      pdpTrack("add_to_cart_failure", { variantId: variant.id });
      // Belt-and-braces: an INVALID shopper session (401 — e.g. suspended
      // account) still gets the sign-in-first flow. Guests never land here:
      // the token-cart path succeeds without a session.
      if (e instanceof ApiFail && (e.status === 401 || e.code === "SHOPPER_LOGIN_REQUIRED")) {
        openShopperAuth(() => void addToCart(openDrawer));
        return false;
      }
      toast.error(e instanceof Error ? e.message : "Could not add to cart");
      return false;
    } finally {
      setAdding(false);
    }
  }

  /** Phase 4: unselected multi-option product → the CTA opens the variant
   *  sheet instead of erroring; a selected SKU adds without reselection. */
  const handleAddToCart = () => {
    if (requiresVariant && !variant) {
      openSheet();
      return;
    }
    void addToCart();
  };

  const handleBuyNow = async () => {
    if (requiresVariant && !variant) {
      openSheet();
      return;
    }
    if (!variant || variant.stock <= 0) {
      pdpTrack("invalid_variant_attempt", { variantId: variant?.id ?? null });
      toast.error("This option is unavailable");
      return;
    }
    pdpTrack("buy_now_initiated", { variantId: variant.id, qty: effectiveQty });
    if (await addToCart(false)) {
      pdpTrack("begin_checkout", { variantId: variant.id, qty: effectiveQty });
      ctx.nav({ name: "checkout" });
    }
  };

  // ---- render ----------------------------------------------------------------
  if (failed) {
    return (
      <EmptyState
        icon={PackageX}
        title="Product not available"
        hint={failed}
        action={
          <Button onClick={() => ctx.nav({ name: "market" })} className="bg-teal-700 hover:bg-teal-800">
            Back to market
          </Button>
        }
      />
    );
  }

  if (!data) return <PdpSkeleton />;

  const { product, store } = data;
  const shareUrl =
    typeof window !== "undefined" ? `${window.location.origin}/?sf=${store.slug}&sp=${product.slug}` : `/?sf=${store.slug}&sp=${product.slug}`;
  const selectedLabel = variant ? `${optionLabel}: ${variant.optionValue ?? variant.name}` : null;

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-3 pb-[calc(5.75rem+env(safe-area-inset-bottom))] md:px-4 md:py-6 md:pb-10">
      {/* breadcrumb (desktop — mobile keeps a clean shopping canvas) */}
      <nav aria-label="Breadcrumb" className="hidden items-center gap-1 pb-4 text-sm text-muted-foreground md:flex">
        <button type="button" className="flex min-h-[44px] items-center transition-colors hover:text-teal-700" onClick={() => ctx.nav({ name: "market" })}>
          Market
        </button>
        <ChevronRight className="h-3.5 w-3.5" />
        <button type="button" className="flex min-h-[44px] items-center transition-colors hover:text-teal-700" onClick={() => ctx.nav({ name: "storefront", slug: store.slug })}>
          {store.name}
        </button>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="max-w-[50vw] truncate font-medium text-foreground">{product.title}</span>
      </nav>

      <div className="lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start lg:gap-8">
        {/* LEFT — media gallery (edge-to-edge on mobile; sticky on desktop) */}
        <div className="-mx-3 lg:sticky lg:top-[84px] lg:mx-0 lg:self-start">
          <PdpGallery
            title={product.title}
            images={product.images}
            variantImageUrl={variant?.imageUrl ?? null}
            discountOff={off}
            lowStock={lowStock}
            ratingAvg={product.ratingAvg}
            ratingCount={product.ratingCount}
            onImageChange={onImageChange}
          />
        </div>

        {/* RIGHT — the buy column */}
        <div className="mt-3 space-y-3 lg:mt-0">
          <PdpIdentityBlock
            title={product.title}
            categoryName={product.categoryName}
            ratingAvg={product.ratingAvg}
            ratingCount={product.ratingCount}
            salesCount={product.salesCount}
            liked={liked}
            onToggleLike={onHeartTap}
            shareUrl={shareUrl}
            onOpenReviews={() => reviewsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
          />

          <PdpPriceBlock price={price} compareAt={compareAt} off={off} moq={moq} />

          {/* voucher centre — account-scoped (guests see no dead UI) */}
          <PdpVoucherCentre signedIn={Boolean(shopper)} storeSlug={store.slug} subtotalMinor={lineTotalMinor} />

          {/* inline variant preview → opens the dedicated bottom sheet.
              Only rendered when there is a REAL choice: single-variant
              products (the "Default" row pattern) are auto-selected and need
              no selector — no noise. */}
          {variants.length > 1 ? (
            <PdpVariantPreview
              optionLabel={optionLabel}
              selectedValue={variant ? variant.optionValue ?? variant.name : null}
              priceFrom={variant ? price : null}
              totalOptions={variants.length}
              onOpen={openSheet}
            />
          ) : null}

          {/* in-flow purchase controls — the sticky bar's visibility anchor */}
          <div ref={anchorRef} className="space-y-3 rounded-2xl border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold">
                Quantity
                {moq > 1 ? <span className="ml-1.5 font-normal text-muted-foreground">· min {moq}</span> : null}
              </p>
              <QtyStepper value={effectiveQty} min={moq} onChange={changeQty} max={variant ? Math.max(moq, variant.stock) : 99} />
            </div>
            {lowStock != null ? <p className="text-xs font-semibold text-amber-600">Only {lowStock} left — order soon.</p> : null}
            {requiresVariant && !variant ? (
              <p className="text-xs font-medium text-amber-600">Choose an option to see availability.</p>
            ) : null}
            <div className="grid gap-2.5 sm:grid-cols-2">
              <Button
                size="lg"
                disabled={adding || outOfStock}
                onClick={handleAddToCart}
                className="min-h-[48px] bg-teal-700 text-white hover:bg-teal-800"
              >
                <ShoppingCart className="h-4 w-4" aria-hidden="true" />
                {outOfStock ? "Out of stock" : adding ? "Adding…" : requiresVariant && !variant ? "Select options" : "Add to cart"}
              </Button>
              <Button
                size="lg"
                disabled={adding || outOfStock}
                onClick={() => void handleBuyNow()}
                className="min-h-[48px] bg-amber-500 text-white hover:bg-amber-600"
              >
                <Zap className="h-4 w-4" aria-hidden="true" />
                Buy now
              </Button>
            </div>
          </div>

          <PdpShippingBlock lineTotalMinor={lineTotalMinor} />

          <PdpSellerBlock store={store} productTitle={product.title} onMessageSeller={onMessageSeller} chatBusy={chatBusy} ctx={ctx} />
        </div>
      </div>

      {/* full-width content sections below the fold */}
      <div className="mt-4 space-y-4 md:mt-8">
        <PdpDescriptionBlock description={product.description} />
        <PdpReviewsBlock
          reviews={data.reviews}
          ratingAvg={product.ratingAvg}
          ratingCount={product.ratingCount}
          ratingDist={product.ratingDist}
          storeName={store.name}
          sectionRef={reviewsRef}
        />
        {data.related.length > 0 ? (
          <section aria-label="More from this seller" className="space-y-3">
            <h2 className="px-1 text-base font-bold md:text-lg">More from {store.name}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {data.related.map((p) => (
                <ProductCard key={p.id} p={p} cardStyle={data.store.cardStyle} onOpen={(pp) => openProduct(ctx, pp)} />
              ))}
            </div>
          </section>
        ) : null}
      </div>

      {/* OPTION A: multi-seller carts — no cross-store replace confirm needed */}

      {/* variant bottom sheet — the SAME server-validated handlers */}
      <PdpVariantSheet
        open={sheetOpen}
        onOpenChange={onSheetOpenChange}
        title={product.title}
        productImage={product.images[0] ?? null}
        variants={variants}
        variantId={variantId}
        onSelectVariant={selectVariant}
        qty={qty}
        onQtyChange={changeQty}
        onAddToCart={() => addToCart(true)}
        onBuyNow={() => void handleBuyNow()}
        adding={adding}
        onOosInteraction={onOosInteraction}
      />

      {/* one persistent purchase bar per breakpoint (never a second sticky
          variant preview): mobile = the TikTok-style CTA bar below (fixed,
          replaces BottomNav), desktop = the scroll-triggered sticky bar. */}
      <PdpStickyBar
        anchorRef={anchorRef}
        price={price}
        compareAt={compareAt}
        selectedLabel={selectedLabel}
        requiresVariant={requiresVariant}
        adding={adding}
        outOfStock={outOfStock}
        onAddToCart={handleAddToCart}
        onBuyNow={() => void handleBuyNow()}
      />

      {/* TikTok-style product CTA bar (mobile only) — replaces the bottom
          navigation on the PDP. Same server-validated handlers as the in-flow
          controls: Shop → storefront, Chat → product-scoped thread (auth
          intent-resume), Add to cart / Buy now → existing cart + checkout. */}
      <PdpCtaBar
        storeName={store.name}
        price={price}
        freeShipping={lineTotalMinor >= PDP_SHIPPING_DISPLAY.freeShipThresholdMinor}
        chatBusy={chatBusy}
        adding={adding}
        disabled={outOfStock}
        actionLabel={requiresVariant && !variant ? "Choose an option first" : null}
        onOpenStore={() => ctx.nav({ name: "storefront", slug: store.slug })}
        onChat={onMessageSeller}
        onAddToCart={handleAddToCart}
        onBuyNow={() => void handleBuyNow()}
      />
    </div>
  );
}

function PdpSkeleton() {
  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-3 pb-[calc(5.75rem+env(safe-area-inset-bottom))] md:px-4 md:py-6 md:pb-10">
      <div className="lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start lg:gap-8">
        <div className="-mx-3 lg:mx-0">
          <Skeleton className="aspect-square rounded-none md:rounded-2xl" />
        </div>
        <div className="mt-3 space-y-3 lg:mt-0">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-24 w-full rounded-2xl" />
          <Skeleton className="h-16 w-full rounded-2xl" />
          <Skeleton className="h-14 w-full rounded-2xl" />
          <Skeleton className="h-36 w-full rounded-2xl" />
          <Skeleton className="h-32 w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
