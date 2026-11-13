// Desktroo TV — © 2026 Mdm-services.fr. Tous droits réservés.
// Le minimum de l'API Jellyfin : ouvrir une session d'administrateur, créer une clé d'accès,
// déclarer le tuner et le guide, puis lancer l'actualisation.
'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');

const CLIENT = 'Desktroo TV';
const DEVICE_ID = 'desktroo-tv';

function request(base, path, opts) {
  const o = opts || {};
  const url = new URL(path.replace(/^\//, ''), base.replace(/\/*$/, '/'));
  const mod = url.protocol === 'https:' ? https : http;
  const body = o.body === undefined ? null : Buffer.from(JSON.stringify(o.body), 'utf8');
  const auth = 'MediaBrowser Client="' + CLIENT + '", Device="NAS", DeviceId="' + DEVICE_ID + '", Version="1.0"' +
    (o.token ? ', Token="' + o.token + '"' : '');
  const headers = { Accept: 'application/json', Authorization: auth };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = body.length;
  }
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: o.method || 'GET', headers: headers, timeout: o.timeout || 30000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          const msg = res.statusCode === 401 ? 'Identifiants refusés par Jellyfin.'
            : res.statusCode === 403 ? "Ce compte Jellyfin n'est pas administrateur."
              : 'Jellyfin répond « ' + res.statusCode + ' »' + (text ? ' : ' + text.slice(0, 200) : '') + '.';
          const e = new Error(msg);
          e.status = res.statusCode;
          return reject(e);
        }
        if (!text) return resolve(null);
        try { resolve(JSON.parse(text)); } catch (_) { resolve(text); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Jellyfin ne répond pas.')));
    req.on('error', (e) => reject(new Error('Jellyfin injoignable : ' + e.message)));
    if (body) req.write(body);
    req.end();
  });
}

/** Nom et version du serveur : sert à vérifier l'adresse avant de demander un mot de passe. */
const info = (base) => request(base, 'System/Info/Public', { timeout: 8000 });

/** Ouvre une session avec un compte administrateur ; rend son jeton. */
async function login(base, user, password) {
  const r = await request(base, 'Users/AuthenticateByName', { method: 'POST', body: { Username: user, Pw: password } });
  if (!r || !r.AccessToken) throw new Error('Jellyfin n’a pas ouvert de session.');
  if (r.User && r.User.Policy && r.User.Policy.IsAdministrator === false) throw new Error("Ce compte Jellyfin n'est pas administrateur.");
  return r.AccessToken;
}

/** Clé d'accès durable pour l'app (réutilisée si elle existe déjà). */
async function apiKey(base, token) {
  const list = await request(base, 'Auth/Keys', { token: token });
  const found = ((list && list.Items) || []).find((k) => k.AppName === CLIENT);
  if (found && found.AccessToken) return found.AccessToken;
  await request(base, 'Auth/Keys?app=' + encodeURIComponent(CLIENT), { method: 'POST', token: token });
  const after = await request(base, 'Auth/Keys', { token: token });
  const made = ((after && after.Items) || []).find((k) => k.AppName === CLIENT);
  if (!made) throw new Error("Jellyfin n'a pas créé la clé d'accès.");
  return made.AccessToken;
}

/** Déclare (ou met à jour) le tuner HDHomeRun servi par cette app. */
async function setTuner(base, token, url, tunerCount) {
  const hosts = (await request(base, 'LiveTv/TunerHosts', { token: token })) || [];
  const mine = hosts.find((h) => String(h.Url || '').replace(/\/+$/, '') === url.replace(/\/+$/, ''));
  const body = Object.assign({}, mine || {}, {
    Type: 'hdhomerun',
    Url: url,
    FriendlyName: 'Desktroo TV',
    AllowHWTranscoding: true,
    EnableStreamLooping: false,
    ImportFavoritesOnly: false,
    TunerCount: Number(tunerCount) || 0,
    UserAgent: 'Desktroo TV',
  });
  return request(base, 'LiveTv/TunerHosts', { method: 'POST', token: token, body: body });
}

/** Déclare (ou met à jour) le guide XMLTV servi par cette app. */
async function setGuide(base, token, url) {
  const current = (await request(base, 'LiveTv/ListingProviders/Default?type=xmltv', { token: token })) || {};
  const providers = ((await request(base, 'System/Configuration/livetv', { token: token })) || {}).ListingProviders || [];
  const mine = providers.find((p) => String(p.Path || '').replace(/\/+$/, '') === url.replace(/\/+$/, ''));
  const body = Object.assign({}, current, mine || {}, {
    Type: 'xmltv',
    Path: url,
    EnableAllTuners: true,
    EnabledTuners: [],
    UserAgent: 'Desktroo TV',
  });
  return request(base, 'LiveTv/ListingProviders?validateListings=false&validateLogin=false', { method: 'POST', token: token, body: body });
}

/** Lance l'actualisation du guide et rend vrai si la tâche a démarré. */
async function refreshGuide(base, token) {
  const tasks = (await request(base, 'ScheduledTasks', { token: token })) || [];
  const task = tasks.find((t) => t.Key === 'RefreshGuide') || tasks.find((t) => /guide/i.test(String(t.Name || '')));
  if (!task) return false;
  await request(base, 'ScheduledTasks/Running/' + task.Id, { method: 'POST', token: token });
  return true;
}

/** Nombre de chaînes de TV en direct connues par Jellyfin. */
async function channelCount(base, token) {
  const r = await request(base, 'LiveTv/Channels?limit=0&enableTotalRecordCount=true', { token: token });
  return (r && r.TotalRecordCount) || 0;
}

/** Vrai si la tâche d'actualisation du guide tourne encore. */
async function guideRunning(base, token) {
  const tasks = (await request(base, 'ScheduledTasks', { token: token })) || [];
  const task = tasks.find((t) => t.Key === 'RefreshGuide');
  return !!(task && task.State && task.State !== 'Idle');
}

module.exports = { info, login, apiKey, setTuner, setGuide, refreshGuide, channelCount, guideRunning, request };
