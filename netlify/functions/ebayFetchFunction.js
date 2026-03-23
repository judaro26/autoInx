/**
 * ebayFetchFunction.js
 * Thin entry point so the admin panel button (/.netlify/functions/ebayFetchFunction)
 * hits the same logic as the scheduled ebaySyncOrders function.
 */
const { handler } = require('./ebaySyncOrders');
exports.handler = handler;
