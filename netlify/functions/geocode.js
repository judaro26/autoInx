// netlify/functions/geocode.js
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { address } = JSON.parse(event.body);
    
    // 1. Get the Key from Netlify Environment Variables
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;

    if (!apiKey) {
      console.error('SERVER ERROR: Missing GOOGLE_MAPS_API_KEY env var');
      return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
    }

    if (!address) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Address is required' }) };
    }

    // 2. Construct URL
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;

    // 3. Call Google Maps API using node-fetch
    const response = await fetch(url);
    const data = await response.json();

    // 4. Return the data to your frontend
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };

  } catch (error) {
    console.error('Geocode function error:', error);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: 'Failed to fetch geocode data' }) 
    };
  }
};
