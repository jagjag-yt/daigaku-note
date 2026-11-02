// テスト用の小さな WebDAV サーバー(CORS つき・メモリ上)。node test/davserver.mjs 8125
import http from 'node:http';
const port = Number(process.argv[2]) || 8125;
const store = new Map(); // path -> Buffer | 'DIR'
store.set('/dav/', 'DIR');
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,HEAD,MKCOL,PROPFIND,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Depth,Content-Type', 'Access-Control-Expose-Headers': 'ETag' };
http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const body = await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const send = (code, data = '', h = {}) => { res.writeHead(code, { ...cors, ...h }); res.end(data); };
  if (req.method === 'OPTIONS') return send(204);
  if (req.headers.authorization !== 'Basic ' + Buffer.from('test:pass').toString('base64')) return send(401);
  const dir = p.endsWith('/') ? p : p + '/';
  switch (req.method) {
    case 'MKCOL': {
      if (store.has(dir)) return send(405);
      const parent = dir.replace(/[^/]+\/$/, '');
      if (!store.has(parent)) return send(409);
      store.set(dir, 'DIR'); return send(201);
    }
    case 'PUT': store.set(p, body); return send(201);
    case 'GET': case 'HEAD': {
      const v = store.get(p);
      if (!v || v === 'DIR') return send(404);
      return send(200, req.method === 'GET' ? v : '');
    }
    case 'PROPFIND': {
      if (!store.has(dir)) return send(404);
      const kids = [...store.keys()].filter((k) => k !== dir && k.startsWith(dir) && !k.slice(dir.length).replace(/\/$/, '').includes('/'));
      const item = (k) => `<d:response><d:href>${encodeURI(k)}</d:href><d:propstat><d:prop><d:resourcetype>${store.get(k) === 'DIR' ? '<d:collection/>' : ''}</d:resourcetype></d:prop></d:propstat></d:response>`;
      return send(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${[dir, ...kids].map(item).join('')}</d:multistatus>`, { 'Content-Type': 'application/xml' });
    }
    default: return send(405);
  }
}).listen(port, () => console.log('dav on', port));
