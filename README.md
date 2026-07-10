# Shopify-Whop Checkout Integration

This middleware allows you to replace or bypass the default Shopify checkout. Customers will check out through Whop while Shopify remains the storefront, product source, cart source, and inventory/order system.

## Setup Requirements

### 1. Environment Variables (`.env`)
Create a `.env` file in the root of your project (or set these inside your Vercel Dashboard env configuration):

```env
# Whop API Config
WHOP_API_KEY=apik_your_whop_key # Provided in Whop Developer Settings
WHOP_WEBHOOK_SECRET=whsec_your_webhook_secret # Provided when setting up webhook in Whop

# Shopify Admin API Config
SHOPIFY_STORE=corvea.myshopify.com # Your .myshopify.com domain
SHOPIFY_CLIENT_ID=your_shopify_client_id # Shopify App Client ID from dev dashboard
SHOPIFY_CLIENT_SECRET=your_shopify_client_secret # Shopify App Client Secret from dev dashboard
SHOPIFY_ADMIN_API_TOKEN=shpat_your_legacy_admin_token # Optional fallback: legacy direct token
SHOPIFY_API_VERSION=2026-07

# Membership Configuration Details
MEMBERSHIP_PRODUCT_ID=corvea-beauty-journal # Shopify product handle for the membership subscription
MEMBERSHIP_CHECKOUT_LINK=https://whop.com/checkout/plan_TZycBpe6PAHCk # Default Whop checkout link for membership
```

---

## Technical Architecture & Cart Strategy
Whop is natively designed for single-product digital checkout configurations (one plan per session). To support checking out multiple Shopify products at once in a single checkout session, the middleware utilizes **on-the-fly pricing configurations**:
1. When a checkout is initiated, the frontend sends the cart object `/cart.js` contents to `/api/create-checkout`.
2. The server iterates over the cart items. It checks if the **Corvea Beauty Journal Membership** is in the cart.
3. Pricing calculations:
   - **One-time only carts:** A checkout configuration is created with `plan_type: "one_time"` and `initial_price` equal to the total of the cart items.
   - **Membership-only carts:** A checkout configuration is created with `plan_type: "renewal"`, `initial_price: 0.00`, `renewal_price: 39.99` representing the A$39.99/mo ongoing rate starting after a `30-day` free trial.
   - **Mixed carts (Membership + One-time):** A checkout configuration is created with `plan_type: "renewal"`, `initial_price` equal to the total of the one-time items (charged immediately), and `renewal_price: 39.99` representing the membership subscription with a `30-day` free trial.
4. The exact Shopify line items (Variant IDs, quantities, handles) are serialized and attached to the checkout configuration's **`metadata`**.
5. When Whop receives payment and sends a `payment.succeeded` or `membership.activated` webhook:
   - The payload signature is computed and verified against `WHOP_WEBHOOK_SECRET` using Standard Webhooks HMAC-SHA256.
   - The metadata is parsed.
   - An idempotency checks verifies Shopify order details to prevent duplicates.
   - A paid Shopify order is created via the Admin REST API, which automatically syncs inventories.

---

## 2. Vercel Deployment Steps

1. Install the Vercel CLI:
   ```bash
   npm install -g vercel
   ```
2. Run log in and deploy:
   ```bash
   vercel login
   } vercel
   ```
3. Set your production environment secrets on Vercel:
   ```bash
   vercel env add WHOP_API_KEY
   vercel env add WHOP_WEBHOOK_SECRET
   vercel env add SHOPIFY_STORE
   vercel env add SHOPIFY_CLIENT_ID
   vercel env add SHOPIFY_CLIENT_SECRET
   vercel env add SHOPIFY_ADMIN_API_TOKEN
   vercel env add SHOPIFY_API_VERSION
   vercel env add MEMBERSHIP_PRODUCT_ID
   vercel env add MEMBERSHIP_CHECKOUT_LINK
   ```
4. Deploy to production:
   ```bash
   vercel --prod
   ```

---

## 3. Whop Webhook Setup Steps

1. In your **Whop Dashboard**, navigate to **Developer Settings** > **Webhooks**.
2. Click **Create Webhook**.
3. Set the endpoint URL to: `https://your-vercel-server-project.vercel.app/api/whop-webhook`.
4. Click select events and listen to:
   - `payment.succeeded`
   - `membership.activated`
