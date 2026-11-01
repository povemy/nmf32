> ## Documentation Index
> Fetch the complete documentation index at: https://docs.chip-in.asia/llms.txt
> Use this file to discover all available pages before exploring further.

# Webhook signatures

> Verify the authenticity of CHIP Collect webhook and success callback deliveries.

Payloads are signed using asymmetric (public-key) cryptography to guarantee
the authenticity of delivered callbacks. Each callback delivery request
includes an `X-Signature` header field. This field contains a base64-encoded
RSA PKCS#1 v1.5 signature of the SHA-256 digest of the request body buffer.

You can obtain the public key for Webhook authentication from
`Webhook.public_key` of the corresponding Webhook.

You can obtain the public key for success callback authentication from
[GET /public\_key/](https://docs.chip-in.asia/chip-collect/api-reference/public-key/retrieve.md).

> [!WARNING]
>
> `GET /public_key/` returns the PEM as a **JSON-encoded string** — the
> response body is `"-----BEGIN PUBLIC KEY-----..."` (with surrounding
> quotes), not a bare PEM body and not a `{"key": ...}` object. You must
> `json_decode` the response body before passing it to your crypto
> library. Passing the raw body (quotes included) to `openssl_verify` /
> `crypto.createVerify` fails with "Supplied key param cannot be coerced
> into a public key".

Please note that CHIP is not responsible for any financial losses incurred
as a result of failing to implement payload signature verification.

## How to verify

The verification process is:

1. Read the **raw request body** (before JSON parsing). The signature is
   computed over the bytes as received.
2. Decode the `X-Signature` header from base64.
3. Verify it against the request body using the public key with RSA
   PKCS#1 v1.5 padding and a SHA-256 digest.
4. Reject the request if verification fails.

> [!WARNING]
>
> Always verify the raw request body. Re-serializing the parsed JSON will
> change byte ordering or whitespace and break the signature.

## Fetching the public key

`GET /public_key/` returns a JSON-encoded PEM string. Decode it before use:

```bash theme={null}
# Raw response (note the surrounding quotes):
curl -H "Authorization: Bearer <secret_key>" \
  "https://gate.chip-in.asia/api/v1/public_key/"
# => "-----BEGIN PUBLIC KEY-----\nMIIBojAN...\n-----END PUBLIC KEY-----\n"
```

```javascript theme={null}
const res = await fetch('https://gate.chip-in.asia/api/v1/public_key/', {
  headers: { Authorization: 'Bearer ' + secretKey }
});
const publicKeyPem = await res.json(); // JSON string -> PEM, quotes stripped
```

```php theme={null}
$response = file_get_contents('https://gate.chip-in.asia/api/v1/public_key/', false, $context);
$publicKeyPem = json_decode($response); // JSON string -> PEM
```

```python theme={null}
import json, urllib.request

req = urllib.request.Request(
    'https://gate.chip-in.asia/api/v1/public_key/',
    headers={'Authorization': 'Bearer ' + secret_key},
)
public_key_pem = json.loads(urllib.request.urlopen(req).read())
```

## Example (Node.js)

```javascript theme={null}
const crypto = require('crypto');
const express = require('express');

const app = express();

// IMPORTANT: capture the raw body before any JSON parsing
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

app.post('/webhook', async (req, res) => {
  const signature = req.header('X-Signature'); // base64-encoded
  const publicKeyPem = await getPublicKeyForThisWebhook();

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(req.rawBody);
  verifier.end();

  const ok = verifier.verify(publicKeyPem, signature, 'base64');
  if (!ok) {
    return res.status(401).send('Invalid signature');
  }

  // Signature valid — process the event
  console.log('Verified event:', req.body);
  res.status(200).end();
});
```

## Example (PHP)

```php theme={null}
$signature = base64_decode($_SERVER['HTTP_X_SIGNATURE']);
$rawBody   = file_get_contents('php://input');

$publicKeyPem = getPublicKeyForThisWebhook(); // PEM-encoded

$ok = openssl_verify($rawBody, $signature, $publicKeyPem, OPENSSL_ALGO_SHA256);
if ($ok !== 1) {
    http_response_code(401);
    exit('Invalid signature');
}

// Signature valid — process the event
```

## Example (Python)

```python theme={null}
import base64
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

def verify(raw_body: bytes, signature_b64: str, public_key_pem: str) -> bool:
    public_key = serialization.load_pem_public_key(public_key_pem.encode())
    signature = base64.b64decode(signature_b64)
    try:
        public_key.verify(
            signature,
            raw_body,
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
        return True
    except Exception:
        return False
```


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.