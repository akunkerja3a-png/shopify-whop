const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

let cachedToken = null;
let tokenExpiresAt = null;

const store = process.env.SHOPIFY_STORE || 'fjra9e-ky.myshopify.com';
const storeDomain = store.replace(/^https?:\/\//, '').replace(/\/$/, '');
const apiVersion = process.env.SHOPIFY_API_VERSION || '2026-07';
const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

/**
 * Strips headers / API keys from raw Axios errors to ensure secrets are never leaked in logs.
 * Truncates raw HTML to prevent massive dumps in log output.
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
        let data = error.response.data;
        if (typeof data === 'string' && data.includes('<html')) {
            // Strip HTML content and truncate
            data = data.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) + '...';
        }
        sanitized.data = data;
    }

    return sanitized;
}

/**
 * Dynamically fetches and caches the Shopify access token using client credentials grant.
 */
async function getAccessToken() {
    // If we have a cached token and it is still valid, return it
    if (cachedToken && (!tokenExpiresAt || Date.now() < tokenExpiresAt)) {
        return cachedToken;
    }

    // Always check if legacy token is supplied in environment (direct custom app token starting with shpat_)
    const legacyToken = process.env.SHOPIFY_ADMIN_API_TOKEN;
    if (legacyToken) {
        console.log('[Shopify Auth] Utilizing static SHOPIFY_ADMIN_API_TOKEN.');
        cachedToken = legacyToken;
        return cachedToken;
    }

    if (!clientId || !clientSecret) {
        throw new Error('Missing Shopify Authentication configuration. Please configure SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET or SHOPIFY_ADMIN_API_TOKEN.');
    }

    try {
        const url = `https://${storeDomain}/admin/oauth/access_token`;
        const params = new URLSearchParams();
        params.set('grant_type', 'client_credentials');
        params.set('client_id', clientId);
        params.set('client_secret', clientSecret);

        console.log(`[Shopify Auth] Requesting access token for ${storeDomain} client credentials...`);
        const res = await axios.post(url, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        cachedToken = res.data.access_token;
        if (res.data.expires_in) {
            tokenExpiresAt = Date.now() + (res.data.expires_in * 1000) - 60000; // Refresh 1 minute early
        } else {
            tokenExpiresAt = Date.now() + (12 * 60 * 60 * 1000); // Default to 12 hours
        }

        console.log('[Shopify Auth] Shopify access token refreshed successfully via client credentials.');
        return cachedToken;
    } catch (err) {
        const sanitized = sanitizeAxiosError(err);
        console.error('[Shopify Auth Error] Failed to retrieve Shopify access token:', sanitized);
        throw new Error(`Shopify Auth Error: ${typeof sanitized.data === 'object' ? JSON.stringify(sanitized.data) : sanitized.data || sanitized.message}`);
    }
}

module.exports = {
    storeDomain,
    apiVersion,
    getAccessToken,
    get baseUrl() {
        return `https://${storeDomain}/admin/api/${this.apiVersion}`;
    }
};
