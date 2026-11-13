// Desktroo TV — © 2026 Mdm-services.fr. Tous droits réservés.
// Pilotage de Threadfin : même liaison que son interface web (WebSocket /data/), sans aucune dépendance.
'use strict';
const net = require('net');
const crypto = require('crypto');

const os = require('os');

let HOST = '127.0.0.1';
const PORT = 34400;

/** Adresses possibles du moteur : la boucle locale, puis celles du conteneur (il n'écoute pas toujours sur 127.0.0.1). */
function candidates() {
  const list = ['127.0.0.1'];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family === 'IPv4' && !a.internal && list.indexOf(a.address) < 0) list.push(a.address);
    }
  }
  return list;
}

/** Essaie chaque adresse une fois ; retient celle qui répond. */
function reach(timeoutMs) {
  const hosts = candidates();
  let i = 0;
  const next = () => new Promise((resolve) => {
    if (i >= hosts.length) return resolve(false);
    const host = hosts[i++];
    const sock = net.connect(PORT, host);
    const done = (ok) => { sock.destroy(); resolve(ok ? (HOST = host, true) : next()); };
    sock.setTimeout(timeoutMs || 1500);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
  return next();
}

// ---------------------------------------------------------------- WebSocket minimal (RFC 6455, côté client)

/** Trame masquée à envoyer au serveur. */
function frame(data, opcode) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const mask = crypto.randomBytes(4);
  const n = payload.length;
  let head;
  if (n < 126) {
    head = Buffer.alloc(2);
    head[1] = 0x80 | n;
  } else if (n < 65536) {
    head = Buffer.alloc(4);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 0x80 | 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(n, 6);
  }
  head[0] = 0x80 | (opcode || 1);
  const body = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

/** Lit une trame complète dans [buf], ou null s'il en manque un morceau. */
function readFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    if (buf.readUInt32BE(off) !== 0) throw new Error('Réponse trop grande.');
    len = buf.readUInt32BE(off + 4);
    off += 8;
  }
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.slice(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.slice(off, off + len));
  if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
  return { fin: fin, opcode: opcode, payload: payload, rest: buf.slice(off + len) };
}

/**
 * Envoie une commande à Threadfin et rend sa réponse (l'état complet du serveur).
 * Une commande = une connexion, comme le fait son interface web.
 */
function cmd(name, data, timeoutMs) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(PORT, HOST);
    let phase = 'handshake';
    let buf = Buffer.alloc(0);
    let message = Buffer.alloc(0);
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('Threadfin ne répond pas (' + name + ').')), timeoutMs || 240000);
    sock.setNoDelay(true);
    sock.on('error', (e) => finish(new Error('Threadfin injoignable : ' + e.message)));
    sock.on('close', () => finish(new Error('Threadfin a coupé la connexion (' + name + ').')));
    sock.on('connect', () => {
      sock.write('GET /data/ HTTP/1.1\r\n' +
        'Host: ' + HOST + ':' + PORT + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n' +
        'Origin: http://' + HOST + ':' + PORT + '\r\n\r\n');
    });
    sock.on('data', (chunk) => {
      try {
        buf = Buffer.concat([buf, chunk]);
        if (phase === 'handshake') {
          const i = buf.indexOf('\r\n\r\n');
          if (i < 0) return;
          const head = buf.slice(0, i).toString('latin1');
          if (!/^HTTP\/1\.1 101/.test(head)) return finish(new Error('Threadfin refuse la liaison : ' + head.split('\r\n')[0]));
          buf = buf.slice(i + 4);
          phase = 'frames';
          sock.write(frame(JSON.stringify(Object.assign({ cmd: name }, data || {}))));
        }
        for (;;) {
          const f = readFrame(buf);
          if (!f) return;
          buf = f.rest;
          if (f.opcode === 8) return finish(new Error('Threadfin a fermé la liaison.'));
          if (f.opcode === 9) { sock.write(frame(f.payload, 0x0a)); continue; }
          if (f.opcode === 0 || f.opcode === 1 || f.opcode === 2) {
            if (f.opcode !== 0) message = Buffer.alloc(0);
            message = Buffer.concat([message, f.payload]);
            if (!f.fin) continue;
            let obj;
            try { obj = JSON.parse(message.toString('utf8')); } catch (e) { return finish(new Error('Réponse illisible de Threadfin.')); }
            if (obj && obj.status === false) return finish(new Error(String(obj.err || 'Threadfin a refusé la demande.')));
            return finish(null, obj || {});
          }
        }
      } catch (e) {
        finish(e);
      }
    });
  });
}

/** Attend que Threadfin réponde (après son démarrage). */
async function ready(seconds) {
  const until = Date.now() + (seconds || 60) * 1000;
  let last = 'Threadfin ne démarre pas.';
  for (;;) {
    try { await reach(1500); return await cmd('getServerConfig', {}, 8000); } catch (e) { last = e.message; }
    if (Date.now() > until) throw new Error(last);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * État complet du moteur : réglages, chaînes, guide et journal.
 * Toute commande autre que « updateLog » renvoie l'état entier ; « getServerConfig » ne modifie rien.
 */
async function state() {
  try { return await cmd('getServerConfig', {}, 20000); } catch (e) {
    if (!(await reach(1500))) throw e;
    return cmd('getServerConfig', {}, 20000);
  }
}

// ---------------------------------------------------------------- Raccourcis utiles

/**
 * Enregistre la liste de lecture et la télécharge. [id] vide = nouvelle liste.
 *
 * Deux commandes sont nécessaires pour une liste déjà connue : « save » change l'adresse enregistrée
 * sans rien télécharger, « update » télécharge mais en ignorant ce qu'on lui envoie. L'une puis l'autre,
 * sinon changer l'adresse recharge l'ancienne.
 */
async function saveM3U(id, name, url, tuner) {
  const entry = { name: name, description: '', 'file.source': url, tuner: Number(tuner) || 1, 'http_proxy.ip': '', 'http_proxy.port': '' };
  const saved = await cmd('saveFilesM3U', { files: { m3u: { [id || '-']: entry } } });
  if (!id) return saved;                                   // nouvelle liste : déjà téléchargée
  return cmd('updateFileM3U', { files: { m3u: { [id]: entry } } });
}

/** Enregistre une source de guide XMLTV et la télécharge (même raison que ci-dessus). */
async function saveXMLTV(id, name, url) {
  const entry = { name: name, description: '', 'file.source': url, 'http_proxy.ip': '', 'http_proxy.port': '' };
  const saved = await cmd('saveFilesXMLTV', { files: { xmltv: { [id || '-']: entry } } });
  if (!id) return saved;
  return cmd('updateFileXMLTV', { files: { xmltv: { [id]: entry } } });
}

const saveSettings = (settings) => cmd('saveSettings', { settings: settings });
const saveFilter = (filter) => cmd('saveFilter', { filter: filter });
const saveEpgMapping = (mapping) => cmd('saveEpgMapping', { epgMapping: mapping });

module.exports = { cmd, ready, state, reach, saveM3U, saveXMLTV, saveSettings, saveFilter, saveEpgMapping,
  host: () => HOST, PORT: PORT };
