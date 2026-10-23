// Página inicial: cabeçalho, lembretes, leads (só Ruben), negócios e reuniões realizadas.
// O HubSpot é simulado: cada pesquisa é registada para confirmar os filtros aplicados no servidor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { _teste } from '../site/_worker.js';

const { periodoLisboa, fazAnosHoje, limparCachesPainel } = _teste;
const RUBEN = '77041306';
const ANA = '1000001';
const DONOS = { 'ruben.teste@fercopor.pt': RUBEN, 'ana.teste@fercopor.pt': ANA };
const raiz = new URL('../site/', import.meta.url);
const ler = (f) => readFileSync(new URL(f, raiz), 'utf8');

function kvMemoria(inicial = {}) {
  const m = new Map(Object.entries(inicial));
  return { async get(k, t) { const v = m.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } };
}

// Chave RSA para assinar sessões do Cloudflare Access nos testes (caminho de autenticação já testado noutro ficheiro)
const EQUIPA = 'fercopor-teste.cloudflareaccess.com';
const AUD = 'aud-teste';
const par = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', par.publicKey)), kid: 'k1', alg: 'RS256' };
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
async function sessao(email) {
  const agora = Math.floor(Date.now() / 1000);
  const corpo = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ email, aud: [AUD], iss: `https://${EQUIPA}`, exp: agora + 600, iat: agora })}`;
  const assinatura = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', par.privateKey, new TextEncoder().encode(corpo));
  return `${corpo}.${Buffer.from(assinatura).toString('base64url')}`;
}

const env = () => ({
  ACCESS_TEAM_DOMAIN: EQUIPA, ACCESS_AUD: AUD, HUBSPOT_TOKEN: 'token-teste',
  REUNIOES_KV: kvMemoria({ utilizadores: JSON.stringify([{ email: 'ruben.teste@fercopor.pt' }, { email: 'ana.teste@fercopor.pt' }]) }),
  ASSETS: { fetch: async () => new Response('x') },
});

const p = periodoLisboa(Date.now());
const [ano, mes, dia] = p.hoje.split('-');
const ontem = periodoLisboa(Date.now() - 3 * 864e5).hoje;

// HubSpot falso: devolve dados conforme o objeto e os filtros, e regista todas as pesquisas
function hubspotFalso({ tiposExtra = [] } = {}) {
  const pesquisas = [];
  const outros = [];
  const filtro = (b, nome) => b.filterGroups.flatMap((g) => g.filters).find((f) => f.propertyName === nome);
  const fetch = async (url, op = {}) => {
    const u = String(url);
    if (u === `https://${EQUIPA}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [jwk] }));
    if (u.includes('/crm/v3/owners/')) {
      const email = decodeURIComponent(new URL(u).searchParams.get('email'));
      return new Response(JSON.stringify({ results: [{ id: DONOS[email], email, firstName: email.split('.')[0], lastName: 'Teste', archived: false }] }));
    }
    if (u.endsWith('/crm/v3/properties/meetings/hs_activity_type')) {
      const valores = ['Reunião Comercial', 'Reunião Follow Up', 'Reunião Parceiro', 'Reunião Parceiro c/ Cliente', 'Reunião Visita Obra', ...tiposExtra];
      return new Response(JSON.stringify({ options: valores.map((v) => ({ value: v, label: v, hidden: false })) }));
    }
    const m = /\/crm\/v3\/objects\/(\w+)\/search$/.exec(u);
    if (m) {
      const corpo = JSON.parse(op.body);
      pesquisas.push({ objeto: m[1], corpo });
      if (m[1] === 'contacts' && filtro(corpo, 'data_de_nascimento')) {
        if (!corpo.after) {
          return new Response(JSON.stringify({ total: 3, results: [
            { id: '11', properties: { firstname: 'Faz', lastname: 'Anos', data_de_nascimento: `1980-${mes}-${dia}` } },
            { id: '12', properties: { firstname: 'Outro', lastname: 'Dia', data_de_nascimento: `1980-${mes === '01' ? '02' : '01'}-15` } },
          ], paging: { next: { after: '2' } } }));
        }
        return new Response(JSON.stringify({ total: 3, results: [{ id: '13', properties: { firstname: 'Segunda', lastname: 'Página', data_de_nascimento: `1975-${mes}-${dia}` } }] }));
      }
      if (m[1] === 'contacts' && filtro(corpo, 'status_atendimento') && corpo.limit === 100) {
        return new Response(JSON.stringify({ total: 2, results: [
          { id: '21', properties: { firstname: 'Em', lastname: 'Atraso', data_do_proximo_contacto: ontem } },
          { id: '22', properties: { firstname: 'Para', lastname: 'Hoje', data_do_proximo_contacto: p.hoje } },
        ] }));
      }
      if (m[1] === 'contacts') {
        const total = filtro(corpo, 'createdate') ? 5 : filtro(corpo, 'interesse') ? 7 : 3;
        return new Response(JSON.stringify({ total, results: [] }));
      }
      if (m[1] === 'deals') return new Response(JSON.stringify({ total: filtro(corpo, 'closedate') ? 2 : 12, results: [] }));
      if (m[1] === 'tasks') {
        if (filtro(corpo, 'hs_timestamp').operator === 'BETWEEN') {
          return new Response(JSON.stringify({ total: 1, results: [{ id: '31', properties: { hs_task_subject: 'Ligar hoje', hs_task_type: 'CALL', hs_timestamp: new Date(p.inicioDia + 9 * 36e5).toISOString() } }] }));
        }
        return new Response(JSON.stringify({ total: 14, results: [{ id: '32', properties: { hs_task_subject: 'Atrasada', hs_task_type: 'TODO', hs_timestamp: new Date(p.inicioDia - 2 * 864e5).toISOString() } }] }));
      }
      if (m[1] === 'meetings') {
        const tipos = ['Reunião Comercial', 'Reunião Comercial', 'Reunião Visita Obra', '', 'Tipo antigo'];
        return new Response(JSON.stringify({ total: tipos.length, results: tipos.map((t, i) => ({ id: String(500 + i), properties: { hs_activity_type: t } })) }));
      }
    }
    outros.push(`${op.method || 'GET'} ${u}`);
    return new Response(JSON.stringify({ results: [] }));
  };
  return { fetch, pesquisas, outros, filtro };
}

