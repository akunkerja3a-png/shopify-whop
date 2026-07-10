const axios = require('axios');
const shopifyConfig = require('../config/shopify');

/**
 * Creates a paid order in Shopify using the Shopify Admin REST API.
 * This naturally deducts inventory for tracking variant IDs in Shopify.
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
            // Optional shipping/billing fields if Whop parses them
            // Since Whop collects payment and membership details, we fill basic customer record
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
        console.log(`Successfully created Shopify paid order ID: ${createdOrder?.id} for Whop TX: ${gatewayTransactionId}`);
        return createdOrder;
    } catch (error) {
        console.error('Error creating order in Shopify:', error.response?.data || error.message);
        throw new Error(`Shopify Order Creation failed: ${JSON.stringify(error.response?.data) || error.message}`);
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
        console.error('Error checking duplicate order in Shopify:', error.message);
        // On error, default to false so we don't block order creation, but log it
        return false;
    }
}

module.exports = {
    createPaidOrder,
    orderExistsForTransaction
};
