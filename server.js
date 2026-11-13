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
const feed = require('./feed');

const PORT = 8080;
const SECRET = process.env.DESKTROO_APP_SECRET || '';
const APP_ID = process.env.DESKTROO_APP_ID || 'tv';
const DATA = process.env.DATA_DIR || '/data';
const CONF = path.join(DATA, 'conf');
const STATE_FILE = path.join(DATA, 'state.json');
const FEED_FILE = path.join(DATA, 'playlist.m3u');
const PUB = path.join(__dirname, 'public');
const FREE_GUIDE = 'https://xmltvfr.fr/xmltv/xmltv_fr.xml.gz';
const SITE = 'nabief.xyz';          // où se réabonner
const SITE_NAME = 'FluxTV';         // nom du fournisseur
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

let state = { subscription: '', jellyfin: { url: '', key: '' }, done: false,
  feed: { token: '', digest: '', total: 0, kept: 0, vod: 0, at: 0 } };
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
  engine = spawn(process.env.ENGINE_BIN || '/app/threadfin', ['-port', String(tf.PORT), '-config', CONF],
    { stdio: ['ignore', 'pipe', 'pipe'] });
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
  // Confusion courante : l'adresse du guide (xmltv.php) collée à la place de celle des chaînes (get.php).
  if (/xmltv/i.test(u.pathname)) {
    throw fail("C'est l'adresse du guide des programmes, pas celle de la liste de chaînes. " +
      "Collez celle qui finit par « get.php?username=…&password=… » ; le guide s'installe tout seul à l'écran ③.");
  }
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
    siteName: SITE_NAME,
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
/**
 * Groupes de la liste, avec leur nom exact. Le moteur compare les groupes à l'identique, et des
 * fournisseurs laissent une espace à la fin de leurs noms : rogner ce nom donne un filtre qui ne
 * retient rien. On prend donc les noms bruts, et le nombre vient de l'étiquette « nom (nombre) ».
 */
function groupsOf(server) {
  const g = (((server.data || {}).playlist || {}).m3u || {}).groups || {};
  const counts = {};
  for (const t of g.text || []) {
    const m = /^(.*) \((\d+)\)$/.exec(t);          // une seule espace avant la parenthèse
    if (m) counts[m[1]] = Number(m[2]);
  }
  const names = (g.value || []).length ? g.value : Object.keys(counts);
  return names.map((n) => ({ name: n, count: counts[n] || 0 }));
}

/**
 * Supprime des filtres. Le moteur traite toute la demande puis reconstruit sa base une seule fois :
 * les envoyer ensemble évite autant de reconstructions que de filtres — des minutes sur une grosse
 * liste. La création, elle, reste un par un : le moteur ne sait créer qu'un filtre à la fois.
 */
async function dropFilters(server, ids) {
  if (!ids.length) return server;
  const req = {};
  for (const id of ids) req[id] = { delete: true };
  return tf.saveFilter(req);
}

/**
 * Rattrape les filtres devenus inopérants. Un fournisseur qui renomme un groupe — ne serait-ce
 * qu'en ajoutant une espace à la fin — fait disparaître ses chaînes sans un mot, puisque le moteur
 * exige un nom identique. On ne corrige que les cas sans ambiguïté, et on retire les doublons.
 */
async function repairFilters(server) {
  const names = groupsOf(server).map((g) => g.name);
  if (!names.length) return server;
  const filters = (server.settings || {}).filter || {};
  const seen = [];
  const req = {};
  for (const id of Object.keys(filters)) {
    const rule = String(filters[id].filter || '');
    if (!rule) continue;
    if (seen.indexOf(rule) !== -1) { req[id] = { delete: true }; continue; }   // doublon d'un passage précédent
    seen.push(rule);
    if (names.indexOf(rule) !== -1) continue;
    const near = names.filter((n) => n.trim().toLowerCase() === rule.trim().toLowerCase());
    if (near.length === 1) req[id] = Object.assign({}, filters[id], { filter: near[0] });
  }
  return Object.keys(req).length ? tf.saveFilter(req) : server;
}

const DEFAULT_EXCLUDE = '✦●✦,24/7,[BK]';

