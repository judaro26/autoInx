/**
 * Netlify Function: sitemap.js
 *
 * Generates a dynamic sitemap.xml by reading live catalog items from Firestore.
 * Each in-stock product gets its own URL: https://autoinx.com/?product=SLUG&id=ID
 *
 * Deploy at: /.netlify/functions/sitemap
 * Route via netlify.toml:  /sitemap.xml -> /.netlify/functions/sitemap
 *
 * Google will crawl /?product=SLUG&id=ID, which auto-opens the product modal
 * and injects product-specific <title>, <meta description>, and JSON-LD.
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
    { url: 'https://autoinx.com/',                   changefreq: 'weekly',  priority: '1.0' },
    { url: 'https://autoinx.com/track-order.html',   changefreq: 'monthly', priority: '0.5' },
    { url: 'https://autoinx.com/about.html',         changefreq: 'monthly', priority: '0.4' },
    { url: 'https://autoinx.com/contact.html',       changefreq: 'monthly', priority: '0.4' },
];

exports.handler = async function(event) {
    // Cache for 1 hour — balances freshness vs Firestore reads
    const CACHE_SECONDS = 3600;

    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method not allowed' };
    }

    try {
        initAdmin();
        const db = admin.firestore();

        // Fetch ALL items — filter in memory.
        // Firestore's != operator silently excludes docs where the field is absent,
        // which drops products created before the field existed.
        const snap = await db
            .collection('artifacts/default-app-id/public/data/items')
            .get();

        const today = new Date().toISOString().slice(0, 10);

        // Build product URL entries
        const productUrls = snap.docs
            .map(doc => {
                const item = doc.data();
                // Skip items explicitly marked as unavailable
                if (item.temporarilyUnavailable === true) return null;

                const slug = slugify(item.name);
                if (!slug) return null;

                // Use /p/slug-id URL — served by product-seo.js function for full SSR
                const url  = `https://autoinx.com/p/${slug}-${doc.id}`;
                const lastmod = item.updatedAt?._seconds
                    ? new Date(item.updatedAt._seconds * 1000).toISOString().slice(0, 10)
                    : today;

                // Collect first image for image sitemap
                const rawImgs = item.imageUrls || (item.imageUrl ? [item.imageUrl] : []);
                const images  = rawImgs.filter(u => u && !u.match(/youtube|youtu\.be|vimeo|\.mp4|\.webm/i));

                return { url, lastmod, changefreq: 'weekly', priority: '0.9', images, name: item.name };
            })
            .filter(Boolean);

        // Build XML
        const urlEntries = [
            ...STATIC_PAGES.map(p => `
    <url>
        <loc>${escapeXml(p.url)}</loc>
        <lastmod>${today}</lastmod>
        <changefreq>${p.changefreq}</changefreq>
        <priority>${p.priority}</priority>
    </url>`),
            ...productUrls.map(p => {
                const imgTags = (p.images || []).slice(0, 5).map(img =>
                    `
        <image:image><image:loc>${escapeXml(img)}</image:loc><image:title>${escapeXml(p.name || '')}</image:title></image:image>`
                ).join('');
                return `
    <url>
        <loc>${escapeXml(p.url)}</loc>
        <lastmod>${escapeXml(p.lastmod)}</lastmod>
        <changefreq>${p.changefreq}</changefreq>
        <priority>${p.priority}</priority>${imgTags}
    </url>`;
            }),
        ].join('');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
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
                'X-Robots-Tag':  'noindex',   // Don't index the sitemap itself
            },
            body: xml,
        };

    } catch (err) {
        console.error('Sitemap generation error:', err);

        // Return a minimal sitemap rather than a 500 — broken sitemaps hurt SEO
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
