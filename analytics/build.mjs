// Holt die täglichen Cloudflare-Web-Analytics-Zahlen (letzte 24 h) über die
// GraphQL-Analytics-API und hängt sie an analytics/history.json an.
// Läuft in GitHub Actions. Benötigt die Umgebungsvariablen:
//   CF_API_TOKEN  (GitHub-Secret, nur-lese "Account Analytics")
//   CF_ACCOUNT_ID (in analytics.yml gesetzt)
//   CF_SITE_TAG   (in analytics.yml gesetzt)
import fs from 'node:fs';

const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const SITE = process.env.CF_SITE_TAG;
const HIST = 'analytics/history.json';

if (!TOKEN || !ACCOUNT || !SITE) {
  console.error('Fehlende Umgebungsvariablen: CF_API_TOKEN / CF_ACCOUNT_ID / CF_SITE_TAG');
  process.exit(1);
}

const end = new Date();
const start = new Date(Date.now() - 24 * 3600 * 1000);
const filter = `{ AND: [ { siteTag: "${SITE}" }, { datetime_geq: "${start.toISOString()}" }, { datetime_leq: "${end.toISOString()}" } ] }`;

const query = `query {
  viewer {
    accounts(filter: { accountTag: "${ACCOUNT}" }) {
      totals: rumPageloadEventsAdaptiveGroups(limit: 1, filter: ${filter}) { count sum { visits } }
      paths: rumPageloadEventsAdaptiveGroups(limit: 20, orderBy: [count_DESC], filter: ${filter}) { count dimensions { requestPath } }
      referers: rumPageloadEventsAdaptiveGroups(limit: 20, orderBy: [count_DESC], filter: ${filter}) { count dimensions { refererHost } }
      countries: rumPageloadEventsAdaptiveGroups(limit: 20, orderBy: [count_DESC], filter: ${filter}) { count dimensions { countryName } }
      devices: rumPageloadEventsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: ${filter}) { count dimensions { deviceType } }
      browsers: rumPageloadEventsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: ${filter}) { count dimensions { userAgentBrowser } }
    }
  }
}`;

const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query })
});
const json = await res.json();
if (json.errors) { console.error('GraphQL-Fehler:', JSON.stringify(json.errors, null, 2)); process.exit(1); }
const acc = json.data && json.data.viewer && json.data.viewer.accounts && json.data.viewer.accounts[0];
if (!acc) { console.error('Keine Account-Daten:', JSON.stringify(json)); process.exit(1); }

const raw = a => (a || []).map(x => ({ name: (Object.values(x.dimensions || {})[0] ?? ''), count: x.count }));
const named = (a, dflt) => raw(a).map(x => ({ name: x.name === '' ? dflt : x.name, count: x.count }));
const t = (acc.totals && acc.totals[0]) || { count: 0, sum: { visits: 0 } };

const snap = {
  date: end.toISOString().slice(0, 10),
  capturedAt: end.toISOString(),
  range: 'last24h',
  pageViews: t.count || 0,
  visits: (t.sum && t.sum.visits) || 0,
  loadTimeMs: null,
  referers: named(acc.referers, 'None (direct)'),
  paths: named(acc.paths, '/'),
  countries: named(acc.countries, '—'),
  browsers: named(acc.browsers, 'Unbekannt'),
  devices: named(acc.devices, 'Unbekannt')
};

const hist = JSON.parse(fs.readFileSync(HIST, 'utf8'));
hist.snapshots = (hist.snapshots || []).filter(s => s.date !== snap.date);
hist.snapshots.push(snap);
hist.snapshots.sort((a, b) => (a.date < b.date ? -1 : 1));
fs.writeFileSync(HIST, JSON.stringify(hist, null, 2));
console.log('OK — pageViews', snap.pageViews, '· visits', snap.visits, '· Snapshots gesamt', hist.snapshots.length);
