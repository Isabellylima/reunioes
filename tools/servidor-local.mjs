// Servidor local para experimentar a app em modo demonstração, sem Cloudflare.
// Uso:  node tools/servidor-local.mjs [email@fercopor.pt] [porta]
// Abre http://localhost:8787 . Usa só dados fictícios; nunca contacta o HubSpot.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../site/_worker.js';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const email = process.argv[2] || 'demo.utilizador@fercopor.pt';
const porta = Number(process.argv[3] || 8787);
const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const kv = new Map();
const env = {
  DEMO_USER_EMAIL: email,
  ADMIN_EMAILS: email,
  REUNIOES_KV: {
    async get(k, t) { const v = kv.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { kv.set(k, v); },
  },
  ASSETS: {
    async fetch(pedido) {
      let caminho = new URL(pedido.url).pathname;
      if (caminho === '/') caminho = '/index.html';
      const ficheiro = normalize(join(raiz, caminho));
      if (!ficheiro.startsWith(raiz) || caminho.startsWith('/_worker')) return new Response('Não encontrado', { status: 404 });
      try {
        return new Response(await readFile(ficheiro), { headers: { 'Content-Type': tipos[extname(ficheiro)] || 'application/octet-stream' } });
      } catch { return new Response('Não encontrado', { status: 404 }); }
    },
  },
};

http.createServer(async (req, res) => {
  const corpo = req.method === 'GET' || req.method === 'HEAD' ? undefined : await new Promise((ok) => {
    const partes = []; req.on('data', (p) => partes.push(p)); req.on('end', () => ok(Buffer.concat(partes)));
  });
  const pedido = new Request(`http://localhost:${porta}${req.url}`, { method: req.method, headers: req.headers, body: corpo });
  const resposta = await worker.fetch(pedido, env);
  res.writeHead(resposta.status, Object.fromEntries(resposta.headers));
  res.end(Buffer.from(await resposta.arrayBuffer()));
}).listen(porta, () => console.log(`App em http://localhost:${porta} (modo demo, utilizador ${email})`));