/** Crée un filtre par groupe choisi (un appel par filtre : Threadfin numérote lui-même). */
// Où en est le travail en cours. Le moteur ne sait créer qu'un filtre à la fois et reconstruit
// tout après chacun : sur une grosse liste avec un guide installé, cela prend des minutes, et sans
// rien dire on croit l'app plantée.
let job = { label: '', unit: '', done: 0, total: 0, at: 0 };
function progress(label, unit, done, total) {
  job = { label: label, unit: unit, done: done, total: total, at: Date.now() };
}

async function makeFilters(groups, opts) {
  const o = opts || {};
  const include = o.hdOnly ? 'HD' : 'HD,SD,HEVC,4K';
  const exclude = (o.exclude === undefined ? DEFAULT_EXCLUDE : String(o.exclude));
  const before = await tf.state();
  const filters = (before.settings || {}).filter || {};
  const wanted = groups.slice(0, 40);
  // L'écran ③ décrit l'ensemble voulu, mais le refaire entièrement coûterait au moteur une
  // reconstruction par groupe — des minutes pour un seul groupe ajouté. On ne touche donc qu'à ce
  // qui change : retraits et corrections partent ensemble, seuls les nouveaux groupes sont créés.
  const req = {};
  const garde = {};
  let maxNum = 0;
  for (const id of Object.keys(filters)) {
    const rule = String(filters[id].filter || '');
    maxNum = Math.max(maxNum, Number(filters[id].startingNumber) || 0);
    if (!rule || wanted.indexOf(rule) === -1 || garde[rule]) { req[id] = { delete: true }; continue; }
    garde[rule] = true;
    if (String(filters[id].include || '') !== include || String(filters[id].exclude || '') !== exclude) {
      req[id] = Object.assign({}, filters[id], { include: include, exclude: exclude });
    }
  }
  const aCreer = wanted.filter((g) => !garde[g]);
  makeFilters.cree = aCreer.length;
  makeFilters.change = aCreer.length + Object.keys(req).length;
  progress('Mise en place de vos groupes', 'Groupe', 0, aCreer.length);
  let last = Object.keys(req).length ? await tf.saveFilter(req) : before;
  let n = Math.max(1000, maxNum + 1000);
  for (const g of aCreer) {
    const f = {
      name: String(g).replace(/^.*\|\s*/, '').trim() || String(g),
      filter: String(g),
      type: 'group-title',
      caseSensitive: false,
      liveEvent: false,
      description: '',
      include: include,
      exclude: exclude,
      startingNumber: String(n),
      'x-category': '',
    };
    last = await tf.saveFilter({ '-1': f });
    n += 1000;
    progress('Mise en place de vos groupes', 'Groupe', aCreer.indexOf(g) + 1, aCreer.length);
  }
  return last;
}

/**
 * Associe chaque chaîne à son programme dans le guide choisi : par identifiant, puis par nom,
 * les autres versions d'une même chaîne reprenant l'association de la première trouvée.
 * Les chaînes sans programme reçoivent une grille de remplacement, pour rester visibles.
 */
function mapChannels(server, guides) {
  const list = (Array.isArray(guides) ? guides : [guides]).filter(Boolean);
  const xepg = server.xepg || {};
  const mapping = xepg.epgMapping || {};
  const sources = list.map((f) => {
    const xm = (xepg.xmltvMap || {})[f] || {};
    const byId = {}, byName = {};
    for (const id of Object.keys(xm)) {
      byId[id.toLowerCase()] = id;
      const disp = norm((xm[id] || {})['display-name']);
      if (disp && !byName[disp]) byName[disp] = id;
      const stem = norm(id.replace(/\.[a-z]{2,3}$/i, ''));
      if (stem && !byName[stem]) byName[stem] = id;
    }
    return { file: f, xm: xm, byId: byId, byName: byName, sibling: {}, matched: 0 };
  });
  const values = Object.keys(mapping).map((k) => mapping[k]);
  // Les variantes d'une même chaîne (HD, FHD, SD) partagent le programme trouvé pour l'une d'elles.
  for (const src of sources) {
    for (const v of values) {
      const key = norm(v['x-name']);
      const id = src.byId[String(v['tvg-id'] || '').toLowerCase()] || src.byName[key] || null;
      if (id && !src.sibling[key]) src.sibling[key] = id;
    }
  }
  let matched = 0, dummy = 0;
  for (const v of values) {
    const key = norm(v['x-name']);
    let trouve = false;
    for (const src of sources) {
      const id = src.sibling[key];
      if (id && src.xm[id]) {
        v['x-xmltv-file'] = src.file;          // le premier guide qui connaît la chaîne l'emporte
        v['x-mapping'] = id;
        src.matched++;
        matched++;
        trouve = true;
        break;
      }
    }
    if (!trouve) {
      v['x-xmltv-file'] = 'Threadfin Dummy';
      v['x-mapping'] = '120_Minutes';
      dummy++;
    }
    v['x-active'] = true;
  }
  return { mapping: mapping, matched: matched, dummy: dummy, total: values.length,
    sources: sources.map((x) => ({ file: x.file, matched: x.matched })) };
}

