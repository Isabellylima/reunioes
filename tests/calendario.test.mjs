// Testes do calendário Outlook/Teams (Microsoft Graph simulado) e da proteção das rotas.
// Correr com:  node --test tests/calendario.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { _teste } from '../site/_worker.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENTE = 'app-cliente-teste';
const URL_APP = 'https://app.exemplo';
const ANA = 'ana.teste@fercopor.pt';

function kvMemoria(inicial = {}) {
  const m = new Map(Object.entries(inicial));
  return {
    async get(k, tipo) { const v = m.get(k); if (v == null) return null; return tipo === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    _m: m,
  };
}

const pedir = (env, caminho, op = {}) => worker.fetch(new Request(URL_APP + caminho, {
  method: op.method || 'GET',
  headers: { 'Content-Type': 'application/json', ...(op.headers || {}) },
  body: op.body ? JSON.stringify(op.body) : undefined,
}), env);

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const par = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', par.publicKey)), kid: 'kc', alg: 'RS256' };
async function idToken(dados) {
  const agora = Math.floor(Date.now() / 1000);
  const c = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: 'kc', typ: 'JWT' })));
  const p = b64url(new TextEncoder().encode(JSON.stringify({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENTE, tid: TENANT, exp: agora + 600, iat: agora, preferred_username: ANA, ...dados })));
  const s = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', par.privateKey, new TextEncoder().encode(`${c}.${p}`));
  return `${c}.${p}.${b64url(new Uint8Array(s))}`;
}

// Como um browser: cookies com Max-Age=0 são apagados e não voltam a ser enviados
const cookiesDe = (r) => r.headers.getSetCookie().filter((c) => !/Max-Age=0/.test(c)).map((c) => c.split(';')[0]).join('; ');

function envBase(extra = {}) {
  return {
    ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENTE, ENTRA_CLIENT_SECRET: 'segredo-do-cliente', SESSION_SECRET: 'x'.repeat(40), APP_URL: URL_APP,
    REUNIOES_KV: kvMemoria({ utilizadores: JSON.stringify([{ email: ANA }, { email: 'bruno.teste@fercopor.pt' }]) }),
    ASSETS: { fetch: async () => new Response('estático') },
    ...extra,
  };
}

// Microsoft simulada: login, token do calendário, Graph (/me, eventos, disponibilidade)
function microsoftSimulada({ emailGraph = ANA, falharEventos = false } = {}) {
  const estado = { nonce: null, chamadas: [], eventos: [], falharEventos };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, op = {}) => {
    const u = String(url);
    const metodo = op.method || 'GET';
    estado.chamadas.push(`${metodo} ${u.split('?')[0]}`);
    if (u.endsWith('/discovery/v2.0/keys')) return new Response(JSON.stringify({ keys: [jwk] }));
    if (u.endsWith('/oauth2/v2.0/token')) {
      const corpo = new URLSearchParams(op.body);
      estado.ultimoToken = corpo;
      if (String(corpo.get('scope')).includes('Calendars.ReadWrite')) {
        return new Response(JSON.stringify({ access_token: 'at-graph', refresh_token: 'rt-secreto-1', expires_in: 3600 }));
      }
      return new Response(JSON.stringify({ id_token: await idToken({ nonce: estado.nonce }) }));
    }
    if (u.startsWith('https://graph.microsoft.com/v1.0/me?')) return new Response(JSON.stringify({ id: 'oid-1', mail: emailGraph }));
    if (u === 'https://graph.microsoft.com/v1.0/me/events' && metodo === 'POST') {
      if (estado.falharEventos) return new Response(JSON.stringify({ error: { code: 'ErrorInternalServerError' } }), { status: 500 });
      const corpo = JSON.parse(op.body);
      estado.eventos.push(corpo);
      return new Response(JSON.stringify({ id: 'EV-' + estado.eventos.length, onlineMeeting: corpo.isOnlineMeeting ? { joinUrl: 'https://teams.microsoft.com/l/meetup-join/real' } : null }), { status: 201 });
    }
    if (u.startsWith('https://graph.microsoft.com/v1.0/me/events/') && metodo === 'PATCH') {
      estado.patch = { url: u, corpo: JSON.parse(op.body) };
      return new Response('{}');
    }
    if (u === 'https://graph.microsoft.com/v1.0/me/calendar/getSchedule') {
      const corpo = JSON.parse(op.body);
      const dia = corpo.startTime.dateTime.slice(0, 10);
      return new Response(JSON.stringify({ value: [{ scheduleItems: [
        { status: 'busy', subject: 'Consulta médica (privado)', start: { dateTime: `${dia}T10:00:00.0000000` }, end: { dateTime: `${dia}T11:00:00.0000000` } },
        { status: 'free', start: { dateTime: `${dia}T12:00:00.0000000` }, end: { dateTime: `${dia}T13:00:00.0000000` } },
      ] }] }));
    }
    return new Response('{}', { status: 404 });
  };
  estado.repor = () => { globalThis.fetch = original; };
  return estado;
}

