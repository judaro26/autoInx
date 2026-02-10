/**
 * Netlify Function: generateShippingLabel.js
 * Purchases a shipping label from Shippo using a selected rate
 */

exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const { rateId, orderId } = JSON.parse(event.body);

        if (!rateId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Missing required field: rateId' })
            };
        }

        const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY;
        const TRANSACTION_URL = 'https://api.goshippo.com/transactions/';

        console.log('🎫 Purchasing label for rate:', rateId);
        console.log('📦 Order ID:', orderId?.substring(0, 8));

        // Purchase the label
        const transactionData = {
            rate: rateId,
            label_file_type: "PDF",
            async: false
        };

        const response = await fetch(TRANSACTION_URL, {
            method: 'POST',
            headers: {
                'Authorization': `ShippoToken ${SHIPPO_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(transactionData)
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('❌ Shippo transaction error:', errorData);
            throw new Error(errorData.detail || 'Failed to generate label');
        }

        const transaction = await response.json();

        if (transaction.status !== 'SUCCESS') {
            console.error('❌ Transaction failed:', transaction);
            throw new Error(transaction.messages?.[0] || 'Label generation failed');
        }

        console.log('✅ Label generated successfully');
        console.log('📋 Tracking:', transaction.tracking_number);

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                labelUrl: transaction.label_url,
                trackingNumber: transaction.tracking_number,
                trackingUrlProvider: transaction.tracking_url_provider,
                carrier: transaction.rate?.provider,
                servicelevel: transaction.rate?.servicelevel?.name,
                orderId: orderId,
                transactionId: transaction.object_id
            })
        };

    } catch (error) {
        console.error('❌ Generate Label Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to generate shipping label',
                details: error.message
            })
        };
    }
};
