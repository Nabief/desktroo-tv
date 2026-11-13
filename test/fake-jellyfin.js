// Faux Jellyfin pour l'essai local : le minimum dont l'app se sert, plus un ancien tuner déjà en place.
// node test/fake-jellyfin.js  → http://127.0.0.1:8096 (compte « admin » / « motdepasse »)
'use strict';
const http = require('http');
const PORT = Number(process.argv[2] || 8096);
const conf = {
  TunerHosts: [{ Id: 'ancien', Type: 'hdhomerun', Url: 'http://192.168.0.200:34400', FriendlyName: 'Threadfin' }],
  ListingProviders: [{ Id: 'vieuxguide', Type: 'xmltv', Path: 'http://192.168.0.200:34400/xmltv/threadfin.xml' }],
};
const keys = [];
const json = (res, obj, code) => {
  res.writeHead(code || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj === undefined ? null : obj));
};
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/^\/+/, '');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {};
    const m = req.method;
    if (p === 'System/Info/Public') return json(res, { ServerName: 'MdM-Media', Version: '12.2.0' });
    if (p === 'Users/AuthenticateByName' && m === 'POST') {
      if (body.Pw !== 'motdepasse') return json(res, { }, 401);
      return json(res, { AccessToken: 'jeton', User: { Policy: { IsAdministrator: true } } });
    }
    // Jellyfin ne sait pas lister les tuners ici : seulement en ajouter ou en retirer.
    if (p === 'LiveTv/TunerHosts') {
      if (m === 'POST') { conf.TunerHosts.push(Object.assign({ Id: 'neuf' }, body)); return json(res, body); }
      if (m === 'DELETE') {
        conf.TunerHosts = conf.TunerHosts.filter((h) => h.Id !== u.searchParams.get('id'));
        res.writeHead(204); return res.end();
      }
      return json(res, { }, 405);
    }
    if (p === 'LiveTv/ListingProviders') {
      if (m === 'POST') { conf.ListingProviders.push(Object.assign({ Id: 'neufguide' }, body)); return json(res, body); }
      if (m === 'DELETE') {
        conf.ListingProviders = conf.ListingProviders.filter((g) => g.Id !== u.searchParams.get('id'));
        res.writeHead(204); return res.end();
      }
      return json(res, { }, 405);
    }
    if (p === 'LiveTv/ListingProviders/Default') return json(res, { Type: 'xmltv' });
    if (p === 'System/Configuration/livetv') return json(res, conf);
    if (p === 'Auth/Keys') {
      if (m === 'POST') { keys.push({ AppName: u.searchParams.get('app'), AccessToken: 'cle-' + keys.length }); return json(res, null); }
      return json(res, { Items: keys });
    }
    if (p === 'ScheduledTasks') return json(res, [{ Id: 'tache', Key: 'RefreshGuide', Name: 'Guide', State: 'Idle' }]);
    if (p.startsWith('ScheduledTasks/Running/')) { res.writeHead(204); return res.end(); }
    if (p === 'LiveTv/Channels') return json(res, { TotalRecordCount: conf.TunerHosts.length * 400 });
    json(res, { }, 404);
  });
}).listen(PORT, () => console.log('faux Jellyfin sur http://127.0.0.1:' + PORT));
