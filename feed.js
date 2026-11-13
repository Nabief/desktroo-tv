// Desktroo TV — © 2026 Mdm-services.fr. Tous droits réservés.
//
// La liste de lecture du fournisseur passe par ici avant d'atteindre le moteur :
//   — elle est lue au fil de l'eau (une liste de 300 Mo ne tient pas en mémoire) ;
//   — les films et les séries à la demande sont écartés : le moteur ne sert qu'à la TV en direct,
//     et une liste de quelques milliers de chaînes se charge en quelques secondes au lieu de minutes ;
//   — le fichier obtenu est servi au moteur sur la boucle locale du conteneur, jamais au réseau.
'use strict';
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

// Adresse d'un film ou d'un épisode chez tous les panneaux de type Xtream :
//   .../movie/identifiant/motdepasse/12345.mkv   .../series/identifiant/motdepasse/12345.mp4
const VOD_PATH = /\/(movie|movies|series|serie|vod)\//i;
const VOD_EXT = /\.(mkv|mp4|avi|mov|m4v|flv|wmv|mpg|mpeg|webm)(\?|$)/i;

const TVG_ID = /tvg-id="([^"]*)"/i;

/**
 * Deux versions d'une même chaîne (HD et FHD) portent souvent le même identifiant de guide. Le moteur
 * s'en sert pour reconnaître ses chaînes et finit par les confondre : l'une des deux disparaît. On
 * laisse son identifiant à la première et on distingue les suivantes ; le guide leur est associé par
 * leur nom, comme le fait déjà l'écran ④ pour les chaînes absentes du guide.
 */
function uniqueId(extinf, seen) {
  const m = TVG_ID.exec(extinf);
  if (!m || !m[1]) return extinf;                   // sans identifiant : le moteur en fabrique un, déjà unique
  const id = m[1];
  const n = (seen.get(id) || 0) + 1;
  seen.set(id, n);
  return n === 1 ? extinf : extinf.replace(TVG_ID, 'tvg-id="' + id + '~' + n + '"');
}

/** Vrai si cette adresse est un film ou un épisode plutôt qu'une chaîne en direct. */
function isVod(url) {
  return VOD_PATH.test(url) || VOD_EXT.test(url);
}

function get(url, timeout) {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, {
      timeout: timeout || 120000,
      headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', Accept: '*/*', 'Accept-Encoding': 'gzip, deflate' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url); } catch (_) { return reject(new Error('Redirection illisible du fournisseur.')); }
        return get(next, timeout).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error('Le fournisseur répond « ' + res.statusCode + ' ».'));
      }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let out = res;
      if (enc === 'gzip') out = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') out = res.pipe(zlib.createInflate());
      out.on('error', reject);
      resolve({ stream: out, request: req });
    });
    req.on('timeout', () => req.destroy(new Error('Le fournisseur ne répond pas.')));
    req.on('error', (e) => reject(new Error('Fournisseur injoignable : ' + e.message)));
  });
}

/**
 * Télécharge la liste du fournisseur, n'en garde que les chaînes en direct et l'écrit dans `dest`.
 * Rend { total, kept, vod, bytes, digest } ; le fichier n'est remplacé qu'une fois complet.
 */
async function download(source, dest) {
  const url = new URL(String(source));
  const { stream } = await get(url);
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  const hash = crypto.createHash('sha1');
  let total = 0, kept = 0, vod = 0, bytes = 0, rest = '', extinf = null, header = false;
  const seen = new Map();

  const write = (text) => {
    const buf = Buffer.from(text, 'utf8');
    bytes += buf.length;
    hash.update(buf);
    if (!out.write(buf)) return new Promise((r) => out.once('drain', r));
    return null;
  };

  const line = async (raw) => {
    const l = raw.replace(/\r$/, '');
    if (!l) return;
    if (/^#EXTM3U/i.test(l)) { header = true; return; }
    if (/^#EXTINF/i.test(l)) { extinf = l; total++; return; }
    if (l[0] === '#') return;                       // #EXTGRP et autres : on repart du nom de groupe de l'#EXTINF
    if (!extinf) return;                            // adresse sans description : inexploitable
    if (isVod(l)) { vod++; extinf = null; return; }
    kept++;
    const p = write(uniqueId(extinf, seen) + '\n' + l + '\n');
    extinf = null;
    if (p) await p;
  };

  await write('#EXTM3U\n');
  for await (const chunk of stream) {
    const text = rest + chunk.toString('utf8');
    const parts = text.split('\n');
    rest = parts.pop();
    for (const p of parts) await line(p);
  }
  if (rest) await line(rest);
  await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });

  if (!header) {
    await fsp.unlink(tmp).catch(() => {});
    throw new Error("Le fournisseur n'a pas renvoyé une liste de lecture (pas de ligne #EXTM3U). " +
      "Vérifiez l'adresse et que l'abonnement est actif.");
  }
  if (!kept) {
    await fsp.unlink(tmp).catch(() => {});
    throw new Error(total
      ? 'La liste ne contient que des films et des séries (' + total + " entrées), aucune chaîne en direct."
      : "La liste reçue est vide : l'abonnement est peut-être expiré ou les identifiants refusés.");
  }
  await fsp.rename(tmp, dest);
  return { total: total, kept: kept, vod: vod, bytes: bytes, digest: hash.digest('hex').slice(0, 16) };
}

module.exports = { download: download, isVod: isVod };
