const shopifyService = require('../services/shopifyService');

/**
 * Endpoint: POST /api/whop-webhook
 * Responds to Whop payment.succeeded and membership.activated events.
 * Reconstructs Shopify orders from customer cart metadata.
 */
async function handleWebhook(req, res) {
    const event = req.body;
    const eventAction = event.action || event.type;
    const eventData = event.data;

    console.log(`[Webhook Receiver] Received event from Whop: ${eventAction}`);

    // Interested in payments or membership activations (e.g. trial activations)
    if (eventAction !== 'payment.succeeded' && eventAction !== 'membership.activated') {
        return res.status(200).json({ message: `Ignored unhandled event: ${eventAction}` });
    }

    if (!eventData) {
        return res.status(400).json({ error: 'Missing webhook data payload.' });
    }

    const transactionId = eventData.id;
    const metadata = eventData.metadata || {};

    if (!transactionId) {
        return res.status(400).json({ error: 'Missing transaction or resource ID.' });
    }

    // Verify that the metadata contains the cart items JSON
    if (!metadata.cart_items_json) {
        console.log(`[Webhook Receiver] Skipping sync: Metadata does not contain cart_items_json. TX: ${transactionId}`);
        return res.status(200).json({ message: 'No Shopify cart metadata found in checkout. Skipping order creation.' });
    }

    try {
        // 1. Idempotency Check: check if order already exists for this Whop Payment/Membership ID
        const exists = await shopifyService.orderExistsForTransaction(transactionId);
        if (exists) {
            console.log(`[Webhook Receiver] Order already exists for transaction: ${transactionId}. Skipping duplicate creation.`);
            return res.status(200).json({ message: 'Order already processed.' });
        }

        // 2. Parse cart line items
        const lineItems = JSON.parse(metadata.cart_items_json);

        // 3. Resolve customer details
        const email = metadata.customer_email || eventData.email || eventData.customer?.email || 'no-email@whop.com';
        const customerName = eventData.customer?.username || eventData.customer?.email || 'Whop Customer';

        // 4. Calculate total paid
        // If it's a membership activation event (with no initial amount field or A$0 initial price), total paid is 0 or what was paid for one-time items
        let totalPaid = 0.00;
        if (eventData.amount) {
            const rawAmt = parseFloat(eventData.amount);
            totalPaid = rawAmt > 200 ? rawAmt / 100 : rawAmt;
        } else {
            // Calculate from one-time items metadata if eventData.amount is not populated
            const oneTimeCentsTotal = lineItems
                .filter(item => !item.is_membership)
                .reduce((sum, item) => sum + (item.price_cents * item.quantity), 0);
            totalPaid = parseFloat((oneTimeCentsTotal / 100).toFixed(2));
        }

        console.log(`[Webhook Receiver] Re-creating Shopify order for customer ${email}. Items count: ${lineItems.length}. Total paid: A$${totalPaid}`);

        // 5. Create paid order in Shopify (this automatically decrements inventory)
        const shopifyOrder = await shopifyService.createPaidOrder({
            email,
            items: lineItems,
            totalAmountPaid: totalPaid,
            gatewayTransactionId: transactionId,
            customerName
        });

        return res.status(201).json({
            message: 'Shopify order created successfully.',
            shopify_order_id: shopifyOrder.id
        });
    } catch (error) {
        console.error(`[Webhook Receiver Error] Failed to process Whop Webhook (${transactionId}):`, error.message);
        return res.status(500).json({ error: error.message || 'Failed to process webhook event.' });
    }
}

module.exports = {
    handleWebhook
};
