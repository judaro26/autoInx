/**
 * getMercuryData.js
 * Returns Mercury account balance and recent transactions.
 * Requires a valid Firebase ID token with admin custom claim.
 */

const axios = require('axios');
const admin = require('firebase-admin');

const MERCURY_API_KEY    = process.env.MERCURY_API_KEY;
const MERCURY_ACCOUNT_ID = process.env.MERCURY_ACCOUNT_ID; // optional — falls back to first account
const BASE_URL           = 'https://api.mercury.com/api/v1';

function initAdmin() {
    if (admin.apps.length === 0) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId:   process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
        });
    }
}

const HEADERS = {
    'Content-Type':                 'application/json',
    'Access-Control-Allow-Origin':  process.env.URL || 'https://autoinx.com',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
    if (event.httpMethod !== 'GET')    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

    // ── Verify admin token ────────────────────────────────────────────────────
    initAdmin();
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!idToken) return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Missing Authorization header' }) };

    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }

    if (!decoded.admin) {
        return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Admin access required' }) };
    }

    // ── Check config ──────────────────────────────────────────────────────────
    if (!MERCURY_API_KEY) {
        return {
            statusCode: 503,
            headers: HEADERS,
            body: JSON.stringify({ error: 'Mercury API key not configured. Add MERCURY_API_KEY to your Netlify environment variables.' }),
        };
    }

    // ── Fetch from Mercury ────────────────────────────────────────────────────
    try {
        const mercuryHeaders = { 'Authorization': `Bearer ${MERCURY_API_KEY}` };

        // Always fetch accounts list so we can show the selector and auto-pick
        const accountsRes = await axios.get(`${BASE_URL}/accounts`, { headers: mercuryHeaders });
        const allAccounts = accountsRes.data.accounts || [];

        const accountId = MERCURY_ACCOUNT_ID || allAccounts[0]?.id;
        if (!accountId) {
            return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'No Mercury account found' }) };
        }

        // Fetch account details + last 50 transactions in parallel
        const [accountRes, txRes] = await Promise.all([
            axios.get(`${BASE_URL}/account/${accountId}`, { headers: mercuryHeaders }),
            axios.get(`${BASE_URL}/account/${accountId}/transactions?limit=50`, { headers: mercuryHeaders }),
        ]);

        const account      = accountRes.data;
        const transactions = (txRes.data.transactions || []).map(tx => ({
            id:               tx.id,
            amount:           tx.amount,
            counterpartyName: tx.counterpartyName || tx.merchantName || '—',
            note:             tx.note || tx.externalMemo || tx.bankDescription || '',
            createdAt:        tx.createdAt,
            postedDate:       tx.postedDate,
            status:           tx.status,
            kind:             tx.kind,
        }));

        return {
            statusCode: 200,
            headers:    HEADERS,
            body: JSON.stringify({
                account: {
                    id:               account.id,
                    name:             account.name,
                    kind:             account.kind,
                    currentBalance:   account.currentBalance,
                    availableBalance: account.availableBalance,
                },
                transactions,
                allAccounts: allAccounts.map(a => ({
                    id:               a.id,
                    name:             a.name,
                    currentBalance:   a.currentBalance,
                    availableBalance: a.availableBalance,
                })),
            }),
        };
    } catch (err) {
        const httpStatus = err.response?.status || 500;
        const detail     = err.response?.data  || err.message;
        console.error('❌ Mercury API error:', JSON.stringify(detail));
        return {
            statusCode: httpStatus >= 400 ? httpStatus : 500,
            headers:    HEADERS,
            body: JSON.stringify({ error: 'Mercury API request failed', detail }),
        };
    }
};
