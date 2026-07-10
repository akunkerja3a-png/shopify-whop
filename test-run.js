const axios = require('axios');
const crypto = require('crypto');

// 1. Mock network layer globally before importing our app
const originalPost = axios.post;
const originalGet = axios.get;

const MOCK_WEBHOOK_SECRET = 'whsec_YTM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTA='; // base64 compatible mock key

// Inject mock behaviors
axios.get = async function (url, config) {
    if (url.includes('/companies')) {
        console.log('   [Mock API] GET /companies -> Returning mock company list');
        return { data: { data: [{ id: 'biz_test_12345' }] } };
    }
    if (url.includes('/orders.json')) {
        console.log('   [Mock API] GET /orders.json -> Returning empty order history (no duplicates)');
        return { data: { orders: [] } };
    }
    return originalGet.apply(this, arguments);
};

axios.post = async function (url, data, config) {
    if (url.includes('/oauth/access_token')) {
        console.log('   [Mock API] POST /oauth/access_token -> Returning mock access token');
        return {
            data: {
                access_token: 'shpat_mock_access_token_123456',
                expires_in: 86400
            }
        };
    }
    if (url.includes('/checkout_configurations')) {
        console.log('   [Mock API] POST /checkout_configurations -> Returning mock checkout purchase_url');
        return {
            data: {
                id: 'config_mock_999',
                purchase_url: 'https://whop.com/checkout/plan_Pj1GzRRMdZzJ9?config=config_mock_999'
            }
        };
    }
    if (url.includes('/orders.json')) {
        console.log('   [Mock API] POST /orders.json -> Shopify Order creation success!');
        return {
            data: {
                order: {
                    id: 888877776666,
                    email: data.order.email,
                    total_price: data.order.transactions[0].amount
                }
            }
        };
    }
    return originalPost.apply(this, arguments);
};

// Override env variables for test run
process.env.WHOP_API_KEY = 'apik_test_apikey';
process.env.WHOP_WEBHOOK_SECRET = MOCK_WEBHOOK_SECRET;
process.env.SHOPIFY_STORE = 'test-corvea.myshopify.com';
process.env.SHOPIFY_CLIENT_ID = 'test_client_id_4455';
process.env.SHOPIFY_CLIENT_SECRET = 'test_client_secret_6677';
process.env.SHOPIFY_ADMIN_API_TOKEN = 'shpat_test_token';

// Import our server
const app = require('./api/index');
const PORT = 3535;

let server;

async function runTests() {
    server = app.listen(PORT, async () => {
        console.log(`\n======================================================`);
        console.log(`Starting Integration Test Suite on http://localhost:${PORT}`);
        console.log(`======================================================\n`);

        try {
            // Test 1: Health check
            console.log('Test 1: Verifying Health Check API...');
            const healthRes = await axios.get(`http://localhost:${PORT}/api/health`);
            if (healthRes.status === 200 && healthRes.data.status === 'healthy') {
                console.log('✅ Health Check Verified: OK');
            } else {
                throw new Error('Health check failed');
            }

            // Test 2: Create Checkout for Mixed Shopify Cart
            console.log('\nTest 2: Requesting checkout configuration for Shopify cart...');
            const mockCartPayload = {
                cart: {
                    token: 'cart_token_abc123xyz',
                    items: [
                        {
                            id: '430099558832', // Toner variant ID
                            handle: 'skintific-5x-ceramide-soothing-toner',
                            title: '5X Ceramide Soothing Toner',
                            price: 1499, // cents (14.99)
                            quantity: 2
                        },
                        {
                            id: '430099558839', // Membership variant ID
                            handle: 'corvea-beauty-journal',
                            title: 'Corvea Beauty Journal - Membership',
                            price: 3999, // cents (39.99/mo)
                            quantity: 1
                        }
                    ]
                },
                customer_email: 'buyer@example.com'
            };

            const checkoutRes = await axios.post(`http://localhost:${PORT}/api/create-checkout`, mockCartPayload);
            if (checkoutRes.status === 200 && checkoutRes.data.purchase_url) {
                console.log('✅ Checkout Generation Verified: OK');
                console.log('   Generated URL:', checkoutRes.data.purchase_url);
            } else {
                throw new Error('Checkout generation failed');
            }

            // Test 3: Standard Webhook HMAC Signature Validation
            console.log('\nTest 3: Processing Webhook payment.succeeded from Whop...');
            const webhookPayload = JSON.stringify({
                action: 'payment.succeeded',
                data: {
                    id: 'pay_txn_whop_98765',
                    amount: 29.98, // 29.98 paid for 2x toners, subscription recurring trial = A$0 upfront
                    currency: 'aud',
                    email: 'buyer@example.com',
                    customer: {
                        username: 'Jane Buyer',
                        email: 'buyer@example.com'
                    },
                    metadata: {
                        shopify_cart_token: 'cart_token_abc123xyz',
                        customer_email: 'buyer@example.com',
                        cart_items_json: JSON.stringify([
                            {
                                variant_id: '430099558832',
                                handle: 'skintific-5x-ceramide-soothing-toner',
                                title: '5X Ceramide Soothing Toner',
                                price_cents: 1499,
                                quantity: 2,
                                is_membership: false
                            },
                            {
                                variant_id: '430099558839',
                                handle: 'corvea-beauty-journal',
                                title: 'Corvea Beauty Journal - Membership',
                                price_cents: 3999,
                                quantity: 1,
                                is_membership: true
                            }
                        ])
                    }
                }
            });

            // Generate webhook headers using the Standard Webhooks spec
            const webhookId = 'msg_wh_id_445566';
            const webhookTimestamp = Math.floor(Date.now() / 1000).toString();
            const signedContent = `${webhookId}.${webhookTimestamp}.${webhookPayload}`;

            // Extract key from whsec_
            const keyBuffer = Buffer.from(MOCK_WEBHOOK_SECRET.substring(6), 'base64');
            const signature = crypto
                .createHmac('sha256', keyBuffer)
                .update(signedContent)
                .digest('base64');

            const webhookHeaders = {
                'Content-Type': 'application/json',
                'webhook-id': webhookId,
                'webhook-timestamp': webhookTimestamp,
                'webhook-signature': `v1,${signature}`
            };

            const webhookRes = await axios.post(`http://localhost:${PORT}/api/whop-webhook`, webhookPayload, {
                headers: webhookHeaders
            });

            if (webhookRes.status === 201 && webhookRes.data.shopify_order_id) {
                console.log('✅ Webhook Validation & Order Creation Verified: OK');
                console.log('   Shopify Order Created ID:', webhookRes.data.shopify_order_id);
            } else {
                throw new Error('Webhook processing failed');
            }

            console.log(`\n======================================================`);
            console.log('🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY! 🎉');
            console.log(`======================================================\n`);
            shutdown(0);

        } catch (error) {
            console.error('\n❌ INTEGRATION TEST FAILED:', error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response data:', error.response.data);
            }
            shutdown(1);
        }
    });
}

function shutdown(code) {
    if (server) {
        server.close(() => {
            console.log('Test Server stopped.');
            process.exit(code);
        });
    } else {
        process.exit(code);
    }
}

runTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
