// CommonHome Canvas — ambient screen SPIKE server.
//
// Serves the ambient composition and a single read-only snapshot endpoint.
//
// SECURITY POSTURE (the reason this is a server and not a browser fetch):
// Canvas Phase 6 states the rule plainly - bounded live data without moving
// source credentials into display clients. A living-room screen is shared with
// the whole household and any visitor, so neither the Home Assistant token nor
// the Unsplash key may be reachable from the page. This process holds both,
// calls the APIs itself, and returns ONLY the shaped fields the composition
// renders. No token, no entity ids, no raw upstream payloads cross to the
// browser.
//
// The snapshot endpoint is read-only by construction: it issues GETs and
// exposes no way to call a service, so a compromised display cannot actuate
// anything in the house.
//
// Run:  HA_URL=... HA_TOKEN=... UNSPLASH_ACCESS_KEY=... npx vite --config vite.ambient.config.ts
import {defineConfig} from 'vite';

// Configuration comes from src/server/config.ts so that no household value -
// no LAN address, no calendar entity, no person entity - survives as a literal
// in source. See that module for why each rule exists.
import {loadConfig} from './src/server/config.ts';

const {config: CONFIG, problems: CONFIG_PROBLEMS} = loadConfig();
for (const p of CONFIG_PROBLEMS) console.warn(`[canvas] config: ${p.key}: ${p.message}`);

const HA_URL = CONFIG.homeAssistant?.url ?? '';
const HA_TOKEN = CONFIG.homeAssistant?.token ?? '';
const UNSPLASH_KEY = CONFIG.photos?.accessKey ?? '';

// Identifies this application in the photo provider's required UTM parameters.
const APP_NAME = CONFIG.photos?.appName ?? 'commonhome_canvas';

// Explicit allowlist. Adding an entity is a deliberate act, not a side effect
// of the display asking for something new. Unset means the ambient screen
// omits that element, which it already handles.
const WEATHER = CONFIG.homeAssistant?.weatherEntity ?? '';
const CALENDAR = CONFIG.homeAssistant?.calendarEntity ?? '';
const PEOPLE = CONFIG.homeAssistant?.personEntities ?? [];

// Unsplash's "Wallpapers" topic: drone shots and landscapes intended as
// desktop backgrounds, which is the closest published topic to a calm wall
// display. content_filter=high is requested because this screen is in a room
// with children.
const UNSPLASH_TOPIC = 'bo8jQKTaE0Y';

const ALLOWED_HOSTS = CONFIG.allowedHosts;

type Photo = {
  url: string;
  color: string | null;
  blurHash: string | null;
  photographer: string;
  photographerUrl: string;
  source: string;
  sourceUrl: string;
};

type Snapshot = {
  weather: unknown;
  events: unknown[];
  peopleHome: string[];
  photo: Photo | null;
  generatedAt: string;
  degraded: string[];
};

