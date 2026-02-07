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
        const highestRate = sortedRates[sortedRates.length - 1];
        const lowestRate = sortedRates[0];
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                allRates: sortedRates.map(r => ({
                    provider: r.provider,
                    servicelevel: r.servicelevel.name,
                    amount: parseFloat(r.amount),
                    currency: r.currency,
                    estimated_days: r.estimated_days
                })),
                // Return HIGHEST rate so customer sees max possible cost
                displayRate: {
                    provider: highestRate.provider,
                    servicelevel: highestRate.servicelevel.name,
                    amount: parseFloat(highestRate.amount),
                    currency: highestRate.currency,
                    estimated_days: highestRate.estimated_days
                },
                // Also include lowest for admin reference
                lowestRate: {
                    provider: lowestRate.provider,
                    amount: parseFloat(lowestRate.amount),
                    currency: lowestRate.currency
                },
                // Keep bestRate for backward compatibility (but use displayRate instead)
                bestRate: {
                    provider: highestRate.provider,
                    amount: parseFloat(highestRate.amount),
                    currency: highestRate.currency,
                    estimated_days: highestRate.estimated_days
                }
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
