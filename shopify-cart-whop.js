/**
 * Shopify-Whop Checkout Interceptor Script
 * Intercepts default checkout events and redirects the user to Whop checkout.
 * 
 * Auto-detects:
 * - Checkout buttons matching common selectors (and Shrine theme selectors).
 * - Standard Shopify cart form submissions.
 * - Redirects to your Vercel instance `/api/create-checkout`.
 */
(function () {
    // CONFIGURATION: Replace with your Vercel API Domain
    const API_ENDPOINT = 'https://corvea.vercel.app/api/create-checkout';

    // Selectors for checkout buttons in Shrine Theme & Shopify standard carts
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
        console.log('[Whop Integration] Interceptor Initialized.');

        // Intercept clicks on any checkout buttons
        document.addEventListener('click', function (event) {
            if (isRedirecting) {
                event.preventDefault();
                return;
            }

            const element = event.target.closest(CHECKOUT_SELECTORS.join(','));
            if (element) {
                console.log('[Whop Integration] Intercepted checkout click.');
                event.preventDefault();
                event.stopPropagation();
                triggerWhopCheckout(element);
            }
        }, true);

        // Intercept checkout form submits
        document.addEventListener('submit', function (event) {
            if (isRedirecting) {
                event.preventDefault();
                return;
            }

            const form = event.target;
            const isCartSubmit = form.action && (form.action.includes('/cart') || form.action.includes('/checkout'));

            // Check if button clicked was checkout or if form is submitting cart checkout
            if (isCartSubmit) {
                const submitter = event.submitter;
                if (submitter && submitter.name === 'checkout') {
                    console.log('[Whop Integration] Intercepted checkout form submit.');
                    event.preventDefault();
                    triggerWhopCheckout(submitter);
                }
            }
        }, true);
    }

    async function triggerWhopCheckout(buttonElement) {
        isRedirecting = true;

        // Visual indicator of progress (Premium Design Feeling)
        const originalText = buttonElement.innerText || buttonElement.value || 'Checkout';
        setLoadingState(buttonElement, true, originalText);

        try {
            // 1. Fetch current Shopify cart contents
            const cartResponse = await fetch('/cart.js');
            if (!cartResponse.ok) {
                throw new Error('Failed to retrieve cart details from Shopify.');
            }
            const cart = await cartResponse.json();

            if (!cart.items || cart.items.length === 0) {
                alert('Your cart is empty. Please add items to your cart before checking out.');
                setLoadingState(buttonElement, false, originalText);
                isRedirecting = false;
                return;
            }

            // Collect customer email if logged in in Shopify
            let customerEmail = null;
            if (window.Shopify && window.Shopify.customerEmail) {
                customerEmail = window.Shopify.customerEmail;
            }

            // Preserve current site host (for return redirects)
            cart.host = window.location.host;

            // 2. Call our backend Express wrapper to generate the checkout session url
            const checkoutResponse = await fetch(API_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    cart: cart,
                    customer_email: customerEmail
                })
            });

            if (!checkoutResponse.ok) {
                const errPayload = await checkoutResponse.json();
                throw new Error(errPayload.error || 'Failed to construct Whop payment session.');
            }

            const session = await checkoutResponse.json();

            if (session.purchase_url) {
                console.log('[Whop Integration] Redirecting to Whop payment gateway URL:', session.purchase_url);
                window.location.href = session.purchase_url;
            } else {
                throw new Error('No purchase_url returned from API.');
            }

        } catch (error) {
            console.error('[Whop Integration] Integration Error:', error.message);

            // Fallback: Notify customer & log, but allow proceeding to standard checkout if critical
            alert('We are experiencing payment gateway connections. Redirecting you to checkout...');
            isRedirecting = false;
            setLoadingState(buttonElement, false, originalText);

            // Default to Shopify checkout if api fails
            window.location.href = '/checkout';
        }
    }

    function setLoadingState(element, isLoading, originalText) {
        if (isLoading) {
            if (element.tagName === 'INPUT') {
                element.value = 'Preparing Secure Checkout...';
            } else {
                element.innerText = 'Preparing Secure Checkout...';
            }
            element.style.opacity = '0.69';
            element.style.cursor = 'not-allowed';
        } else {
            if (element.tagName === 'INPUT') {
                element.value = originalText;
            } else {
                element.innerText = originalText;
            }
            element.style.opacity = '1';
            element.style.cursor = 'pointer';
        }
    }

    // Ensure DOM is ready to bind
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initInterceptor);
    } else {
        initInterceptor();
    }
})();
