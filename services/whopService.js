const axios = require('axios');
const whopConfig = require('../config/whop');
const productMappings = require('../config/product-mappings.json');

let cachedCompanyId = process.env.WHOP_COMPANY_ID || null;

/**
 * Gets the company ID dynamically from Whop API if not cached.
 * Utilizes a triple-fallback mechanism:
 * 1. Checks if WHOP_COMPANY_ID is configured in the environment values.
 * 2. Queries GET /companies API (outputs sanitized logs on failure).
 * 3. Fetches GET /plans/{plan_id} from mappings to extract company_id.
 */
async function getCompanyId() {
    if (cachedCompanyId) return cachedCompanyId;

    // 1. Primary: List companies endpoint query
    try {
        console.log('Attempting to fetch Whop Company ID via GET /companies...');
        const response = await axios.get(`${whopConfig.apiUrl}/companies`, {
            headers: {
                Authorization: `Bearer ${whopConfig.apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        const companies = response.data?.data || response.data || [];
        if (companies.length > 0) {
            cachedCompanyId = companies[0].id;
            console.log(`Resolved dynamically Whop Company ID from /companies: ${cachedCompanyId}`);
            return cachedCompanyId;
        }
    } catch (error) {
        const status = error.response?.status || 'N/A';
        const data = error.response?.data ? JSON.stringify(error.response.data) : 'N/A';
        console.error(`[Whop API Error] GET /companies failed - Status: ${status}, Body: ${data}, Message: ${error.message}`);
    }

    // 2. Secondary: Retrieve details of mapped plan to extract its company_id
    console.log('Attempting fallback company ID extraction via GET /plans...');
    let targetPlanId = 'plan_Pj1GzRRMdZzJ9'; // Default fallback plan
    try {
        // Grab the first plan ID from mapped products if available
        if (productMappings && typeof productMappings === 'object') {
            const firstMapping = Object.values(productMappings)[0];
            if (firstMapping && Array.isArray(firstMapping.plans) && firstMapping.plans[0]) {
                targetPlanId = firstMapping.plans[0];
            }
        }
    } catch (err) {
        console.error('Failed to parse plan IDs from product mappings:', err.message);
    }

    try {
        console.log(`Fetching details for plan ${targetPlanId} to extract company reference...`);
        const response = await axios.get(`${whopConfig.apiUrl}/plans/${targetPlanId}`, {
            headers: {
                Authorization: `Bearer ${whopConfig.apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        const planData = response.data;
        const extracted = planData?.company_id || planData?.company?.id || planData?.data?.company_id;

        if (extracted) {
            cachedCompanyId = extracted;
            console.log(`Resolved Whop Company ID from plan (${targetPlanId}): ${cachedCompanyId}`);
            return cachedCompanyId;
        }
        console.warn(`GET /plans/${targetPlanId} succeeded but did not contain company_id. Body: ${JSON.stringify(planData)}`);
    } catch (error) {
        const status = error.response?.status || 'N/A';
        const data = error.response?.data ? JSON.stringify(error.response.data) : 'N/A';
        console.error(`[Whop API Error] GET /plans/${targetPlanId} failed - Status: ${status}, Body: ${data}, Message: ${error.message}`);
    }

    throw new Error('Failed to resolve Whop Company ID via /companies or plan lookup fallbacks. Please configure WHOP_COMPANY_ID in Vercel environment variables.');
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

    // Parse line items and locate membership item
    const mappedItems = items.map(item => {
        // Check if handle matches membership
        const isMembership = item.handle === whopConfig.membershipProductId;
        if (isMembership) {
            isMembershipInCart = true;
        } else {
            oneTimeCentsTotal += (item.price * item.quantity);
        }

        return {
            variant_id: item.id,
            handle: item.handle,
            title: item.title,
            price_cents: item.price,
            quantity: item.quantity,
            sku: item.sku || '',
            is_membership: isMembership
        };
    });

    const oneTimeAmountDecimal = parseFloat((oneTimeCentsTotal / 100).toFixed(2));

    let planPayload = {};

    if (isMembershipInCart) {
        // If the membership is in the cart, the billing structure is 'renewal'
        // - Initial price = total of one-time items in cart (upfront payment)
        // - Renewal price = A$39.99 (monthly journal membership)
        // - Free trial = 30 days
        planPayload = {
            plan_type: 'renewal',
            initial_price: oneTimeAmountDecimal,
            renewal_price: 39.99,
            billing_period: 30,
            trial_period_days: 30,
            currency: 'aud' // Corvea store prices are A$
        };
    } else {
        // One-time payment only
        planPayload = {
            plan_type: 'one_time',
            initial_price: oneTimeAmountDecimal,
            currency: 'aud'
        };
    }

    // Construct request checkout configuration
    // Metadata stores details needed to rebuild Shopify Order in Webhook
    const payload = {
        company_id: companyId,
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
        console.error('Error generating Whop checkout configuration:', error.response?.data || error.message);
        throw new Error(`Whop Checkout API error: ${JSON.stringify(error.response?.data) || error.message}`);
    }
}

module.exports = {
    getCompanyId,
    createCheckout
};
