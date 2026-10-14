"use client";
// ============================================================================
// Shopper — PRODUCT DETAIL PAGE (Task 2-e).
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  ChevronRight,
  Heart,
  MessageCircle,
  Loader2,
  Store,
  ShoppingCart,
  Zap,
  PackageX,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMinor } from "@/lib/money";
import { useApp } from "@/lib/app-store";
import { cn } from "@/lib/utils";
import { breadcrumbJsonLd, injectJsonLd, productJsonLd, setMeta } from "@/lib/seo";
import {
  fetchJson,
  postJson,
  notifyCartUpdated,
  discountPercent,
  dateShort,
  openProduct,
  ApiFail,
  EmptyState,
  ProductCard,
  QtyStepper,
  Stars,
  type ProductCardT,
  type ShopperCtx,
} from "./ui-bits";

type VariantT = {
  id: string;
  name: string;
  optionName: string | null;
  optionValue: string | null;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  stock: number;
  sku: string | null;
  isActive: boolean;
};

type PdpPayload = {
  product: {
    id: string;
    title: string;
    slug: string;
    description: string;
    priceMinor: number;
    compareAtPriceMinor: number | null;
    ratingAvg: number;
    ratingCount: number;
    salesCount: number;
    categoryId: string | null;
    categoryName: string | null;
    images: string[];
    variants: VariantT[];
  };
  reviews: { id: string; customerName: string; rating: number; title: string | null; body: string | null; reply: string | null; createdAt: string }[];
  related: ProductCardT[];
  store: { id: string; name: string; slug: string; tagline: string | null; logoUrl: string | null; whatsapp: string | null };
};