async function entrar(env, ms) {
  const r1 = await pedir(env, '/auth/entrar');
  const destino = new URL(r1.headers.get('Location'));
  ms.nonce = destino.searchParams.get('nonce');
  const r2 = await pedir(env, `/auth/retorno?code=c1&state=${destino.searchParams.get('state')}`, { headers: { Cookie: cookiesDe(r1) } });
  assert.equal(r2.status, 302);
  return cookiesDe(r2);
}

async function ligarCalendario(env, sessao) {
  const r1 = await pedir(env, '/auth/calendario/ligar', { headers: { Cookie: sessao } });
  assert.equal(r1.status, 302);
  const destino = new URL(r1.headers.get('Location'));
  const r2 = await pedir(env, `/auth/retorno?code=c2&state=${destino.searchParams.get('state')}`, { headers: { Cookie: `${sessao}; ${cookiesDe(r1)}` } });
  return { r1, destino, r2 };
}

const novaReuniao = (extra = {}) => ({
  contactoId: '1002', clienteId: '1003', empreendimento: 'SERENITY', tipo: 'Reunião Parceiro c/ Cliente', modalidade: 'online',
  inicio: '2026-11-10T10:00:00Z', fim: '2026-11-10T11:00:00Z', orcamento: '450 000 €', observacoes: 'nota interna confidencial', ...extra,
});

/* ---------- Fase 1: proteção das rotas ---------- */

test('Rotas: sem sessão Microsoft nada é entregue (páginas, API e escritas)', async () => {
  const env = envBase({ AUTH_MODE: 'entra' });
  for (const caminho of ['/', '/index.html', '/app.js', '/#/lista']) {
    const r = await pedir(env, caminho);
    assert.match(await r.text(), /Iniciar sessão com Microsoft/, caminho);
  }
  for (const [metodo, caminho] of [['GET', '/api/me'], ['GET', '/api/reunioes?de=2026-01-01T00:00:00Z&ate=2026-01-10T00:00:00Z'],
    ['GET', '/api/reunioes/por-classificar'], ['GET', '/api/contactos?q=ri'], ['GET', '/api/empreendimentos'], ['GET', '/api/reunioes/900001'],
    ['POST', '/api/reunioes'], ['PATCH', '/api/reunioes/900001'], ['POST', '/api/reunioes/900001/resultado'], ['POST', '/api/reunioes/900001/outlook'],
    ['GET', '/api/admin/utilizadores'], ['PUT', '/api/admin/utilizadores'], ['GET', '/api/calendario/disponibilidade'], ['POST', '/api/calendario/desligar']]) {
    const r = await pedir(env, caminho, { method: metodo, body: metodo === 'GET' ? undefined : {} });
    assert.equal(r.status, 401, `${metodo} ${caminho}`);
  }
  assert.equal((await pedir(env, '/auth/diagnostico')).status, 401);
  assert.match(await (await pedir(env, '/auth/calendario/ligar')).text(), /Iniciar sessão com Microsoft/);
});

test('Rotas: com AUTH_MODE=entra, uma sessão do Cloudflare Access não abre a app nem o diagnóstico', async () => {
  const env = envBase({ AUTH_MODE: 'entra', ACCESS_TEAM_DOMAIN: 'x.cloudflareaccess.com', ACCESS_AUD: 'aud' });
  const h = { 'Cf-Access-Jwt-Assertion': 'a.b.c' };
  assert.equal((await pedir(env, '/api/me', { headers: h })).status, 401);
  assert.equal((await pedir(env, '/auth/diagnostico', { headers: h })).status, 401);
});

test('Rotas: AUTH_MODE=entra sem o login Microsoft configurado → 503 (nunca abre)', async () => {
  const r = await pedir({ AUTH_MODE: 'entra', DEMO_USER_EMAIL: ANA, ASSETS: { fetch: async () => new Response('x') } }, '/api/me');
  assert.equal(r.status, 503);
});

/* ---------- Fase 2: calendário em modo de simulação ---------- */

