> ## Documentation Index
> Fetch the complete documentation index at: https://docs.chip-in.asia/llms.txt
> Use this file to discover all available pages before exploring further.

# Delivery protocol

> How CHIP Collect delivers callbacks and webhooks, and how failed deliveries are retried.

CHIP Collect sends two kinds of asynchronous notification to your server — `Purchase` success callbacks and `Webhook` callbacks (see [Callbacks](https://docs.chip-in.asia/chip-collect/overview/callbacks.md)). Both follow the same delivery and retry rules described on this page.

## What counts as a failed delivery

A delivery attempt succeeds only when your server responds with an HTTP `2xx` status code. The attempt is treated as failed when:

* your server responds with a non-`2xx` status code (eg. `403`, `404`, `500`);
* the connection could not be established (DNS failure, TLS error, connection refused);
* no response was received in time.

A failed attempt is retried automatically with the same payload and event. Every attempt, including a retry, must be verified with the `X-Signature` header exactly as described in [Webhook signatures](https://docs.chip-in.asia/chip-collect/overview/webhook-signatures.md) — verification is per request, not per event.

## Retry schedule

Retries follow an exponential schedule with base 3. The delay before an attempt is

```
3 ^ (attempt - 1) - 1   minutes
```

where attempt `1` is the initial delivery. Delays are counted from the moment the callback was **first scheduled**, not from the previous attempt, so a slow or hanging attempt does not push the following attempts back.

| Attempt | Delay after first scheduling | Clock time, if the first attempt is at `00:41:52` |
| - | - | - |
| 1 | 0 (immediate) | `00:41:52` |
| 2 | 2 minutes | `00:43:52` |
| 3 | 8 minutes | `00:49:52` |
| 4 | 26 minutes | `01:07:52` |
| 5 | 1 hour 20 minutes | `02:01:52` |
| 6 | 4 hours 2 minutes | `04:43:52` |
| 7 | 12 hours 8 minutes | `12:49:52` |
| 8 | 36 hours 26 minutes | next day, `13:07:52` |

Delivery stops after the 8th attempt — 36 hours 26 minutes after the first one. The callback is not re-sent beyond that point, so a late recovery on your side does not receive the missed events. Reconcile against the API instead of waiting: [GET /purchases/\{id}/](https://docs.chip-in.asia/chip-collect/api-reference/purchases/retrieve.md) always returns the current state of the `Purchase`.

> [!NOTE]
>
> A retry can occasionally arrive more than once, or arrive after a previous attempt was in fact received. This is unavoidable with asynchronous network requests — see [Duplicate deliveries](#duplicate-deliveries).

## Duplicate deliveries

Due to the asynchronous nature of network requests, it is possible for a delivery confirmation (an HTTP response with a `200` series status code) to not properly arrive from your callback's target server. In that case your server can receive a callback, respond to it with a `200` series status code — for example on the first attempt — and then receive the same callback again on a later attempt.

Callbacks are therefore **at least once**, not exactly once. Handle a callback idempotently: key your processing on the payload's `id` (the `Purchase` id) together with `event_type`, and treat a repeat of the same pair as already processed rather than as a new event.

## Ordering

Callback deliveries are guaranteed to be sequential to events triggered on their source objects. For example, when registering webhooks for both the `purchase.created` and `purchase.paid` events, there will be no `purchase.paid` callbacks for this `Purchase` until all `purchase.created` callbacks for this `Purchase` are successfully delivered. A purchase that is stuck on a failing `purchase.created` callback therefore also delays the later events of that same purchase — for up to the 8 attempts described above.

## Related

* [Callbacks](https://docs.chip-in.asia/chip-collect/overview/callbacks.md) — how to register `success_callback` and `Webhook` callbacks
* [Webhook signatures](https://docs.chip-in.asia/chip-collect/overview/webhook-signatures.md) — verifying the `X-Signature` header
* [Webhooks API reference](https://docs.chip-in.asia/chip-collect/api-reference/webhooks/create.md) — creating and managing webhooks


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.