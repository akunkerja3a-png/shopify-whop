const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

let cachedToken = null;
let tokenExpiresAt = null;

const store = process.env.SHOPIFY_STORE || 'corvea.myshopify.com';
const storeDomain = store.replace(/^https?:\/\//, '').replace(/\/$/, '');
const apiVersion = process.env.SHOPIFY_API_VERSION || '2026-07';
const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

/**
 * Dynamically fetches and caches the Shopify access token using client credentials grant.
 */
async function getAccessToken() {
    // If we have a cached token and it is still valid, return it
    if (cachedToken && (!tokenExpiresAt || Date.now() < tokenExpiresAt)) {
        return cachedToken;
    }

    // Backwards compatibility fallback if legacy token is supplied instead
    if (!clientId || !clientSecret) {
        const legacyToken = process.env.SHOPIFY_ADMIN_API_TOKEN;
        if (legacyToken) {
            console.warn('Warning: Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET. Falling back to legacy SHOPIFY_ADMIN_API_TOKEN.');
            cachedToken = legacyToken;
            return cachedToken;
        }
        throw new Error('Missing Shopify Authentication configuration. Please configure SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET or SHOPIFY_ADMIN_API_TOKEN.');
    }

    try {
        const url = `https://${storeDomain}/admin/oauth/access_token`;
        const params = new URLSearchParams();
        params.set('grant_type', 'client_credentials');
        params.set('client_id', clientId);
        params.set('client_secret', clientSecret);

        const res = await axios.post(url, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        cachedToken = res.data.access_token;
        if (res.data.expires_in) {
            tokenExpiresAt = Date.now() + (res.data.expires_in * 1000) - 60000; // Refresh 1 minute early
        } else {
            tokenExpiresAt = Date.now() + (12 * 60 * 60 * 1000); // Default to 12 hours
        }

        console.log('Shopify access token refreshed successfully via client credentials.');
        return cachedToken;
    } catch (err) {
        console.error('Failed to retrieve Shopify client credentials token:', err.response?.data || err.message);
        throw new Error(`Shopify Auth Error: ${JSON.stringify(err.response?.data) || err.message}`);
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
