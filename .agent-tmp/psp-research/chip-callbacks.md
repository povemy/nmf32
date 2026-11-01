> ## Documentation Index
> Fetch the complete documentation index at: https://docs.chip-in.asia/llms.txt
> Use this file to discover all available pages before exploring further.

# Callbacks

Two methods for defining asynchronous callbacks are supported - `Purchase` success callbacks and webhooks.

## Purchase success callbacks

`Purchase` success callbacks are defined by providing a target URL in the `success_callback` field on `Purchase` creation (see [POST /purchases/](https://docs.chip-in.asia/chip-collect/api-reference/purchases/create.md)). The system will generate a callback when:

* a `Purchase` with `skip_capture=false` is successfully paid
* a `Purchase` with `skip_capture=true` is successfully captured (see [POST /purchases/\{id}/capture/](https://docs.chip-in.asia/chip-collect/api-reference/purchases/capture.md))
* a `Purchase` is successfully paid using a recurring token (see [POST /purchases/\{id}/charge/](https://docs.chip-in.asia/chip-collect/api-reference/purchases/charge.md))

The `success_callback` URL must not contain an explicit port. Only the scheme's default port is usable — `http` on 80 and `https` on 443 — and a URL that spells the port out is rejected with `webhooks_callback_port`, **including `:80` and `:443`, which name the default port**. Only the `http` and `https` schemes are accepted; any other scheme is rejected with `webhooks_callback_scheme`.

> [!WARNING]
>
> This restriction applies to `success_callback` (and to `Webhook.callback`) only. The redirect fields — `success_redirect`, `failure_redirect`, `cancel_redirect` — are **not** subject to it and do accept a custom port, so a development host serving on e.g. `http://host:8899` can be used as a redirect target but not as a callback target.

All four fields — `success_callback` and the three redirects — are read from the **top level** of the `POST /purchases/` request body, alongside `brand_id` and `client_id`, not from inside `purchase`. A callback or redirect placed inside `purchase` is ignored silently: the request still succeeds, the value is not stored, and no callback is delivered.

These callbacks pass a JSON-encoded `Purchase` as their payload. The payload represents a snapshot of the state of the `Purchase` when the event was created. The payload will include an `event_type` field to indicate which specific event (see [Event schema](https://docs.chip-in.asia/chip-collect/api-reference/webhooks/create.md)) triggered the callback.

The payload is signed using a company-wide key pair. You can obtain the public key with `GET /public_key/`. See the `Authentication` section below for more details.

## Webhooks

For creating and modifying webhooks, see the Webhook [CRUD API specification](https://docs.chip-in.asia/chip-collect/api-reference/webhooks/create.md).

The same URL rules apply to a webhook's `callback` field as to `success_callback`: no explicit port (only the scheme's default 80 / 443, with `:80` and `:443` spelled out also rejected as `webhooks_callback_port`), and only the `http` and `https` schemes (`webhooks_callback_scheme`).

`Webhook` callback payloads are signed using a dedicated key pair. You can obtain the public key from `Webhook.public_key`. See the [Authentication](https://docs.chip-in.asia/chip-collect/overview/authentication.md) section below for more details.

## Delivery protocol

A callback delivery succeeds only when the target server responds with a `200` series HTTP response code. Failed deliveries are retried automatically: up to 8 attempts, scheduled at `3 ^ (attempt - 1) - 1` minutes **from the moment the callback was first scheduled** (not from the previous attempt), with the 8th and last attempt 36 hours 26 minutes after the first. Because of the asynchronous nature of network requests a callback can still be delivered more than once, so processing must be idempotent.

The full schedule, the exact failure conditions, duplicate handling and the ordering guarantee between events of the same object are described in [Delivery protocol](https://docs.chip-in.asia/chip-collect/overview/delivery-protocol.md).


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.