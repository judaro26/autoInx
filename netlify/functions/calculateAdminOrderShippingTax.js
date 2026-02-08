async function calculateAdminOrderShippingTax() {
    const addressInput = document.getElementById('deliveryAddress');
    const address = addressInput?.value?.trim();
    
    if (!address || addressInput.dataset.validated !== 'true') {
        // Reset if address is invalid
        state.adminOrderShippingCents = 0;
        state.adminOrderTaxCents = 0;
        state.adminOrderShippingDetails = null;
        state.adminOrderTaxDetails = null;
        updateAdminCartDisplay();
        return;
    }

    const submitButton = document.getElementById('submitOrderButton');
    if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Calculating shipping...';
    }

    try {
        // Parse address for state/zip
        const addressParts = address.split(',');
        const stateZip = addressParts[addressParts.length - 2]?.trim().split(' ') || [];
        const orderState = stateZip[0] || 'CA';
        const zipCode = stateZip[1] || '00000';

        // Calculate total weight (1 lb per item as example)
        const totalWeight = Object.values(state.adminCart).reduce((sum, e) => sum + e.quantity, 0);
        const cartTotalCents = Object.values(state.adminCart).reduce((s, e) => s + e.item.price * e.quantity, 0);

        // 1. Calculate Shipping
        try {
            const shippingRes = await fetch('/.netlify/functions/calculateShipping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    addressTo: {
                        name: document.getElementById('buyerName')?.value || 'Customer',
                        street1: addressParts[0]?.trim() || address,
                        city: addressParts[1]?.trim() || 'Unknown',
                        state: orderState,
                        zip: zipCode,
                        country: 'US'
                    },
                    parcels: [{
                        length: "12",
                        width: "8",
                        height: "6",
                        distance_unit: "in",
                        weight: Math.max(1, totalWeight).toString(),
                        mass_unit: "lb"
                    }]
                })
            });

            if (shippingRes.ok) {
                const shippingData = await shippingRes.json();
                if (shippingData.bestRate) {
                    state.adminOrderShippingCents = Math.round(shippingData.bestRate.amount * 100);
                    state.adminOrderShippingDetails = {
                        provider: shippingData.bestRate.provider,
                        servicelevel: shippingData.bestRate.servicelevel?.name || 'Standard',
                        amount: shippingData.bestRate.amount,
                        estimated_days: shippingData.bestRate.estimated_days
                    };
                    console.log('✅ Shipping calculated:', shippingData.bestRate);
                }
            } else {
                console.warn('Shipping API failed, using default');
                state.adminOrderShippingCents = 1000; // $10 default
                state.adminOrderShippingDetails = { provider: 'Standard', amount: 10 };
            }
        } catch (shippingError) {
            console.error('Shipping calculation error:', shippingError);
            state.adminOrderShippingCents = 1000;
            state.adminOrderShippingDetails = { provider: 'Standard', amount: 10 };
        }

        if (submitButton) submitButton.textContent = 'Calculating tax...';

        // 2. Calculate Tax
        try {
            const taxRes = await fetch('/.netlify/functions/calculateTax', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    subtotalCents: cartTotalCents,
                    state: orderState,
                    zipCode: zipCode
                })
            });

            if (taxRes.ok) {
                const taxData = await taxRes.json();
                state.adminOrderTaxCents = taxData.taxCents || 0;
                state.adminOrderTaxDetails = {
                    rate: taxData.taxRate,
                    ratePercent: taxData.taxRatePercent
                };
                console.log('✅ Tax calculated:', taxData);
            } else {
                console.warn('Tax API failed, using 0');
                state.adminOrderTaxCents = 0;
            }
        } catch (taxError) {
            console.error('Tax calculation error:', taxError);
            state.adminOrderTaxCents = 0;
        }

        // Re-render cart with updated totals
        updateAdminCartDisplay();

    } catch (error) {
        console.error('Calculation error:', error);
        showMessage('error', 'Failed to calculate shipping/tax. Using defaults.', 5000, 'orders');
    } finally {
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = 'SUBMIT ORDER & SEND EMAIL';
        }
    }
}
