> ## Documentation Index
> Fetch the complete documentation index at: https://docs.chip-in.asia/llms.txt
> Use this file to discover all available pages before exploring further.

# What We Offer

> Easily access these features using simple API parameters.

### [Purchase Notifications](https://docs.chip-in.asia/chip-collect/api-reference/purchases/create.md#body-success-callback)

Receive real-time notifications via system callback or email when a transaction is successfully completed.

### [Send Receipts to Customers](https://docs.chip-in.asia/chip-collect/api-reference/purchases/create.md#body-send-receipt)

Automatically send a standardized receipt to your customers on your behalf.

### [Redirect Customer After Purchase](https://docs.chip-in.asia/chip-collect/api-reference/purchases/create.md#body-success-redirect)

Automatically redirect customers to a designated webpage based on the outcome of the transaction—success, failure, or cancellation.

### [Secure Customer Card Information](https://docs.chip-in.asia/chip-collect/api-reference/purchases/create.md#body-skip-capture)

Tokenize and securely store your customers’ card details for future purchases or subscriptions by setting the parameter `skip_capture: true` and `price: 0`

### [Pre-Authorize Payment](https://docs.chip-in.asia/chip-collect/api-reference/purchases/create.md#body-skip-capture)

Withhold the amount in the customer's account to be captured or released later by setting the parameter `skip_capture: true` and `price` to a value greater than 0.

### [Free Form API Field](https://docs.chip-in.asia/chip-collect/api-reference/purchases/create.md#body-reference)

Lets you store any custom value, such as an invoice number or other reference data, for your business needs.

### [Payment Method Whitelist](https://docs.chip-in.asia/chip-collect/api-reference/purchases/create.md#body-payment-method-whitelist)

Enable or disable specific payment methods to suit your business needs.

Payment methods available:

* FPX Online Banking
* Local credit and debit cards
* Foreign credit and debit cards
* E-wallets
* DuitNow QR (Online)
* Buy Now, Pay Later
* Crypto Coin
* On-Premise POS Terminal


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.