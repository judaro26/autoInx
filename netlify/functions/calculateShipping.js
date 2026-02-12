const axios = require('axios');

exports.handler = async (event, context) => {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const { addressTo, parcels } = JSON.parse(event.body);

        // Validate required fields
        if (!addressTo || !parcels) {
            return {
                statusCode: 400,
                body: JSON.stringify({ 
                    error: 'Missing required fields: addressTo and parcels are required' 
                })
            };
        }

        // Validate Shippo API token exists
        const SHIPPO_API_TOKEN = process.env.SHIPPO_API_TOKEN;
        if (!SHIPPO_API_TOKEN) {
            console.error('❌ SHIPPO_API_TOKEN not configured');
            return {
                statusCode: 500,
                body: JSON.stringify({ 
                    error: 'Shipping service not configured',
                    details: 'SHIPPO_API_TOKEN missing'
                })
            };
        }

        console.log('📦 Creating shipment for address:', addressTo.city, addressTo.state);

        // Create shipment with Shippo
        const shipmentResponse = await axios.post(
            'https://api.goshippo.com/shipments/',
            {
                address_from: {
                    name: "AutoInx Warehouse",
                    street1: "1234 Warehouse St",
                    city: "San Francisco",
                    state: "CA",
                    zip: "94103",
                    country: "US",
                    phone: "+1 415 123 4567"
                },
                address_to: addressTo,
                parcels: parcels,
                async: false
            },
            {
                headers: {
                    'Authorization': `ShippoToken ${SHIPPO_API_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const shipmentData = shipmentResponse.data;
        console.log('✅ Shipment created:', shipmentData.object_id);

        // Check if we got rates
        if (!shipmentData.rates || shipmentData.rates.length === 0) {
            console.warn('⚠️ No shipping rates returned');
            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: false,
                    message: 'No shipping rates available for this destination',
                    bestRate: null
                })
            };
        }

        // ✅ FIX: Sort rates by price (lowest first)
        const sortedRates = shipmentData.rates.sort((a, b) => 
            parseFloat(a.amount) - parseFloat(b.amount)
        );

        // Get the cheapest rate
        const bestRate = sortedRates[0];

        console.log('💰 Best rate:', bestRate.provider, bestRate.servicelevel.name, `$${bestRate.amount}`);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                success: true,
                bestRate: {
                    provider: bestRate.provider,
                    servicelevel: bestRate.servicelevel,
                    amount: parseFloat(bestRate.amount),
                    currency: bestRate.currency,
                    estimated_days: bestRate.estimated_days,
                    duration_terms: bestRate.duration_terms
                },
                allRates: sortedRates.map(rate => ({
                    provider: rate.provider,
                    servicelevel: rate.servicelevel.name,
                    amount: parseFloat(rate.amount),
                    currency: rate.currency,
                    estimated_days: rate.estimated_days
                })),
                shipmentId: shipmentData.object_id
            })
        };

    } catch (error) {
        console.error('❌ Shipping calculation error:', error.message);
        
        // Log more details for debugging
        if (error.response) {
            console.error('Shippo API Error:', error.response.data);
        }

        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                error: 'Failed to calculate shipping',
                details: error.message,
                // Include API error details if available
                apiError: error.response?.data || null
            })
        };
    }
};
