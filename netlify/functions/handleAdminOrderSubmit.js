async function handleAdminOrderSubmit(e) {
    e.preventDefault();
    resetTimer();

    const form = document.getElementById('createOrderForm');
    const deliveryAddress = document.getElementById('deliveryAddress');
    const submitButton = document.getElementById('submitOrderButton');

    // 1. Get Form Data
    const buyerName = form.buyerName.value.trim();
    const buyerEmail = form.buyerEmail.value.trim();
    const buyerPhone = form.buyerPhone.value.trim();
    const orderNotes = form.orderNotes.value.trim();
    const buyerLanguage = form.buyerLanguage?.value.trim() || 'en';
    
    const email = buyerEmail;
    const name = buyerName;
    const phone = buyerPhone;
    const address = deliveryAddress.value.trim();
    const itemsToOrder = Object.values(state.adminCart);

    // 1.1 Validation
    if (itemsToOrder.length === 0) {
        return showMessage('error', 'The order cart is empty.', 3000, 'orders');
    }
    
    if (deliveryAddress.dataset.validated !== 'true') {
        return showMessage('error', 'Please select a valid delivery address from the dropdown.', 5000, 'orders');
    }

    // 1.2 Get Geolocation (if available)
    let geolocation = null;
    if (autocomplete && autocomplete.getPlace) {
        const place = autocomplete.getPlace();
        if (place.geometry && place.geometry.location) {
            geolocation = { 
                lat: place.geometry.location.lat(), 
                lng: place.geometry.location.lng() 
            };
        }
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Creating order...';

    try {
        // 2. Calculate Totals - Use pre-calculated shipping/tax from state
        const cartTotalCents = itemsToOrder.reduce((s, e) => s + e.item.price * e.quantity, 0);
        const shippingCents = state.adminOrderShippingCents || 0;
        const taxCents = state.adminOrderTaxCents || 0;
        const finalTotalCents = cartTotalCents + shippingCents + taxCents;

        console.log('💰 Order Totals:', {
            subtotal: formatPriceDisplay(cartTotalCents),
            shipping: formatPriceDisplay(shippingCents),
            tax: formatPriceDisplay(taxCents),
            total: formatPriceDisplay(finalTotalCents)
        });

        // 3. Prepare Order Data
        const whatsappConsent = document.getElementById('adminWhatsappOpt')?.checked || false;
        const smsConsent = document.getElementById('adminSmsOpt')?.checked || false;
        
        const orderData = {
            buyerEmail: email,
            buyerName: name,
            buyerPhone: phone,
            deliveryAddress: address,
            whatsappConsent: whatsappConsent,
            smsConsent: smsConsent,
            notificationPreferences: {
                whatsapp: whatsappConsent,
                sms: smsConsent,
                email: true
            },
            items: itemsToOrder.map(e => ({
                id: e.item.id,
                name: e.item.name,
                sku: e.item.sku || null,
                price: e.item.price,
                quantity: e.quantity
            })),
            subtotalCents: cartTotalCents,
            shippingCents: shippingCents,
            taxCents: taxCents,
            totalCents: finalTotalCents,
            shippingDetails: state.adminOrderShippingDetails,
            taxDetails: state.adminOrderTaxDetails,
            userId: auth.currentUser.uid,
            createdByAdmin: auth.currentUser.uid,
            timestamp: new Date().toISOString(),
            geolocation: geolocation,
            adminNotes: orderNotes,
            language: buyerLanguage,
            communicationLang: buyerLanguage
        };

        // 4. Submit Order to Backend
        const idToken = await auth.currentUser.getIdToken();
        const res = await fetch(ADMIN_CREATE_ORDER_FUNCTION, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${idToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(orderData)
        });
        
        if (!res.ok) {
            const errorDetails = await res.json();
            throw new Error(errorDetails.details || 'Order creation failed on server.');
        }
        
        const orderCreationResponse = await res.json();
        const finalOrderId = orderCreationResponse.orderId || 'ADMIN_ORDER_ID';
        
        console.log('✅ Order created:', finalOrderId);

        // 5. Update Inventory
        const inventoryUpdates = itemsToOrder.map(async entry => {
            const itemId = entry.item.id;
            const orderQty = entry.quantity;
            const currentItem = state.items.find(i => i.id === itemId);
            
            if (!currentItem) return;

            const newStock = Math.max(0, (currentItem.stock || 0) - orderQty);
            
            const itemRef = doc(db, ITEMS_COLLECTION, itemId);
            await updateDoc(itemRef, { stock: newStock });

            await logAdminAction('INVENTORY_DECREASED', { 
                itemId, 
                item: currentItem.name, 
                action: 'remove', 
                amount: orderQty, 
                oldStock: currentItem.stock, 
                newStock 
            }, itemId);
        });
        
        await Promise.all(inventoryUpdates);
        console.log('✅ Inventory updated');
        
        // 6. Send Confirmation Email
        const emailPayload = {
            ...orderData,
            orderId: finalOrderId,
            adminEmail: auth.currentUser?.email,
            requesterEmail: auth.currentUser?.email,
            language: buyerLanguage
        };
        
        try {
            const emailRes = await fetch(EMAIL_CONFIRMATION_FUNCTION, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(emailPayload)
            });

            if (emailRes.ok) {
                console.log('✅ Confirmation email sent');
            } else {
                console.warn('⚠️ Email send failed, but order was created');
            }
        } catch (emailError) {
            console.error('Email error:', emailError);
            // Don't fail the whole order if email fails
        }
        
        // 7. Success - Reset Form and State
        state.adminCart = {};
        state.adminOrderShippingCents = 0;
        state.adminOrderTaxCents = 0;
        state.adminOrderShippingDetails = null;
        state.adminOrderTaxDetails = null;
        
        form.reset();
        deliveryAddress.dataset.validated = 'false';
        deliveryAddress.classList.remove('address-valid');
        deliveryAddress.classList.add('address-invalid');
        
        showMessage('success', 
            `✅ Order ${finalOrderId.substring(0, 8)} created successfully!\n` +
            `Subtotal: ${formatPriceDisplay(cartTotalCents)}\n` +
            `Shipping: ${formatPriceDisplay(shippingCents)}\n` +
            `Tax: ${formatPriceDisplay(taxCents)}\n` +
            `Total: ${formatPriceDisplay(finalTotalCents)}`, 
            10000, 'orders'
        );
        
        // Refresh orders list
        window.module.fetchOrders();

    } catch (error) {
        console.error('❌ Error creating order:', error);
        showMessage('error', `Failed to create order: ${error.message}`, 10000, 'orders');
    } finally {
        submitButton.textContent = 'SUBMIT ORDER & SEND EMAIL';
        submitButton.disabled = false;
        updateAdminCartDisplay();
    }
}