async function inicioComo(email, falso, sufixo = '') {
  limparCachesPainel();
  const original = globalThis.fetch;
  globalThis.fetch = falso.fetch;
  try {
    const r = await worker.fetch(new Request(`https://app.exemplo/api/inicio${sufixo}`, { headers: { 'Cf-Access-Jwt-Assertion': await sessao(email) } }), env());
    return { status: r.status, dados: await r.json() };
  } finally { globalThis.fetch = original; }
}

const filtrosDe = (pesq) => pesq.corpo.filterGroups.flatMap((g) => g.filters);
const temFiltro = (pesq, nome, valor) => filtrosDe(pesq).some((f) => f.propertyName === nome && (valor === undefined || f.value === valor || (f.values || []).includes(valor)));

/* 1. Cabeçalho */
test('1. Cabeçalho: no telemóvel só o botão circular «+»; no computador o botão «+ Agendar reunião»', () => {
  const html = ler('index.html');
  assert.match(html, /<a class="botao-mais" href="#\/agendar" aria-label="Agendar reunião"/);
  assert.match(html, /class="botao botao-principal botao-topo" href="#\/agendar">\+ Agendar reunião/);
  assert.ok(html.indexOf('botao-mais') < html.indexOf('data-menu-conta'), 'o «+» fica junto ao botão de perfil');
  const css = ler('style.css');
  assert.match(css, /\.topo \.botao-topo \{ display: none; \}/);
  const desktop = css.slice(css.indexOf('@media (min-width: 900px)'));
  assert.match(desktop, /\.topo \.botao-topo \{ display: inline-flex; \}/);
  assert.match(desktop, /\.topo \.botao-mais \{ display: none; \}/);
});

