// Testes do servidor. Correr com:  node --test tests/
// Usam o modo demo (sem HubSpot) e um KV em memória; o modo HubSpot é simulado com fetch falso.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { _teste } from '../site/_worker.js';

const { gerarTitulo, papelDoContacto, validarNovaReuniao } = _teste;

function kvMemoria(inicial = {}) {
  const m = new Map(Object.entries(inicial));
  return {
    async get(k, tipo) { const v = m.get(k); if (v == null) return null; return tipo === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    _m: m,
  };
}

function envDemo(email = 'ana.teste@fercopor.pt', extra = {}) {
  return {
    DEMO_USER_EMAIL: email,
    ADMIN_EMAILS: 'admin.teste@fercopor.pt',
    REUNIOES_KV: kvMemoria({ utilizadores: JSON.stringify([{ email: 'ana.teste@fercopor.pt', admin: false }, { email: 'bruno.teste@fercopor.pt', admin: false }]) }),
    ASSETS: { fetch: async () => new Response('estático') },
    ...extra,
  };
}

const pedir = (env, caminho, op = {}) => worker.fetch(new Request('https://app.exemplo' + caminho, {
  method: op.method || 'GET',
  headers: { 'Content-Type': 'application/json', ...(op.headers || {}) },
  body: op.body ? JSON.stringify(op.body) : undefined,
}), env);

test('títulos padronizados', () => {
  assert.equal(gerarTitulo('PURE', { nome: 'Ana', papel: 'cliente' }), 'FERCOPOR | PURE - Ana');
  assert.equal(gerarTitulo('PURE', { nome: 'Rita', papel: 'parceiro' }), 'FERCOPOR | PURE - Parceiro Rita');
  assert.equal(gerarTitulo('PURE', { nome: 'Rita', papel: 'parceiro' }, { nome: 'Ana' }), 'FERCOPOR | PURE - Parceiro Rita - Ana');
});

test('papel pelo tipo de contacto (vários valores)', () => {
  assert.deepEqual(papelDoContacto('Mediador Imobiliário'), { papel: 'parceiro', excluido: false });
  assert.deepEqual(papelDoContacto('Comprador Serenity;Comprador c/ Histórico'), { papel: 'cliente', excluido: false });
  assert.equal(papelDoContacto('Staff FERCOPOR').excluido, true);
});

test('validação recusa horas invertidas e tipos inventados', () => {
  const base = { empreendimento: 'PURE', tipo: 'Reunião Comercial', modalidade: 'presencial', inicio: '2026-10-27T10:00:00Z', fim: '2026-10-27T11:00:00Z', contactoId: '1001' };
  assert.ok(validarNovaReuniao(base, ['PURE']));
  assert.throws(() => validarNovaReuniao({ ...base, fim: '2026-10-27T09:00:00Z' }, ['PURE']));
  assert.throws(() => validarNovaReuniao({ ...base, tipo: 'Almoço' }, ['PURE']));
  assert.throws(() => validarNovaReuniao({ ...base, empreendimento: 'OUTRO' }, ['PURE']));
});

test('sem configuração de acesso nada é servido', async () => {
  const r = await pedir({ ASSETS: { fetch: async () => new Response('x') } }, '/');
  assert.equal(r.status, 503);
});

test('domínio fora da organização é recusado', async () => {
  const r = await pedir(envDemo('alguem@gmail.com'), '/api/me');
  assert.equal(r.status, 403);
});

test('utilizador @fercopor.pt não autorizado é recusado', async () => {
  const r = await pedir(envDemo('carlos.teste@fercopor.pt'), '/api/me');
  assert.equal(r.status, 403);
});

test('administrador por ADMIN_EMAILS entra e gere a lista', async () => {
  const env = envDemo('admin.teste@fercopor.pt');
  const me = await (await pedir(env, '/api/me')).json();
  assert.equal(me.admin, true);
  const r = await pedir(env, '/api/admin/utilizadores', { method: 'PUT', body: { utilizadores: [{ email: 'carlos.teste@fercopor.pt' }] } });
  assert.equal(r.status, 200);
  const fora = await pedir(env, '/api/admin/utilizadores', { method: 'PUT', body: { utilizadores: [{ email: 'x@gmail.com' }] } });
  assert.equal(fora.status, 400);
});

test('não administrador não acede à gestão de utilizadores', async () => {
  const r = await pedir(envDemo(), '/api/admin/utilizadores');
  assert.equal(r.status, 403);
});

// Uma reunião fictícia «Programados» do utilizador, obtida pela própria API
async function umaReuniaoProgramada(env) {
  const de = new Date(Date.now() - 30 * 864e5).toISOString();
  const ate = new Date(Date.now() + 30 * 864e5).toISOString();
  const { reunioes } = await (await pedir(env, `/api/reunioes?de=${de}&ate=${ate}`)).json();
  const m = reunioes.find((r) => r.resultado === 'SCHEDULED');
  assert.ok(m, 'há reuniões de demonstração');
  return m;
}

test('isolamento: reunião de outro proprietário devolve 404 em leitura e escrita (T-10)', async () => {
  const ana = envDemo('ana.teste@fercopor.pt');
  const bruno = envDemo('bruno.teste@fercopor.pt');
  const doBruno = await umaReuniaoProgramada(bruno);
  assert.equal((await pedir(ana, `/api/reunioes/${doBruno.id}`)).status, 404);
  assert.equal((await pedir(ana, `/api/reunioes/${doBruno.id}/resultado`, { method: 'POST', body: { resultado: 'CANCELED' } })).status, 404);
  assert.equal((await pedir(ana, `/api/reunioes/${doBruno.id}`, { method: 'PATCH', body: { inicio: '2026-10-27T10:00:00Z', fim: '2026-10-27T11:00:00Z' } })).status, 404);
  const depois = await (await pedir(bruno, `/api/reunioes/${doBruno.id}`)).json();
  assert.equal(depois.reuniao.resultado, 'SCHEDULED');   // nada foi alterado
  const daAna = await umaReuniaoProgramada(ana);
  assert.notEqual(daAna.id, doBruno.id);
});

test('criar reunião: idempotência e título', async () => {
  const env = envDemo();
  const corpo = { contactoId: '1002', clienteId: '1003', empreendimento: 'SERENITY', tipo: 'Reunião Parceiro c/ Cliente', modalidade: 'online', inicio: '2026-11-03T10:00:00Z', fim: '2026-11-03T11:00:00Z' };
  const chave = 'teste-idem-0001-abcdef';
  const r1 = await pedir(env, '/api/reunioes', { method: 'POST', body: corpo, headers: { 'Idempotency-Key': chave } });
  assert.equal(r1.status, 201);
  const a = (await r1.json()).reuniao;
  assert.equal(a.titulo, 'FERCOPOR | SERENITY - Parceiro Rita Lemos - Paulo Antunes');
  assert.equal(a.resultado, 'SCHEDULED');
  const r2 = await pedir(env, '/api/reunioes', { method: 'POST', body: corpo, headers: { 'Idempotency-Key': chave } });
  const b = await r2.json();
  assert.equal(b.repetida, true);
  assert.equal(b.reuniao.id, a.id);
});

test('cliente não pode apresentar cliente; contacto interno é recusado', async () => {
  const env = envDemo();
  const base = { empreendimento: 'PURE', tipo: 'Reunião Comercial', modalidade: 'presencial', inicio: '2026-11-03T10:00:00Z', fim: '2026-11-03T11:00:00Z' };
  const r1 = await pedir(env, '/api/reunioes', { method: 'POST', body: { ...base, contactoId: '1001', clienteId: '1003' }, headers: { 'Idempotency-Key': 'teste-idem-0002-abcdef' } });
  assert.equal(r1.status, 400);
  const r2 = await pedir(env, '/api/reunioes', { method: 'POST', body: { ...base, contactoId: '1015' }, headers: { 'Idempotency-Key': 'teste-idem-0003-abcdef' } });
  assert.equal(r2.status, 400);
});

test('reprogramar mantém o resultado; cancelar não elimina', async () => {
  const env = envDemo();
  const { id } = await umaReuniaoProgramada(env);
  const r = await (await pedir(env, `/api/reunioes/${id}`, { method: 'PATCH', body: { inicio: '2026-11-05T10:00:00Z', fim: '2026-11-05T11:00:00Z' } })).json();
  assert.equal(r.reuniao.resultado, 'SCHEDULED');
  assert.match(r.reuniao.notas, /Reprogramada/);
  const c = await (await pedir(env, `/api/reunioes/${id}/resultado`, { method: 'POST', body: { resultado: 'CANCELED', observacao: 'Cliente pediu' } })).json();
  assert.equal(c.reuniao.resultado, 'CANCELED');
  assert.equal((await pedir(env, `/api/reunioes/${id}`)).status, 200);
});

test('modo HubSpot sem Access configurado: DEMO_USER_EMAIL não serve de entrada (503) e o HubSpot não é chamado', async () => {
  const chamadas = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => { chamadas.push(String(url)); return new Response('{}'); };
  try {
    const env = { HUBSPOT_TOKEN: 'x', DEMO_USER_EMAIL: 'ana.teste@fercopor.pt', REUNIOES_KV: kvMemoria(), ASSETS: { fetch: async () => new Response('x') } };
    const r = await pedir(env, '/api/reunioes', { method: 'POST', body: {}, headers: { 'Idempotency-Key': 'teste-idem-0004-abcdef' } });
    assert.equal(r.status, 503);
    assert.equal(chamadas.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

/* ---------- Sessão Cloudflare Access (JWT RS256) com chave gerada no teste ---------- */

const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const EQUIPA = 'fercopor-teste.cloudflareaccess.com';
const AUD = 'aud-teste-123';
const parChaves = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
);
const jwkPublica = { ...(await crypto.subtle.exportKey('jwk', parChaves.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

async function jwt(dados, { kid = 'k1', chave = parChaves.privateKey } = {}) {
  const agora = Math.floor(Date.now() / 1000);
  const cab = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })));
  const corpo = b64url(new TextEncoder().encode(JSON.stringify({ iss: `https://${EQUIPA}`, aud: [AUD], exp: agora + 600, iat: agora, ...dados })));
  const ass = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', chave, new TextEncoder().encode(`${cab}.${corpo}`));
  return `${cab}.${corpo}.${b64url(new Uint8Array(ass))}`;
}

function comHubSpotFalso(fn) {
  return async () => {
    const chamadas = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, op = {}) => {
      const u = String(url);
      chamadas.push(`${op.method || 'GET'} ${u}`);
      if (u === `https://${EQUIPA}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [jwkPublica] }));
      if (u.includes('/crm/v3/owners/')) return new Response(JSON.stringify({ results: [{ id: '1000001', email: 'ana.teste@fercopor.pt', firstName: 'Ana', lastName: 'Teste', archived: false }] }));
      if (u.startsWith('https://api.hubapi.com/crm/v3/objects/meetings/555?')) {
        return new Response(JSON.stringify({ id: '555', properties: { hubspot_owner_id: '1000001', hs_meeting_title: 'Teste', hs_meeting_start_time: '2026-10-27T10:00:00Z', hs_meeting_end_time: '2026-10-27T11:00:00Z', hs_meeting_outcome: 'SCHEDULED' } }));
      }
      return new Response(JSON.stringify({ results: [] }));
    };
    try { await fn(chamadas); } finally { globalThis.fetch = original; }
  };
}

const envAccess = () => ({
  ACCESS_TEAM_DOMAIN: EQUIPA, ACCESS_AUD: AUD, HUBSPOT_TOKEN: 'token-teste',
  REUNIOES_KV: kvMemoria({ utilizadores: JSON.stringify([{ email: 'ana.teste@fercopor.pt' }]) }),
  ASSETS: { fetch: async () => new Response('x') },
});

test('Access: sessão válida entra; modo HubSpot só leitura', comHubSpotFalso(async () => {
  const r = await pedir(envAccess(), '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': await jwt({ email: 'ana.teste@fercopor.pt' }) } });
  assert.equal(r.status, 200);
  const me = await r.json();
  assert.equal(me.ownerId, '1000001');
  assert.equal(me.modo, 'hubspot');
  assert.equal(me.escritaAtiva, false);
}));

test('Access: sem token, expirado, audiência errada ou assinatura falsa → 401', comHubSpotFalso(async () => {
  const env = envAccess();
  assert.equal((await pedir(env, '/api/me')).status, 401);
  const expirado = await jwt({ email: 'ana.teste@fercopor.pt', exp: Math.floor(Date.now() / 1000) - 10 });
  assert.equal((await pedir(env, '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': expirado } })).status, 401);
  const outraAud = await jwt({ email: 'ana.teste@fercopor.pt', aud: ['outra'] });
  assert.equal((await pedir(env, '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': outraAud } })).status, 401);
  const outroPar = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const falso = await jwt({ email: 'ana.teste@fercopor.pt' }, { chave: outroPar.privateKey });
  assert.equal((await pedir(env, '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': falso } })).status, 401);
  const outroEmissor = await jwt({ email: 'ana.teste@fercopor.pt', iss: 'https://outro.cloudflareaccess.com' });
  assert.equal((await pedir(env, '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': outroEmissor } })).status, 401);
}));

test('Access: modo HubSpot com escrita desligada recusa criar, reprogramar e resultado sem escrever no HubSpot', comHubSpotFalso(async (chamadas) => {
  const env = envAccess();
  const h = { 'Cf-Access-Jwt-Assertion': await jwt({ email: 'ana.teste@fercopor.pt' }) };
  const criar = await pedir(env, '/api/reunioes', { method: 'POST', body: {}, headers: { ...h, 'Idempotency-Key': 'teste-idem-0005-abcdef' } });
  assert.equal(criar.status, 403);
  const ler = await pedir(env, '/api/reunioes/555', { headers: h });
  assert.equal(ler.status, 200);   // a leitura da própria reunião funciona
  const reprog = await pedir(env, '/api/reunioes/555', { method: 'PATCH', body: { inicio: '2026-10-28T10:00:00Z', fim: '2026-10-28T11:00:00Z' }, headers: h });
  assert.equal(reprog.status, 403);
  const resultado = await pedir(env, '/api/reunioes/555/resultado', { method: 'POST', body: { resultado: 'CANCELED' }, headers: h });
  assert.equal(resultado.status, 403);
  const escritas = chamadas.filter((c) => /^(POST|PATCH|PUT|DELETE) https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/meetings(\/\d+)?$/.test(c));
  assert.deepEqual(escritas, []);
}));

test('pedido de outra origem é recusado', async () => {
  const r = await pedir(envDemo(), '/api/reunioes', { method: 'POST', body: {}, headers: { Origin: 'https://malicioso.exemplo' } });
  assert.equal(r.status, 403);
});

/* ---------- Login Microsoft (Entra ID, OIDC + PKCE) com diretório simulado ---------- */

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENTE = 'app-cliente-teste';
const URL_APP = 'https://app.exemplo';

const envEntra = (extra = {}) => ({
  ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENTE, ENTRA_CLIENT_SECRET: 'segredo-do-cliente',
  SESSION_SECRET: 's'.repeat(40), APP_URL: URL_APP,
  REUNIOES_KV: kvMemoria({ utilizadores: JSON.stringify([{ email: 'ana.teste@fercopor.pt' }]) }),
  ASSETS: { fetch: async () => new Response('estático') },
  ...extra,
});

async function idTokenEntra(dados) {
  return jwt({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENTE, tid: TENANT, oid: 'oid-ana', name: 'Ana Teste', preferred_username: 'ana.teste@fercopor.pt', ...dados });
}

// Simula a Microsoft: chaves públicas e endpoint de token (devolve um id_token com o nonce pedido)
let nonceAtual = null;
function comMicrosoftFalsa(fn) {
  return async () => {
    const pedidosToken = [];
    let extraToken = {};
    const original = globalThis.fetch;
    globalThis.fetch = async (url, op = {}) => {
      const u = String(url);
      if (u === `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`) return new Response(JSON.stringify({ keys: [jwkPublica] }));
      if (u === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) {
        pedidosToken.push(new URLSearchParams(op.body));
        return new Response(JSON.stringify({ id_token: await idTokenEntra({ nonce: nonceAtual, ...extraToken }) }));
      }
      return new Response('{}', { status: 404 });
    };
    try { await fn({ pedidosToken, definir: (x) => { extraToken = x; } }); } finally { globalThis.fetch = original; }
  };
}

const cookiesDe = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

async function iniciar(env) {
  const r = await pedir(env, '/auth/entrar');
  assert.equal(r.status, 302);
  const destino = new URL(r.headers.get('Location'));
  nonceAtual = destino.searchParams.get('nonce');
  return { destino, cookieOauth: cookiesDe(r) };
}

const retorno = (env, destino, cookieOauth) => pedir(env, `/auth/retorno?code=codigo-1&state=${destino.searchParams.get('state')}`, { headers: { Cookie: cookieOauth } });

test('Entra: sem sessão, as páginas mostram «Iniciar sessão com Microsoft» e a API responde 401', async () => {
  const env = envEntra();
  const pagina = await pedir(env, '/');
  assert.equal(pagina.status, 200);
  assert.match(await pagina.text(), /Iniciar sessão com Microsoft/);
  assert.equal((await pedir(env, '/api/me')).status, 401);
  assert.equal((await pedir(env, '/style.css')).status, 200);   // a página de entrada precisa do estilo
  assert.match(await (await pedir(env, '/app.js')).text(), /Iniciar sessão/);   // o código da app não é entregue
});

test('Entra: /auth/entrar usa PKCE (S256), state, nonce e só os âmbitos de login', async () => {
  const { destino, cookieOauth } = await iniciar(envEntra());
  assert.equal(destino.origin + destino.pathname, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
  assert.equal(destino.searchParams.get('client_id'), CLIENTE);
  assert.equal(destino.searchParams.get('redirect_uri'), `${URL_APP}/auth/retorno`);
  assert.equal(destino.searchParams.get('scope'), 'openid profile email');
  assert.equal(destino.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(destino.searchParams.get('code_challenge').length >= 43);
  assert.ok(destino.searchParams.get('state'));
  assert.match(cookieOauth, /^__Host-reunioes_oauth=/);
});

test('Entra: login completo cria sessão HttpOnly/Secure e a app reconhece o utilizador', comMicrosoftFalsa(async ({ pedidosToken }) => {
  const env = envEntra();
  const { destino, cookieOauth } = await iniciar(env);
  const r = await retorno(env, destino, cookieOauth);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/');
  const sessao = r.headers.getSetCookie().find((c) => c.startsWith('__Host-reunioes_sessao='));
  assert.match(sessao, /HttpOnly/);
  assert.match(sessao, /Secure/);
  assert.match(sessao, /SameSite=Lax/);
  assert.equal(pedidosToken.length, 1);
  assert.ok(pedidosToken[0].get('code_verifier'));
  assert.equal(pedidosToken[0].get('client_secret'), 'segredo-do-cliente');
  const me = await pedir(env, '/api/me', { headers: { Cookie: cookiesDe(r) } });
  assert.equal(me.status, 200);
  const dados = await me.json();
  assert.equal(dados.email, 'ana.teste@fercopor.pt');
  assert.equal(dados.autenticacao, 'microsoft');
  assert.equal(dados.sair, '/auth/sair');
}));

test('Entra: state errado ou sem cookie temporário → recusado, sem pedir token', comMicrosoftFalsa(async ({ pedidosToken }) => {
  const env = envEntra();
  const { cookieOauth } = await iniciar(env);
  assert.equal((await pedir(env, '/auth/retorno?code=c&state=outro', { headers: { Cookie: cookieOauth } })).status, 400);
  assert.equal((await pedir(env, '/auth/retorno?code=c&state=x')).status, 400);
  assert.equal(pedidosToken.length, 0);
}));

test('Entra: conta de outra organização (tid) ou de outro domínio → recusada sem sessão', comMicrosoftFalsa(async ({ definir }) => {
  const env = envEntra();
  definir({ tid: '99999999-9999-9999-9999-999999999999' });
  let { destino, cookieOauth } = await iniciar(env);
  let r = await retorno(env, destino, cookieOauth);
  assert.equal(r.status, 403);
  assert.ok(!r.headers.getSetCookie().some((c) => c.startsWith('__Host-reunioes_sessao=')));
  definir({ preferred_username: 'ana@gmail.com' });
  ({ destino, cookieOauth } = await iniciar(env));
  r = await retorno(env, destino, cookieOauth);
  assert.equal(r.status, 403);
}));

test('Entra: nonce diferente (reutilização de token) → recusado', comMicrosoftFalsa(async ({ definir }) => {
  const env = envEntra();
  definir({ nonce: 'nonce-antigo' });
  const { destino, cookieOauth } = await iniciar(env);
  assert.equal((await retorno(env, destino, cookieOauth)).status, 401);
}));

test('Entra: cookie de sessão forjado → sem sessão', async () => {
  const corpo = Buffer.from(JSON.stringify({ e: 'ana.teste@fercopor.pt', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const r = await pedir(envEntra(), '/api/me', { headers: { Cookie: `__Host-reunioes_sessao=${corpo}.assinaturafalsa` } });
  assert.equal(r.status, 401);
});

test('Entra: da organização mas não autorizado → mensagem e sessão apagada', comMicrosoftFalsa(async ({ definir }) => {
  const env = envEntra();
  definir({ preferred_username: 'carlos.teste@fercopor.pt' });
  const { destino, cookieOauth } = await iniciar(env);
  const r = await retorno(env, destino, cookieOauth);
  assert.equal(r.status, 302);
  const pagina = await pedir(env, '/', { headers: { Cookie: cookiesDe(r) } });
  assert.equal(pagina.status, 403);
  assert.match(await pagina.text(), /sem autorização/);
  assert.ok(pagina.headers.getSetCookie().some((c) => c.startsWith('__Host-reunioes_sessao=;')));
}));

test('Entra: /auth/sair apaga a sessão', async () => {
  const r = await pedir(envEntra(), '/auth/sair');
  assert.equal(r.status, 200);
  assert.ok(r.headers.getSetCookie().some((c) => c.startsWith('__Host-reunioes_sessao=;') && c.includes('Max-Age=0')));
});

test('Transição: com Entra e Access, o Access continua a funcionar; com AUTH_MODE=entra deixa de ser aceite', comHubSpotFalso(async () => {
  const base = { ...envEntra(), ACCESS_TEAM_DOMAIN: EQUIPA, ACCESS_AUD: AUD };
  const h = { 'Cf-Access-Jwt-Assertion': await jwt({ email: 'ana.teste@fercopor.pt' }) };
  const r1 = await pedir(base, '/api/me', { headers: h });
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).autenticacao, 'access');
  assert.equal((await pedir({ ...base, AUTH_MODE: 'entra' }, '/api/me', { headers: h })).status, 401);
}));

test('Configuração do painel: MICROSOFT_* sem APP_URL nem SESSION_SECRET, com o Access ativo', comMicrosoftFalsa(async () => {
  const env = {
    MICROSOFT_TENANT_ID: ` ${TENANT} `, MICROSOFT_CLIENT_ID: CLIENTE, MICROSOFT_CLIENT_SECRET: 'segredo-do-cliente',
    ACCESS_TEAM_DOMAIN: EQUIPA, ACCESS_AUD: AUD,
    REUNIOES_KV: kvMemoria({ utilizadores: JSON.stringify([{ email: 'ana.teste@fercopor.pt' }]) }),
    ASSETS: { fetch: async () => new Response('estático') },
  };
  const { destino, cookieOauth } = await iniciar(env);
  assert.equal(destino.searchParams.get('redirect_uri'), 'https://app.exemplo/auth/retorno');   // APP_URL = endereço da app
  const r = await retorno(env, destino, cookieOauth);
  assert.equal(r.status, 302);
  const me = await pedir(env, '/api/me', { headers: { Cookie: cookiesDe(r) } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).autenticacao, 'microsoft');
  // sem sessão Microsoft nem Access, a API continua fechada
  assert.equal((await pedir(env, '/api/me')).status, 401);
}));

test('Diagnóstico: erro da Microsoft na troca do código mostra o código AADSTS, sem expor código nem segredo', async () => {
  const original = globalThis.fetch;
  const registos = [];
  const erroOriginal = console.error;
  console.error = (...a) => registos.push(a.join(' '));
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.', error_codes: [7000215], trace_id: 'abcd1234-0000', correlation_id: 'corr-1' }), { status: 401 });
    }
    return new Response('{}', { status: 404 });
  };
  try {
    const env = envEntra();
    const { destino, cookieOauth } = await iniciar(env);
    const r = await retorno(env, destino, cookieOauth);
    assert.equal(r.status, 502);
    const texto = await r.text();
    assert.match(texto, /AADSTS7000215/);
    assert.match(texto, /«Value»/);
    const log = registos.join('\n');
    assert.match(log, /entra_troca_codigo_falhou/);
    assert.doesNotMatch(log, /codigo-1|segredo-do-cliente/);   // nem o código de autorização nem o segredo
  } finally {
    globalThis.fetch = original;
    console.error = erroOriginal;
  }
});

test('Diagnóstico: segredo com formato de Secret ID é detetado antes de contactar a Microsoft', async () => {
  const original = globalThis.fetch;
  let chamouToken = false;
  globalThis.fetch = async (url) => { if (String(url).endsWith('/token')) chamouToken = true; return new Response('{}'); };
  const erroOriginal = console.error; console.error = () => {};
  try {
    const env = envEntra({ ENTRA_CLIENT_SECRET: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    const { destino, cookieOauth } = await iniciar(env);
    const r = await retorno(env, destino, cookieOauth);
    assert.match(await r.text(), /Secret ID/);
    assert.equal(chamouToken, false);
  } finally { globalThis.fetch = original; console.error = erroOriginal; }
});

test('Diagnóstico: /auth/diagnostico exige sessão e não mostra o segredo', comHubSpotFalso(async () => {
  const env = { ...envEntra({ ENTRA_CLIENT_SECRET: ' segredo-com-espaco\n' }), ACCESS_TEAM_DOMAIN: EQUIPA, ACCESS_AUD: AUD };
  assert.equal((await pedir(env, '/auth/diagnostico')).status, 401);
  const r = await pedir(env, '/auth/diagnostico', { headers: { 'Cf-Access-Jwt-Assertion': await jwt({ email: 'ana.teste@fercopor.pt' }) } });
  assert.equal(r.status, 200);
  const texto = await r.text();
  assert.doesNotMatch(texto, /segredo-com-espaco/);
  const d = JSON.parse(texto);
  assert.equal(d.clientSecretPresente, true);
  assert.equal(d.clientSecretTinhaEspacos, true);
  assert.equal(d.redirectUri, `${URL_APP}/auth/retorno`);
  assert.equal(d.tenantIdEGuid, true);
}));

test('Entra: configuração incompleta → 503 (nunca abre sem login)', async () => {
  const r = await pedir({ ENTRA_TENANT_ID: TENANT, ASSETS: { fetch: async () => new Response('x') } }, '/');
  assert.equal(r.status, 503);
});
