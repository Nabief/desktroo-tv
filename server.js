// Desktroo TV — © 2026 Mdm-services.fr. Tous droits réservés.
// Logiciel propriétaire, distribué avec l'abonnement Desktroo (https://desktroo.fr).
//
// Installe la TV en direct de bout en bout : l'app fait tourner Threadfin (moteur HDHomeRun émulé, MIT,
// non modifié), le règle à partir de la liste de lecture du client, associe le guide, puis déclare le
// tuner et le guide dans Jellyfin. L'utilisateur ne voit qu'un assistant en quatre écrans.
//
// Serveur minimal, sans dépendance. L'identité vient de Desktroo (en-têtes posés par son nginx) et
// n'est acceptée qu'avec le secret de cette installation.
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');
const tf = require('./tf');
const jf = require('./jellyfin');

const PORT = 8080;
const SECRET = process.env.DESKTROO_APP_SECRET || '';
const APP_ID = process.env.DESKTROO_APP_ID || 'tv';
const DATA = process.env.DATA_DIR || '/data';
const CONF = path.join(DATA, 'conf');
const STATE_FILE = path.join(DATA, 'state.json');
const PUB = path.join(__dirname, 'public');
const FREE_GUIDE = 'https://xmltvfr.fr/xmltv/xmltv_fr.xml.gz';
const SITE = 'nabief.xyz';
// Adresse à laquelle Jellyfin joint cette app sur le réseau des apps de Desktroo.
const TUNER_URL = 'http://dt-' + APP_ID + ':' + tf.PORT;

const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

function send(res, code, body, type, extra) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8', 'Content-Length': b.length,
    'Cache-Control': 'no-store' }, HEADERS, extra || {}));
  res.end(b);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
const fail = (msg, status) => Object.assign(new Error(msg), { status: status || 400 });

function safeEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function identity(req) {
  if (!SECRET) return null;   // sans secret, personne n'est accepté : l'app n'a de sens que dans Desktroo
  if (!safeEq(req.headers['x-desktroo-secret'], SECRET)) return null;
  let u = '';
  try { u = decodeURIComponent(String(req.headers['x-desktroo-user'] || '')); } catch (_) { return null; }
  return /^[A-Za-z0-9._@-]{1,64}$/.test(u) ? u : null;
}
function body(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > (max || 262144)) { req.destroy(); reject(fail('Requête trop grande.', 413)); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (_) { reject(fail('Requête illisible.')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- Mémoire de l'app

let state = { subscription: '', jellyfin: { url: '', key: '' }, done: false };
async function loadState() {
  try { state = Object.assign(state, JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'))); } catch (_) { /* premier démarrage */ }
}
async function saveState() {
  const tmp = STATE_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(state), 'utf8');
  await fsp.rename(tmp, STATE_FILE);
}

// ---------------------------------------------------------------- Moteur Threadfin

let engine = null;
let engineLog = [];
function startEngine() {
  fs.mkdirSync(CONF, { recursive: true });
  engine = spawn('/app/threadfin', ['-port', String(tf.PORT), '-config', CONF], { stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (buf) => {
    engineLog = engineLog.concat(String(buf).split('\n').filter(Boolean)).slice(-200);
  };
  engine.on('error', (e) => {
    keep('[Desktroo] moteur introuvable : ' + e.message);
    engine = null;
  });
  engine.stdout.on('data', keep);
  engine.stderr.on('data', keep);
  engine.on('exit', (code) => {
    keep('[Desktroo] moteur arrêté (code ' + code + '), redémarrage dans 5 s');
    engine = null;
    setTimeout(startEngine, 5000);
  });
}

/**
 * Le moteur n'écoute que sur une adresse : on lui demande de prendre toutes celles du conteneur,
 * pour que l'app (boucle locale) et Jellyfin (réseau des apps) le joignent tous les deux.
 * Rend vrai s'il faut le relancer.
 */
async function ensureBind() {
  const file = path.join(CONF, 'settings.json');
  let s;
  try { s = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return false; }
  if (s.bindIpAddress === '0.0.0.0') return false;
  s.bindIpAddress = '0.0.0.0';
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8');
  await fsp.rename(tmp, file);
  return true;
}

/** Attend que le moteur ait écrit ses réglages (premier démarrage). */
async function waitSettings(seconds) {
  const until = Date.now() + (seconds || 60) * 1000;
  for (;;) {
    try { await fsp.access(path.join(CONF, 'settings.json')); return true; } catch (_) { /* pas encore */ }
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Réglages imposés par Desktroo au premier démarrage (l'utilisateur n'a pas à les connaître). */
async function engineDefaults() {
  const s = (await tf.state()).settings || {};
  const wanted = {};
  if (s.epgSource !== 'XEPG') wanted.epgSource = 'XEPG';
  if (s.enableNonAscii !== true) wanted.enableNonAscii = true;      // accents des titres (« Scènes de ménages »)
  if (s.api !== false) wanted.api = false;
  if (s.ssdp !== false) wanted.ssdp = false;                        // pas d'annonce sur le réseau : Jellyfin est déclaré directement
  if (s.ThreadfinAutoUpdate !== false) wanted.ThreadfinAutoUpdate = false;  // la version vient de l'image
  if (s.buffer !== '-') wanted.buffer = '-';                        // le flux va du fournisseur au client, sans passer par ici
  if (!Array.isArray(s.update) || !s.update.length) wanted.update = ['0300'];
  // Adresse annoncée dans les liens (chaînes, logos) : le nom du conteneur, que Jellyfin sait joindre.
  const domain = 'dt-' + APP_ID;
  if (s.httpThreadfinDomain !== domain) wanted.httpThreadfinDomain = domain;
  if (s['files.update'] !== true) wanted['files.update'] = true;
  if (Object.keys(wanted).length) await tf.saveSettings(wanted);
}

// ---------------------------------------------------------------- Abonnement du client (API Xtream)

function providerUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { throw fail("Adresse de liste non comprise."); }
  const user = u.searchParams.get('username');
  const pass = u.searchParams.get('password');
  if (!user || !pass) throw fail("L'adresse doit contenir username et password (celle du fournisseur, « …/get.php?username=…&password=… »).");
  const api = new URL(u.origin + '/player_api.php');
  api.searchParams.set('username', user);
  api.searchParams.set('password', pass);
  return api;
}

function getJson(url, timeout) {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { timeout: timeout || 20000, headers: { 'User-Agent': 'Desktroo TV', Accept: 'application/json' } }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > 2 * 1024 * 1024) { req.destroy(); reject(fail('Réponse trop grande du fournisseur.')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(fail('Le fournisseur répond « ' + res.statusCode + ' ».'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(fail('Réponse illisible du fournisseur.')); }
      });
    });
    req.on('timeout', () => req.destroy(fail('Le fournisseur ne répond pas.')));
    req.on('error', (e) => reject(fail('Fournisseur injoignable : ' + e.message)));
  });
}

async function subscription(raw) {
  const data = await getJson(providerUrl(raw));
  const u = (data && data.user_info) || {};
  const str = (k) => (u[k] === undefined || u[k] === null ? '' : String(u[k]));
  const raw_status = str('status');
  const expires = Number(str('exp_date')) ? Number(str('exp_date')) * 1000 : null;
  const label = /^active$/i.test(raw_status) ? 'Actif'
    : /^expired$/i.test(raw_status) ? 'Expiré'
      : /^banned$/i.test(raw_status) ? 'Bloqué'
        : /^disabled$/i.test(raw_status) ? 'Désactivé'
          : (raw_status || 'État inconnu');
  if (String(u.auth) === '0') throw fail('Identifiants refusés par le fournisseur.');
  return {
    status: label,
    active: /^active$/i.test(raw_status) && (!expires || expires > Date.now()),
    expiresAt: expires,
    connections: Number(str('active_cons')) || 0,
    maxConnections: Number(str('max_connections')) || 1,
    trial: str('is_trial') === '1',
    site: SITE,
  };
}

// ---------------------------------------------------------------- Chaînes, filtres et guide

const QUALITY = /\b(uhd|fhd|hd|sd|4k|hevc|h265)\b/gi;
/** Nom comparable : sans accents, sans préfixe de pays, sans qualité, sans ponctuation. */
function norm(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/^\s*[a-z]{2,4}\s*\|\s*/, '').replace(QUALITY, '')
    .replace(/&/g, 'and').replace(/\+/g, 'plus').replace(/[^a-z0-9]/g, '');
}

/** Groupes de la liste de lecture, avec le nombre de flux : [{name, count}]. */
function groupsOf(server) {
  const g = (((server.data || {}).playlist || {}).m3u || {}).groups || {};
  return (g.text || []).map((t) => {
    const m = /^(.*?)\s*\((\d+)\)\s*$/.exec(t);
    return m ? { name: m[1], count: Number(m[2]) } : { name: t, count: 0 };
  });
}

const DEFAULT_EXCLUDE = '✦●✦,24/7,[BK]';

/** Crée un filtre par groupe choisi (un appel par filtre : Threadfin numérote lui-même). */
async function makeFilters(groups, opts) {
  const o = opts || {};
  let last = null;
  let n = 1000;
  for (const g of groups.slice(0, 40)) {
    const f = {
      name: String(g).replace(/^.*\|\s*/, '').trim() || String(g),
      filter: String(g),
      type: 'group-title',
      caseSensitive: false,
      liveEvent: false,
      description: '',
      include: o.hdOnly ? 'HD' : 'HD,SD,HEVC,4K',
      exclude: (o.exclude === undefined ? DEFAULT_EXCLUDE : String(o.exclude)),
      startingNumber: String(n),
      'x-category': '',
    };
    last = await tf.saveFilter({ '-1': f });
    n += 1000;
  }
  return last;
}

/**
 * Associe chaque chaîne à son programme dans le guide choisi : par identifiant, puis par nom,
 * les autres versions d'une même chaîne reprenant l'association de la première trouvée.
 * Les chaînes sans programme reçoivent une grille de remplacement, pour rester visibles.
 */
function mapChannels(server, guideFile) {
  const xepg = server.xepg || {};
  const mapping = xepg.epgMapping || {};
  const xm = (xepg.xmltvMap || {})[guideFile] || {};
  const byId = {}, byName = {};
  for (const id of Object.keys(xm)) {
    byId[id.toLowerCase()] = id;
    const disp = norm((xm[id] || {})['display-name']);
    if (disp && !byName[disp]) byName[disp] = id;
    const stem = norm(id.replace(/\.[a-z]{2,3}$/i, ''));
    if (stem && !byName[stem]) byName[stem] = id;
  }
  const sibling = {};
  let matched = 0, dummy = 0;
  const values = Object.keys(mapping).map((k) => mapping[k]);
  for (const v of values) {
    const key = norm(v['x-name']);
    const id = byId[String(v['tvg-id'] || '').toLowerCase()] || byName[key] || null;
    if (id) sibling[key] = id;
  }
  for (const v of values) {
    const key = norm(v['x-name']);
    const id = sibling[key] || null;
    if (id && xm[id]) {
      v['x-xmltv-file'] = guideFile;
      v['x-mapping'] = id;
      matched++;
    } else {
      v['x-xmltv-file'] = 'Threadfin Dummy';
      v['x-mapping'] = '120_Minutes';
      dummy++;
    }
    v['x-active'] = true;
  }
  return { mapping: mapping, matched: matched, dummy: dummy, total: values.length };
}

function guideFileOf(server, name) {
  const files = ((server.settings || {}).files || {}).xmltv || {};
  for (const id of Object.keys(files)) {
    if (!name || files[id].name === name) return { id: id, file: id + '.xml', entry: files[id] };
  }
  return null;
}

// ---------------------------------------------------------------- Routes de l'assistant

async function apiState() {
  let server = null, error = '';
  try { server = await tf.state(); } catch (e) { error = e.message; }
  const settings = (server || {}).settings || {};
  const files = settings.files || {};
  const m3u = Object.keys(files.m3u || {}).map((id) => ({ id: id, name: files.m3u[id].name, tuner: files.m3u[id].tuner,
    updated: files.m3u[id]['last.update'] || '', streams: ((files.m3u[id].compatibility || {}).streams) || 0 }))[0] || null;
  const xmltv = Object.keys(files.xmltv || {}).map((id) => ({ id: id, name: files.xmltv[id].name,
    updated: files.xmltv[id]['last.update'] || '', programs: ((files.xmltv[id].compatibility || {})['xmltv.programs']) || 0 }));
  const mapping = ((server || {}).xepg || {}).epgMapping || {};
  const values = Object.keys(mapping).map((k) => mapping[k]);
  const withGuide = values.filter((v) => v['x-xmltv-file'] && v['x-xmltv-file'] !== 'Threadfin Dummy' && v['x-xmltv-file'] !== '-').length;
  return {
    engine: { ok: !!server, error: error, version: (((server || {}).clientInfo) || {}).version || '' },
    playlist: m3u,
    groups: server ? groupsOf(server) : [],
    filters: Object.keys(settings.filter || {}).map((k) => settings.filter[k].name),
    channels: values.length,
    withGuide: withGuide,
    guides: xmltv,
    subscriptionUrl: state.subscription ? state.subscription.replace(/password=[^&]*/i, 'password=••••') : '',
    jellyfin: { url: state.jellyfin.url, linked: !!state.jellyfin.key },
    tunerUrl: TUNER_URL,
    guideUrl: TUNER_URL + '/xmltv/threadfin.xml',
    site: SITE,
  };
}

async function routes(req, res, url, user) {
  const p = url.pathname;

  if (p === '/api/state' && req.method === 'GET') return json(res, 200, await apiState());

  // 1. Abonnement : on vérifie l'adresse avant de l'enregistrer.
  if (p === '/api/subscription' && req.method === 'POST') {
    const b = await body(req);
    const sub = await subscription(b.url);
    state.subscription = String(b.url).trim();
    await saveState();
    return json(res, 200, sub);
  }

  // 2. Liste de lecture : enregistrée dans le moteur, puis lue (les groupes servent à l'écran suivant).
  if (p === '/api/playlist' && req.method === 'POST') {
    const b = await body(req);
    const u = String(b.url || state.subscription || '').trim();
    if (!u) throw fail('Adresse de la liste manquante.');
    providerUrl(u);                                   // même contrôle que pour l'abonnement
    const before = await tf.state();
    const existing = Object.keys(((before.settings || {}).files || {}).m3u || {})[0] || '';
    const tuner = Math.max(1, Math.min(10, Number(b.tuner) || 1));
    const after = await tf.saveM3U(existing, 'Ma liste', u, tuner, !!existing);
    state.subscription = u;
    await saveState();
    const groups = groupsOf(after);
    return json(res, 200, { groups: groups, streams: (((after.data || {}).StreamPreviewUI || {}).inactiveStreams || []).length +
      (((after.data || {}).StreamPreviewUI || {}).activeStreams || []).length });
  }

  // 3. Chaînes : un filtre par groupe choisi.
  if (p === '/api/filters' && req.method === 'POST') {
    const b = await body(req);
    const groups = Array.isArray(b.groups) ? b.groups.map(String) : [];
    if (!groups.length) throw fail('Choisissez au moins un groupe de chaînes.');
    const server = await makeFilters(groups, { hdOnly: !!b.hdOnly, exclude: b.exclude });
    const mapping = ((server || {}).xepg || {}).epgMapping || {};
    return json(res, 200, { channels: Object.keys(mapping).length });
  }

  // 4. Guide : source gratuite et association automatique.
  if (p === '/api/guide' && req.method === 'POST') {
    const b = await body(req);
    let server = await tf.state();
    const wanted = b.url ? String(b.url).trim() : FREE_GUIDE;
    const name = b.url ? 'Guide du fournisseur' : 'Guide France (xmltvfr.fr)';
    const files = ((server.settings || {}).files || {}).xmltv || {};
    const existing = Object.keys(files).find((id) => files[id]['file.source'] === wanted) || '';
    server = await tf.saveXMLTV(existing, name, wanted, !!existing);
    const guide = guideFileOf(server, name);
    if (!guide) throw fail("Le guide n'a pas été enregistré.");
    const mapped = mapChannels(server, guide.file);
    if (!mapped.total) throw fail("Aucune chaîne à associer : choisissez d'abord vos groupes de chaînes.");
    await tf.saveEpgMapping(mapped.mapping);
    return json(res, 200, { matched: mapped.matched, dummy: mapped.dummy, total: mapped.total,
      programs: ((guide.entry.compatibility || {})['xmltv.programs']) || 0 });
  }

  // 5. Jellyfin : tuner, guide et actualisation.
  if (p === '/api/jellyfin' && req.method === 'POST') {
    const b = await body(req);
    const base = String(b.url || state.jellyfin.url || 'http://dt-jellyfin:8096').trim();
    const about = await jf.info(base);
    const token = await jf.login(base, String(b.user || ''), String(b.password || ''));
    const key = await jf.apiKey(base, token);
    const server = await tf.state();
    const tuner = (Object.keys(((server.settings || {}).files || {}).m3u || {}).map((id) => server.settings.files.m3u[id].tuner)[0]) || 1;
    await jf.setTuner(base, key, TUNER_URL, tuner);
    await jf.setGuide(base, key, TUNER_URL + '/xmltv/threadfin.xml');
    const started = await jf.refreshGuide(base, key);
    state.jellyfin = { url: base, key: key };
    state.done = true;
    await saveState();
    return json(res, 200, { server: (about && about.ServerName) || 'Jellyfin', version: (about && about.Version) || '', refreshing: started });
  }

  // Vérification de bout en bout, à relancer quand quelque chose cloche.
  if (p === '/api/check' && req.method === 'GET') {
    const out = [];
    const add = (label, ok, detail) => out.push({ label: label, ok: !!ok, detail: detail || '' });
    let server = null;
    try { server = await tf.state(); add('Moteur TV démarré', true, 'Threadfin ' + ((server.clientInfo || {}).version || '')); }
    catch (e) { add('Moteur TV démarré', false, e.message); }
    if (server) {
      const files = (server.settings || {}).files || {};
      const m3u = Object.keys(files.m3u || {}).map((id) => files.m3u[id])[0];
      add('Liste de lecture à jour', !!(m3u && m3u['last.update']), m3u ? ('mise à jour le ' + (m3u['last.update'] || 'jamais')) : 'aucune liste');
      if (state.subscription) {
        try {
          const sub = await subscription(state.subscription);
          add('Abonnement valable', sub.active, sub.status + (sub.expiresAt ? ' jusqu’au ' + new Date(sub.expiresAt).toLocaleDateString('fr-FR') : ''));
        } catch (e) { add('Abonnement valable', false, e.message); }
      }
      const mapping = (server.xepg || {}).epgMapping || {};
      const n = Object.keys(mapping).length;
      add('Chaînes retenues', n > 0, n + ' chaîne(s)');
      const withGuide = Object.keys(mapping).filter((k) => {
        const f = mapping[k]['x-xmltv-file'];
        return f && f !== 'Threadfin Dummy' && f !== '-';
      }).length;
      add('Programmes associés', withGuide > 0, withGuide + ' chaîne(s) avec programme');
    }
    if (state.jellyfin.key) {
      try {
        const count = await jf.channelCount(state.jellyfin.url, state.jellyfin.key);
        const running = await jf.guideRunning(state.jellyfin.url, state.jellyfin.key);
        add('Chaînes visibles dans Jellyfin', count > 0, count + ' chaîne(s)' + (running ? ' · actualisation en cours' : ''));
      } catch (e) { add('Chaînes visibles dans Jellyfin', false, e.message); }
    } else {
      add('Jellyfin relié', false, 'étape 4 de l’assistant');
    }
    return json(res, 200, { checks: out });
  }

  if (p === '/api/log' && req.method === 'GET') {
    let log = [];
    try { log = (((await tf.state()).log || {}).log || []).slice(-80); } catch (_) { log = engineLog.slice(-80); }
    return json(res, 200, { log: log.map((l) => String(l).replace(/password=[^&\s"]*/gi, 'password=••••')) });
  }

  throw fail('Page inconnue.', 404);
}

// ---------------------------------------------------------------- Fichiers de l'app

async function serveFile(res, rel) {
  const file = path.join(PUB, rel.replace(/^\/+/, '') || 'index.html');
  if (!file.startsWith(PUB + path.sep) && file !== path.join(PUB, 'index.html')) throw fail('Chemin refusé.', 400);
  let data;
  try { data = await fsp.readFile(file); } catch (_) { throw fail('Introuvable.', 404); }
  send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (_) { return send(res, 400, 'Requête invalide.'); }
  if (url.pathname === '/healthz') return send(res, 200, 'ok');
  const user = identity(req);
  if (!user) return send(res, 403, 'Accès refusé.');
  try {
    if (url.pathname.startsWith('/api/')) return await routes(req, res, url, user);
    if (url.pathname.startsWith('/engine/')) return proxyEngine(req, res, url);
    await serveFile(res, url.pathname === '/' ? 'index.html' : url.pathname);
  } catch (e) {
    if (!e.status) console.error('[tv]', e && e.stack ? e.stack : e);
    json(res, e.status || 500, { error: String((e && e.message) || 'Erreur interne.') });
  }
});

/** Interface complète de Threadfin, pour les réglages fins (sous /engine/). */
function proxyEngine(req, res, url) {
  const target = url.pathname.replace(/^\/engine/, '') + url.search;
  const up = http.request({ host: tf.host(), port: tf.PORT, method: req.method, path: target || '/',
    headers: Object.assign({}, req.headers, { host: tf.host() + ':' + tf.PORT }) }, (r) => {
    res.writeHead(r.statusCode, Object.assign({}, r.headers, HEADERS));
    r.pipe(res);
  });
  up.on('error', () => send(res, 502, 'Moteur TV injoignable.'));
  req.pipe(up);
}

// La liaison en direct de l'interface de Threadfin (WebSocket) passe par le même chemin.
server.on('upgrade', (req, socket, head) => {
  if (!identity(req) || !String(req.url || '').startsWith('/engine/')) return socket.destroy();
  const target = String(req.url).replace(/^\/engine/, '') || '/';
  const up = http.request({ host: tf.host(), port: tf.PORT, method: 'GET', path: target,
    headers: Object.assign({}, req.headers, { host: tf.host() + ':' + tf.PORT }) });
  up.on('upgrade', (r, upSocket, upHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
      Object.keys(r.headers).map((k) => k + ': ' + r.headers[k]).join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  up.on('error', () => socket.destroy());
  if (head && head.length) up.write(head);
  up.end();
});

(async () => {
  await loadState();
  startEngine();
  server.listen(PORT, () => console.log('[tv] prêt sur ' + PORT));
  try {
    await waitSettings(120);
    if (await ensureBind() && engine) {
      console.log('[tv] moteur relancé pour écouter sur toutes les adresses');
      engine.kill();               // le gardien le relance tout seul
      await new Promise((r) => setTimeout(r, 7000));
    }
    await tf.ready(120);
    await engineDefaults();
    console.log('[tv] moteur réglé');
  } catch (e) {
    console.error('[tv] moteur :', e.message);
  }
})();