async function ha(path: string): Promise<any> {
  const res = await fetch(`${HA_URL}/api/${path}`, {
    headers: {Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json'},
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HA ${path} -> ${res.status}`);
  return res.json();
}

/* Photo rotation is cached for hours, not fetched per snapshot.
 *
 * The demo tier allows 50 requests an hour and the snapshot endpoint is polled
 * every two minutes; fetching a photo each time would exhaust the quota in
 * about an hour and a half. A wall photo that changes a few times a day is
 * also simply calmer than one that changes while someone is looking at it.
 * Re-serving the same image URL costs no API request. */
const PHOTO_TTL_MS = 3 * 60 * 60 * 1000;
let photoCache: {photo: Photo; at: number} | null = null;

async function unsplashPhoto(): Promise<Photo | null> {
  if (!UNSPLASH_KEY) return null;
  if (photoCache && Date.now() - photoCache.at < PHOTO_TTL_MS) return photoCache.photo;

  const url = `https://api.unsplash.com/photos/random`
    + `?topics=${UNSPLASH_TOPIC}&orientation=landscape&content_filter=high`;
  const res = await fetch(url, {
    headers: {Authorization: `Client-ID ${UNSPLASH_KEY}`},
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`unsplash -> ${res.status}`);
  const d: any = await res.json();

  // Unsplash's API guidelines REQUIRE triggering the download endpoint each
  // time a photo is used as a background. It is not a download - it is how
  // photographers are credited with a use. Fire-and-forget so a slow response
  // never delays the screen, but never skipped.
  const dl = d?.links?.download_location;
  if (dl) {
    void fetch(dl, {
      headers: {Authorization: `Client-ID ${UNSPLASH_KEY}`},
      signal: AbortSignal.timeout(8000),
    }).catch(() => { /* credit ping is best-effort; the display must not block */ });
  }

  // Sized server-side via Unsplash's imgix parameters. The ixid in urls.raw is
  // preserved, as the guidelines require.
  const sized = `${d.urls.raw}&w=1920&h=1080&fit=crop&crop=entropy&auto=format&q=80`;
  const utm = `?utm_source=${APP_NAME}&utm_medium=referral`;

  const photo: Photo = {
    url: sized,
    color: d.color ?? null,
    blurHash: d.blur_hash ?? null,
    photographer: String(d.user?.name ?? 'Unknown'),
    photographerUrl: `${d.user?.links?.html ?? 'https://unsplash.com'}${utm}`,
    source: 'Unsplash',
    sourceUrl: `https://unsplash.com/${utm}`,
  };
  photoCache = {photo, at: Date.now()};
  return photo;
}

async function snapshot(): Promise<Snapshot> {
  const degraded: string[] = [];

  // Each source degrades independently. One failing provider must not blank a
  // household screen, so failures are recorded and the rest still renders.
  let weather = null;
  /* An unset entity is not a failure - it means this household did not
   * configure weather. Skipping explicitly avoids a pointless request and a
   * degraded-source entry that would read as a broken integration. */
  if (WEATHER) try {
    const s = await ha(`states/${WEATHER}`);
    weather = {
      state: String(s.state ?? 'unknown'),
      temperature: typeof s.attributes?.temperature === 'number'
        ? s.attributes.temperature : null,
      unit: String(s.attributes?.temperature_unit ?? ''),
      attribution: String(s.attributes?.attribution ?? ''),
    };
  } catch {
    degraded.push('weather');
  }

  let events: unknown[] = [];
  if (CALENDAR) try {
    const now = new Date();
    const end = new Date(now.getTime() + 36 * 3600 * 1000);
    const raw = await ha(
      `calendars/${CALENDAR}?start=${now.toISOString()}&end=${end.toISOString()}`,
    );
    events = (Array.isArray(raw) ? raw : [])
      .slice(0, 8)
      .map((e: any) => ({
        // Only these three fields leave the server. Descriptions and locations
        // are household-private and have no business on a wall display.
        summary: String(e.summary ?? 'Busy').slice(0, 120),
        start: String(e.start?.dateTime ?? e.start?.date ?? ''),
        allDay: Boolean(e.start?.date && !e.start?.dateTime),
      }))
      .filter((e: any) => e.start);
  } catch {
    degraded.push('calendar');
  }

  const peopleHome: string[] = [];
  for (const id of PEOPLE) {
    try {
      const s = await ha(`states/${id}`);
      if (s.state === 'home') {
        peopleHome.push(String(s.attributes?.friendly_name ?? id.split('.')[1]));
      }
    } catch {
      degraded.push('presence');
    }
  }

  let photo: Photo | null = null;
  try {
    photo = await unsplashPhoto();
  } catch {
    // A missing photo is a visual downgrade, not an outage: the composition
    // falls back to the flat canvas colour and everything else still renders.
    degraded.push('photo');
    photo = photoCache?.photo ?? null;
  }

  return {
    weather, events, peopleHome, photo,
    generatedAt: new Date().toISOString(),
    degraded,
  };
}

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 4174,
    strictPort: true,
    cors: false,
    allowedHosts: ALLOWED_HOSTS,
    // An appliance display has no use for hot reload, and a wall screen should
    // not hold an open websocket it never reads.
    hmr: false,
    fs: {strict: true},
  },
  plugins: [{
    name: 'ambient-spike',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const host = (req.headers.host || '').split(':')[0];
        if (!ALLOWED_HOSTS.includes(host)) {
          res.statusCode = 403;
          return res.end('Host not permitted.');
        }
        // Never serve repository internals from a display-facing process.
        //
        // node_modules is deliberately NOT blocked here. Vite's own client
        // runtime (/@vite/client) imports from /node_modules/vite/dist/..., so
        // blocking that path 404s Vite's runtime and every module import in the
        // page fails - the screen renders blank with no console error, because
        // the failure is a fetch rejection inside the module graph rather than
        // a thrown exception. Blocking it is a self-inflicted outage, not
        // hardening: the dependency tree is public npm packages, while the
        // private material is .git/.planning/.hermes, which stay blocked.
        if (/^\/(?:\.planning|\.git|\.hermes)(?:\/|$)/.test(req.url || '')) {
          res.statusCode = 404;
          return res.end('Not served.');
        }
        if (req.url?.split('?')[0] !== '/__ambient/snapshot') return next();
        if (req.method !== 'GET') {
          res.statusCode = 405;
          return res.end('GET required.');
        }
        try {
          const data = await snapshot();
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(data));
        } catch {
          // Shape is preserved on total failure so the client keeps rendering
          // its last known good snapshot instead of blanking.
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            weather: null, events: [], peopleHome: [], photo: null,
            generatedAt: new Date().toISOString(), degraded: ['all'],
          }));
        }
      });
    },
  }],
});
