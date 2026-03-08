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
            shippingCents = 0,
            state: orderState, 
            zipCode,
            street,
            city,
            country = 'US'
        } = JSON.parse(event.body);

        console.log('📋 Calculating tax for:', { 
            subtotalCents,
            shippingCents,
            address: `${street}, ${city}, ${orderState} ${zipCode}` 
        });

        // ✅ TRY STRIPE TAX FIRST
        try {
            const taxCalculation = await stripe.tax.calculations.create({
                currency: 'usd',
                line_items: [
                    {
                        amount: subtotalCents,
                        reference: 'order-subtotal',
                        tax_behavior: 'exclusive',      // tax is added on top — matches checkout display
                        tax_code: 'txcd_99999999',      // General tangible goods (auto parts)
                    },
                    // Include shipping in the tax calculation if present
                    ...(shippingCents > 0 ? [{
                        amount: shippingCents,
                        reference: 'shipping',
                        tax_behavior: 'exclusive',
                        tax_code: 'txcd_92010001',      // Shipping / delivery
                    }] : []),
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
            });

            console.log('✅ Stripe Tax response:', taxCalculation);

            // ✅ CHECK IF STRIPE IS ACTUALLY COLLECTING TAX
            const isCollecting = taxCalculation.tax_amount_exclusive > 0;
            const notCollectingReason = taxCalculation.tax_breakdown?.[0]?.taxability_reason;

            if (!isCollecting && notCollectingReason === 'not_collecting') {
                console.warn('⚠️ Stripe Tax not configured for this state - using fallback');
                throw new Error('Stripe Tax not collecting - use fallback');
            }

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
                    calculationId: taxCalculation.id
                })
            };

        } catch (stripeError) {
            console.warn('⚠️ Stripe Tax failed or not collecting, using fallback:', stripeError.message);
            
            // ✅ FALLBACK: Local calculation with enhanced rates
            const taxData = getLocalTaxRate(orderState, zipCode, city);
            
            if (taxData.rate === 0) {
                console.log('ℹ️ No tax nexus in', orderState);
            }
            
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
                    warning: 'Using fallback tax calculation. Configure Stripe Tax for accurate rates.'
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

// ✅ ENHANCED FALLBACK with California district rates
function getLocalTaxRate(state, zipCode, city) {
    // ⚠️ IMPORTANT: Update this array with states where you have nexus
    const nexusStates = ['CA']; // Add states where you're registered to collect tax
    
    if (!nexusStates.includes(state)) {
        return { rate: 0, jurisdiction: 'No nexus' };
    }

    // California - Detailed rates by ZIP code
    if (state === 'CA') {
        const caRates = {
            // San Francisco Bay Area
            '94102': { rate: 0.08625, jurisdiction: 'San Francisco' },
            '94103': { rate: 0.08625, jurisdiction: 'San Francisco' },
            '95101': { rate: 0.09125, jurisdiction: 'San Jose' },
            '94501': { rate: 0.10250, jurisdiction: 'Alameda' },
            '94502': { rate: 0.10250, jurisdiction: 'Alameda' },
            
            // Los Angeles Area
            '90001': { rate: 0.0950, jurisdiction: 'Los Angeles' },
            '90002': { rate: 0.0950, jurisdiction: 'Los Angeles' },
            '90210': { rate: 0.0950, jurisdiction: 'Beverly Hills' },
            
            // San Diego
            '92101': { rate: 0.0775, jurisdiction: 'San Diego' },
            '92102': { rate: 0.0775, jurisdiction: 'San Diego' },
            
            // Sacramento
            '95814': { rate: 0.08750, jurisdiction: 'Sacramento' },
            '95815': { rate: 0.08750, jurisdiction: 'Sacramento' },
            
            // Stockton Area (your test address!)
            '95201': { rate: 0.09000, jurisdiction: 'Stockton' },
            '95202': { rate: 0.09000, jurisdiction: 'Stockton' },
            '95203': { rate: 0.09000, jurisdiction: 'Stockton' },
            '95204': { rate: 0.09000, jurisdiction: 'Stockton' },
            '95205': { rate: 0.09000, jurisdiction: 'Stockton' },
            '95206': { rate: 0.09000, jurisdiction: 'Stockton' },
            '95207': { rate: 0.09000, jurisdiction: 'Stockton' },
            '95208': { rate: 0.09000, jurisdiction: 'Stockton' },
            '95209': { rate: 0.09000, jurisdiction: 'Stockton' },
            '95210': { rate: 0.09000, jurisdiction: 'Stockton' },
            '95211': { rate: 0.09000, jurisdiction: 'Stockton' },
            '95212': { rate: 0.09000, jurisdiction: 'Stockton' },
            '95213': { rate: 0.09000, jurisdiction: 'Stockton' },
            
            // Add more ZIP codes as needed
        };

        return caRates[zipCode] || { 
            rate: 0.0725, // CA base state rate (7.25%)
            jurisdiction: 'California (base rate)' 
        };
    }

    return { rate: 0, jurisdiction: 'No rate configured' };
}
