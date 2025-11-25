// /.netlify/functions/getClientIp

exports.handler = async function (event) {
    // Netlify provides the client IP in the headers
    const clientIp = event.headers['client-ip'] || event.headers['x-nf-client-connection-ip'];

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: clientIp || 'unknown' }),
    };
};
