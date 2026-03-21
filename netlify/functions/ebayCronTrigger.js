// Lightweight cron that pings ebayFetchFunction every 30 minutes.
// No firebase-admin, no axios — just Node built-ins.
const https = require('https');

exports.handler = async () => {
  const siteUrl = process.env.URL || 'https://autoinx.com';
  const target  = `${siteUrl}/.netlify/functions/ebayFetchFunction`;

  console.log(`⏰ ebayCronTrigger firing → ${target}`);

  return new Promise((resolve) => {
    const req = https.request(target, { method: 'GET' }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        console.log(`✅ ebayFetchFunction responded ${res.statusCode}: ${body.slice(0, 200)}`);
        resolve({ statusCode: 200 });
      });
    });
    req.on('error', (err) => {
      console.error('❌ ebayCronTrigger error:', err.message);
      resolve({ statusCode: 500 });
    });
    req.end();
  });
};