/**
 * Tous les guides en place, celui dont le nom est donné en tête. Un fournisseur couvre souvent des
 * chaînes que le guide français ignore, et l'inverse : chaque chaîne prendra le premier qui la
 * connaît, au lieu de tout jouer sur une seule source.
 */
function guideFilesOf(server, firstName) {
  const files = ((server.settings || {}).files || {}).xmltv || {};
  const ids = Object.keys(files);
  ids.sort((a, b) => (files[b].name === firstName ? 1 : 0) - (files[a].name === firstName ? 1 : 0));
  return ids.map((id) => ({ id: id, file: id + '.xml', entry: files[id], name: files[id].name }));
}

function guideFileOf(server, name) {
  const files = ((server.settings || {}).files || {}).xmltv || {};
  for (const id of Object.keys(files)) {
    if (!name || files[id].name === name) return { id: id, file: id + '.xml', entry: files[id] };
  }
  return null;
}

// ---------------------------------------------------------------- Liste de lecture servie au moteur

function feedToken() {
  if (!state.feed.token) state.feed.token = crypto.randomBytes(16).toString('hex');
  return state.feed.token;
}
/** Adresse interne au conteneur : le moteur tourne ici même, le fichier ne sort pas sur le réseau. */
const feedUrl = () => 'http://127.0.0.1:' + PORT + '/feed/' + feedToken() + '/playlist.m3u';

let feeding = null;
/** Télécharge la liste du fournisseur (une seule à la fois) et retient ses compteurs. */
function refreshFeed(source) {
  if (feeding) return feeding;
  const src = String(source || state.subscription || '');
  if (!src) return Promise.reject(fail('Adresse de la liste manquante.'));
  feeding = (async () => {
    const r = await feed.download(src, FEED_FILE);
    state.feed = Object.assign({ token: feedToken() }, r, { at: Date.now() });
    await saveState();
    console.log('[tv] liste : ' + r.kept + ' chaînes en direct, ' + r.vod + ' films/séries écartés');
    return r;
  })();
  feeding.catch(() => {}).then(() => { feeding = null; });
  return feeding;
}

/**
 * Déclare la liste dans le moteur, ou la lui fait relire. L'adresse donnée au moteur ne change jamais
 * (c'est celle de cette app), si bien que les chaînes gardent leur numéro et leur programme d'une
 * relecture à l'autre : seules les chaînes réellement nouvelles sont ajoutées, et celles qui ont
 * disparu de la liste sont retirées.
 */
async function installPlaylist(tuner) {
  const before = await tf.state();
  const files = ((before.settings || {}).files || {}).m3u || {};
  const u = feedUrl();
  const existing = Object.keys(files).find((id) => files[id]['file.source'] === u) || '';
  const n = Math.max(1, Math.min(10, Number(tuner) || Number(files[existing] && files[existing].tuner) || 1));
  for (const id of Object.keys(files)) {
    if (id !== existing) await tf.deleteM3U(id);      // liste d'une version précédente ou d'une autre adresse
  }
  // Première fois : le moteur télécharge la liste et construit sa base de chaînes dans le même geste.
  if (!existing) return tf.saveM3U('', 'Ma liste', u, n);
  let after = await tf.saveM3U(existing, 'Ma liste', u, n);     // relit le fichier
  after = await repairFilters(after);                           // groupes renommés par le fournisseur
  return activate(await rebuild(after));
}

/**
 * Refait la base des chaînes du moteur à partir du fichier relu : il ne le fait pas de lui-même après
 * une relecture, et son interface de commande n'a pas d'ordre pour cela. Réécrire un filtre à
 * l'identique déclenche exactement ce travail — reconstruction et retrait des chaînes disparues.
 */
