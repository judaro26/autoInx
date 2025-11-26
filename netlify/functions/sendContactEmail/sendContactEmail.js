// --- Netlify Handler ---
exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: "Method Not Allowed" }),
        };
    }

    // ... (Rate Limiting and Honeypot checks remain here)
    // ... (Lines 34 to 125, the existing setup code)

    // 3. Record the current request timestamp
    rateLimitStore[clientIp].push(now);

    try {
        const { name, email, subjectType, message, urlCheck } = JSON.parse(event.body);

        // 4. --- Honeypot Check (Bot Mitigation) ---
        if (urlCheck) {
            console.warn(`Honeypot triggered by IP: ${clientIp}`);
            return { statusCode: 200, body: JSON.stringify({ message: "Thank you for your submission (bot detected)" }) };
        }
        
        // 5. --- Input Validation ---
        if (!name || !email || !subjectType || !message) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
        }

        // 6. --- Prepare Email Data & Recipients ---
        const adminRecipient =
            subjectType === "order" ? "orders@autoinx.com" : "support@autoinx.com";
            
        const customerRecipient = email;
        
        // Send the email to BOTH the admin/orders address AND the customer's email.
        const allRecipients = [adminRecipient, customerRecipient]; 

        const currentTime = new Date();
        const runtimeData = {
            // For the template, we'll use the ADMIN recipient's email address in the 'Enviado automáticamente a:' footer.
            recipientEmail: adminRecipient, 
            timestamp: currentTime.toLocaleDateString('es-CO') + ' ' + currentTime.toLocaleTimeString('es-CO'),
            ip: clientIp,
        };

        // Generate the HTML body (this is the admin's copy of the submission)
        const htmlBody = await getContactTemplate({ name, email, subjectType, message }, runtimeData);

        // 7. --- Send Email ---
        
        // Separate Subject for Customer vs. Admin
        const adminSubject = subjectType === "order"
            ? `[Order Inquiry] New Question from ${name}`
            : `[General Support] New Message from ${name}`;

        const customerSubject = `Copia de tu Consulta - AutoInx`;
        
        // Send Admin/Customer emails separately to customize the subject line for each recipient.
        
        // 7a. Send to Admin/Orders
        await transporter.sendMail({
            from: "noreply@autoinx.com", 
            to: adminRecipient, // Only admin receives the original admin-focused subject
            subject: adminSubject,
            html: htmlBody,
            replyTo: email,
        });

        // 7b. Send copy to Customer
        await transporter.sendMail({
            from: "noreply@autoinx.com", 
            to: customerRecipient, // Only customer receives the copy
            subject: customerSubject, // Friendly subject for customer
            html: htmlBody, // Use the same generated HTML body
            replyTo: adminRecipient, // Customer can reply to the admin/orders address
        });


        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Email sent successfully to admin and submitter.", recipient: customerRecipient }),
        };
    } catch (error) {
        console.error("Email Processing Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to process contact submission", details: error.message }),
        };
    }
};
