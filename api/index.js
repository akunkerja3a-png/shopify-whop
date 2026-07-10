const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const checkoutController = require('../controllers/checkoutController');
const webhookController = require('../controllers/webhookController');
const validateWebhook = require('../middleware/validateWebhook');

const app = express();

// Parse json requests and preserve raw request body for HMAC verification
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf.toString();
    }
}));

// Enable CORS for Shopify AJAX requests
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'webhook-signature', 'webhook-id', 'webhook-timestamp']
}));

// API Endpoints
app.get('/', (req, res) => {
    res.status(200).send('Shopify-Whop Checkout Integration Gateway is running.');
});

app.get('/api/auth/callback', (req, res) => {
    res.status(200).send('OAuth Configuration Verified: App token handshake occurs strictly via backend client credentials.');
});

app.post('/api/create-checkout', checkoutController.handleCreateCheckout);
app.post('/api/whop-webhook', validateWebhook, webhookController.handleWebhook);

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString()
    });
});

// Local development server listener
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Express server running on http://localhost:${PORT}`);
    });
}

module.exports = app;
