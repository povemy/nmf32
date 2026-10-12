# Authorization overview

Authorization is how a TikTok Shop user (seller, creator, or partner) grants your app access to their data. The flow is OAuth-based: the user approves an authorization link, your app receives a short-lived `auth_code`, and you exchange it for an `access_token` and `refresh_token`.
This page is the **reference** for the token APIs and the `user_type` values. For step-by-step, role-specific walkthroughs, see:

* [Seller authorization guide](https://partner.tiktokshop.com/docv2/page/seller-authorization-guide)
* [Creator authorization guide](https://partner.tiktokshop.com/docv2/page/creator-authorization-guide)
* [Partner authorization guide](https://partner.tiktokshop.com/docv2/page/partner-authorization-guide)

# Authorization domains by market
Different markets and authorization types use different domains. Use this table as the single reference:
| Authorization type | US market | Rest of World (ROW) |
| --- | --- | --- |
| Seller (via authorization link) | `https://services.us.tiktokshop.com/open/authorize?service_id={service_id}` | `https://services.tiktokshop.com/open/authorize?service_id={service_id}` |
| Partner (TAP) | `https://partner.us.tiktokshop.com/open/authorize?service_id={service_id}` | `https://partner.tiktokshop.com/open/authorize?service_id={service_id}` |
| Creator | `https://shop.tiktok.com/alliance/creator/auth?app_key={app_key}&state={state}` | `https://shop.tiktok.com/alliance/creator/auth?app_key={app_key}&state={state}` |
| Token endpoints (all markets) | `https://auth.tiktok-shops.com/api/v2/token/get` and `.../token/refresh` | same |
> **Where do I get** **`service_id` / `app_key`?** Both are shown on your app's detail page in Partner Center (**App & Service**). The `service_id` is the unique identifier of your registered online application (OAuth client).

# Authorization flow
[IMAGE]

1. The user opens your authorization link and approves (or rejects) the request.
2. On approval, the user is redirected to your **Redirect URL** with a temporary `code`:

```Plain Text
{redirect_url}?code=FeBoANmHP3yqdoUI9fZOCw&state={state}
```

If the user rejects, they are still redirected, but `code` is null: `code=null&error=auth_denied`.
> ❗ **Important:** The `auth_code` expires in **30 minutes** and can be used **only once**. Exchange it for tokens immediately.

1. Your app exchanges the `code` (passed as `auth_code`) for tokens via the Get Access Token API.

# Get Access Token API
Make a `GET` request to `https://auth.tiktok-shops.com/api/v2/token/get` with the following parameters:
| Parameter | Type | Required? | Description | Sample |
| --- | --- | --- | --- | --- |
| `app_key` | string | Yes | App key from the Partner Center app page. | 123abc |
| `app_secret` | string | Yes | App secret from the Partner Center app page. | (your app secret) |
| `auth_code` | string | Yes | Authorization code obtained from the authorization link. | TTP_FeBoANmHP3yqdoUI9fZOCw |
| `grant_type` | string | Yes | Grant token type. Only `authorized_code` is accepted. | authorized_code |
> **On** **`grant_type=authorized_code`:** this value is intentional and correct for the TikTok Shop token API — it is **not** the standard OAuth `authorization_code`. Do not "fix" it to `authorization_code`, or the request will fail.

Your request should resemble:
```Plain Text
https://auth.tiktok-shops.com/api/v2/token/get?app_key=123abc
&app_secret={your_app_secret}
&auth_code=TTP_FeBoANmHP3yqdoUI9fZOCw
&grant_type=authorized_code
```

If all parameters are valid, the response contains:
| Field | Type | Description | Sample |
| --- | --- | --- | --- |
| `code` | int | Machine-readable result code. `0` = success. See Common error codes. | 0 |
| `message` | string | Human-readable result message. | success |
| `request_id` | string | ID to track the API request. | 2024080809462301024509910319695C45 |
| `data.access_token` | string | User access token. Pass it in the `x-tts-access-token` header of API requests. | TTP_RLM6CIADWF606TZGFO5XGA |
| `data.access_token_expire_in` | Unix timestamp | Access token expiration (default validity: **7 days**). | 1660556783 |
| `data.refresh_token` | string | Token used to refresh the access token. | TTP_C2XWDN63ON-FOHJSMR0WSG |
| `data.refresh_token_expire_in` | Unix timestamp | Refresh token expiration (equals the authorization duration the user granted). | 1691487031 |
| `data.open_id` | string | ID identifying the authorizing user. | 7010736057180325637 |
| `data.seller_name` | string | Name of the authorizing seller. | Test Seller |
| `data.seller_base_region` | string | Region where the seller is based. | US |
| `data.user_type` | int | Type of authorizing user. See the enumeration below. | 0 |
| `data.granted_scopes` | []string | The **Scope Key** values authorized for the app. | ["seller.affiliate_collaboration.read", "seller.affiliate_collaboration.write"] |
```Plain Text
{
  "code": 0,
  "message": "success",
  "request_id": "2024080809462301024509910319695C45",
  "data": {
    "access_token": "TTP_Fw8rBwAAAAAkW03FYd09DG-9INtpw361hWthei8S3fHX8iPJ5AUv99fLSCYD9-UucaqxTgNRzKZxi5",
    "access_token_expire_in": 1660556783,
    "refresh_token": "TTP_NTUxZTNhYTQ2ZDk2YmRmZWNmYWY2YWY2YzkxNGYwNjQ3YjkzYTllYjA0YmNlMw",
    "refresh_token_expire_in": 1691487031,
    "open_id": "7010736057180325637",
    "seller_name": "Test Seller",
    "seller_base_region": "US",
    "user_type": 0,
    "granted_scopes": [
      "seller.affiliate_collaboration.read",
      "seller.affiliate_collaboration.write"
    ]
  }
}
```

# `user_type` enumeration
The `user_type` field tells you which kind of user authorized your app:
| Value | User type | Notes |
| --- | --- | --- |
| 0 | Seller | Standard seller authorization. |
| 1 | Creator | Affiliate creator authorization. |
| 2 | Partner | Legacy partner type. |
| 3 | Partner | Current partner type used for Affiliate Partner / TAP authorization. |
| 4 | Global Selling seller | Cross-border / Global Selling. |
| 5 | Global Selling seller | Current Global Selling type. |
> Match the value you receive against this table — for example, creator integrations should receive `1`, and Affiliate Partner (TAP) integrations should receive `3`. If you receive an unexpected value, verify that the user authorized through the correct authorization link for your app type.

# Get Refresh Token API
Access tokens expire (default 7 days). Before expiry, refresh them by making a `GET` request to `https://auth.tiktok-shops.com/api/v2/token/refresh`:
| Parameter | Type | Required? | Description | Sample |
| --- | --- | --- | --- | --- |
| `app_key` | string | Yes | App key from the Partner Center app page. | 123abc |
| `app_secret` | string | Yes | App secret from the Partner Center app page. | (your app secret) |
| `refresh_token` | string | Yes | Refresh token from the Get Access Token response. | TTP_C2XWDN63ON-FOHJSMR0WSG |
| `grant_type` | string | Yes | Grant token type. Only `refresh_token` is accepted. | refresh_token |
Your request should resemble:
```Plain Text
https://auth.tiktok-shops.com/api/v2/token/refresh?app_key=123abc
&app_secret={your_app_secret}
&refresh_token=TTP_C2XWDN63ON-FOHJSMR0WSG
&grant_type=refresh_token
```

The response has the same shape as Get Access Token. Note the corrected JSON (every field is comma-separated):
```Plain Text
{
  "code": 0,
  "message": "success",
  "request_id": "2024080809462301024509910319695C45",
  "data": {
    "access_token": "TTP_Fw8rBwAAAAAkW03FYd09DG-9INtpw361hWthei8S3fHX8iPJ5AUv99fLSCYD9-UucaqxTgNRzKZxi5",
    "access_token_expire_in": 1660556783,
    "refresh_token": "TTP_NTUxZTNhYTQ2ZDk2YmRmZWNmYWY2YWY2YzkxNGYwNjQ3YjkzYTllYjA0YmNlMw",
    "refresh_token_expire_in": 1691487031,
    "open_id": "7010736057180325637",
    "seller_name": "Test Seller",
    "seller_base_region": "US",
    "user_type": 0,
    "granted_scopes": [
      "seller.affiliate_collaboration.read",
      "seller.affiliate_collaboration.write"
    ]
  }
}
```

# State parameter (recommended)
Add a `state` parameter to your authorization link for CSRF protection. It should be an unguessable, server-generated, single-use random string that you validate on callback. See the [OpenID Connect documentation](https://developers.google.com/identity/protocols/oauth2/openid-connect#createxsrftoken) for an example of creating and confirming a `state`.
# Common questions
Token retrieval/refresh and understanding `user_type` are among the most frequent authorization support topics. Before contacting support, double-check:

* `grant_type` is exactly `authorized_code` (get) or `refresh_token` (refresh).
* Your `auth_code` is fresh (≤ 30 minutes old) and unused.
* You're using the correct authorization domain for your market and app type (see the table above).

For more help, see How to contact support.
# Enable API Scope
[IMG]
Before developing an app, the developer should enable or apply for the necessary API scope depending on the app's business type.
<span style="background-color: rgb(255, 245, 235)">📌 </span><span style="background-color: rgb(255, 245, 235)"><strong>Note</strong></span><span style="background-color: rgb(255, 245, 235)">: Enabling unnecessary scope(s) could result in a longer app review time and lower user authorization rate.</span>