/* 2 e 3. Agendamento preservado; lista de reuniões retirada do Início */
test('2–3. Início: mantém o botão de agendar e o resumo, sem a lista de reuniões; ordem das secções', () => {
  const js = ler('app.js');
  const inicio = js.slice(js.indexOf('async function ecraInicio'), js.indexOf('const erroSeccao'));
  assert.match(inicio, /href="#\/agendar">\+ Agendar reunião/);
  assert.doesNotMatch(inicio, /cartoesMisturados|listaAgrupada|Sem reuniões hoje|t-hoje/);
  const ordem = ['Agendar reunião', '#/lista/hoje', '#/lista/proximas', '#/por-classificar', 'seccaoLembretes(', 'seccaoLeads(', 'seccaoRealizadas(', 'seccaoNegocios('].map((t) => inicio.indexOf(t));
  assert.ok(ordem.every((v, i) => v >= 0 && (i === 0 || v > ordem[i - 1])), `ordem: ${ordem}`);
  assert.match(js, /async function ecraSemana/);   // separadores Semana e Lista continuam
  for (const v of ['agenda', 'dia', 'semana']) assert.match(js, new RegExp(`data-vista="${v}"`), `vista ${v}`);   // Semana: Agenda, Dia e grelha semanal
  assert.match(js, /data-formulario="agendar"/);
});

