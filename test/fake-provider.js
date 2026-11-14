// Faux fournisseur IPTV pour l'essai local : liste, guide et état du compte.
// node test/fake-provider.js  → http://127.0.0.1:9999/get.php?username=demo&password=demo
'use strict';
const http = require('http');
const PORT = Number(process.argv[2] || 9999);
const CH = [
  ['FR| TF1 HD', 'TF1.fr', 'EU | FRANCE GENERALE '], ['FR| TF1 FHD', 'TF1.fr', 'EU | FRANCE GENERALE '],
  ['FR| M6 HD', 'M6.fr', 'EU | FRANCE GENERALE '], ['FR| ARTE HD', 'Arte.fr', 'EU | FRANCE GENERALE '],
  ['FR| BFM TV HD', 'BFMTV.fr', 'EU | FRANCE INFORMATION'], ['FR| CNEWS SD', 'CNews.fr', 'EU | FRANCE INFORMATION'],
  ['FR| GULLI HD', 'Gulli.fr', 'EU | FRANCE ENFANTS'], ['FR| CHAINE SANS GUIDE HD', '', 'EU | FRANCE ENFANTS'],
];
// Le port 9998 sert une liste plus courte : de quoi vérifier qu'un changement d'adresse est bien pris.
const LIST = () => (PORT === 9999 ? CH : CH.slice(0, 4));
// « big » ajoute des dizaines de milliers de films et de séries, comme un vrai fournisseur : la liste
// dépasse alors 10 Mo, le seuil au-delà duquel le lecteur de listes du moteur basculait dans son
// chemin cassé. De quoi vérifier le correctif et le tri de Desktroo TV.
const BIG = process.argv.includes('big') ? 60000 : 0;
const m3u = () => '#EXTM3U\n' + LIST().map(([name, id, grp], i) =>
  '#EXTINF:-1 tvg-id="' + id + '" tvg-name="' + name + '" tvg-chno="' + (100 + i) + '" group-title="' + grp + '",' + name +
  '\nhttp://127.0.0.1:' + PORT + '/live/' + i + '.ts').join('\n') + '\n' +
  Array.from({ length: BIG }, (_, i) =>
    '#EXTINF:-1 tvg-id="" tvg-name="Film numéro ' + i + '" tvg-logo="http://127.0.0.1:' + PORT + '/img/' + i +
    '.jpg" group-title="VOD | FILMS ' + (i % 40) + '",Film numéro ' + i + ' (2026) VF multi audio\n' +
    'http://127.0.0.1:' + PORT + (i % 2 ? '/movie' : '/series') + '/demo/demo/' + i + '.mkv').join('\n') +
  (BIG ? '\n' : '');
const xmltv = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const stamp = (h) => { const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
    t.setMinutes(t.getMinutes() + Math.round(h * 60));
    return t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + p(t.getHours()) + p(t.getMinutes()) + '00 +0100'; };
  const ids = [...new Set(CH.map((c) => c[1]).filter(Boolean))];
  // « big » : un guide de la taille d'un vrai (des dizaines de milliers de programmes, plusieurs Mo),
  // de quoi mesurer ce que coûte au moteur une reconstruction quand un guide est en place.
  const jours = BIG ? 7 : 1, parJour = BIG ? 48 : 4, autres = BIG ? 250 : 0;
  const tous = ids.concat(Array.from({ length: autres }, (_, i) => 'Autre' + i + '.fr'));
  const creneaux = Array.from({ length: jours * parJour }, (_, k) => k * (24 / parJour));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<tv>' +
    tous.map((id) => '<channel id="' + id + '"><display-name>' + id.replace('.fr', '') + '</display-name></channel>').join('') +
    tous.map((id) => creneaux.map((h) => '<programme channel="' + id + '" start="' + stamp(h) + '" stop="' + stamp(h + 24 / parJour) +
      '"><title lang="fr">Émission ' + h + 'h sur ' + id.replace('.fr', '') + '</title><desc lang="fr">Résumé d’essai, assez long pour peser comme un vrai résumé de programme télévisé.</desc></programme>').join('')).join('') +
    '</tv>';
};
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const ok = u.searchParams.get('username') === 'demo' && u.searchParams.get('password') === 'demo';
  if (u.pathname === '/player_api.php') {
    const exp = Math.floor(Date.now() / 1000) + 45 * 86400;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ user_info: { auth: ok ? 1 : 0, status: ok ? 'Active' : 'Expired', exp_date: String(exp),
      active_cons: '0', max_connections: '2', is_trial: '0' } }));
  }
  // Faux flux : des octets au rythme d'une vraie diffusion, pour vérifier que le moteur relaie
  // bien jusqu'au lecteur. Comme chez un vrai fournisseur, seul un lecteur connu est servi.
  if (u.pathname.startsWith('/live/')) {
    if (!/VLC/i.test(String(req.headers['user-agent'] || ''))) { req.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    // Un vrai flux MPEG-TS, rejoué en boucle : FFmpeg refuse des octets quelconques.
    const fichier = process.env.FAKE_TS || '';
    let data;
    try { data = require('fs').readFileSync(fichier); } catch (_) { data = Buffer.alloc(16 * 1024, 7); }
    let pos = 0;
    const t = setInterval(() => {
      const bout = data.subarray(pos, pos + 64 * 1024);
      pos = (pos + 64 * 1024) % data.length;
      if (!res.write(bout)) { /* le client suivra */ }
    }, 60);
    req.on('close', () => clearInterval(t));
    return;
  }
  if (u.pathname === '/get.php') {
    if (!ok) { res.writeHead(403); return res.end('no'); }
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
    return res.end(m3u());
  }
  if (u.pathname === '/xmltv.php') {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    return res.end(xmltv());
  }
  res.writeHead(404); res.end('');
}).listen(PORT, () => console.log('faux fournisseur sur http://127.0.0.1:' + PORT));
