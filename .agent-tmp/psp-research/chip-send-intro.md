> ## Documentation Index
> Fetch the complete documentation index at: https://docs.chip-in.asia/llms.txt
> Use this file to discover all available pages before exploring further.

# Introduction

> How to authenticate and call the CHIP Send API.

# CHIP Send API

The CHIP Send API enables merchants to send funds programmatically via a REST API and to register recipient bank accounts for payouts.

All endpoints share a single base URL and a single authentication scheme. This page covers everything required to make a successful request.

## Endpoints

The base URL must match the merchant's environment:

| Environment | Base URL |
| - | - |
| Staging | `https://staging-api.chip-in.asia/api` |
| Production | `https://api.chip-in.asia/api` |

The operation path from the [API reference](#) (for example `/send/accounts` or `/send/send_instructions`) is appended to the base URL.

## Prerequisites

Before integration begins, a CHIP Send account must be created for the merchant by the CHIP admin team. To obtain credentials, the merchant's CHIP Account Manager must be contacted with the following information:

1. A primary email address.
2. The email addresses of every required approver. If two approvals are required, both email addresses must be provided.

## Credentials

Two pieces of information are issued to the merchant:

| Credential | Where it goes | What it does |
| - | - | - |
| **API Key** | `Authorization: Bearer <API Key>` header | Identifies the merchant's account. Sent on every request. |
| **API Secret** | Never sent over the network. Used only for signing. | Used to compute the per-request checksum. Must be stored securely, like a password. |

The API Key and the `api_key` value used inside the checksum string are the **same value**.

The API Secret is **never** transmitted in any request. It only ever lives on the merchant's server and is used to compute the checksum described below.

Both the API Key and the API Secret are available to the merchant in the [CHIP Control → Settings → Applications](https://portal.chip-in.asia/control/settings/applications) page of the merchant portal.

## How authentication works

Every request to the CHIP Send API must include three headers:

| Header | Value |
| - | - |
| `Authorization` | `Bearer <API Key>` |
| `epoch` | The current Unix timestamp in seconds (for example, `1689826456`) |
| `checksum` | Hex-encoded HMAC-SHA512 of the signing string, computed with the API Secret |

The `epoch` value must be within **30 seconds** of the server's clock. If it is too old or too far in the future, the request is rejected as `Unauthorized`. The merchant's server clock must therefore be synchronised (for example via NTP).

## How to compute the checksum

The signing string is formed by **concatenating the `epoch` value and the API Key with no separator, in that order**:

```
signing_string = <epoch> + <API Key>
```

For example, with `epoch = 1689826456` and `API Key = e0645c9e-fcf2-4f29-a327-202f7ed3d969`:

```
1689826456e0645c9e-fcf2-4f29-a327-202f7ed3d969
```

The checksum is then computed as:

```
checksum = HEX( HMAC_SHA512( key = API Secret, message = signing_string ) )
```

Given `API Secret = a118729e-4243-4145-83b3-0b8cb213fe8e`, the checksum for the example signing string above is:

```
45bee62dba8087ab1e7e767d92f8d6e26f8bd19ee5fd2fef6386bb9425976498a86ffdbddb7a49919998e993c20626196ea652320f438a9528d2b8c9d19ec266
```

This expected value can be used to verify the implementation before any real request is sent.

## A complete request

The following `curl` example computes the epoch and checksum, then sends a request end-to-end:

```bash theme={null}
# 1. Compute the epoch and checksum (must be recomputed for every request)
EPOCH=$(date +%s)
API_KEY="e0645c9e-fcf2-4f29-a327-202f7ed3d969"
API_SECRET="a118729e-4243-4145-83b3-0b8cb213fe8e"
CHECKSUM=$(printf '%s%s' "$EPOCH" "$API_KEY" | openssl dgst -sha512 -hmac "$API_SECRET" -hex | sed 's/^.*= //')

# 2. Send the request
curl -X POST "https://staging-api.chip-in.asia/api/send/bank_accounts" \
  -H "Authorization: Bearer $API_KEY" \
  -H "epoch: $EPOCH" \
  -H "checksum: $CHECKSUM" \
  -H "Content-Type: application/json" \
  -d '{
    "account_number": "157380112229",
    "bank_code": "MBBEMYKL",
    "name": "Ahmad Razali",
    "reference": "VENDOR-EMP-001"
  }'
```

A `200 OK` response confirms that authentication is working correctly. For other responses, see [Troubleshooting](#troubleshooting) below.

## Language examples

The same computation in four common languages:

```javascript Node.js theme={null}
const crypto = require('crypto');

const epoch = Math.floor(Date.now() / 1000).toString();
const apiKey = process.env.CHIP_API_KEY;
const apiSecret = process.env.CHIP_API_SECRET;

const signingString = epoch + apiKey;
const checksum = crypto
  .createHmac('sha512', apiSecret)
  .update(signingString)
  .digest('hex');

// Then send the request with headers:
//   Authorization: Bearer <apiKey>
//   epoch: <epoch>
//   checksum: <checksum>
```

```ruby Ruby theme={null}
require 'openssl'

epoch = Time.now.to_i.to_s
api_key = ENV['CHIP_API_KEY']
api_secret = ENV['CHIP_API_SECRET']

signing_string = "#{epoch}#{api_key}"
checksum = OpenSSL::HMAC.hexdigest('SHA512', api_secret, signing_string)

# Then send the request with headers:
#   Authorization: Bearer <api_key>
#   epoch: <epoch>
#   checksum: <checksum>
```

```python Python theme={null}
import hashlib, hmac, time

epoch = str(int(time.time()))
api_key = "YOUR_API_KEY"
api_secret = "YOUR_API_SECRET"

signing_string = (epoch + api_key).encode()
checksum = hmac.new(api_secret.encode(), signing_string, hashlib.sha512).hexdigest()

# Then send the request with headers:
#   Authorization: Bearer <api_key>
#   epoch: <epoch>
#   checksum: <checksum>
```

```php PHP theme={null}
<?php
$epoch = (string) time();
$apiKey = getenv('CHIP_API_KEY');
$apiSecret = getenv('CHIP_API_SECRET');

$signingString = $epoch . $apiKey;
$checksum = hash_hmac('sha512', $signingString, $apiSecret);

// Then send the request with headers:
//   Authorization: Bearer <apiKey>
//   epoch: <epoch>
//   checksum: <checksum>
```

## Troubleshooting

| Symptom | Most likely cause |
| - | - |
| `401 Unauthorized` with no further detail | The `epoch` value is more than 30 seconds off the server clock, or the merchant's server clock is incorrect. NTP synchronisation should be verified. |
| `401 Unauthorized` with a checksum-related error | The signing string is wrong. The following should be verified: (a) it is `<epoch> + <apiKey>` with **no separator**, (b) the message is the *string* (not a JSON object), (c) the output is **hex-encoded** (not base64), (d) SHA-512 is used (not SHA-256). |
| `401 Unauthorized` with an `Authorization`-related error | The `Authorization: Bearer <API Key>` header is missing, malformed, or the API Key is invalid. |
| `400 Bad Request` on a syntactically valid payload | The `epoch` or `checksum` header is missing, or one of the values contains an unexpected character. |
| A request works in Postman but fails from the merchant's code | The checksum is being computed once and reused across requests. The checksum must be **recomputed for every request** with a fresh `epoch`. |
| `429 Too Many Requests` | The API key has exceeded a [rate limit](https://docs.chip-in.asia/chip-send/api-reference/rate-limits.md). Wait the number of seconds in the `Retry-After` header, then retry. |

## Rate limits

Authenticated requests under `/api/send` are limited per API key, in
5-minute windows. The limits, the `429` body, and the `Retry-After`
and `X-RateLimit-*` headers are described in
[Rate limits](https://docs.chip-in.asia/chip-send/api-reference/rate-limits.md).

## Basic integration flow

A complete payout consists of four steps:

1. The [Accounts API](https://docs.chip-in.asia/chip-send/api-reference/accounts/list.md) is called to check the convertible balance.
2. The [Increase Send Limit API](https://docs.chip-in.asia/chip-send/api-reference/send-limits/create.md) is called to allocate balance for payouts.
3. The [Add Bank Account API](https://docs.chip-in.asia/chip-send/api-reference/bank-accounts/create.md) is called to register a recipient.
4. The [Create Send Instruction API](https://docs.chip-in.asia/chip-send/api-reference/send-instructions/create.md) is called to send funds.

A walkthrough is provided in [Test Integration](https://docs.chip-in.asia/chip-send/api-reference/test-integration.md).

## Approving CHIP Send Budget Allocation requests

Every approver receives an email when a budget-allocation request requires approval. Approval is performed by clicking the **Approve** button in the email. Once all required approvers have approved, the new balance is reflected in the [Accounts API](https://docs.chip-in.asia/chip-send/api-reference/accounts/list.md) response.

The token used in the `Authorization` header is the **API Key** mentioned in the Credentials section above.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.