5. Copy the generated Webhook Secret (starts with `whsec_...`) and save it to your server's `WHOP_WEBHOOK_SECRET` environment variable.

---

## 4. Shopify Theme Integration (Shrine Theme)

To redirect customers from the checkout buttons of your Shopify store to Whop, follow these steps to install the client-side script in your **Shrine** theme:

1. In your Shopify Admin, go to **Online Store** > **Themes**.
2. Locate your **Shrine** theme, click the three dots (`...`), and select **Edit code**.
3. Locate layout/theme.liquid (for global site coverage) or sections/main-cart.liquid (specifically for the cart page).
4. Scroll to the bottom of the file (before the closing `</body>` tag) and paste the following snippet:

```html
<!-- Whop Checkout Interceptor Script -->
<script>
(function() {
  // Replace this with your production Vercel URL
  const API_ENDPOINT = 'https://your-vercel-project.vercel.app/api/create-checkout';

  const CHECKOUT_SELECTORS = [
    'button[name="checkout"]',
    'input[name="checkout"]',
    'a[href="/checkout"]',
    '.cart__checkout-button',
    '.checkout-btn',
    '.checkout-button',
    '.cart-drawer__checkout'
  ];

  let isRedirecting = false;

  function initInterceptor() {
    document.addEventListener('click', function(event) {
      if (isRedirecting) {
        event.preventDefault();
        return;
      }
      const element = event.target.closest(CHECKOUT_SELECTORS.join(','));
      if (element) {
        event.preventDefault();
        event.stopPropagation();
        triggerWhopCheckout(element);
      }
    }, true);

    document.addEventListener('submit', function(event) {
      if (isRedirecting) {
        event.preventDefault();
        return;
      }
      const form = event.target;
      const isCartSubmit = form.action && (form.action.includes('/cart') || form.action.includes('/checkout'));
      if (isCartSubmit) {
        const submitter = event.submitter;
        if (submitter && submitter.name === 'checkout') {
          event.preventDefault();
          triggerWhopCheckout(submitter);
        }
      }
    }, true);
  }

  async function triggerWhopCheckout(buttonElement) {
    isRedirecting = true;
    const originalText = buttonElement.innerText || buttonElement.value || 'Checkout';
    setLoadingState(buttonElement, true, originalText);

    try {
      const cartResponse = await fetch('/cart.js');
      if (!cartResponse.ok) throw new Error('Failed to retrieve cart details.');
      const cart = await cartResponse.json();

      if (!cart.items || cart.items.length === 0) {
        alert('Your cart is empty.');
        setLoadingState(buttonElement, false, originalText);
        isRedirecting = false;
        return;
      }

      let customerEmail = null;
      if (window.Shopify && window.Shopify.customerEmail) {
        customerEmail = window.Shopify.customerEmail;
      }

      cart.host = window.location.host;

      const checkoutResponse = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cart: cart, customer_email: customerEmail })
      });

      if (!checkoutResponse.ok) {
        const errPayload = await checkoutResponse.json();
        throw new Error(errPayload.error || 'Failed to construct Whop payment session.');
      }

      const session = await checkoutResponse.json();
      if (session.purchase_url) {
        window.location.href = session.purchase_url;
      } else {
        throw new Error('No purchase_url returned from API.');
      }
    } catch (error) {
      console.error('[Whop Integration] Error:', error.message);
      alert('We are experiencing payment gateway connections. Redirecting you to checkout...');
      isRedirecting = false;
      setLoadingState(buttonElement, false, originalText);
      window.location.href = '/checkout';
    }
  }

  function setLoadingState(element, isLoading, originalText) {
    if (isLoading) {
      if (element.tagName === 'INPUT') element.value = 'Preparing Secure Checkout...';
      else element.innerText = 'Preparing Secure Checkout...';
      element.style.opacity = '0.69';
      element.style.cursor = 'not-allowed';
    } else {
      if (element.tagName === 'INPUT') element.value = originalText;
      else element.innerText = originalText;
      element.style.opacity = '1';
      element.style.cursor = 'pointer';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initInterceptor);
  } else {
    initInterceptor();
  }
})();
</script>
```

5. Click **Save** in the top right.

---

## 5. Local Mock Testing
Execute script:
```bash
node test-run.js
```
This runs the integration test suite, demonstrating:
- Cart checkouts calculations and Whop checkout config url creation.
- Webhook HMAC SHA-256 validation.
- Subscriptions/Trial calculations setup.
- Paid order creation outputs.
