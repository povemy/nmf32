> ## Documentation Index
> Fetch the complete documentation index at: https://docs.chip-in.asia/llms.txt
> Use this file to discover all available pages before exploring further.

# CHIP Send overview

> Programmatically pay out funds via the CHIP Send API.

CHIP Send is CHIP's **payouts** product. It lets a registered merchant
move funds from a CHIP Send account to recipient bank accounts via a
REST API, with built-in approval workflows and per-recipient bank account
registration.

It is a **separate product** from [CHIP Collect](https://docs.chip-in.asia/chip-collect/overview/introduction.md):

| | CHIP Collect | CHIP Send |
| - | - | - |
| Purpose | Accept payments from buyers | Pay out funds to recipients |
| Base URL | `https://gate.chip-in.asia/api/v1` | `https://api.chip-in.asia/api` |
| Sandbox base URL | (same — test mode uses test keys) | `https://staging-api.chip-in.asia/api` |
| Authentication | `Authorization: Bearer <secret>` | Bearer + `epoch` + HMAC-SHA512 `checksum` |
| Path convention | Plural with trailing slash | `snake_case` under `/send/...` |

## Typical payout flow

A complete payout consists of four steps:

1. Call the [Accounts API](https://docs.chip-in.asia/chip-send/api-reference/accounts/list.md) to check
   the convertible balance.
2. Call the
   [Increase Send Limit API](https://docs.chip-in.asia/chip-send/api-reference/send-limits/create.md)
   to allocate balance for payouts.
3. Call the
   [Add Bank Account API](https://docs.chip-in.asia/chip-send/api-reference/bank-accounts/create.md)
   to register a recipient.
4. Call the
   [Create Send Instruction API](https://docs.chip-in.asia/chip-send/api-reference/send-instructions/create.md)
   to send funds.

A walkthrough is provided in
[Test Integration](https://docs.chip-in.asia/chip-send/api-reference/test-integration.md).

## Prerequisites

Before integration begins, a CHIP Send account must be created for the
merchant by the CHIP admin team. The merchant's CHIP Account Manager
must be contacted with:

1. A primary email address.
2. The email addresses of every required approver. If two approvals are
   required, both email addresses must be provided.

## Authentication in one line

Every request needs three headers:

```
Authorization: Bearer <api_key>
epoch:         <unix_seconds>
checksum:      HEX( HMAC_SHA512(key=api_secret, msg=epoch + api_key) )
```

Full algorithm, code samples in Node, Ruby, Python, and PHP, and a
troubleshooting table are in the
[CHIP Send introduction](https://docs.chip-in.asia/chip-send/api-reference/introduction.md).

Calls under `/api/send` are
[rate limited per API key](https://docs.chip-in.asia/chip-send/api-reference/rate-limits.md).


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.