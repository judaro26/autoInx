const fetch = require('node-fetch');

exports.handler = async (event) => {
    // CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    // Handle preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { 
            statusCode: 405, 
            headers, 
            body: JSON.stringify({ error: 'Method not allowed' }) 
        };
    }

    try {
        const { addressTo, parcels, serviceLevel = 'usps_priority' } = JSON.parse(event.body);
        
        if (!addressTo || !parcels) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Missing required fields: addressTo, parcels' })
            };
        }

        // Shippo API Key (store in Netlify environment variables)
        const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY;
        
        if (!SHIPPO_API_KEY) {
            throw new Error('Shippo API key not configured');
        }

        // Create shipment request
        const shipmentData = {
            address_from: {
                name: "AutoInx Store",
                street1: "587 Paradise Blvd",
                city: "Hayward",
                state: "CA",
                zip: "94545",
                country: "US"
            },
            address_to: addressTo,
            parcels: parcels,
            async: false
        };

        const response = await fetch('https://api.goshippo.com/shipments/', {
            method: 'POST',
            headers: {
                'Authorization': `ShippoToken ${SHIPPO_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(shipmentData)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(`Shippo API error: ${JSON.stringify(error)}`);
        }

        const shipment = await response.json();
        
        // Filter rates for requested service level
        const rates = shipment.rates.filter(r => 
            r.servicelevel.token === serviceLevel || r.provider === serviceLevel.split('_')[0]
        );

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                rates: rates.map(r => ({
                    provider: r.provider,
                    servicelevel: r.servicelevel.name,
                    amount: parseFloat(r.amount),
                    currency: r.currency,
                    estimated_days: r.estimated_days
                })),
                bestRate: rates[0] ? {
                    provider: rates[0].provider,
                    amount: parseFloat(rates[0].amount),
                    currency: rates[0].currency
                } : null
            })
        };

    } catch (error) {
        console.error('Shipping calculation error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: 'Failed to calculate shipping',
                details: error.message 
            })
        };
    }
};
