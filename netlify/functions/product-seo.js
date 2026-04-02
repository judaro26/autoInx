/**
 * Netlify Function: product-seo.js
 *
 * Serves fully server-rendered HTML product pages for SEO crawlers and direct links.
 * Accessible at:  /p/:slug-:id  (via netlify.toml redirect)
 *
 * Why this matters: AutoInx products live in Firebase and render via JS modals.
 * Googlebot cannot see modal content — this function gives every product its own
 * crawlable, indexable page with full schema markup, images, and description.
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
    return admin.firestore();
}

function slugify(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmt(cents) {
    return '$' + ((cents || 0) / 100).toFixed(2);
}

function stripHtml(html) {
    return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

exports.handler = async function(event) {
    // Only handle GET
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    // Extract product ID from path: /p/oil-filter-abc123def → id = abc123def
    // Also accept ?id=PRODUCT_ID directly
    const path   = event.path || '';
    const qs     = event.queryStringParameters || {};
    let productId = qs.id || null;

    if (!productId) {
        // Try to extract from /p/slug-ID path
        const match = path.match(/\/p\/(.+?)(?:\/)?$/);
        if (match) {
            // Last segment after final hyphen group that looks like a Firestore ID (20 chars)
            const parts = match[1].split('-');
            // Firestore auto-IDs are 20 chars; if last segment looks like one use it
            const lastPart = parts[parts.length - 1];
            if (lastPart && lastPart.length >= 15) {
                productId = lastPart;
            } else {
                // Fall back: whole slug is the ID
                productId = match[1];
            }
        }
    }

    if (!productId) {
        return { statusCode: 302, headers: { Location: '/' }, body: '' };
    }

    try {
        const db = initAdmin();

        // Fetch product
        const docRef = db.collection('artifacts/default-app-id/public/data/items').doc(productId);
        const snap   = await docRef.get();

        if (!snap.exists) {
            return {
                statusCode: 404,
                headers: { 'Content-Type': 'text/html; charset=utf-8' },
                body: '<html><body><h1>Product Not Found</h1><a href="/">← Back to catalog</a></body></html>'
            };
        }

        const item = snap.data();
        const slug = slugify(item.name);
        const canonicalUrl = `https://autoinx.com/p/${slug}-${productId}`;
        const spaUrl       = `https://autoinx.com/?product=${encodeURIComponent(slug)}&id=${encodeURIComponent(productId)}`;

        // Images
        const rawUrls    = item.imageUrls || (item.imageUrl ? [item.imageUrl] : []);
        const isVideo    = u => /youtube|youtu\.be|vimeo|\.mp4|\.webm|drive\.google/.test(u);
        const images     = rawUrls.filter(u => !isVideo(u));
        const mainImage  = images[0] || 'https://autoinx.com/images/AutoInx logo.png';

        // Description
        const descPlain = stripHtml(item.description || '');
        const metaDesc  = descPlain.slice(0, 155) || `Shop ${item.name} at AutoInx — quality auto parts with fast US shipping.`;

        // Fetch a few related products from same category
        let related = [];
        if (item.catalogId) {
            const relSnap = await db
                .collection('artifacts/default-app-id/public/data/items')
                .where('catalogId', '==', item.catalogId)
                .limit(5)
                .get();
            related = relSnap.docs
                .filter(d => d.id !== productId && !d.data().temporarilyUnavailable)
                .slice(0, 4)
                .map(d => ({ id: d.id, ...d.data() }));
        }

        // Fetch category name
        let categoryName = 'Auto Parts';
        if (item.catalogId) {
            const catSnap = await db.collection('artifacts/default-app-id/public/data/catalogs').doc(item.catalogId).get();
            if (catSnap.exists) categoryName = catSnap.data().name || categoryName;
        }

        const inStock    = (item.stock || 0) > 0 && !item.temporarilyUnavailable;
        const price      = ((item.price || 0) / 100).toFixed(2);
        const pageTitle  = `${item.name} — ${fmt(item.price)} | AutoInx Auto Parts`;

        // JSON-LD schemas
        const productSchema = {
            '@context': 'https://schema.org',
            '@type': 'Product',
            name:        item.name,
            description: descPlain || undefined,
            sku:         item.sku  || productId,
            image:       images.length ? images : [mainImage],
            url:         canonicalUrl,
            brand:       { '@type': 'Brand', name: 'AutoInx' },
            offers: {
                '@type':           'Offer',
                price,
                priceCurrency:     'USD',
                availability:      inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
                url:               spaUrl,
                seller:            { '@type': 'Organization', name: 'AutoInx' },
                shippingDetails: {
                    '@type':             'OfferShippingDetails',
                    shippingRate:        { '@type': 'MonetaryAmount', value: '0', currency: 'USD', name: 'Free shipping available' },
                    deliveryTime:        { '@type': 'ShippingDeliveryTime', businessDays: { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday','Tuesday','Wednesday','Thursday','Friday'] } },
                    shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' }
                }
            }
        };

        const breadcrumbSchema = {
            '@context': 'https://schema.org',
            '@type':    'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'AutoInx',       item: 'https://autoinx.com/' },
                { '@type': 'ListItem', position: 2, name: categoryName,    item: `https://autoinx.com/?category=${encodeURIComponent(item.catalogId || '')}` },
                { '@type': 'ListItem', position: 3, name: item.name,       item: canonicalUrl },
            ]
        };

        // Related products HTML
        const relatedHtml = related.length === 0 ? '' : `
        <section style="max-width:900px;margin:2.5rem auto;padding:0 1rem;">
            <h2 style="font-size:1.2rem;font-weight:800;color:#4f46e5;margin-bottom:1rem;">🔧 More in ${escHtml(categoryName)}</h2>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1rem;">
                ${related.map(r => {
                    const rImg   = (r.imageUrls?.[0] || r.imageUrl || '');
                    const rSlug  = slugify(r.name);
                    const rUrl   = `/p/${rSlug}-${r.id}`;
                    return `<a href="${escHtml(rUrl)}" style="display:block;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;text-decoration:none;transition:box-shadow .15s;" onmouseover="this.style.boxShadow='0 4px 16px rgba(79,70,229,.15)'" onmouseout="this.style.boxShadow='none'">
                        ${rImg ? `<img src="${escHtml(rImg)}" alt="${escHtml(r.name)}" style="width:100%;height:130px;object-fit:contain;background:#f9fafb;padding:8px;" loading="lazy">` : ''}
                        <div style="padding:.75rem;">
                            <p style="font-size:.8rem;font-weight:700;color:#1f2937;margin:0 0 4px;line-height:1.3;">${escHtml(r.name)}</p>
                            <p style="font-size:.875rem;font-weight:900;color:#4f46e5;margin:0;">${fmt(r.price)}</p>
                        </div>
                    </a>`;
                }).join('')}
            </div>
        </section>`;

        // Gallery HTML
        const galleryHtml = images.length <= 1 ? '' : `
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.75rem;">
            ${images.slice(1).map(u => `<img src="${escHtml(u)}" alt="${escHtml(item.name)}" style="width:70px;height:70px;object-fit:contain;border:2px solid #e5e7eb;border-radius:8px;cursor:pointer;background:#f9fafb;" onclick="document.getElementById('mainImg').src=this.src" loading="lazy">`).join('')}
        </div>`;

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escHtml(pageTitle)}</title>
    <meta name="description" content="${escHtml(metaDesc)}">
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="${escHtml(canonicalUrl)}">

    <!-- Open Graph -->
    <meta property="og:type"        content="product">
    <meta property="og:title"       content="${escHtml(item.name)} — ${escHtml(fmt(item.price))} | AutoInx">
    <meta property="og:description" content="${escHtml(metaDesc)}">
    <meta property="og:image"       content="${escHtml(mainImage)}">
    <meta property="og:url"         content="${escHtml(canonicalUrl)}">
    <meta property="og:site_name"   content="AutoInx">
    <meta property="product:price:amount"   content="${price}">
    <meta property="product:price:currency" content="USD">

    <!-- Twitter Card -->
    <meta name="twitter:card"        content="summary_large_image">
    <meta name="twitter:title"       content="${escHtml(item.name)} | AutoInx">
    <meta name="twitter:description" content="${escHtml(metaDesc)}">
    <meta name="twitter:image"       content="${escHtml(mainImage)}">

    <!-- hreflang -->
    <link rel="alternate" hreflang="en" href="${escHtml(canonicalUrl)}">
    <link rel="alternate" hreflang="es" href="${escHtml(canonicalUrl)}">
    <link rel="alternate" hreflang="x-default" href="${escHtml(canonicalUrl)}">

    <!-- Schema.org -->
    <script type="application/ld+json">${JSON.stringify(productSchema)}</script>
    <script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>

    <link rel="icon" href="/images/AutoInx logo.ico">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap" rel="stylesheet">

    <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:'Inter',sans-serif;background:#f0f4ff;color:#1f2937;min-height:100vh;}
        a{color:#4f46e5;text-decoration:none;}
        a:hover{text-decoration:underline;}
        .badge{display:inline-block;padding:4px 12px;border-radius:9999px;font-size:.75rem;font-weight:700;}
        .badge-green{background:#dcfce7;color:#15803d;}
        .badge-red{background:#fee2e2;color:#dc2626;}
        .badge-gray{background:#f3f4f6;color:#6b7280;}
        .cta-btn{display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;font-weight:800;font-size:1rem;border-radius:12px;text-decoration:none;transition:opacity .15s;}
        .cta-btn:hover{opacity:.9;text-decoration:none;}
    </style>
</head>
<body>

    <!-- Header -->
    <header style="background:#fff;border-bottom:3px solid #4f46e5;padding:.75rem 1rem;position:sticky;top:0;z-index:10;box-shadow:0 2px 12px rgba(79,70,229,.08);">
        <div style="max-width:900px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:1rem;">
            <a href="/" style="display:flex;align-items:center;gap:10px;text-decoration:none;">
                <img src="/images/AutoInx logo.png" alt="AutoInx" style="height:36px;width:auto;" onerror="this.style.display='none'">
                <span style="font-size:1.3rem;font-weight:900;color:#4f46e5;">AutoInx</span>
            </a>
            <a href="/" class="cta-btn" style="padding:8px 20px;font-size:.85rem;">🛒 Shop All Parts</a>
        </div>
    </header>

    <!-- Breadcrumb -->
    <nav style="max-width:900px;margin:.75rem auto 0;padding:0 1rem;font-size:.8rem;color:#9ca3af;">
        <a href="/">Home</a>
        <span style="margin:0 6px;">›</span>
        <a href="/?category=${encodeURIComponent(item.catalogId || '')}">${escHtml(categoryName)}</a>
        <span style="margin:0 6px;">›</span>
        <span style="color:#374151;">${escHtml(item.name)}</span>
    </nav>

    <!-- Product card -->
    <main style="max-width:900px;margin:1.5rem auto;padding:0 1rem;">
        <div style="background:#fff;border-radius:20px;box-shadow:0 4px 24px rgba(0,0,0,.07);overflow:hidden;display:grid;grid-template-columns:1fr 1fr;gap:0;" class="product-grid">
            <style>.product-grid{grid-template-columns:1fr 1fr;}@media(max-width:640px){.product-grid{grid-template-columns:1fr!important;}}</style>

            <!-- Image -->
            <div style="background:#f9fafb;padding:2rem;display:flex;flex-direction:column;align-items:center;justify-content:center;border-right:1px solid #f3f4f6;">
                <img id="mainImg" src="${escHtml(mainImage)}" alt="${escHtml(item.name)}"
                     style="max-width:100%;max-height:340px;object-fit:contain;border-radius:8px;"
                     onerror="this.src='https://placehold.co/400x300/e5e7eb/9ca3af?text=No+Image'">
                ${galleryHtml}
            </div>

            <!-- Details -->
            <div style="padding:2rem;">
                <!-- Category tag -->
                <p style="font-size:.75rem;font-weight:700;color:#4f46e5;text-transform:uppercase;letter-spacing:.08em;margin-bottom:.5rem;">${escHtml(categoryName)}</p>

                <h1 style="font-size:1.5rem;font-weight:900;color:#1f2937;line-height:1.3;margin-bottom:.75rem;">${escHtml(item.name)}</h1>

                <!-- Price -->
                <div style="font-size:2rem;font-weight:900;color:#4f46e5;margin-bottom:1rem;">${escHtml(fmt(item.price))}</div>

                <!-- Stock badge -->
                ${item.temporarilyUnavailable
                    ? `<span class="badge badge-gray" style="margin-bottom:1rem;display:inline-block;">🔒 Temporarily Unavailable</span>`
                    : inStock
                        ? `<span class="badge badge-green" style="margin-bottom:1rem;display:inline-block;">✅ In Stock (${item.stock} available)</span>`
                        : `<span class="badge badge-red" style="margin-bottom:1rem;display:inline-block;">❌ Out of Stock</span>`}

                <!-- SKU -->
                ${item.sku ? `<p style="font-size:.8rem;color:#9ca3af;margin-bottom:1rem;">SKU: <span style="color:#374151;font-weight:600;">${escHtml(item.sku)}</span></p>` : ''}

                <!-- CTA -->
                <div style="margin-bottom:1.5rem;">
                    <a href="${escHtml(spaUrl)}" class="cta-btn" style="width:100%;display:block;text-align:center;">
                        🛒 ${inStock ? 'Add to Cart' : 'View Product'}
                    </a>
                    <p style="font-size:.75rem;color:#9ca3af;margin-top:.5rem;text-align:center;">Secure checkout · Fast US shipping · 30-day returns</p>
                </div>

                <!-- Trust signals -->
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;font-size:.75rem;color:#6b7280;border-top:1px solid #f3f4f6;padding-top:1rem;">
                    <span>📦 USPS · UPS · FedEx</span>
                    <span>🔒 Secure Checkout</span>
                    <span>↩️ 30-Day Returns</span>
                    <span>🏠 Family-Owned · Hayward, CA</span>
                </div>
            </div>
        </div>

        <!-- Description -->
        ${descPlain ? `
        <div style="background:#fff;border-radius:16px;padding:2rem;margin-top:1.5rem;box-shadow:0 2px 12px rgba(0,0,0,.05);">
            <h2 style="font-size:1.1rem;font-weight:800;color:#1f2937;margin-bottom:1rem;">📋 Product Details</h2>
            <div style="color:#374151;line-height:1.8;font-size:.9rem;">${item.description || descPlain}</div>
        </div>` : ''}

        ${relatedHtml}

    </main>

    <!-- Footer -->
    <footer style="background:#111827;color:#9ca3af;padding:2rem 1rem;margin-top:3rem;text-align:center;">
        <p style="font-weight:700;color:#e5e7eb;margin-bottom:.5rem;">AutoInx — Family-Owned Auto Parts · Hayward, CA</p>
        <p style="font-size:.8rem;margin-bottom:.75rem;">
            <a href="mailto:support@autoinx.com" style="color:#818cf8;">support@autoinx.com</a> ·
            <a href="tel:+19377016185" style="color:#818cf8;">(937) 701-6185</a>
        </p>
        <p style="font-size:.75rem;">
            <a href="/terms.html" style="color:#6b7280;margin:0 8px;">Terms</a>
            <a href="/privacy.html" style="color:#6b7280;margin:0 8px;">Privacy</a>
            <a href="/about.html" style="color:#6b7280;margin:0 8px;">About</a>
        </p>
    </footer>

</body>
</html>`;

        return {
            statusCode: 200,
            headers: {
                'Content-Type':  'text/html; charset=utf-8',
                'Cache-Control': 'public, max-age=3600, s-maxage=86400',
                'X-Robots-Tag':  'index, follow',
            },
            body: html,
        };

    } catch (err) {
        console.error('product-seo error:', err);
        return { statusCode: 302, headers: { Location: '/' }, body: '' };
    }
};
