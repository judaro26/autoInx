exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

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
        const { subtotalCents, state: orderState, zipCode } = JSON.parse(event.body);
        
        // Tax rates by state (simplified - you may want to use TaxJar API for production)
        const taxRates = {
            'CA': 0.0825,  // California
            'CO': 0.029,   // Colombia (if applicable)
            'NY': 0.04,
            'TX': 0.0625,
            'FL': 0.06,
            // Add more states as needed
        };

        const taxRate = taxRates[orderState] || 0;
        const taxCents = Math.round(subtotalCents * taxRate);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                taxCents: taxCents,
                taxRate: taxRate,
                taxRatePercent: (taxRate * 100).toFixed(2)
            })
        };

    } catch (error) {
        console.error('Tax calculation error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: 'Failed to calculate tax',
                details: error.message 
            })
        };
    }
};
