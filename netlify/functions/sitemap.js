/**
 * Netlify Function: sitemap.js
 *
 * Generates a dynamic sitemap.xml by reading live catalog items from Firestore.
 * Each in-stock product gets its own URL: https://autoinx.com/?product=SLUG&id=ID
 *
 * Deploy at: /.netlify/functions/sitemap
 * Route via netlify.toml:  /sitemap.xml -> /.netlify/functions/sitemap
 */

const admin = require('firebase-admin');

function initAdmin() {
    if (admin.apps.length === 0) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId:   process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
        });
    }
}

function slugify(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function escapeXml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Static pages that are always in the sitemap
const STATIC_PAGES = [
    { url: 'https://autoinx.com/',                  changefreq: 'weekly',  priority: '1.0' },
    { url: 'https://autoinx.com/track-order.html',  changefreq: 'monthly', priority: '0.5' },
    { url: 'https://autoinx.com/about.html',        changefreq: 'monthly', priority: '0.4' },
    { url: 'https://autoinx.com/contact.html',      changefreq: 'monthly', priority: '0.4' },
    { url: 'https://autoinx.com/terms.html',        changefreq: 'yearly',  priority: '0.3' },
    { url: 'https://autoinx.com/privacy.html',      changefreq: 'yearly',  priority: '0.3' },
];

exports.handler = async function(event) {
    const CACHE_SECONDS = 3600;

    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method not allowed' };
    }

    try {
        initAdmin();
        const db = admin.firestore();

        const snap = await db
            .collection('artifacts/default-app-id/public/data/items')
            .get();

        const today = new Date().toISOString().slice(0, 10);

        const productUrls = snap.docs
            .map(doc => {
                const item = doc.data();
                if (item.temporarilyUnavailable === true) return null;

                const slug = slugify(item.name);
                if (!slug) return null;

                const url     = `https://autoinx.com/?product=${encodeURIComponent(slug)}&id=${encodeURIComponent(doc.id)}`;
                const lastmod = item.updatedAt?._seconds
                    ? new Date(item.updatedAt._seconds * 1000).toISOString().slice(0, 10)
                    : today;

                return { url, lastmod, changefreq: 'weekly', priority: '0.8' };
            })
            .filter(Boolean);

        const urlEntries = [
            ...STATIC_PAGES.map(p => `
    <url>
        <loc>${escapeXml(p.url)}</loc>
        <lastmod>${today}</lastmod>
        <changefreq>${p.changefreq}</changefreq>
        <priority>${p.priority}</priority>
    </url>`),
            ...productUrls.map(p => `
    <url>
        <loc>${escapeXml(p.url)}</loc>
        <lastmod>${escapeXml(p.lastmod)}</lastmod>
        <changefreq>${p.changefreq}</changefreq>
        <priority>${p.priority}</priority>
    </url>`),
        ].join('');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
            http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
${urlEntries}
</urlset>`;

        console.log(`✅ Sitemap generated: ${productUrls.length} products + ${STATIC_PAGES.length} static pages`);

        return {
            statusCode: 200,
            headers: {
                'Content-Type':  'application/xml; charset=utf-8',
                'Cache-Control': `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
                'X-Robots-Tag':  'noindex',   // Don't index the sitemap URL itself
            },
            body: xml,
        };

    } catch (err) {
        console.error('Sitemap generation error:', err);

        const fallback = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://autoinx.com/</loc></url>
</urlset>`;

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
            body: fallback,
        };
    }
};
