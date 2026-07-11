const axios = require('axios');
const whopConfig = require('../config/whop');
const productMappings = require('../config/product-mappings.json');

let cachedCompanyId = process.env.WHOP_COMPANY_ID || null;

/**
 * Strips headers / API keys from raw Axios errors to ensure secrets are never leaked in logs.
 * @param {Error} error 
 * @returns {Object}
 */
function sanitizeAxiosError(error) {
    if (!error) return { message: 'Unknown error occurred.' };

    const sanitized = {
        message: error.message,
        name: error.name
    };

    if (error.response) {
        sanitized.status = error.response.status;
        sanitized.data = error.response.data;
    }

    return sanitized;
}

/**
 * Gets the company ID dynamically from Whop API if not cached.
 * Utilizes a secure, triple-fallback resolution mechanism:
 * 1. Checks if WHOP_COMPANY_ID is configured in the environment values.
 * 2. Fetches GET /plans/{plan_id} from mappings to resolve the company.
 * 3. Queries GET /companies API (outputs sanitized logs on failure).
 */
async function getCompanyId() {
    // 1. Primary: Direct Environment variable check
    if (process.env.WHOP_COMPANY_ID) {
        cachedCompanyId = process.env.WHOP_COMPANY_ID;
        return cachedCompanyId;
    }

    if (cachedCompanyId) return cachedCompanyId;

    // 2. Secondary: Extract from mapped products (find the first valid plans defined in mapping JSON file)
    let planIds = [];
    try {
        if (Array.isArray(productMappings)) {
            planIds = productMappings
                .map(m => m.whop_plan_id)
                .filter(id => id && typeof id === 'string' && id.startsWith('plan_'));
        }
    } catch (err) {
        console.error('Failed to parse plan IDs from product mappings:', err.message);
    }

    // Default static fallback plan ID just in case
    if (!planIds.includes('plan_Pj1GzRRMdZzJ9')) {
        planIds.push('plan_Pj1GzRRMdZzJ9');
    }

    console.log(`[Company Resolution] Attempting extraction using mapped plans:`, planIds);

    for (const planId of planIds) {
        try {
            console.log(`[Company Resolution] Requesting plan details: GET /plans/${planId}...`);
            const response = await axios.get(`${whopConfig.apiUrl}/plans/${planId}`, {
                headers: {
                    Authorization: `Bearer ${whopConfig.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            const planData = response.data;
            const extracted = planData?.company_id || planData?.company?.id || planData?.data?.company_id || planData?.data?.company?.id;

            if (extracted) {
                cachedCompanyId = extracted;
                console.log(`[Company Resolution] Permanently resolved Whop Company ID: ${cachedCompanyId}`);
                return cachedCompanyId;
            }
        } catch (error) {
            const sanitized = sanitizeAxiosError(error);
            console.warn(`[Whop API Warning] GET /plans/${planId} failed - Status: ${sanitized.status || 'N/A'}, Message: ${sanitized.message}`);
        }
    }

    // 3. Fallback: List companies endpoint query
    try {
        console.log('[Company Resolution] Falling back to list companies endpoint: GET /companies...');
        const response = await axios.get(`${whopConfig.apiUrl}/companies`, {
            headers: {
                Authorization: `Bearer ${whopConfig.apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        const companies = response.data?.data || response.data || [];
        if (companies.length > 0) {
            cachedCompanyId = companies[0].id;
            console.log(`[Company Resolution] Resolved company ID via /companies: ${cachedCompanyId}`);
            return cachedCompanyId;
        }
    } catch (error) {
        const sanitized = sanitizeAxiosError(error);
        console.error(`[Whop API Error] GET /companies failed - Status: ${sanitized.status || 'N/A'}, Message: ${sanitized.message}`);
    }

    throw new Error('Failed to resolve Whop Company ID. Configure WHOP_COMPANY_ID in Vercel or ensure at least one mapped Whop plan ID in product-mappings.json is accessible.');
}

/**
 * Creates dynamic Whop checkout configuration based on current Shopify Cart items.
 * 
 * Supports:
 * - One-time only carts (plan_type: 'one_time')
 * - Membership (subscription) only carts with 30-day trials (plan_type: 'renewal')
 * - Mixed carts: charges one-time total upfront & sets up membership renewal after 30 days
 */
async function createCheckout(cartPayload, customerEmail = null) {
    const companyId = await getCompanyId();

    const items = cartPayload.items || [];
    let isMembershipInCart = false;
    let oneTimeCentsTotal = 0;

    // Parse line items, supporting quantities, discounts, and free gifts correctly
    const mappedItems = items.map(item => {
        const isMembership = item.handle === whopConfig.membershipProductId;

        // Use final_price or price per unit, and calculate total line price accurately
        const unitPrice = typeof item.final_price !== 'undefined' ? item.final_price : item.price;
        const linePrice = typeof item.final_line_price !== 'undefined' ? item.final_line_price : (unitPrice * item.quantity);

        if (isMembership) {
            isMembershipInCart = true;
        } else {
            oneTimeCentsTotal += linePrice;
        }

        return {
            variant_id: item.id,
            handle: item.handle,
            title: item.title,
            price_cents: unitPrice,
            quantity: item.quantity,
            sku: item.sku || '',
            is_membership: isMembership
        };
    });

    const oneTimeAmountDecimal = parseFloat((oneTimeCentsTotal / 100).toFixed(2));

    let planPayload = {};

    if (isMembershipInCart) {
        // Renewal billing structure:
        // - Initial price = total sum of one-time items upfront (e.g. A$54.98)
        // - Renewal price = A$39.99 (monthly journal subscription)
        // - Free trial = 30 days
        // - Associated product = Corvea Beauty Journal (required by Whop API for dynamic renewal plans)
        planPayload = {
            company_id: companyId, // Required for inline plans; must NOT be present at top level of checkout config
            product_id: whopConfig.whopMembershipProductId, // Required by Whop API for renewal plans
            plan_type: 'renewal',
            initial_price: oneTimeAmountDecimal,
            renewal_price: 39.99,
            billing_period: 30,
            trial_period_days: 30,
            currency: 'aud' // Corvea store base currency is AUD
        };
    } else {
        // One-time payment only
        planPayload = {
            company_id: companyId, // Required for inline plans; must NOT be present at top level of checkout config
            plan_type: 'one_time',
            initial_price: oneTimeAmountDecimal,
            currency: 'aud'
        };
    }

    const payload = {
        // Note: company_id must NOT be at the top level of this request, otherwise Whop returns a 400 bad request error
        mode: 'payment',
        plan: planPayload,
        redirect_url: `https://${cartPayload.host || 'corvea.store'}/pages/thank-you`,
        metadata: {
            shopify_cart_token: cartPayload.token || '',
            customer_email: customerEmail || '',
            cart_items_json: JSON.stringify(mappedItems)
        }
    };

    try {
        console.log(`[Whop Checkout] Creating checkout configuration for plan type: ${planPayload.plan_type}...`);
        const response = await axios.post(
            `${whopConfig.apiUrl}/checkout_configurations`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${whopConfig.apiKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const purchaseUrl = response.data?.purchase_url || response.data?.data?.purchase_url;
        if (!purchaseUrl) {
            throw new Error('Whop API response did not contain purchase_url.');
        }

        return {
            purchase_url: purchaseUrl,
            checkout_id: response.data?.id || response.data?.data?.id
        };
    } catch (error) {
        // Sanitize the request payload to ensure no sensitive credentials, secrets, or buyer emails are logged
        const sanitizedPayload = {
            mode: payload.mode,
            plan: {
                company_id: payload.plan?.company_id,
                product_id: payload.plan?.product_id,
                plan_type: payload.plan?.plan_type,
                initial_price: payload.plan?.initial_price,
                renewal_price: payload.plan?.renewal_price,
                billing_period: payload.plan?.billing_period,
                trial_period_days: payload.plan?.trial_period_days,
                currency: payload.plan?.currency
            },
            redirect_url: payload.redirect_url,
            metadata_size: payload.metadata ? JSON.stringify(payload.metadata).length : 0
        };

        // Extract Shopify cart debugging information for audit
        const cartDebugInfo = {
            total_price: cartPayload?.total_price,
            items_subtotal_price: cartPayload?.items_subtotal_price,
            total_discount: cartPayload?.total_discount,
            items: (cartPayload?.items || []).map(item => ({
                handle: item.handle,
                variant_title: item.variant_title || item.title,
                quantity: item.quantity,
                final_price: item.final_price || item.price,
                final_line_price: item.final_line_price || item.line_price || ((item.final_price || item.price) * item.quantity)
            }))
        };

        console.error(
            '[Whop Checkout Response Body]',
            JSON.stringify(error.response?.data, null, 2)
        );

        console.error(
            '[Whop Checkout Payload]',
            JSON.stringify(sanitizedPayload, null, 2)
        );

        console.error(
            '[Shopify Cart Totals]',
            JSON.stringify(cartDebugInfo, null, 2)
        );

        throw new Error(`Whop Checkout API error: ${error.response?.data ? JSON.stringify(error.response.data, null, 2) : error.message}`);
    }
}

module.exports = {
    getCompanyId,
    createCheckout
};
