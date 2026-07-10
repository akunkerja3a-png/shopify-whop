const crypto = require('crypto');
const whopConfig = require('../config/whop');

/**
 * Express middleware to validate Whop webhook signatures based on the Standard Webhooks spec.
 * Requires `req.rawBody` to be populated (e.g. from the express.json() verify parameter).
 */
module.exports = (req, res, next) => {
    // Graceful fallback for local development or unconfigured environments
    if (!whopConfig.webhookSecret || whopConfig.webhookSecret === 'whsec_placeholder') {
        console.warn('WARNING: Whop webhook secret is not configured. Webhook signature validation Bypassed!');
        return next();
    }

    const webhookId = req.headers['webhook-id'] || req.headers['webhook_id'];
    const webhookTimestamp = req.headers['webhook-timestamp'] || req.headers['webhook_timestamp'];
    const webhookSignature = req.headers['webhook-signature'] || req.headers['webhook_signature'];

    if (!webhookId || !webhookTimestamp || !webhookSignature) {
        console.error('Webhook verification failed: Missing required webhook headers.');
        return res.status(401).json({ error: 'Missing standard webhook verification headers.' });
    }

    try {
        // 1. Parse Whop secret key (strip 'whsec_' or 'ws_' prefix and decode from base64)
        let secretKey = whopConfig.webhookSecret;
        if (secretKey.startsWith('whsec_')) {
            secretKey = secretKey.substring(6);
        } else if (secretKey.startsWith('ws_')) {
            secretKey = secretKey.substring(3);
        }
        const secretBuffer = Buffer.from(secretKey, 'base64');

        // 2. Re-create the signature payload payload
        const rawBody = req.rawBody || '';
        const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;

        // 3. Compute HMCA-SHA256 signature
        const computedSignature = crypto
            .createHmac('sha256', secretBuffer)
            .update(signedContent)
            .digest('base64');

        // 4. Extract v1 signatures from the signature header (e.g., 'v1,sig1 v2,sig2')
        const signatureParts = webhookSignature.split(' ');
        const signaturesToCompare = signatureParts
            .map(part => {
                const kv = part.split(',');
                return kv.length === 2 && kv[0] === 'v1' ? kv[1] : null;
            })
            .filter(Boolean);

        // 5. Compare using timingSafeEqual to avoid timing attacks
        const computedSignatureBuffer = Buffer.from(computedSignature, 'base64');
        const isValid = signaturesToCompare.some(sig => {
            try {
                const sigBuffer = Buffer.from(sig, 'base64');
                return crypto.timingSafeEqual(sigBuffer, computedSignatureBuffer);
            } catch (e) {
                return false;
            }
        });

        if (!isValid) {
            console.error('Webhook verification failed: Signature mismatch.');
            return res.status(401).json({ error: 'Invalid webhook signature.' });
        }

        // Success
        next();
    } catch (err) {
        console.error('Webhook signature validation internal error:', err);
        return res.status(500).json({ error: 'Error validating webhook signature.' });
    }
};
