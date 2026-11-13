// Faux fournisseur IPTV pour l'essai local : liste, guide et état du compte.
// node test/fake-provider.js  → http://127.0.0.1:9999/get.php?username=demo&password=demo
'use strict';
const http = require('http');
const PORT = Number(process.argv[2] || 9999);
const CH = [
  ['FR| TF1 HD', 'TF1.fr', 'EU | FRANCE GENERALE'], ['FR| TF1 FHD', 'TF1.fr', 'EU | FRANCE GENERALE'],
  ['FR| M6 HD', 'M6.fr', 'EU | FRANCE GENERALE'], ['FR| ARTE HD', 'Arte.fr', 'EU | FRANCE GENERALE'],
  ['FR| BFM TV HD', 'BFMTV.fr', 'EU | FRANCE INFORMATION'], ['FR| CNEWS SD', 'CNews.fr', 'EU | FRANCE INFORMATION'],
  ['FR| GULLI HD', 'Gulli.fr', 'EU | FRANCE ENFANTS'], ['FR| CHAINE SANS GUIDE HD', '', 'EU | FRANCE ENFANTS'],
];
// Le port 9998 sert une liste plus courte : de quoi vérifier qu'un changement d'adresse est bien pris.
const LIST = () => (PORT === 9999 ? CH : CH.slice(0, 4));
const m3u = () => '#EXTM3U\n' + LIST().map(([name, id, grp], i) =>
  '#EXTINF:-1 tvg-id="' + id + '" tvg-name="' + name + '" tvg-chno="' + (100 + i) + '" group-title="' + grp + '",' + name +
  '\nhttp://127.0.0.1:' + PORT + '/live/' + i + '.ts').join('\n') + '\n';
const xmltv = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const stamp = (h) => d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(h) + '0000 +0100';
  const ids = [...new Set(CH.map((c) => c[1]).filter(Boolean))];
  return '<?xml version="1.0" encoding="UTF-8"?>\n<tv>' +
    ids.map((id) => '<channel id="' + id + '"><display-name>' + id.replace('.fr', '') + '</display-name></channel>').join('') +
    ids.map((id) => [0, 6, 12, 18].map((h) => '<programme channel="' + id + '" start="' + stamp(h) + '" stop="' + stamp(h + 6) +
      '"><title lang="fr">Émission ' + h + 'h sur ' + id.replace('.fr', '') + '</title><desc lang="fr">Résumé d’essai.</desc></programme>').join('')).join('') +
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