async function rebuild(server) {
  const f = (server.settings || {}).filter || {};
  const id = Object.keys(f)[0];
  if (id === undefined) return server;                // pas encore de chaînes choisies : rien à refaire
  return tf.saveFilter({ [id]: f[id] });
}

/**
 * Rend visibles toutes les chaînes retenues. Le moteur crée ses chaînes désactivées, et il refuse
 * alors de mettre à jour leur adresse à la construction suivante : deux versions d'une même chaîne
 * (HD et FHD) peuvent finir confondues, et l'une des deux disparaît. Les activer tout de suite
 * supprime ce cas. Sans guide encore choisi, elles reçoivent la grille de remplacement du moteur.
 */
async function activate(server) {
  const mapping = ((server.xepg || {}).epgMapping) || {};
  const keys = Object.keys(mapping);
  if (!keys.length) return server;
  const guide = guideFileOf(server, null);
  if (guide) return remap(server);
  let n = 0;
  for (const k of keys) {
    const v = mapping[k];
    if (!v['x-active']) { v['x-active'] = true; n++; }
    if (!v['x-xmltv-file'] || v['x-xmltv-file'] === '-') {
      v['x-xmltv-file'] = 'Threadfin Dummy';
      v['x-mapping'] = '120_Minutes';
      n++;
    }
  }
  return n ? tf.saveEpgMapping(mapping) : server;
}

/** Renvoie toutes les chaînes vers la grille de remplacement du moteur : plus de guide, mais toujours visibles. */
async function toDummy(server) {
  const mapping = ((server.xepg || {}).epgMapping) || {};
  const keys = Object.keys(mapping);
  if (!keys.length) return server;
  for (const k of keys) {
    mapping[k]['x-xmltv-file'] = 'Threadfin Dummy';
    mapping[k]['x-mapping'] = '120_Minutes';
    mapping[k]['x-active'] = true;
  }
  return tf.saveEpgMapping(mapping);
}

/** Réassocie le guide comme à l'écran ④, pour que les chaînes nouvellement apparues aient leur programme. */
async function remap(server) {
  const guides = guideFilesOf(server, null);
  if (!guides.length) return server;
  const mapped = mapChannels(server, guides.map((g) => g.file));
  if (!mapped.total) return server;
  return tf.saveEpgMapping(mapped.mapping);
}

/** Fichier servi au moteur seul : même conteneur (boucle locale) et jeton de cette installation. */
function serveFeed(req, res, url) {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip !== '127.0.0.1' && ip !== '::1') return send(res, 403, 'Accès refusé.');
  if (!safeEq(url.pathname.split('/')[2], state.feed.token)) return send(res, 403, 'Accès refusé.');
  let st;
  try { st = fs.statSync(FEED_FILE); } catch (_) { return send(res, 404, "Liste pas encore téléchargée."); }
  // Le moteur revient la chercher chaque nuit : on lui sert la dernière connue et on en prépare une
  // neuve en fond, pour ne pas le faire attendre plusieurs minutes de téléchargement.
  if (Date.now() - st.mtimeMs > 3600000) refreshFeed().catch(() => {});
  res.writeHead(200, Object.assign({ 'Content-Type': 'application/x-mpegurl', 'Content-Length': st.size,
    'Cache-Control': 'no-store' }, HEADERS));
  fs.createReadStream(FEED_FILE).pipe(res);
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
    // Noms exacts des groupes retenus : l'écran ② s'en sert pour recocher le choix en place,
    // afin qu'ajouter un groupe n'oblige pas à tout refaire.
    chosen: Object.keys(settings.filter || {}).map((k) => String(settings.filter[k].filter || '')).filter(Boolean),
    hdOnly: Object.keys(settings.filter || {}).every((k) => String(settings.filter[k].include || '') === 'HD')
      && Object.keys(settings.filter || {}).length > 0,
    channels: values.length,
    withGuide: withGuide,
    guides: xmltv,
    subscriptionUrl: state.subscription ? state.subscription.replace(/password=[^&]*/i, 'password=••••') : '',
    feed: { live: state.feed.kept || 0, vod: state.feed.vod || 0, at: state.feed.at || 0 },
    jellyfin: { url: state.jellyfin.url, linked: !!state.jellyfin.key },
    tunerUrl: TUNER_URL,
    guideUrl: TUNER_URL + '/xmltv/threadfin.xml',
    site: SITE,
    siteName: SITE_NAME,
  };
}