test('Simulação: ligar, disponibilidade, criar com Teams, reprogramar — sem chamadas ao Graph', async () => {
  const ms = microsoftSimulada();
  try {
    const env = envBase({ CALENDAR_MODE: 'simulacao' });
    const sessao = await entrar(env, ms);
    const h = { Cookie: sessao };
    let me = await (await pedir(env, '/api/me', { headers: h })).json();
    assert.deepEqual(me.calendario, { modo: 'simulacao', ligado: false });
    assert.equal((await pedir(env, '/auth/calendario/ligar', { headers: h })).status, 302);
    me = await (await pedir(env, '/api/me', { headers: h })).json();
    assert.equal(me.calendario.ligado, true);
    const disp = await (await pedir(env, '/api/calendario/disponibilidade?inicio=2026-11-10T13:30:00Z&fim=2026-11-10T14:00:00Z', { headers: h })).json();
    assert.equal(disp.modo, 'simulacao');
    assert.equal(disp.conflito, true);
    const r = await pedir(env, '/api/reunioes', { method: 'POST', body: novaReuniao({ outlook: true, convidar: ['1002'] }), headers: { ...h, 'Idempotency-Key': 'sim-0001-abcdefghij' } });
    assert.equal(r.status, 201);
    const { reuniao, outlook } = await r.json();
    assert.equal(outlook.estado, 'simulado');
    assert.match(reuniao.ligacao, /SIMULACAO/);
    const p = await (await pedir(env, `/api/reunioes/${reuniao.id}`, { method: 'PATCH', body: { inicio: '2026-11-11T10:00:00Z', fim: '2026-11-11T11:00:00Z' }, headers: h })).json();
    assert.equal(p.outlook.estado, 'simulado');
    assert.equal(p.reuniao.resultado, 'SCHEDULED');
    assert.ok(!ms.chamadas.some((c) => c.includes('graph.microsoft.com')), 'nenhuma chamada ao Graph');
  } finally { ms.repor(); }
});

test('Convites: só contactos desta reunião podem ser convidados', async () => {
  const ms = microsoftSimulada();
  try {
    const env = envBase({ CALENDAR_MODE: 'simulacao' });
    const sessao = await entrar(env, ms);
    const r = await pedir(env, '/api/reunioes', { method: 'POST', body: novaReuniao({ outlook: true, convidar: ['1009'] }), headers: { Cookie: sessao, 'Idempotency-Key': 'sim-0002-abcdefghij' } });
    assert.equal(r.status, 400);
  } finally { ms.repor(); }
});

test('Modo real só para os utilizadores de teste; os outros ficam em simulação', async () => {
  const ms = microsoftSimulada();
  try {
    const env = envBase({ CALENDAR_MODE: 'real', CALENDAR_TEST_EMAILS: 'outra.pessoa@fercopor.pt' });
    const sessao = await entrar(env, ms);
    const me = await (await pedir(env, '/api/me', { headers: { Cookie: sessao } })).json();
    assert.equal(me.calendario.modo, 'simulacao');
  } finally { ms.repor(); }
});

/* ---------- Fase 2: calendário real com o Graph simulado ---------- */

test('Real: consentimento separado (só calendário), token cifrado em KV, criar evento com Teams e convites escolhidos', async () => {
  const ms = microsoftSimulada();
  try {
    const env = envBase({ CALENDAR_MODE: 'real', CALENDAR_TEST_EMAILS: ANA });
    const sessao = await entrar(env, ms);
    const { destino, r2 } = await ligarCalendario(env, sessao);
    assert.equal(destino.searchParams.get('scope'), 'offline_access Calendars.ReadWrite');
    assert.equal(destino.searchParams.get('login_hint'), ANA);
    assert.equal(r2.status, 302);
    const guardado = env.REUNIOES_KV._m.get(`cal:${ANA}`);
    assert.ok(guardado);
    assert.doesNotMatch(guardado, /rt-secreto-1/, 'o token de renovação está cifrado');

    const h = { Cookie: sessao };
    const disp = await (await pedir(env, '/api/calendario/disponibilidade?inicio=2026-11-10T10:30:00Z&fim=2026-11-10T11:30:00Z', { headers: h })).json();
    assert.equal(disp.conflito, true);
    assert.equal(disp.ocupados.length, 1);
    assert.doesNotMatch(JSON.stringify(disp), /Consulta médica/, 'sem detalhes privados');

    const chave = 'real-0001-abcdefghij';
    const r = await pedir(env, '/api/reunioes', { method: 'POST', body: novaReuniao({ outlook: true, convidar: ['1003'] }), headers: { ...h, 'Idempotency-Key': chave } });
    assert.equal(r.status, 201);
    const { reuniao, outlook } = await r.json();
    assert.equal(outlook.estado, 'criado');
    assert.equal(reuniao.ligacao, 'https://teams.microsoft.com/l/meetup-join/real');
    const ev = ms.eventos[0];
    assert.equal(ev.transactionId, chave);
    assert.equal(ev.isOnlineMeeting, true);
    assert.equal(ev.onlineMeetingProvider, 'teamsForBusiness');
    assert.deepEqual(ev.attendees.map((a) => a.emailAddress.address), ['paulo.antunes@exemplo.pt'], 'só o convidado escolhido');
    assert.doesNotMatch(JSON.stringify(ev), /450 000|confidencial/, 'o convite não leva as notas internas');
    assert.equal(ev.singleValueExtendedProperties[0].value, reuniao.id);

    // repetir o mesmo pedido não cria 2.º evento
    await pedir(env, '/api/reunioes', { method: 'POST', body: novaReuniao({ outlook: true, convidar: ['1003'] }), headers: { ...h, 'Idempotency-Key': chave } });
    assert.equal(ms.eventos.length, 1);

    // reprogramar atualiza o MESMO evento
    const p = await (await pedir(env, `/api/reunioes/${reuniao.id}`, { method: 'PATCH', body: { inicio: '2026-11-12T15:00:00Z', fim: '2026-11-12T16:00:00Z' }, headers: h })).json();
    assert.equal(p.outlook.estado, 'atualizado');
    assert.match(ms.patch.url, /\/me\/events\/EV-1$/);
    assert.equal(ms.patch.corpo.start.dateTime, '2026-11-12T15:00:00.000');
    assert.equal(ms.eventos.length, 1);
    assert.equal(p.reuniao.resultado, 'SCHEDULED');
  } finally { ms.repor(); }
});