export default function PdpView({ ctx, slug, pSlug }: { ctx: ShopperCtx; slug: string; pSlug: string }) {
  const [data, setData] = useState<PdpPayload | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [imgIdx, setImgIdx] = useState(0);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(null);
    setVariantId(null);
    setQty(1);
    setImgIdx(0);
    fetchJson<PdpPayload>(`/api/sf/${encodeURIComponent(slug)}/products/${encodeURIComponent(pSlug)}`)
      .then((d) => {
        if (!alive) return;
        setData(d);
        const firstInStock = d.product.variants.find((v) => v.stock > 0) ?? d.product.variants[0];
        setVariantId(firstInStock?.id ?? null);
      })
      .catch((e: Error) => alive && setFailed(e.message));
    return () => {
      alive = false;
    };
  }, [slug, pSlug]);

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

  const variant = useMemo(() => data?.product.variants.find((v) => v.id === variantId) ?? null, [data, variantId]);
  const price = variant?.priceMinor ?? data?.product.priceMinor ?? 0;
  const compareAt = variant?.compareAtPriceMinor ?? data?.product.compareAtPriceMinor ?? null;
  const off = discountPercent(price, compareAt);
  const outOfStock = !variant || variant.stock <= 0;

  const me = useApp((s) => s.me);
  const openShopperAuth = useApp((s) => s.openShopperAuth);
  const shopper = me.loaded ? me.shopper : null;
  const [chatBusy, setChatBusy] = useState(false);

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
      // not signed in → ask to sign in / register first, then continue to the chat
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

  async function addToCart(): Promise<boolean> {
    if (!variant || variant.stock <= 0) return false;
    // Carts are ACCOUNT-scoped (no guest cart) — guests must sign in first.
    // Auth state is read from the STORE at call time, NOT from this render's
    // closure: the sign-in dialog resumes this exact function via a stored
    // callback AFTER `me` has changed, so a captured `shopper` would be stale
    // and would wrongly re-open the dialog instead of adding the item.
    const meNow = useApp.getState().me;
    if (!(meNow.loaded ? meNow.shopper : null)) {
      openShopperAuth(() => void addToCart());
      return false;
    }
    setAdding(true);
    try {
      const res = await postJson<{ cart: unknown; notice: string | null }>("/api/cart/items", { variantId: variant.id, qty });
      notifyCartUpdated();
      if (res.notice) {
        toast.warning("Cart updated", { description: res.notice });
      } else {
        toast.success("Added to cart", { description: `${data?.product.title}${qty > 1 ? ` × ${qty}` : ""}` });
      }
      return true;
    } catch (e) {
      // Belt-and-braces: an expired session gets the same sign-in-first flow.
      if (e instanceof ApiFail && (e.status === 401 || e.code === "SHOPPER_LOGIN_REQUIRED")) {
        openShopperAuth(() => void addToCart());
        return false;
      }
      toast.error(e instanceof Error ? e.message : "Could not add to cart");
      return false;
    } finally {
      setAdding(false);
    }
  }

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

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 flex-1">
      {/* breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground pb-4 flex-wrap">
        <button type="button" className="hover:text-teal-700 transition-colors min-h-[44px] flex items-center" onClick={() => ctx.nav({ name: "market" })}>
          Market
        </button>
        <ChevronRight className="h-3.5 w-3.5" />
        <button type="button" className="hover:text-teal-700 transition-colors min-h-[44px] flex items-center" onClick={() => ctx.nav({ name: "storefront", slug: store.slug })}>
          {store.name}
        </button>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-foreground font-medium truncate max-w-[50vw]">{product.title}</span>
      </nav>

      <div className="grid gap-8 lg:grid-cols-2">
        {/* gallery */}
        <div className="space-y-3">
          <motion.div
            key={imgIdx}
            initial={{ opacity: 0.4 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25 }}
            className="aspect-square overflow-hidden rounded-2xl border bg-muted"
          >
            <img
              src={product.images[imgIdx] ?? "/api/img/fallback?w=900&h=900"}
              alt={`${product.title} — image ${imgIdx + 1}`}
              className="h-full w-full object-cover"
            />
          </motion.div>
          {product.images.length > 1 ? (
            <div className="flex gap-2 overflow-x-auto pb-1" role="listbox" aria-label="Product images">
              {product.images.map((url, i) => (
                <button
                  key={url + i}
                  type="button"
                  role="option"
                  aria-selected={i === imgIdx}
                  onClick={() => setImgIdx(i)}
                  className={cn(
                    "h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 transition-all",
                    i === imgIdx ? "border-teal-600" : "border-transparent opacity-70 hover:opacity-100"
                  )}
                >
                  <img src={url} alt={`${product.title} thumbnail ${i + 1}`} loading="lazy" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* buy box */}
        <div className="space-y-5">
          <div className="space-y-2">
            {product.categoryName ? <Badge variant="outline" className="border-teal-700/30 text-teal-800">{product.categoryName}</Badge> : null}
            <h1 className="text-2xl font-bold tracking-tight leading-tight">{product.title}</h1>
            <div className="flex flex-wrap items-center gap-3">
              <Stars rating={product.ratingAvg} count={product.ratingCount} />
              <span className="text-xs text-muted-foreground">· {product.salesCount} sold</span>
            </div>
          </div>

          <div className="flex items-end gap-3">
            <span className="text-3xl font-extrabold text-teal-700">{formatMinor(price)}</span>
            {compareAt && compareAt > price ? (
              <>
                <span className="text-lg text-muted-foreground line-through">{formatMinor(compareAt)}</span>
                <Badge className="bg-rose-600 hover:bg-rose-600">-{off}%</Badge>
              </>
            ) : null}
            <button
              type="button"
              onClick={onHeartTap}
              aria-pressed={liked}
              aria-label={liked ? "Remove from My Likes" : "Save to My Likes"}
              className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors hover:bg-muted"
            >
              <Heart className={cn("h-5 w-5", liked ? "fill-rose-600 text-rose-600" : "text-muted-foreground")} aria-hidden="true" />
            </button>
          </div>

          {/* variant selector */}
          {product.variants.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold">
                {product.variants[0].optionName ?? "Option"}
                {variant?.optionValue ? <span className="text-muted-foreground font-normal"> — {variant.optionValue}</span> : null}
              </p>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Choose option">
                {product.variants.map((v) => {
                  const soldOut = v.stock <= 0;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      role="radio"
                      aria-checked={v.id === variantId}
                      disabled={soldOut}
                      onClick={() => setVariantId(v.id)}
                      className={cn(
                        "rounded-full border px-5 min-h-[44px] text-sm font-medium transition-all",
                        v.id === variantId
                          ? "border-teal-700 bg-teal-700 text-white shadow-sm"
                          : "bg-background hover:border-teal-600/60",
                        soldOut && "opacity-40 cursor-not-allowed line-through"
                      )}
                    >
                      {v.optionValue ?? v.name}
                      {soldOut ? " · out" : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <Separator />

          {/* qty + actions */}
          <div className="flex flex-wrap items-center gap-3">
            <QtyStepper value={qty} onChange={setQty} max={variant ? Math.max(1, variant.stock) : 99} />
            {variant && variant.stock > 0 && variant.stock <= 5 ? (
              <span className="text-xs font-semibold text-amber-600">Only {variant.stock} left!</span>
            ) : null}
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2">
            <Button
              size="lg"
              disabled={outOfStock || adding}
              onClick={() => addToCart()}
              className="min-h-[48px] bg-teal-700 hover:bg-teal-800 text-white"
            >
              <ShoppingCart className="h-4 w-4" />
              {outOfStock ? "Out of stock" : adding ? "Adding…" : "Add to cart"}
            </Button>
            <Button
              size="lg"
              disabled={outOfStock || adding}
              onClick={async () => {
                if (await addToCart()) ctx.nav({ name: "checkout" });
              }}
              className="min-h-[48px] bg-amber-500 hover:bg-amber-600 text-white"
            >
              <Zap className="h-4 w-4" />
              Buy now
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={onMessageSeller}
              disabled={chatBusy}
              className="min-h-[48px] gap-2 border-teal-700/40 text-teal-800 hover:bg-teal-50 sm:col-span-2"
              title="Ask the seller about this product — opens a chat quoting this item"
            >
              {chatBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
              Message seller
            </Button>
          </div>

          <div className="flex flex-wrap gap-4 pt-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Truck className="h-4 w-4 text-teal-700" /> Standard RM 8 · FREE over RM 100
            </span>
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-emerald-600" /> 7-day buyer protection
            </span>
          </div>

          {/* description */}
          {product.description ? (
            <div className="space-y-2 pt-2">
              <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Description</h2>
              <p className="text-sm leading-relaxed whitespace-pre-line text-foreground/90">{product.description}</p>
            </div>
          ) : null}
        </div>
      </div>

      <Separator className="my-10" />

      <div className="grid gap-8 lg:grid-cols-3">
        {/* reviews */}
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-lg font-bold">Reviews ({product.ratingCount})</h2>
          {data.reviews.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reviews yet — be the first after you purchase.</p>
          ) : (
            <ul className="space-y-4">
              {data.reviews.map((r) => (
                <li key={r.id} className="rounded-xl border bg-card p-4 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-50 text-teal-800 text-xs font-bold">
                        {r.customerName.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="text-sm font-semibold">{r.customerName}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{dateShort(r.createdAt)}</span>
                  </div>
                  <Stars rating={r.rating} />
                  {r.title ? <p className="text-sm font-medium">{r.title}</p> : null}
                  {r.body ? <p className="text-sm text-foreground/85">{r.body}</p> : null}
                  {r.reply ? (
                    <div className="rounded-lg bg-muted/60 border-l-2 border-teal-600 p-2.5 text-xs">
                      <span className="font-semibold text-teal-800">{store.name} replied:</span> {r.reply}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* store card */}
        <aside className="space-y-4">
          <div className="rounded-xl border bg-card p-5 space-y-3">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-teal-50 overflow-hidden shrink-0">
                {store.logoUrl ? (
                  <img src={store.logoUrl} alt={`${store.name} logo`} className="h-full w-full object-cover" />
                ) : (
                  <Store className="h-6 w-6 text-teal-700" />
                )}
              </span>
              <div className="min-w-0">
                <p className="font-bold truncate">{store.name}</p>
                <p className="text-xs text-muted-foreground line-clamp-2">{store.tagline ?? "Independent seller"}</p>
              </div>
            </div>
            <div className="grid gap-2">
              <Button variant="outline" onClick={() => ctx.nav({ name: "storefront", slug: store.slug })} className="min-h-[44px] border-teal-700/40 text-teal-800 hover:bg-teal-50">
                <Store className="h-4 w-4" /> Visit store
              </Button>
              {store.whatsapp ? (
                <a
                  href={`https://wa.me/${store.whatsapp}?text=${encodeURIComponent(`Hi ${store.name}! I'm interested in "${product.title}".`)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-10 min-h-[44px] items-center justify-center gap-2 rounded-md border border-emerald-600/40 px-4 text-sm font-medium text-emerald-700 hover:bg-emerald-50 transition-colors"
                >
                  <MessageCircle className="h-4 w-4" /> WhatsApp us
                </a>
              ) : null}
            </div>
          </div>
        </aside>
      </div>

      {/* related */}
      {data.related.length > 0 ? (
        <div className="pt-12 space-y-4">
          <h2 className="text-lg font-bold">More from {store.name}</h2>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {data.related.map((p) => (
              <ProductCard key={p.id} p={p} onOpen={(pp) => openProduct(ctx, pp)} />
            ))}
          </div>
        </div>
      ) : null}

      {/* OPTION A: multi-seller carts — no cross-store replace confirm needed */}
    </div>
  );
}

function PdpSkeleton() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 flex-1">
      <Skeleton className="h-4 w-64 mb-6" />
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="space-y-3">
          <Skeleton className="aspect-square rounded-2xl" />
          <div className="flex gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-16 rounded-lg" />
            ))}
          </div>
        </div>
        <div className="space-y-4">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-9 w-3/4" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  );
}
