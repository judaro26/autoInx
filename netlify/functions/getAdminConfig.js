exports.handler = async function (event) {
    
    const authHeader = event.headers.authorization;
    let isAdmin = false;

    // ✅ Auth is now optional — only attempt verification if a token is present
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const idToken = authHeader.split('Bearer ')[1];
        try {
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            isAdmin = decodedToken.admin === true;
        } catch (e) {
            // Invalid token — treat as unauthenticated, not an error
            isAdmin = false;
        }
    }

    try {
        const configRef = db.doc(CONFIG_DOC_PATH);
        const configDoc = await configRef.get();

        if (!configDoc.exists) {
            const initialConfig = {
                ipWhitelist: ["127.0.0.1"],
                maintenanceMode: false,
                chatWidgetEnabled: true,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            };
            await configRef.set(initialConfig);
            console.log('Admin config initialized.');
            
            // ✅ Return only public fields to unauthenticated callers
            if (!isAdmin) {
                const { ipWhitelist, ...publicConfig } = initialConfig;
                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(publicConfig),
                };
            }
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(initialConfig),
            };
        }

        const configData = configDoc.data();
        if (configData.chatWidgetEnabled === undefined) {
            configData.chatWidgetEnabled = true;
        }

        // ✅ Strip sensitive fields for public callers
        if (!isAdmin) {
            const { ipWhitelist, ...publicConfig } = configData;
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(publicConfig),
            };
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configData),
        };

    } catch (error) {
        console.error('Error fetching admin config:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch admin configuration', details: error.message }),
        };
    }
};
