# Marketplace Integration Research (Phase 2 — merged)

Verdicts: URL-only import is NOT supported by either platform (seller authorisation required).
Full per-platform research:

→ [research-tiktok.md](./research-tiktok.md)

→ [research-shopee.md](./research-shopee.md)

Endpoint matrix summary:

| Capability | Shopee (V2) | TikTok Shop (202309) |
|---|---|---|
| Auth | open.shopee.com/auth → code → /api/v2/auth/token/get (4h/30d, refresh rotates) | services.tiktokshop.com/open/authorize → code → auth.tiktok-shops.com token/get (7d, grant_type=authorized_code) |
| Signing | HMAC-SHA256(partner_id+api_path+timestamp+access_token+shop_id, partner_key) | HMAC-SHA256(secret+path+sorted_params+body+secret) |
| Shop info | shop.get_shop_info | GET /authorization/202309/shops (shop_cipher) |
| List products | product.get_item_list (offset, page_size≤100, has_next_page) | POST /product/202309/products/search (page_size 1-100, page_token, 10k cap) |
| Product detail | product.get_item_base_info (≤50 ids) + get_item_extra_info | GET /product/202309/products/{product_id} |
| Variants | product.get_model_list (tier_variation + models) | product.skus[] + sales_attributes |
| Images | item.image.image_url_list, tier_variation images | main_images[].urls, sku sales_attributes.sku_img |
| MY market | Yes (en/ms-my, 2-decimal MYR) | Yes (16 regions, MYR) |
| Scrapping policy | Forbidden outside official APIs | Forbidden without authorisation |