/* Datas em Lisboa */
test('Datas: mês atual em Lisboa (com mudança de hora) e aniversários', () => {
  const o = periodoLisboa(Date.parse('2026-10-23T22:30:00Z'));
  assert.equal(o.hoje, '2026-10-23');
  assert.equal(new Date(o.inicioMes).toISOString(), '2026-09-30T23:00:00.000Z');
  assert.equal(new Date(o.fimMes).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(periodoLisboa(Date.parse('2026-10-31T23:30:00Z')).hoje, '2026-10-31');   // 23h30 em Lisboa (já em hora de inverno)
  assert.equal(periodoLisboa(Date.parse('2026-09-30T23:30:00Z')).hoje, '2026-10-01');   // 00h30 de 1 de outubro em Lisboa
  const hojeP = periodoLisboa(Date.parse('2026-10-23T12:00:00Z'));
  assert.equal(fazAnosHoje('1980-10-23', hojeP), true);
  assert.equal(fazAnosHoje('1980-10-24', hojeP), false);
  assert.equal(fazAnosHoje('', hojeP), false);
  assert.equal(fazAnosHoje('1988-02-29', periodoLisboa(Date.parse('2027-02-28T12:00:00Z'))), true);
  assert.equal(fazAnosHoje('1988-02-29', periodoLisboa(Date.parse('2028-02-28T12:00:00Z'))), false);
});

/* 4. Lembretes */
test('4. Lembretes: só contactos com «Proprietário do Acompanhamento» = utilizador; aniversários de hoje; hoje vs em atraso', async () => {
  const f = hubspotFalso();
  const { status, dados } = await inicioComo('ana.teste@fercopor.pt', f);
  assert.equal(status, 200);
  const contactos = f.pesquisas.filter((x) => x.objeto === 'contacts');
  assert.ok(contactos.length >= 3);   // 2 páginas de aniversários + contactar futuramente
  for (const c of contactos) {
    assert.ok(temFiltro(c, 'proprietario_do_acompanhamento', ANA), 'filtro do acompanhamento');
    assert.ok(!temFiltro(c, 'hubspot_owner_id'), 'não usa o proprietário geral do contacto');
  }
  assert.deepEqual(dados.lembretes.aniversarios.map((c) => c.nome), ['Faz Anos', 'Segunda Página']);   // inclui a 2.ª página
  assert.match(dados.lembretes.aniversarios[0].url, /^https:\/\/app\.hubspot\.com\/contacts\/27006740\/record\/0-1\/11$/);
  const futuro = contactos.find((c) => temFiltro(c, 'status_atendimento', 'Contactar futuramente'));
  assert.ok(futuro && temFiltro(futuro, 'data_do_proximo_contacto'));
  assert.equal(filtrosDe(futuro).find((x) => x.propertyName === 'data_do_proximo_contacto').operator, 'LTE');
  assert.deepEqual(dados.lembretes.contactar.map((c) => [c.nome, c.emAtraso]), [['Em Atraso', true], ['Para Hoje', false]]);
  assert.equal(f.outros.filter((o) => !o.startsWith('GET')).length, 0, 'nenhuma escrita no HubSpot');
});

/* 5. Leads só para o Ruben */
test('5. Situação das Leads: só para o Ruben, com os três filtros', async () => {
  const fr = hubspotFalso();
  const ruben = await inicioComo('ruben.teste@fercopor.pt', fr);
  assert.equal(ruben.dados.verLeads, true);
  assert.deepEqual(ruben.dados.leads, { recebidasMes: 5, comInteresse: 7, novosAcompanhamentos: 3 });
  const contagens = fr.pesquisas.filter((x) => x.objeto === 'contacts' && x.corpo.limit === 1);
  assert.equal(contagens.length, 3);
  for (const c of contagens) {
    assert.ok(temFiltro(c, 'tipo_de_contacto', 'Lead'));
    assert.ok(temFiltro(c, 'proprietario_do_acompanhamento', RUBEN));
  }
  const criadas = contagens.find((c) => temFiltro(c, 'createdate'));
  assert.equal(filtrosDe(criadas).find((x) => x.propertyName === 'createdate').value, String(p.inicioMes));
  const interesse = contagens.find((c) => temFiltro(c, 'interesse'));
  assert.deepEqual(filtrosDe(interesse).find((x) => x.propertyName === 'interesse').values, ['Interessado c/condição', 'Interessado c/condição noutros projetos', 'Interessado condição indefinida']);
  assert.ok(!temFiltro(interesse, 'createdate'), 'acumulado, sem limite de data');
  const novos = contagens.find((c) => temFiltro(c, 'status_atendimento', 'Novo'));
  assert.ok(novos && !temFiltro(novos, 'createdate'));

  const fa = hubspotFalso();
  const ana = await inicioComo('ana.teste@fercopor.pt', fa);
  assert.equal(ana.dados.verLeads, false);
  assert.equal(ana.dados.leads, null);
  assert.equal(fa.pesquisas.filter((x) => x.objeto === 'contacts' && temFiltro(x, 'tipo_de_contacto')).length, 0, 'nem sequer consulta');
});

/* 6, 7 e 8. Negócios */
test('6–8. Meus Negócios: proprietário do negócio e «Status do Negócio» = Concluído; total histórico e mês atual', async () => {
  const f = hubspotFalso();
  const { dados } = await inicioComo('ana.teste@fercopor.pt', f);
  assert.deepEqual(dados.negocios, { fechadosTotal: 12, fechadosMes: 2 });
  const negocios = f.pesquisas.filter((x) => x.objeto === 'deals');
  assert.equal(negocios.length, 2);
  for (const n of negocios) {
    for (const g of n.corpo.filterGroups) {
      assert.ok(g.filters.some((x) => x.propertyName === 'hubspot_owner_id' && x.value === ANA), 'cada grupo filtra o proprietário do negócio');
      assert.ok(g.filters.some((x) => x.propertyName === 'status_do_negocio' && x.values.includes('Vendida')), 'cada grupo filtra o status Concluído');
    }
    for (const nome of ['dealstage', 'pipeline', 'hs_is_closed_won']) assert.ok(!temFiltro(n, nome), `não usa ${nome}`);
  }
  const total = negocios.find((n) => !temFiltro(n, 'closedate') && !temFiltro(n, 'data_cpcv'));
  assert.ok(total && total.corpo.filterGroups.length === 1, 'total sem limite de mês ou ano');
  const mesP = negocios.find((n) => n.corpo.filterGroups.length === 2);
  const [porCpcv, porFecho] = mesP.corpo.filterGroups.map((g) => g.filters);
  const cpcv = porCpcv.find((x) => x.propertyName === 'data_cpcv');
  assert.equal(cpcv.operator, 'BETWEEN');
  assert.equal(cpcv.value, String(Date.UTC(Number(ano), Number(mes) - 1, 1)));
  assert.equal(cpcv.highValue, String(p.hojeUtc));
  assert.ok(porFecho.some((x) => x.propertyName === 'data_cpcv' && x.operator === 'NOT_HAS_PROPERTY'), 'a data de fecho só conta quando não há Data CPCV (sem duplicar)');
  const fecho = porFecho.find((x) => x.propertyName === 'closedate');
  assert.equal(fecho.value, String(p.inicioMes));
  assert.ok(Number(fecho.highValue) <= Date.now() && Number(fecho.highValue) > p.inicioMes, 'até ao momento presente');
});

/* 9 e 10. Reuniões realizadas */
test('9–10. Reuniões realizadas: concluídas do mês por tipo, todos os tipos do HubSpot, sem tipo à parte', async () => {
  const f = hubspotFalso({ tiposExtra: ['Reunião Online'] });
  const { dados } = await inicioComo('ana.teste@fercopor.pt', f);
  const reun = f.pesquisas.find((x) => x.objeto === 'meetings');
  assert.ok(temFiltro(reun, 'hubspot_owner_id', ANA));
  assert.ok(temFiltro(reun, 'hs_meeting_outcome', 'COMPLETED'));
  const data = filtrosDe(reun).find((x) => x.propertyName === 'hs_meeting_start_time');
  assert.equal(data.value, String(p.inicioMes));
  assert.equal(Number(data.highValue), p.fimMes - 1);
  const porTipo = Object.fromEntries(dados.reunioes.porTipo.map((t) => [t.tipo, t.total]));
  assert.equal(porTipo['Reunião Comercial'], 2);
  assert.equal(porTipo['Reunião Visita Obra'], 1);
  assert.equal(porTipo['Reunião Follow Up'], 0);
  assert.equal(porTipo['Tipo antigo'], 1);           // valor usado que já não é opção
  assert.equal(dados.reunioes.semTipo, 1);
  assert.equal(dados.reunioes.total, 5);
  assert.ok(dados.reunioes.porTipo.some((t) => t.tipo === 'Reunião Online'), 'inclui opções novas do HubSpot');
});

/* 11. Proteção entre utilizadores */
test('11. Cada coordenador só vê o seu: parâmetros no endereço são ignorados', async () => {
  const f = hubspotFalso();
  await inicioComo('ana.teste@fercopor.pt', f, `?ownerId=${RUBEN}&proprietario=${RUBEN}`);
  const valores = f.pesquisas.flatMap((x) => filtrosDe(x)).filter((x) => ['hubspot_owner_id', 'proprietario_do_acompanhamento'].includes(x.propertyName)).map((x) => x.value);
  assert.ok(valores.length > 0 && valores.every((v) => v === ANA), valores.join(','));
  const semSessao = await worker.fetch(new Request('https://app.exemplo/api/inicio'), env());
  assert.equal(semSessao.status, 401);
});

test('Erros: uma secção que falha não impede as outras e não fica em cache', async () => {
  const f = hubspotFalso();
  const original = f.fetch;
  f.fetch = async (url, op) => (String(url).includes('/objects/deals/') ? new Response('{}', { status: 403 }) : original(url, op));
  const { status, dados } = await inicioComo('ana.teste@fercopor.pt', f);
  assert.equal(status, 200);
  assert.equal(dados.negocios, null);
  assert.ok(dados.erros.negocios);
  assert.ok(dados.lembretes && dados.reunioes);
});

test('Limite do HubSpot (429): espera e repete o pedido', async () => {
  const f = hubspotFalso();
  const original = f.fetch;
  let recusado = false;
  f.fetch = async (url, op) => {
    if (!recusado && String(url).includes('/objects/meetings/search')) { recusado = true; return new Response('{}', { status: 429 }); }
    return original(url, op);
  };
  const { dados } = await inicioComo('ana.teste@fercopor.pt', f);
  assert.ok(recusado);
  assert.equal(dados.reunioes.total, 5);
});

test('Demo: o painel responde sem HubSpot e sem leads para quem não está autorizado', async () => {
  limparCachesPainel();
  const e = { DEMO_USER_EMAIL: 'ana.teste@fercopor.pt', ADMIN_EMAILS: 'ana.teste@fercopor.pt', REUNIOES_KV: kvMemoria(), ASSETS: { fetch: async () => new Response('x') } };
  const r = await worker.fetch(new Request('https://app.exemplo/api/inicio'), e);
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.leads, null);
  assert.ok(d.lembretes.aniversarios.length && d.negocios && d.reunioes.porTipo.length === 5);
  assert.equal(d.lembretes.aniversarios[0].url, null);
});