test('Real: consentimento de outra conta Microsoft é recusado e nada é guardado', async () => {
  const ms = microsoftSimulada({ emailGraph: 'outra.conta@fercopor.pt' });
  try {
    const env = envBase({ CALENDAR_MODE: 'real' });
    const sessao = await entrar(env, ms);
    const { r2 } = await ligarCalendario(env, sessao);
    assert.equal(r2.status, 403);
    assert.equal(env.REUNIOES_KV._m.get(`cal:${ANA}`), undefined);
  } finally { ms.repor(); }
});

test('Real: se o Outlook falhar, a reunião fica no HubSpot e pode criar-se o evento depois', async () => {
  const ms = microsoftSimulada({ falharEventos: true });
  try {
    const env = envBase({ CALENDAR_MODE: 'real' });
    const sessao = await entrar(env, ms);
    await ligarCalendario(env, sessao);
    const h = { Cookie: sessao };
    const r = await pedir(env, '/api/reunioes', { method: 'POST', body: novaReuniao({ modalidade: 'presencial', outlook: true, convidar: [] }), headers: { ...h, 'Idempotency-Key': 'real-0002-abcdefghij' } });
    assert.equal(r.status, 201);
    const { reuniao, outlook } = await r.json();
    assert.equal(outlook.estado, 'falhou');
    const d = await (await pedir(env, `/api/reunioes/${reuniao.id}`, { headers: h })).json();
    assert.equal(d.outlook.estado, 'falhou');
    ms.falharEventos = false;
    const t = await (await pedir(env, `/api/reunioes/${reuniao.id}/outlook`, { method: 'POST', body: { convidar: [] }, headers: h })).json();
    assert.equal(t.outlook.estado, 'criado');
    assert.equal(ms.eventos[0].transactionId, `retry-${reuniao.id}`);
    assert.deepEqual(ms.eventos[0].attendees, []);
  } finally { ms.repor(); }
});

test('Real: sem calendário ligado, pedir o evento devolve aviso e a reunião é criada', async () => {
  const ms = microsoftSimulada();
  try {
    const env = envBase({ CALENDAR_MODE: 'real' });
    const sessao = await entrar(env, ms);
    const r = await pedir(env, '/api/reunioes', { method: 'POST', body: novaReuniao({ outlook: true }), headers: { Cookie: sessao, 'Idempotency-Key': 'real-0003-abcdefghij' } });
    assert.equal(r.status, 201);
    const { outlook } = await r.json();
    assert.equal(outlook.estado, 'falhou');
    assert.match(outlook.erro, /não está ligado/);
  } finally { ms.repor(); }
});

/* ---------- Fase 3: duplicados ---------- */

test('Duplicados: a reunião da app e a que a sincronização criou à mesma hora são assinaladas', async () => {
  const kv = kvMemoria({ 'mapdono:77': JSON.stringify([{ r: '10', i: 1000 }]) });
  const reunioes = [
    { id: '10', inicio: 1_000_000, origem: 'INTEGRATION' },
    { id: '11', inicio: 1_030_000, origem: 'BIDIRECTIONAL_SYNC' },
    { id: '12', inicio: 9_000_000, origem: 'BIDIRECTIONAL_SYNC' },
  ];
  const r = await _teste.marcarDuplicados({ REUNIOES_KV: kv }, { ownerId: '77' }, reunioes);
  assert.equal(r[0].possivelDuplicado, '11');
  assert.equal(r[1].possivelDuplicado, '10');
  assert.equal(r[2].possivelDuplicado, undefined);
});
