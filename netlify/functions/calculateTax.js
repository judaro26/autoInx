const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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
        const { 
            subtotalCents, 
            state: orderState, 
            zipCode,
            // ✅ NEW: Accept full address for accurate calculation
            street,
            city,
            country = 'US'
        } = JSON.parse(event.body);

        console.log('📋 Calculating tax for:', { 
            subtotalCents, 
            address: `${street}, ${city}, ${orderState} ${zipCode}` 
        });

        // ✅ STRIPE TAX CALCULATION (Primary Method)
        try {
            const taxCalculation = await stripe.tax.calculations.create({
                currency: 'usd',
                line_items: [
                    {
                        amount: subtotalCents,
                        reference: 'order-subtotal',
                    },
                ],
                customer_details: {
                    address: {
                        line1: street || 'Unknown',
                        city: city || 'Unknown',
                        state: orderState,
                        postal_code: zipCode,
                        country: country,
                    },
                    address_source: 'shipping',
                },
                // ✅ Configure based on your business location
                shipping_cost: {
                    amount: 0, // We calculate shipping separately
                },
            });

            console.log('✅ Stripe Tax calculated:', taxCalculation);

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    taxCents: taxCalculation.tax_amount_exclusive || 0,
                    taxRate: taxCalculation.tax_breakdown?.[0]?.tax_rate_details?.percentage_decimal 
                        ? parseFloat(taxCalculation.tax_breakdown[0].tax_rate_details.percentage_decimal) / 100 
                        : 0,
                    taxRatePercent: taxCalculation.tax_breakdown?.[0]?.tax_rate_details?.percentage_decimal || '0.00',
                    provider: 'stripe_tax',
                    jurisdiction: taxCalculation.tax_breakdown?.[0]?.jurisdiction || orderState,
                    taxBreakdown: taxCalculation.tax_breakdown,
                    calculationId: taxCalculation.id // ✅ Store this for the actual transaction
                })
            };

        } catch (stripeError) {
            console.warn('⚠️ Stripe Tax failed, falling back to local calculation:', stripeError.message);
            
            // ✅ FALLBACK: Enhanced local calculation with city-level rates
            const taxData = getLocalTaxRate(orderState, zipCode, city);
            const taxCents = Math.round(subtotalCents * taxData.rate);

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    taxCents: taxCents,
                    taxRate: taxData.rate,
                    taxRatePercent: (taxData.rate * 100).toFixed(2),
                    provider: 'local_fallback',
                    jurisdiction: taxData.jurisdiction,
                    warning: 'Using fallback tax calculation. Consider enabling Stripe Tax for accurate rates.'
                })
            };
        }

    } catch (error) {
        console.error('❌ Tax calculation error:', error);
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

// ✅ ENHANCED FALLBACK: More accurate local rates with city/county data
function getLocalTaxRate(state, zipCode, city) {
    // Define your nexus states (states where you have physical presence or economic nexus)
    const nexusStates = ['CA', 'NY', 'TX']; // ⚠️ UPDATE THIS based on your business
    
    if (!nexusStates.includes(state)) {
        return { rate: 0, jurisdiction: 'No nexus' };
    }

    // California - Most complex state with district taxes
    if (state === 'CA') {
        const caRates = {
            // San Francisco Bay Area
            '94102': { rate: 0.08625, jurisdiction: 'San Francisco' },
            '94103': { rate: 0.08625, jurisdiction: 'San Francisco' },
            '94104': { rate: 0.08625, jurisdiction: 'San Francisco' },
            '95101': { rate: 0.09125, jurisdiction: 'San Jose' },
            '94501': { rate: 0.10250, jurisdiction: 'Alameda' },
            '94502': { rate: 0.10250, jurisdiction: 'Alameda' },
            
            // Los Angeles Area
            '90001': { rate: 0.0950, jurisdiction: 'Los Angeles' },
            '90002': { rate: 0.0950, jurisdiction: 'Los Angeles' },
            '90210': { rate: 0.0950, jurisdiction: 'Beverly Hills' },
            
            // San Diego
            '92101': { rate: 0.0775, jurisdiction: 'San Diego' },
            
            // Add more ZIP codes as needed
        };

        return caRates[zipCode] || { 
            rate: 0.0725, // CA base rate
            jurisdiction: 'California (base rate)' 
        };
    }

    // New York
    if (state === 'NY') {
        const nyRates = {
            // NYC has combined state + city tax
            '10001': { rate: 0.08875, jurisdiction: 'New York City' },
            '10002': { rate: 0.08875, jurisdiction: 'New York City' },
            '11201': { rate: 0.08875, jurisdiction: 'Brooklyn' },
            
            // Upstate NY (state rate only)
            '12180': { rate: 0.04, jurisdiction: 'Troy' },
        };

        return nyRates[zipCode] || { 
            rate: 0.04, // NY state rate
            jurisdiction: 'New York State' 
        };
    }

    // Texas
    if (state === 'TX') {
        const txRates = {
            '75201': { rate: 0.0825, jurisdiction: 'Dallas' },
            '77001': { rate: 0.0825, jurisdiction: 'Houston' },
            '78701': { rate: 0.0825, jurisdiction: 'Austin' },
        };

        return txRates[zipCode] || { 
            rate: 0.0625, // TX state rate
            jurisdiction: 'Texas' 
        };
    }

    // Other states - add as needed
    const stateRates = {
        'FL': { rate: 0.06, jurisdiction: 'Florida' },
        'WA': { rate: 0.065, jurisdiction: 'Washington' },
        'IL': { rate: 0.0625, jurisdiction: 'Illinois' },
        'PA': { rate: 0.06, jurisdiction: 'Pennsylvania' },
        'OH': { rate: 0.0575, jurisdiction: 'Ohio' },
    };

    return stateRates[state] || { rate: 0, jurisdiction: 'No rate configured' };
}
