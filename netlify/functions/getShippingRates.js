/**
 * Netlify Function: getShippingRates.js
 * Fetches real-time shipping rates from Shippo for an order
 */

exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const { orderId, addressTo, parcels } = JSON.parse(event.body);

        if (!addressTo || !parcels) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Missing required fields: addressTo, parcels' })
            };
        }

        // Shippo API configuration
        const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY;
        const SHIPPO_API_URL = 'https://api.goshippo.com/shipments/';

        // Your warehouse/sender address
        const addressFrom = {
            name: "AutoInx USA",
            street1: "587 Paradise Blvd",
            city: "Hayward",
            state: "CA",
            zip: "94542",
            country: "US",
            phone: "+13412227912",
            email: process.env.BREVO_SMTP_USER  // ✅ Reuse your existing email env var
        };

        console.log('📦 Fetching rates for order:', orderId?.substring(0, 8));
        console.log('📍 Ship to:', addressTo.city, addressTo.state);

        // Create shipment to get rates
        const shipmentData = {
            address_from: addressFrom,
            address_to: addressTo,
            parcels: parcels,
            async: false // Get rates synchronously
        };

        const response = await fetch(SHIPPO_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `ShippoToken ${SHIPPO_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(shipmentData)
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('❌ Shippo API error:', errorData);
            throw new Error(errorData.detail || 'Failed to fetch rates from Shippo');
        }

        const shipmentResult = await response.json();
        console.log('✅ Shipment created:', shipmentResult.object_id);

        // Extract and format rates
        const rates = shipmentResult.rates
            .filter(rate => rate.available)
            .map(rate => ({
                object_id: rate.object_id,
                provider: rate.provider,
                servicelevel: {
                    name: rate.servicelevel.name,
                    token: rate.servicelevel.token
                },
                amount: parseFloat(rate.amount),
                currency: rate.currency,
                estimated_days: rate.estimated_days,
                duration_terms: rate.duration_terms,
                carrier_account: rate.carrier_account
            }))
            .sort((a, b) => a.amount - b.amount); // Sort by price

        console.log(`✅ Found ${rates.length} available rates`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                shipmentId: shipmentResult.object_id,
                rates: rates,
                orderId: orderId
            })
        };

    } catch (error) {
        console.error('❌ Get Rates Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to fetch shipping rates',
                details: error.message
            })
        };
    }
};
