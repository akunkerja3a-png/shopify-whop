const axios = require('axios');
const shopifyConfig = require('../config/shopify');

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
 * Creates a paid order in Shopify using the Shopify Admin REST API.
 * 
 * @param {Object} params
 * @param {string} params.email - Customer email
 * @param {Array} params.items - Mapped cart items {variant_id, quantity, price_cents, title}
 * @param {number} params.totalAmountPaid - Decimal amount paid (e.g. 54.98)
 * @param {string} params.gatewayTransactionId - Whop payment transaction ID
 * @param {string} params.customerName - Customer display name from Whop
 */
async function createPaidOrder({ email, items, totalAmountPaid, gatewayTransactionId, customerName }) {
    const nameParts = (customerName || '').trim().split(/\s+/);
    const firstName = nameParts[0] || 'Whop';
    const lastName = nameParts.slice(1).join(' ') || 'Customer';

    // Construct Shopify order JSON payload
    const orderPayload = {
        order: {
            line_items: items.map(item => ({
                variant_id: parseInt(item.variant_id, 10),
                quantity: parseInt(item.quantity, 10),
                price: parseFloat((item.price_cents / 100).toFixed(2))
            })),
            customer: {
                first_name: firstName,
                last_name: lastName,
                email: email
            },
            email: email,
            financial_status: 'paid',
            // Enforce automatic inventory decrementing matching the store's policy
            inventory_behaviour: 'decrement_obeying_policy',
            transactions: [
                {
                    kind: 'sale',
                    status: 'success',
                    amount: parseFloat(totalAmountPaid).toFixed(2),
                    gateway: 'Whop Payments'
                }
            ],
            note_attributes: [
                {
                    name: 'Whop Payment ID',
                    value: gatewayTransactionId
                }
            ],
            tags: 'Whop-Checkout'
        }
    };

    try {
        const accessToken = await shopifyConfig.getAccessToken();
        console.log(`[Shopify Service] Creating paid order on ${shopifyConfig.storeDomain} for Whop TX: ${gatewayTransactionId}...`);

        const response = await axios.post(
            `${shopifyConfig.baseUrl}/orders.json`,
            orderPayload,
            {
                headers: {
                    'X-Shopify-Access-Token': accessToken,
                    'Content-Type': 'application/json'
                }
            }
        );

        const createdOrder = response.data?.order;
        console.log(`[Shopify Service] Successfully created Shopify paid order ID: ${createdOrder?.id}`);
        return createdOrder;
    } catch (error) {
        const sanitized = sanitizeAxiosError(error);
        console.error('[Shopify Service Error] Failed to create order in Shopify:', sanitized);
        throw new Error(`Shopify Order Creation failed: ${JSON.stringify(sanitized.data) || sanitized.message}`);
    }
}

/**
 * Checks if an order was already created for a specific Whop transaction or payment ID.
 * This is used to ensure idempotency and prevent duplicate order creations.
 * 
 * @param {string} gatewayTransactionId 
 * @returns {Promise<boolean>}
 */
async function orderExistsForTransaction(gatewayTransactionId) {
    try {
        const accessToken = await shopifyConfig.getAccessToken();
        const response = await axios.get(
            `${shopifyConfig.baseUrl}/orders.json`,
            {
                params: {
                    status: 'any',
                    limit: 50,
                    fields: 'id,note_attributes'
                },
                headers: {
                    'X-Shopify-Access-Token': accessToken,
                    'Content-Type': 'application/json'
                }
            }
        );

        const orders = response.data?.orders || [];
        return orders.some(order => {
            const attributes = order.note_attributes || [];
            return attributes.some(attr =>
                (attr.name === 'Whop Payment ID' || attr.name === 'Whop Transaction ID') &&
                attr.value === gatewayTransactionId
            );
        });
    } catch (error) {
        const sanitized = sanitizeAxiosError(error);
        console.error('[Shopify Service Error] Failed to verify duplicate order check in Shopify:', sanitized.message);
        // Default to false to avoid blocking order creation in case of transient check failures, but log it
        return false;
    }
}

module.exports = {
    createPaidOrder,
    orderExistsForTransaction
};