/* Convites a outras pessoas */
test('Equipa: lista os utilizadores do HubSpot sem o próprio e com a Gabriela Matos pré-selecionada', async () => {
  limparCachesPainel();
  const f = hubspotFalso();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, op) => {
    if (String(url).includes('/crm/v3/owners/?limit=100')) {
      return new Response(JSON.stringify({ results: [
        { id: ANA, email: 'ana.teste@fercopor.pt', firstName: 'Ana', lastName: 'Teste' },
        { id: '758451159', email: 'gabriela.matos@fercopor.pt', firstName: 'Gabriela', lastName: 'Matos' },
      ] }));
    }
    return f.fetch(url, op);
  };
  try {
    const r = await worker.fetch(new Request('https://app.exemplo/api/equipa', { headers: { 'Cf-Access-Jwt-Assertion': await sessao('ana.teste@fercopor.pt') } }), env());
    const d = await r.json();
    assert.deepEqual(d.pessoas.map((x) => x.email), ['gabriela.matos@fercopor.pt']);
    assert.deepEqual(d.predefinidos, ['gabriela.matos@fercopor.pt']);
  } finally { globalThis.fetch = original; }
});

test('Convidar outras pessoas: validação, participantes no HubSpot, notas e convite Outlook', async () => {
  const { validarNovaReuniao } = _teste;
  const base = { empreendimento: 'PURE', tipo: 'Reunião Comercial', modalidade: 'presencial', inicio: '2026-10-27T10:00:00Z', fim: '2026-10-27T11:00:00Z', contactoId: '1001' };
  assert.deepEqual(validarNovaReuniao({ ...base, outrosConvidados: [{ email: 'Gabriela.Matos@fercopor.pt' }, { email: 'gabriela.matos@fercopor.pt' }] }, ['PURE']).outrosConvidados,
    [{ email: 'gabriela.matos@fercopor.pt', nome: 'gabriela.matos@fercopor.pt' }]);
  assert.throws(() => validarNovaReuniao({ ...base, outrosConvidados: [{ email: 'sem-arroba' }] }, ['PURE']));
  assert.throws(() => validarNovaReuniao({ ...base, outrosConvidados: Array.from({ length: 16 }, (_, i) => ({ email: `p${i}@exemplo.pt` })) }, ['PURE']));

  // Modo demo com calendário em simulação: a reunião guarda os participantes da equipa e as notas listam os convidados
  limparCachesPainel();
  const e = { DEMO_USER_EMAIL: 'ana.teste@fercopor.pt', ADMIN_EMAILS: 'ana.teste@fercopor.pt', REUNIOES_KV: kvMemoria(), ASSETS: { fetch: async () => new Response('x') } };
  const corpo = { ...base, inicio: '2026-11-05T10:00:00Z', fim: '2026-11-05T11:00:00Z', outrosConvidados: [{ email: 'gabriela.matos@fercopor.pt' }, { email: 'arquiteto@exemplo.pt', nome: 'Arquiteto' }] };
  const r = await worker.fetch(new Request('https://app.exemplo/api/reunioes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'teste-convidados-0001' }, body: JSON.stringify(corpo) }), e);
  assert.equal(r.status, 201);
  const { reuniao } = await r.json();
  assert.deepEqual(reuniao.participantes, ['758451159']);
  assert.match(reuniao.notas, /Convidados: Gabriela Matos \(gabriela\.matos@fercopor\.pt\), Arquiteto \(arquiteto@exemplo\.pt\)/);
});

test('HubSpot: a reunião leva os participantes da equipa (hs_attendee_owner_ids) e as notas com os convidados', async () => {
  limparCachesPainel();
  const f = hubspotFalso();
  let criada = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, op = {}) => {
    const u = String(url);
    if (u.includes('/crm/v3/owners/?limit=100')) return new Response(JSON.stringify({ results: [{ id: '758451159', email: 'gabriela.matos@fercopor.pt', firstName: 'Gabriela', lastName: 'Matos' }] }));
    if (u.endsWith('/crm/v3/properties/meetings/empreendimento')) return new Response(JSON.stringify({ options: [{ value: 'PURE', label: 'PURE' }] }));
    if (u.endsWith('/crm/v3/properties/meetings/tipologia')) return new Response(JSON.stringify({ options: [] }));
    if (u.endsWith('/crm/v3/objects/contacts/batch/read')) return new Response(JSON.stringify({ results: [{ id: '2001', properties: { firstname: 'Maria', lastname: 'Cliente', tipo_de_contacto: 'Lead' } }] }));
    if ((op.method || 'GET') === 'POST' && u.endsWith('/crm/v3/objects/meetings')) { criada = JSON.parse(op.body); return new Response(JSON.stringify({ id: '778' }), { status: 201 }); }
    if (u.includes('/crm/v3/objects/meetings/778?')) return new Response(JSON.stringify({ id: '778', properties: { ...criada.properties } }));
    return f.fetch(url, op);
  };
  try {
    const corpo = { contactoId: '2001', empreendimento: 'PURE', tipo: 'Reunião Comercial', modalidade: 'presencial', inicio: '2026-11-04T10:00:00Z', fim: '2026-11-04T11:00:00Z',
      outrosConvidados: [{ email: 'gabriela.matos@fercopor.pt' }, { email: 'externo@exemplo.pt' }] };
    const r = await worker.fetch(new Request('https://app.exemplo/api/reunioes', { method: 'POST', body: JSON.stringify(corpo),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'teste-convidados-hubspot-1', 'Cf-Access-Jwt-Assertion': await sessao('ana.teste@fercopor.pt') } }),
      { ...env(), HUBSPOT_WRITE_ENABLED: 'true' });
    assert.equal(r.status, 201);
    assert.equal(criada.properties.hs_attendee_owner_ids, '758451159');
    assert.match(criada.properties.hs_internal_meeting_notes, /Convidados: Gabriela Matos \(gabriela\.matos@fercopor\.pt\), externo@exemplo\.pt/);
    assert.deepEqual(criada.associations.map((x) => x.to.id), ['2001']);   // os convidados não são associados como contactos
  } finally { globalThis.fetch = original; }
});

