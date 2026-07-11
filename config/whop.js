const dotenv = require('dotenv');
dotenv.config();

module.exports = {
    apiKey: process.env.WHOP_API_KEY,
    webhookSecret: process.env.WHOP_WEBHOOK_SECRET,
    membershipProductId: process.env.MEMBERSHIP_PRODUCT_ID || 'corvea-beauty-journal',
    membershipCheckoutLink: process.env.MEMBERSHIP_CHECKOUT_LINK || 'https://whop.com/checkout/plan_0mVLjtR5CvElu',
    whopMembershipProductId: process.env.WHOP_MEMBERSHIP_PRODUCT_ID || 'prod_CRyGT1Xm98jqk',
    apiUrl: 'https://api.whop.com/api/v1',
    sandboxApiUrl: 'https://sandbox-api.whop.com/api/v1'
};
