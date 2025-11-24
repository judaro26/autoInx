/**
 * Netlify Function to get or initialize Admin configuration from Firestore.
 * This includes the dynamic IP Whitelist and Maintenance Mode status.
 */
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
// ... (omitted initialization details)
    }),
  });
}

const db = admin.firestore();
const CONFIG_DOC_PATH = 'admin/config'; // Collection 'admin', Document 'config'

exports.handler = async function (event) {
    try {
        // FIX: Correctly reference the full document path using db.doc()
        const configRef = db.doc(CONFIG_DOC_PATH);
        const configDoc = await configRef.get();

        if (!configDoc.exists) {
            // Initialize config if it doesn't exist
            const initialConfig = {
                ipWhitelist: ["127.0.0.1"], // Default IP
                maintenanceMode: false,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            };
            await configRef.set(initialConfig);
// ... (omitted response) ...
