/**
 * Netlify Function to read the local password reset HTML template.
 */
const fs = require('fs');
const path = require('path');

exports.handler = async function (event, context) {
    // We expect this to be called via internal fetch or client fetch.
    
    try {
        const templatePath = path.join(__dirname, 'emailTemplates', 'passwordResetTemplate.html');
        
        // Read the template content synchronously (safe in serverless functions)
        const template = fs.readFileSync(templatePath, 'utf8');

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html',
            },
            body: template,
        };
    } catch (error) {
        console.error('Error fetching local email template:', error);
        if (error.code === 'ENOENT') {
            console.error(`File not found at: ${path.join(__dirname, 'emailTemplates', 'passwordResetTemplate.html')}`);
        }
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch local email template', message: error.message }),
        };
    }
};