async function routes(req, res, url, user) {
  const p = url.pathname;

  if (p === '/api/state' && req.method === 'GET') return json(res, 200, await apiState());

  // 1. Abonnement : on vérifie l'adresse avant de l'enregistrer.
  if (p === '/api/subscription' && req.method === 'POST') {
    const b = await body(req);
    // Champ laissé vide : on reprend l'adresse déjà enregistrée (elle contient un mot de passe, on ne la réaffiche pas).
    const url = String(b.url || '').trim() || state.subscription;
    if (!url) throw fail("Collez l'adresse de votre liste de lecture.");
    const sub = await subscription(url);
    state.subscription = url;
    await saveState();
    return json(res, 200, sub);
  }

  // 2. Liste de lecture : téléchargée ici, débarrassée des films et séries, puis donnée au moteur.
  if (p === '/api/playlist' && req.method === 'POST') {
    const b = await body(req);
    const u = String(b.url || state.subscription || '').trim();
    if (!u) throw fail('Adresse de la liste manquante.');
    providerUrl(u);                                   // même contrôle que pour l'abonnement
    state.subscription = u;
    await saveState();
    const info = await refreshFeed(u);
    const after = await installPlaylist(b.tuner);
    const groups = groupsOf(after);
    const streams = (((after.data || {}).StreamPreviewUI || {}).inactiveStreams || []).length +
      (((after.data || {}).StreamPreviewUI || {}).activeStreams || []).length;
    if (!streams) {
      throw fail("Le moteur n'a retenu aucune chaîne des " + info.kept + " reçues. Réessayez avec « Relire la liste » ; " +
        "si cela se reproduit, le journal du moteur (écran Vérification) en donne la raison.");
    }
    return json(res, 200, { groups: groups, streams: streams, live: info.kept, vod: info.vod, total: info.total });
  }

  // 3. Chaînes : un filtre par groupe choisi.
  if (p === '/api/filters' && req.method === 'POST') {
    const b = await body(req);
    const groups = Array.isArray(b.groups) ? b.groups.map(String) : [];
    if (!groups.length) throw fail('Choisissez au moins un groupe de chaînes.');
    // Le moteur cesse d'écouter une ou deux secondes après avoir appliqué un filtre : la réponse se
    // perd alors que le travail est fait. Comme makeFilters ne pose que ce qui manque, le rejouer
    // après l'avoir attendu reprend exactement là où il s'était arrêté, sans rien créer en double.
    let server = null;
    for (let essai = 0; ; essai++) {
      try { server = await makeFilters(groups, { hdOnly: !!b.hdOnly, exclude: b.exclude }); break; }
      catch (e) {
        if (essai >= 3 || !/coupé la connexion|injoignable/i.test(String(e.message))) throw e;
        await tf.ready(60);
      }
    }
    // Chaque passe fait réécrire tout le guide au moteur : on n'en fait que le nécessaire. Rien
    // n'a changé, rien à faire ; des groupes seulement retirés, une passe suffit ; des groupes
    // ajoutés, une seconde passe récupère les versions de chaînes confondues à la construction.
    if (makeFilters.change) {
      progress('Association du guide', 'Étape', 0, makeFilters.cree ? 2 : 1);
      server = await activate(server);
      if (makeFilters.cree) {
        progress('Association du guide', 'Étape', 1, 2);
        server = await activate(await rebuild(server));
      }
    }
    progress('', '', 0, 0);
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
    // Une source sous le même nom mais d'une autre adresse : on la remplace plutôt que de la mettre à jour.
    const stale = Object.keys(files).find((id) => files[id].name === name && files[id]['file.source'] !== wanted);
    if (!existing && stale) await tf.deleteXMLTV(stale);
    server = await tf.saveXMLTV(existing, name, wanted);
    const guides = guideFilesOf(server, name);                 // celui qu'on vient de choisir en tête
    if (!guides.length) throw fail("Le guide n'a pas été enregistré.");
    const mapped = mapChannels(server, guides.map((g) => g.file));
    if (!mapped.total) throw fail("Aucune chaîne à associer : choisissez d'abord vos groupes de chaînes.");
    await tf.saveEpgMapping(mapped.mapping);
    const parSource = mapped.sources.map((x) => {
      const g = guides.find((y) => y.file === x.file);
      return { name: (g && g.name) || x.file, matched: x.matched };
    });
    return json(res, 200, { matched: mapped.matched, dummy: mapped.dummy, total: mapped.total, sources: parSource,
      programs: guides.reduce((n, g) => n + (((g.entry.compatibility || {})['xmltv.programs']) || 0), 0) });
  }

  // 5. Jellyfin : tuner, guide et actualisation.
  if (p === '/api/jellyfin' && req.method === 'POST') {
    const b = await body(req);
    const base = await jf.resolve(b.url || state.jellyfin.url || 'http://dt-jellyfin:8080');
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
    const rest = await jf.others(base, key, TUNER_URL, TUNER_URL + '/xmltv/threadfin.xml');
    return json(res, 200, { server: (about && about.ServerName) || 'Jellyfin', version: (about && about.Version) || '',
      refreshing: started, others: rest });
  }

  // Tuner ou guide d'une installation précédente : tant qu'ils restent, tout apparaît en double.
  if (p === '/api/jellyfin/others' && req.method === 'POST') {
    if (!state.jellyfin.key) throw fail("Reliez d'abord Jellyfin (écran ④).");
    const b = await body(req);
    const base = state.jellyfin.url, key = state.jellyfin.key;
    const rest = await jf.others(base, key, TUNER_URL, TUNER_URL + '/xmltv/threadfin.xml');
    if (!b.remove) return json(res, 200, { others: rest });
    let n = 0;
    for (const g of rest.guides) { if (g.id) { await jf.dropGuide(base, key, g.id); n++; } }
    for (const t of rest.tuners) { if (t.id) { await jf.dropTuner(base, key, t.id); n++; } }
    const started = n ? await jf.refreshGuide(base, key) : false;
    return json(res, 200, { removed: n, refreshing: started,
      others: await jf.others(base, key, TUNER_URL, TUNER_URL + '/xmltv/threadfin.xml') });
  }

  // Changement de fournisseur ou d'abonnement : effacer ce qui vient de l'ancien.
  if (p === '/api/reset' && req.method === 'POST') {
    const b = await body(req);
    const what = String(b.what || '');
    if (['playlist', 'guide', 'all'].indexOf(what) === -1) throw fail('Précisez ce qu\'il faut effacer.');
    let server = await tf.state();
    const files = (server.settings || {}).files || {};
    if (what === 'guide' || what === 'all') {
      for (const id of Object.keys(files.xmltv || {})) server = await tf.deleteXMLTV(id);
      if (what === 'guide') server = await toDummy(server);   // les chaînes restent, sans programme
    }
    if (what === 'playlist' || what === 'all') {
      // Les filtres d'abord : ils désignent des groupes de l'ancienne liste.
      server = await dropFilters(server, Object.keys((server.settings || {}).filter || {}));
      for (const id of Object.keys(files.m3u || {})) server = await tf.deleteM3U(id);
      await fsp.unlink(FEED_FILE).catch(() => {});
      state.subscription = '';
      state.feed = { token: state.feed.token, digest: '', total: 0, kept: 0, vod: 0, at: 0 };
      state.done = false;
      await saveState();
    }
    return json(res, 200, await apiState());
  }

  // Où en est le travail en cours, pour que l'écran puisse le montrer plutôt que de faire attendre.
  if (p === '/api/progress') return json(res, 200, job);

  // Vérification de bout en bout, à relancer quand quelque chose cloche.
  if (p === '/api/check' && req.method === 'GET') {
    const out = [];
    let others = { tuners: [], guides: [] };
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
      const groupes = groupsOf(server).map((g) => g.name);
      const perdus = Object.values((server.settings || {}).filter || {})
        .map((f) => String(f.filter || '')).filter((r) => r && groupes.indexOf(r) === -1);
      if (groupes.length) {
        add('Groupes encore présents chez le fournisseur', perdus.length === 0,
          perdus.length === 0 ? 'tous les groupes choisis existent toujours'
            : perdus.join(', ') + ' — introuvable(s) : repassez par l’écran ③');
      }
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
      try {
        const rest = await jf.others(state.jellyfin.url, state.jellyfin.key, TUNER_URL, TUNER_URL + '/xmltv/threadfin.xml');
        others = rest;
        const n = rest.tuners.length + rest.guides.length;
        add('Pas d’autre tuner dans Jellyfin', n === 0, n === 0 ? 'cette app est la seule source de TV en direct'
          : rest.tuners.concat(rest.guides).map((x) => x.label).join(', ') + ' — vos chaînes apparaissent en double');
      } catch (_) { /* configuration illisible : rien à signaler */ }
    } else {
      add('Jellyfin relié', false, 'étape 4 de l’assistant');
    }
    return json(res, 200, { checks: out, others: others });
  }

  if (p === '/api/log' && req.method === 'GET') {
    let log = [];
    try { log = (((await tf.state()).log || {}).log || []).slice(-80); } catch (_) { log = engineLog.slice(-80); }
    return json(res, 200, { log: log.map((l) => String(l)
      .replace(/&nbsp;/g, ' ').replace(/ +/g, ' ')
      .replace(/password=[^&\s"]*/gi, 'password=••••')) });
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
  if (url.pathname.startsWith('/feed/')) return serveFeed(req, res, url);
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

/**
 * L'interface du moteur se croit à la racine du site : sa liaison en direct viserait « /data/ »
 * au lieu de « /a/tv/engine/data/ ». On glisse ce petit correctif dans ses pages.
 */
const ENGINE_PATCH = '<script>(function(){' +
  'var base=location.pathname.replace(/\\/web\\/.*$/,"");' +
  'var Native=window.WebSocket;' +
  'function Patched(u,p){try{var x=new URL(u,location.href);' +
  'x.protocol=(location.protocol==="https:"?"wss:":"ws:");x.host=location.host;x.pathname=base+"/data/";u=x.toString();}catch(e){}' +
  'return p?new Native(u,p):new Native(u);}' +
  'Patched.prototype=Native.prototype;Patched.CONNECTING=0;Patched.OPEN=1;Patched.CLOSING=2;Patched.CLOSED=3;' +
  'window.WebSocket=Patched;})();</script>';

// En-têtes qui ne valent que d'un bout à l'autre d'une connexion : les recopier d'une réponse à
// l'autre produit un message incohérent (une longueur annoncée en même temps qu'un envoi par
// morceaux), que le serveur de Desktroo refuse — et l'écran affiche « l'app ne répond pas ».
const HOP = ['transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'upgrade', 'content-length', 'content-encoding'];
function passThrough(headers) {
  const out = Object.assign({}, headers);
  for (const h of HOP) delete out[h];
  return out;
}

/** Interface complète de Threadfin, pour les réglages fins (sous /engine/). */
function proxyEngine(req, res, url) {
  const target = url.pathname.replace(/^\/engine/, '') + url.search;
  const up = http.request({ host: tf.host(), port: tf.PORT, method: req.method, path: target || '/',
    headers: Object.assign({}, req.headers, { host: tf.host() + ':' + tf.PORT }) }, (r) => {
    const html = /text\/html/i.test(String(r.headers['content-type'] || ''));
    if (!html) {
      const head = Object.assign(passThrough(r.headers), HEADERS);
      if (r.headers['content-length']) head['content-length'] = r.headers['content-length'];
      if (r.headers['content-encoding']) head['content-encoding'] = r.headers['content-encoding'];
      res.writeHead(r.statusCode, head);
      return r.pipe(res);
    }
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => {
      let page = Buffer.concat(chunks).toString('utf8');
      page = /<head[^>]*>/i.test(page) ? page.replace(/<head[^>]*>/i, (m) => m + ENGINE_PATCH) : ENGINE_PATCH + page;
      const body = Buffer.from(page, 'utf8');
      res.writeHead(r.statusCode, Object.assign(passThrough(r.headers), HEADERS, { 'content-length': body.length }));
      res.end(body);
    });
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
    // La liste est retéléchargée régulièrement ; le moteur n'est refait que si son contenu a bougé.
    setInterval(() => {
      if (!state.subscription) return;
      const was = state.feed.digest;
      refreshFeed().then((r) => (r.digest === was ? null : installPlaylist(0))).catch(() => {});
    }, 6 * 3600 * 1000);
  } catch (e) {
    console.error('[tv] moteur :', e.message);
  }
})();