test('Lembretes: tarefas por concluir do utilizador, de hoje e em atraso (10 mais recentes + total)', async () => {
  const f = hubspotFalso();
  const { dados } = await inicioComo('ana.teste@fercopor.pt', f);
  const tarefas = f.pesquisas.filter((x) => x.objeto === 'tasks');
  assert.equal(tarefas.length, 2);
  for (const t of tarefas) {
    assert.ok(temFiltro(t, 'hubspot_owner_id', ANA), 'só as atribuídas ao utilizador');
    const estado = filtrosDe(t).find((x) => x.propertyName === 'hs_task_status');
    assert.equal(estado.operator, 'NOT_IN');
    assert.deepEqual(estado.values, ['COMPLETED']);
  }
  const hoje = filtrosDe(tarefas.find((t) => filtrosDe(t).some((x) => x.operator === 'BETWEEN'))).find((x) => x.propertyName === 'hs_timestamp');
  assert.equal(hoje.value, String(p.inicioDia));
  assert.equal(Number(hoje.highValue), p.fimDia - 1);
  const atraso = tarefas.find((t) => filtrosDe(t).some((x) => x.propertyName === 'hs_timestamp' && x.operator === 'LT'));
  assert.equal(atraso.corpo.limit, 10);
  assert.equal(atraso.corpo.sorts[0].direction, 'DESCENDING');
  assert.deepEqual(dados.tarefas.hoje.map((t) => t.titulo), ['Ligar hoje']);
  assert.deepEqual(dados.tarefas.atraso.map((t) => t.titulo), ['Atrasada']);
  assert.equal(dados.tarefas.atrasoTotal, 14);
  assert.equal(dados.tarefas.hoje[0].url, 'https://app.hubspot.com/tasks/27006740/view/all/task/31');
  assert.equal(dados.tarefas.todas, 'https://app.hubspot.com/tasks/27006740/view/all');
});
