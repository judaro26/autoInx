const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();

// ─── Event calendar ────────────────────────────────────────────────────────────
// Each entry: { theme, month (1-based), day } for fixed-date holidays
// For variable-date holidays (Thanksgiving) we compute the date dynamically
function getEventDates(year) {
  return [
    { theme: 'newyear',      date: new Date(year,  0,  1) },  // Jan 1
    { theme: 'valentines',   date: new Date(year,  1, 14) },  // Feb 14
    { theme: 'stpatricks',   date: new Date(year,  2, 17) },  // Mar 17
    { theme: 'spring',       date: new Date(year,  2, 20) },  // Mar 20 (equinox)
    { theme: 'fourthofjuly', date: new Date(year,  6,  4) },  // Jul 4
    { theme: 'summer',       date: new Date(year,  5, 21) },  // Jun 21 (solstice)
    { theme: 'halloween',    date: new Date(year,  9, 31) },  // Oct 31
    { theme: 'thanksgiving', date: getNthWeekday(year, 10, 4, 4) }, // 4th Thu of Nov
    { theme: 'christmas',    date: new Date(year, 11, 25) },  // Dec 25
  ];
}

// Returns the Nth occurrence of a weekday (0=Sun..6=Sat) in a given month
function getNthWeekday(year, month, weekday, nth) {
  const d = new Date(year, month, 1);
  let count = 0;
  while (count < nth) {
    if (d.getDay() === weekday) count++;
    if (count < nth) d.setDate(d.getDate() + 1);
  }
  return d;
}

// ─── Core logic ────────────────────────────────────────────────────────────────
const AUTO_ENABLE_DAYS_BEFORE = 14;   // enable 2 weeks before the event
const AUTO_DISABLE_DAYS_AFTER  = 3;   // disable 3 days after the event

const handler = async () => {
  try {
    const now   = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // midnight local

    // Check current year AND next year (handles Dec → Jan crossover for New Year)
    const events = [
      ...getEventDates(today.getFullYear()),
      ...getEventDates(today.getFullYear() + 1),
    ];

    // Find the nearest upcoming (or recently past) event
    let targetEvent = null;
    let minDiff = Infinity;

    for (const event of events) {
      const eventDay = new Date(
        event.date.getFullYear(),
        event.date.getMonth(),
        event.date.getDate()
      );
      const diffMs   = today - eventDay;              // positive = event is past
      const diffDays = Math.round(diffMs / 86400000); // days since event (negative = future)

      // Within the active window: [-AUTO_ENABLE_DAYS_BEFORE .. +AUTO_DISABLE_DAYS_AFTER]
      if (diffDays >= -AUTO_ENABLE_DAYS_BEFORE && diffDays <= AUTO_DISABLE_DAYS_AFTER) {
        if (Math.abs(diffDays) < minDiff) {
          minDiff      = Math.abs(diffDays);
          targetEvent  = { ...event, diffDays };
        }
      }
    }

    // Fetch current config
    const configRef = db.collection('admin').doc('config');
    const configDoc = await configRef.get();
    const config    = configDoc.exists ? configDoc.data() : {};
    const banner    = config.seasonalBanner || {};

    console.log(`📅 Today: ${today.toISOString().split('T')[0]}`);
    console.log(`🎯 Target event: ${targetEvent ? targetEvent.theme + ' (day diff: ' + targetEvent.diffDays + ')' : 'none'}`);
    console.log(`🚩 Current banner: enabled=${banner.enabled}, theme=${banner.theme}, autoManaged=${banner.autoManaged}`);

    let update = null;

    if (targetEvent) {
      const withinWindow = targetEvent.diffDays >= -AUTO_ENABLE_DAYS_BEFORE
                        && targetEvent.diffDays <= AUTO_DISABLE_DAYS_AFTER;

      if (withinWindow && !banner.enabled) {
        // Auto-enable: banner is off and we're in the window
        update = {
          seasonalBanner: {
            enabled:     true,
            theme:       targetEvent.theme,
            message:     banner.message || '',   // preserve any custom message
            autoManaged: true,
            autoEnabledAt: admin.firestore.FieldValue.serverTimestamp(),
          }
        };
        console.log(`✅ Auto-enabling banner for: ${targetEvent.theme}`);

      } else if (withinWindow && banner.enabled && banner.autoManaged
                 && banner.theme !== targetEvent.theme) {
        // Theme changed (e.g. spring window overlaps St. Patrick's) — update theme
        update = {
          seasonalBanner: {
            ...banner,
            theme:       targetEvent.theme,
            autoManaged: true,
          }
        };
        console.log(`🔄 Switching auto-managed banner theme to: ${targetEvent.theme}`);
      }

    } else {
      // Outside all event windows
      if (banner.enabled && banner.autoManaged) {
        // Auto-disable: only turn off if WE turned it on
        update = {
          seasonalBanner: {
            ...banner,
            enabled:      false,
            autoManaged:  false,
            autoDisabledAt: admin.firestore.FieldValue.serverTimestamp(),
          }
        };
        console.log(`🔕 Auto-disabling banner (outside all event windows)`);
      } else {
        console.log(`ℹ️ No action needed — banner is ${banner.enabled ? 'manually enabled' : 'off'}`);
      }
    }

    if (update) {
      await configRef.set(update, { merge: true });
      console.log(`💾 Config updated:`, JSON.stringify(update.seasonalBanner));
    }

    return { statusCode: 200 };

  } catch (err) {
    console.error('❌ autoSeasonalBanner error:', err);
    return { statusCode: 500 };
  }
};

exports.handler = handler;
