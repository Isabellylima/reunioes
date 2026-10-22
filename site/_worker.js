/* ==========================================================================
   FERCOPOR Reuniões — servidor (Cloudflare Pages, modo avançado _worker.js)

   O que faz:
   1. Exige sessão Microsoft 365 através do Cloudflare Access e valida o token
      (JWT) no servidor: assinatura, audiência, emissor, validade e domínio.
   2. Só deixa entrar utilizadores autorizados (lista em KV + ADMIN_EMAILS),
      cada um ligado a um proprietário ATIVO do HubSpot.
   3. Cada utilizador só lê e altera as SUAS reuniões (verificado aqui, em cada
      pedido, mesmo que o token do HubSpot tenha permissões mais amplas).
   4. Lê e escreve reuniões no HubSpot com a chave privada, que nunca sai daqui.
      As escritas no HubSpot estão DESLIGADAS até HUBSPOT_WRITE_ENABLED = "true".

   Modos:
     demo     sem HUBSPOT_TOKEN: dados fictícios em memória (para ver a app)
     hubspot  com HUBSPOT_TOKEN: dados reais (escrita só com HUBSPOT_WRITE_ENABLED)

   Variáveis (Settings › Variables and Secrets):
     ACCESS_TEAM_DOMAIN     ex.: fercopor.cloudflareaccess.com          (Text)
     ACCESS_AUD             "Application Audience (AUD) Tag" do Access   (Text)
     ADMIN_EMAILS           e-mails com acesso de administração, separados por vírgulas (Text)
     HUBSPOT_TOKEN          token da Private App do HubSpot              (Secret, opcional)
     HUBSPOT_WRITE_ENABLED  "true" para permitir escrever no HubSpot      (Text, opcional)
     ALLOWED_DOMAIN         por omissão fercopor.pt                      (Text, opcional)
     DEMO_USER_EMAIL        só no modo demo e sem Access: utilizador de pré-visualização (Text, opcional)
   Ligação (Settings › Bindings):
     KV  →  REUNIOES_KV     utilizadores autorizados, idempotência e auditoria
   ========================================================================== */

const CABECALHOS_SEGURANCA = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const HUBSPOT = 'https://api.hubapi.com';
const ASSOC_REUNIAO_CONTACTO = 200;   // HUBSPOT_DEFINED meeting → contact (confirmar no teste T-08)
const TIPOS = ['Reunião Comercial', 'Reunião Follow Up', 'Reunião Parceiro', 'Reunião Parceiro c/ Cliente', 'Reunião Visita Obra'];
const RESULTADOS = { SCHEDULED: 'Programados', COMPLETED: 'Concluído', RESCHEDULED: 'Reprogramado', NO_SHOW: 'Não compareceu', CANCELED: 'Cancelado' };
const MODALIDADES = { presencial: 'ADDRESS', telefonica: 'PHONE', online: 'VCE' };
const TIPOS_EXCLUIDOS = ['Staff FERCOPOR', 'Inativo'];
const PROPRIEDADES_REUNIAO = [
  'hs_meeting_title', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_outcome', 'hs_activity_type',
  'hubspot_owner_id', 'hs_internal_meeting_notes', 'hs_meeting_location', 'hs_meeting_location_type',
  'hs_video_conference_url', 'hs_meeting_source',
];

export default {
  async fetch(request, env) {
    try {
      return comSeguranca(await tratar(request, env));
    } catch (e) {
      if (e instanceof ErroHttp) return comSeguranca(json({ erro: e.message }, e.status));
      console.error(e);
      return comSeguranca(json({ erro: 'Erro interno' }, 500));
    }
  },
};

class ErroHttp extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- Encaminhamento ---------- */

async function tratar(request, env) {
  const url = new URL(request.url);
  const caminho = url.pathname;

  const utilizador = await autenticar(request, env);   // nada é entregue sem sessão válida

  if (!caminho.startsWith('/api/')) {
    return env.ASSETS.fetch(request);
  }

  if (request.method !== 'GET' && !mesmaOrigem(request, url)) {
    throw new ErroHttp(403, 'Pedido de outra origem recusado.');
  }

  const fonte = criarFonte(env);
  const partes = caminho.split('/').filter(Boolean);   // ['api', ...]
  const m = request.method;

  if (m === 'GET' && caminho === '/api/me') {
    return json({ ...utilizador, modo: fonte.modo, escritaAtiva: fonte.escritaAtiva });
  }
  if (m === 'GET' && caminho === '/api/empreendimentos') {
    return json({ empreendimentos: await fonte.empreendimentos() });
  }
  if (m === 'GET' && caminho === '/api/contactos') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return json({ contactos: [] });
    return json({ contactos: await fonte.procurarContactos(q.slice(0, 80)) });
  }
  if (m === 'GET' && caminho === '/api/reunioes') {
    const de = Date.parse(url.searchParams.get('de') || '');
    const ate = Date.parse(url.searchParams.get('ate') || '');
    if (!Number.isFinite(de) || !Number.isFinite(ate) || ate <= de || ate - de > 62 * 864e5) {
      throw new ErroHttp(400, 'Intervalo de datas inválido.');
    }
    return json({ reunioes: await fonte.listarReunioes(utilizador.ownerId, de, ate) });
  }
  if (m === 'GET' && caminho === '/api/reunioes/por-classificar') {
    return json({ reunioes: await fonte.porClassificar(utilizador.ownerId, Date.now()) });
  }
  if (m === 'POST' && caminho === '/api/reunioes') {
    return criarReuniao(request, env, fonte, utilizador);
  }
  if (partes[1] === 'reunioes' && partes.length >= 3 && /^\d{1,20}$/.test(partes[2])) {
    const id = partes[2];
    const reuniao = await fonte.lerReuniao(id);
    if (!reuniao || String(reuniao.ownerId) !== String(utilizador.ownerId)) {
      throw new ErroHttp(404, 'Reunião não encontrada.');   // 404 também para reuniões de outros: não revela que existem
    }
    if (m === 'GET' && partes.length === 3) return json({ reuniao });
    if (m === 'PATCH' && partes.length === 3) return reprogramar(request, env, fonte, utilizador, reuniao);
    if (m === 'POST' && partes[3] === 'resultado' && partes.length === 4) return atualizarResultado(request, env, fonte, utilizador, reuniao);
  }
  if (partes[1] === 'admin' && partes[2] === 'utilizadores' && partes.length === 3) {
    if (!utilizador.admin) throw new ErroHttp(403, 'Só administradores.');
    if (m === 'GET') return json({ utilizadores: await lerAutorizados(env) });
    if (m === 'PUT') return guardarAutorizados(request, env, utilizador);
  }
  throw new ErroHttp(404, 'Não encontrado.');
}

/* ---------- Autenticação e autorização ---------- */

async function autenticar(request, env) {
  const dominio = (env.ALLOWED_DOMAIN || 'fercopor.pt').toLowerCase();
  let email;

  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) throw new ErroHttp(401, 'Sessão em falta. Entre com a conta Microsoft 365.');
    const dados = await verificarJwtAccess(token, env);
    email = String(dados.email || '').toLowerCase();
  } else if (!env.HUBSPOT_TOKEN && env.DEMO_USER_EMAIL) {
    email = String(env.DEMO_USER_EMAIL).toLowerCase();   // pré-visualização sem Access, só com dados fictícios
  } else {
    throw new ErroHttp(503, 'Configuração em falta: defina ACCESS_TEAM_DOMAIN e ACCESS_AUD no Cloudflare.');
  }

  if (!email.endsWith('@' + dominio)) throw new ErroHttp(403, 'Conta fora da organização.');

  const lista = await lerAutorizados(env);
  const registo = lista.find((u) => u.email === email);
  const admins = listaEmails(env.ADMIN_EMAILS);
  const admin = admins.includes(email) || Boolean(registo && registo.admin);
  if (!registo && !admin) throw new ErroHttp(403, 'Utilizador sem autorização para esta aplicação.');

  const proprietario = await proprietarioComCache(env, email);
  if (!proprietario) throw new ErroHttp(403, 'Sem utilizador ativo correspondente no HubSpot.');

  return { email, nome: proprietario.nome, ownerId: String(proprietario.id), admin };
}

// Proprietário HubSpot por e-mail, guardado 5 minutos em memória (um utilizador desativado deixa de entrar em ≤ 5 min)
const proprietariosCache = new Map();

async function proprietarioComCache(env, email) {
  const chave = (env.HUBSPOT_TOKEN ? 'hs:' : 'demo:') + email;
  const guardado = proprietariosCache.get(chave);
  if (guardado && guardado.ate > Date.now()) return guardado.valor;
  const valor = await criarFonte(env).proprietarioPorEmail(email);
  proprietariosCache.set(chave, { valor, ate: Date.now() + 5 * 6e4 });
  return valor;
}

let certificadosCache = { dominio: '', chaves: null, ate: 0 };

async function verificarJwtAccess(token, env) {
  const partes = token.split('.');
  if (partes.length !== 3) throw new ErroHttp(401, 'Sessão inválida.');
  const cabecalho = JSON.parse(textoBase64Url(partes[0]));
  const dados = JSON.parse(textoBase64Url(partes[1]));
  if (cabecalho.alg !== 'RS256') throw new ErroHttp(401, 'Sessão inválida.');

  const dominio = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (certificadosCache.dominio !== dominio || Date.now() > certificadosCache.ate) {
    const r = await fetch(`https://${dominio}/cdn-cgi/access/certs`);
    if (!r.ok) throw new ErroHttp(503, 'Não foi possível validar a sessão.');
    certificadosCache = { dominio, chaves: (await r.json()).keys || [], ate: Date.now() + 36e5 };
  }
  const jwk = certificadosCache.chaves.find((k) => k.kid === cabecalho.kid);
  if (!jwk) throw new ErroHttp(401, 'Sessão inválida.');

  const chave = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valido = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', chave, bytesBase64Url(partes[2]), new TextEncoder().encode(partes[0] + '.' + partes[1]),
  );
  if (!valido) throw new ErroHttp(401, 'Sessão inválida.');

  const agora = Math.floor(Date.now() / 1000);
  const audiencias = Array.isArray(dados.aud) ? dados.aud : [dados.aud];
  if (!audiencias.includes(env.ACCESS_AUD)) throw new ErroHttp(401, 'Sessão inválida.');
  if (dados.iss !== `https://${dominio}`) throw new ErroHttp(401, 'Sessão inválida.');
  if (!dados.exp || dados.exp < agora) throw new ErroHttp(401, 'Sessão expirada. Volte a entrar.');
  if (dados.nbf && dados.nbf > agora + 60) throw new ErroHttp(401, 'Sessão inválida.');
  return dados;
}

async function lerAutorizados(env) {
  if (!env.REUNIOES_KV) return [];
  const lista = await env.REUNIOES_KV.get('utilizadores', 'json');
  return Array.isArray(lista) ? lista : [];
}

async function guardarAutorizados(request, env, utilizador) {
  if (!env.REUNIOES_KV) throw new ErroHttp(503, 'Ligação KV (REUNIOES_KV) em falta.');
  const corpo = await lerJson(request);
  const dominio = (env.ALLOWED_DOMAIN || 'fercopor.pt').toLowerCase();
  if (!Array.isArray(corpo.utilizadores) || corpo.utilizadores.length > 200) throw new ErroHttp(400, 'Lista inválida.');
  const vistos = new Set();
  const lista = [];
  for (const u of corpo.utilizadores) {
    const email = String(u && u.email || '').trim().toLowerCase();
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+$/.test(email) || !email.endsWith('@' + dominio)) {
      throw new ErroHttp(400, `E-mail inválido ou fora da organização: ${email}`);
    }
    if (vistos.has(email)) continue;
    vistos.add(email);
    lista.push({ email, admin: Boolean(u.admin) });
  }
  await env.REUNIOES_KV.put('utilizadores', JSON.stringify(lista));
  await auditar(env, utilizador, 'utilizadores.atualizar', null, { total: lista.length });
  return json({ utilizadores: lista });
}

/* ---------- Escritas ---------- */

async function criarReuniao(request, env, fonte, utilizador) {
  exigirEscrita(fonte);
  const chave = (request.headers.get('Idempotency-Key') || '').trim();
  if (!/^[A-Za-z0-9-]{16,64}$/.test(chave)) throw new ErroHttp(400, 'Chave de idempotência em falta.');
  const jaFeita = await lerIdempotencia(env, utilizador, chave);
  if (jaFeita) return json({ reuniao: await fonte.lerReuniao(jaFeita), repetida: true });

  const corpo = await lerJson(request);
  const empreendimentos = await fonte.empreendimentos();
  const pedido = validarNovaReuniao(corpo, empreendimentos);

  const ids = [pedido.contactoId, pedido.clienteId].filter(Boolean);
  const contactos = await fonte.lerContactos(ids);
  for (const id of ids) {
    const c = contactos.find((x) => String(x.id) === String(id));
    if (!c) throw new ErroHttp(400, 'Contacto inexistente. Registe-o primeiro no HubSpot.');
    if (c.excluido) throw new ErroHttp(400, 'Este contacto não pode ser usado em reuniões comerciais.');
  }
  const principal = contactos.find((x) => String(x.id) === String(pedido.contactoId));
  const cliente = pedido.clienteId ? contactos.find((x) => String(x.id) === String(pedido.clienteId)) : null;
  if (cliente && principal.papel !== 'parceiro') throw new ErroHttp(400, 'Só um parceiro pode apresentar um cliente.');

  const titulo = pedido.titulo || gerarTitulo(pedido.empreendimento, principal, cliente);
  const notas = gerarNotas(pedido, utilizador);

  const criada = await fonte.criarReuniao({
    ownerId: utilizador.ownerId,
    titulo,
    inicio: pedido.inicio,
    fim: pedido.fim,
    tipo: pedido.tipo,
    modalidade: pedido.modalidade,
    local: pedido.local,
    ligacao: pedido.ligacao,
    notas,
    contactos: ids,
  });
  await guardarIdempotencia(env, utilizador, chave, criada.id);
  await auditar(env, utilizador, 'reuniao.criar', criada.id, { tipo: pedido.tipo });
  return json({ reuniao: criada }, 201);
}

async function reprogramar(request, env, fonte, utilizador, reuniao) {
  exigirEscrita(fonte);
  const corpo = await lerJson(request);
  const inicio = Date.parse(corpo.inicio || '');
  const fim = Date.parse(corpo.fim || '');
  validarHorario(inicio, fim);
  const nota = linhaNota(utilizador, `Reprogramada: ${dataHora(reuniao.inicio)} → ${dataHora(inicio)}`);
  // Regra A-9: só mudam as horas; o resultado não passa a «Reprogramado» por isso.
  const atualizada = await fonte.atualizarReuniao(reuniao.id, {
    inicio, fim, notas: juntarNotas(reuniao.notas, nota),
  });
  await auditar(env, utilizador, 'reuniao.reprogramar', reuniao.id, {});
  return json({ reuniao: atualizada });
}

async function atualizarResultado(request, env, fonte, utilizador, reuniao) {
  exigirEscrita(fonte);
  const corpo = await lerJson(request);
  const resultado = String(corpo.resultado || '');
  if (!Object.prototype.hasOwnProperty.call(RESULTADOS, resultado)) throw new ErroHttp(400, 'Resultado inválido.');
  const observacao = limparTexto(corpo.observacao, 2000);
  let notas = reuniao.notas;
  if (observacao || resultado !== reuniao.resultado) {
    notas = juntarNotas(notas, linhaNota(utilizador, `Resultado: ${RESULTADOS[resultado]}${observacao ? ' — ' + observacao : ''}`));
  }
  // Regra A-10: cancelar só muda o resultado. Nada é eliminado e o participante não é avisado.
  const atualizada = await fonte.atualizarReuniao(reuniao.id, { resultado, notas });
  await auditar(env, utilizador, 'reuniao.resultado', reuniao.id, { resultado });
  return json({ reuniao: atualizada });
}

function exigirEscrita(fonte) {
  if (!fonte.escritaAtiva) {
    throw new ErroHttp(403, 'A escrita no HubSpot ainda não está autorizada (HUBSPOT_WRITE_ENABLED).');
  }
}

/* ---------- Regras de negócio (puras) ---------- */

function validarNovaReuniao(c, empreendimentos) {
  const empreendimento = String(c.empreendimento || '');
  if (!empreendimentos.includes(empreendimento)) throw new ErroHttp(400, 'Empreendimento inválido.');
  const tipo = String(c.tipo || '');
  if (!TIPOS.includes(tipo)) throw new ErroHttp(400, 'Tipo de reunião inválido.');
  const modalidade = String(c.modalidade || '');
  if (!MODALIDADES[modalidade]) throw new ErroHttp(400, 'Modalidade inválida.');
  const inicio = Date.parse(c.inicio || '');
  const fim = Date.parse(c.fim || '');
  validarHorario(inicio, fim);
  const contactoId = String(c.contactoId || '');
  if (!/^\d{1,20}$/.test(contactoId)) throw new ErroHttp(400, 'Escolha um contacto existente.');
  const clienteId = c.clienteId ? String(c.clienteId) : '';
  if (clienteId && (!/^\d{1,20}$/.test(clienteId) || clienteId === contactoId)) throw new ErroHttp(400, 'Cliente inválido.');
  const ligacao = limparTexto(c.ligacao, 500);
  if (ligacao && !/^https:\/\/[^\s]+$/.test(ligacao)) throw new ErroHttp(400, 'A ligação tem de começar por https://');
  return {
    empreendimento, tipo, modalidade, inicio, fim, contactoId, clienteId,
    local: limparTexto(c.local, 300),
    ligacao,
    tipologia: limparTexto(c.tipologia, 40),
    orcamento: limparTexto(c.orcamento, 60),
    observacoes: limparTexto(c.observacoes, 2000),
    titulo: limparTexto(c.titulo, 200),
  };
}

function validarHorario(inicio, fim) {
  if (!Number.isFinite(inicio) || !Number.isFinite(fim)) throw new ErroHttp(400, 'Data ou hora inválida.');
  if (fim <= inicio) throw new ErroHttp(400, 'A hora de fim tem de ser depois da hora de início.');
  if (fim - inicio > 12 * 36e5) throw new ErroHttp(400, 'A reunião não pode durar mais de 12 horas.');
}

function gerarTitulo(empreendimento, principal, cliente) {
  if (principal.papel === 'parceiro') {
    return cliente
      ? `FERCOPOR | ${empreendimento} - Parceiro ${principal.nome} - ${cliente.nome}`
      : `FERCOPOR | ${empreendimento} - Parceiro ${principal.nome}`;
  }
  return `FERCOPOR | ${empreendimento} - ${principal.nome}`;
}

function gerarNotas(p, utilizador) {
  const linhas = [`Empreendimento: ${p.empreendimento}`];
  if (p.tipologia) linhas.push(`Tipologia: ${p.tipologia}`);
  if (p.orcamento) linhas.push(`Orçamento: ${p.orcamento}`);
  if (p.observacoes) linhas.push(`Observações: ${p.observacoes}`);
  if (p.ligacao) linhas.push(`Ligação: ${p.ligacao}`);
  linhas.push(`Agendada na app por ${utilizador.nome}`);
  return linhas.join('\n');
}

function papelDoContacto(tipoDeContacto) {
  const valores = String(tipoDeContacto || '').split(';').map((v) => v.trim()).filter(Boolean);
  if (valores.some((v) => TIPOS_EXCLUIDOS.includes(v))) return { papel: 'cliente', excluido: true };
  return { papel: valores.includes('Mediador Imobiliário') ? 'parceiro' : 'cliente', excluido: false };
}

function linhaNota(utilizador, texto) {
  return `[${dataHora(Date.now())} · ${utilizador.nome}] ${texto}`;
}

function juntarNotas(existentes, nova) {
  return existentes ? `${existentes}\n${nova}` : nova;
}

function limparTexto(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function dataHora(ms) {
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone: 'Europe/Lisbon', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms));
}

/* ---------- Fontes de dados: HubSpot e demonstração ---------- */

function criarFonte(env) {
  return env.HUBSPOT_TOKEN ? fonteHubSpot(env) : fonteDemo();
}

function fonteHubSpot(env) {
  const pedir = async (metodo, caminho, corpo) => {
    const r = await fetch(HUBSPOT + caminho, {
      method: metodo,
      headers: { Authorization: `Bearer ${env.HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (r.status === 404) return null;
    if (!r.ok) {
      console.error('HubSpot', metodo, caminho, r.status, (await r.text()).slice(0, 500));
      throw new ErroHttp(502, 'O HubSpot não respondeu como esperado. Tente novamente.');
    }
    return r.status === 204 ? {} : r.json();
  };

  const paraReuniao = (o, contactos) => {
    const p = o.properties || {};
    return {
      id: String(o.id),
      titulo: p.hs_meeting_title || '(sem título)',
      inicio: Date.parse(p.hs_meeting_start_time) || null,
      fim: Date.parse(p.hs_meeting_end_time) || null,
      resultado: p.hs_meeting_outcome || '',
      tipo: p.hs_activity_type || '',
      ownerId: String(p.hubspot_owner_id || ''),
      notas: p.hs_internal_meeting_notes || '',
      local: p.hs_meeting_location || '',
      modalidade: Object.keys(MODALIDADES).find((k) => MODALIDADES[k] === p.hs_meeting_location_type) || '',
      ligacao: p.hs_video_conference_url || '',
      origem: p.hs_meeting_source || '',
      contactos: contactos || [],
    };
  };

  const comContactos = async (objetos) => {
    if (!objetos.length) return [];
    const assoc = await pedir('POST', '/crm/v4/associations/meetings/contacts/batch/read', {
      inputs: objetos.map((o) => ({ id: String(o.id) })),
    });
    const porReuniao = {};
    const todos = new Set();
    for (const r of (assoc && assoc.results) || []) {
      const ids = (r.to || []).map((t) => String(t.toObjectId));
      porReuniao[String(r.from.id)] = ids;
      ids.forEach((i) => todos.add(i));
    }
    const contactos = todos.size ? await lerContactos([...todos]) : [];
    const mapa = Object.fromEntries(contactos.map((c) => [c.id, c]));
    return objetos.map((o) => paraReuniao(o, (porReuniao[String(o.id)] || []).map((i) => mapa[i]).filter(Boolean)));
  };

  const procurarReunioes = async (filterGroups) => {
    const r = await pedir('POST', '/crm/v3/objects/meetings/search', {
      filterGroups, properties: PROPRIEDADES_REUNIAO,
      sorts: [{ propertyName: 'hs_meeting_start_time', direction: 'ASCENDING' }], limit: 100,
    });
    return comContactos((r && r.results) || []);
  };

  const lerContactos = async (ids) => {
    if (!ids.length) return [];
    const r = await pedir('POST', '/crm/v3/objects/contacts/batch/read', {
      inputs: ids.map((id) => ({ id: String(id) })), properties: ['firstname', 'lastname', 'email', 'tipo_de_contacto'],
    });
    return ((r && r.results) || []).map(paraContacto);
  };

  const paraContacto = (o) => {
    const p = o.properties || {};
    const nome = [p.firstname, p.lastname].filter(Boolean).join(' ') || p.email || `Contacto ${o.id}`;
    return { id: String(o.id), nome, email: p.email || '', tipoDeContacto: p.tipo_de_contacto || '', ...papelDoContacto(p.tipo_de_contacto) };
  };

  return {
    modo: 'hubspot',
    escritaAtiva: env.HUBSPOT_WRITE_ENABLED === 'true',

    async proprietarioPorEmail(email) {
      const r = await pedir('GET', `/crm/v3/owners/?email=${encodeURIComponent(email)}&archived=false`);
      const o = r && r.results && r.results.find((x) => String(x.email || '').toLowerCase() === email);
      if (!o || o.archived) return null;
      return { id: String(o.id), nome: [o.firstName, o.lastName].filter(Boolean).join(' ') || email };
    },

    async empreendimentos() {
      const r = await pedir('GET', '/crm/v3/properties/deals/empreendimento');
      return ((r && r.options) || []).filter((o) => !o.hidden).map((o) => o.value);
    },

    async procurarContactos(q) {
      const r = await pedir('POST', '/crm/v3/objects/contacts/search', {
        query: q, properties: ['firstname', 'lastname', 'email', 'tipo_de_contacto'], limit: 20,
      });
      return ((r && r.results) || []).map(paraContacto).filter((c) => !c.excluido);
    },

    lerContactos,

    async listarReunioes(ownerId, de, ate) {
      return procurarReunioes([{ filters: [
        { propertyName: 'hubspot_owner_id', operator: 'EQ', value: String(ownerId) },
        { propertyName: 'hs_meeting_start_time', operator: 'BETWEEN', value: String(de), highValue: String(ate) },
      ] }]);
    },

    async porClassificar(ownerId, agora) {
      const base = [
        { propertyName: 'hubspot_owner_id', operator: 'EQ', value: String(ownerId) },
        { propertyName: 'hs_meeting_end_time', operator: 'LT', value: String(agora) },
        { propertyName: 'hs_meeting_end_time', operator: 'GT', value: String(agora - 90 * 864e5) },
      ];
      return procurarReunioes([
        { filters: [...base, { propertyName: 'hs_meeting_outcome', operator: 'NOT_HAS_PROPERTY' }] },
        { filters: [...base, { propertyName: 'hs_meeting_outcome', operator: 'EQ', value: 'SCHEDULED' }] },
      ]);
    },

    async lerReuniao(id) {
      const o = await pedir('GET', `/crm/v3/objects/meetings/${encodeURIComponent(id)}?properties=${PROPRIEDADES_REUNIAO.join(',')}`);
      if (!o) return null;
      return (await comContactos([o]))[0];
    },

    async criarReuniao(r) {
      const propriedades = {
        hs_timestamp: new Date(r.inicio).toISOString(),
        hs_meeting_title: r.titulo,
        hs_meeting_start_time: new Date(r.inicio).toISOString(),
        hs_meeting_end_time: new Date(r.fim).toISOString(),
        hs_meeting_outcome: 'SCHEDULED',
        hs_activity_type: r.tipo,
        hubspot_owner_id: String(r.ownerId),
        hs_internal_meeting_notes: r.notas,
        hs_meeting_location_type: MODALIDADES[r.modalidade],
      };
      if (r.local) propriedades.hs_meeting_location = r.local;
      if (r.ligacao) propriedades.hs_video_conference_url = r.ligacao;
      const o = await pedir('POST', '/crm/v3/objects/meetings', {
        properties: propriedades,
        associations: r.contactos.map((id) => ({
          to: { id: String(id) },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC_REUNIAO_CONTACTO }],
        })),
      });
      return this.lerReuniao(o.id);
    },

    async atualizarReuniao(id, alteracoes) {
      const propriedades = {};
      if (alteracoes.inicio != null) {
        propriedades.hs_meeting_start_time = new Date(alteracoes.inicio).toISOString();
        propriedades.hs_timestamp = propriedades.hs_meeting_start_time;
      }
      if (alteracoes.fim != null) propriedades.hs_meeting_end_time = new Date(alteracoes.fim).toISOString();
      if (alteracoes.resultado) propriedades.hs_meeting_outcome = alteracoes.resultado;
      if (alteracoes.notas != null) propriedades.hs_internal_meeting_notes = alteracoes.notas;
      await pedir('PATCH', `/crm/v3/objects/meetings/${encodeURIComponent(id)}`, { properties: propriedades });
      return this.lerReuniao(id);
    },
  };
}

/* Dados fictícios (modo demo). Vivem na memória do servidor e perdem-se quando o Cloudflare o reinicia.
   Não há pessoas reais no código: cada utilizador autorizado que entra recebe o seu próprio conjunto de reuniões fictícias. */
let demo = null;

function fonteDemo() {
  if (!demo) demo = semearDemo();
  const d = demo;
  const comContactos = (r) => ({ ...r, contactos: r.contactos.map((id) => d.contactos.find((c) => c.id === id)).filter(Boolean) });
  return {
    modo: 'demo',
    escritaAtiva: true,   // escreve só na memória, nunca no HubSpot
    async proprietarioPorEmail(email) {
      const id = 'demo-' + resumoTexto(email);
      if (!d.semeados.has(id)) { d.semeados.add(id); d.reunioes.push(...reunioesDemo(id, Date.now(), d)); }
      return { id, nome: nomeDoEmail(email) };
    },
    async empreendimentos() { return d.empreendimentos; },
    async procurarContactos(q) {
      const n = normalizar(q);
      return d.contactos.filter((c) => !c.excluido && normalizar(c.nome + ' ' + c.email).includes(n)).slice(0, 20);
    },
    async lerContactos(ids) { return d.contactos.filter((c) => ids.includes(c.id)); },
    async listarReunioes(ownerId, de, ate) {
      return d.reunioes.filter((r) => r.ownerId === String(ownerId) && r.inicio >= de && r.inicio <= ate)
        .sort((a, b) => a.inicio - b.inicio).map(comContactos);
    },
    async porClassificar(ownerId, agora) {
      return d.reunioes.filter((r) => r.ownerId === String(ownerId) && r.fim < agora && (!r.resultado || r.resultado === 'SCHEDULED'))
        .sort((a, b) => b.inicio - a.inicio).map(comContactos);
    },
    async lerReuniao(id) {
      const r = d.reunioes.find((x) => x.id === String(id));
      return r ? comContactos(r) : null;
    },
    async criarReuniao(r) {
      const nova = {
        id: String(d.proximoId++), titulo: r.titulo, inicio: r.inicio, fim: r.fim, resultado: 'SCHEDULED', tipo: r.tipo,
        ownerId: String(r.ownerId), notas: r.notas, local: r.local, modalidade: r.modalidade, ligacao: r.ligacao,
        origem: 'APP_DEMO', contactos: r.contactos.map(String),
      };
      d.reunioes.push(nova);
      return comContactos(nova);
    },
    async atualizarReuniao(id, alt) {
      const r = d.reunioes.find((x) => x.id === String(id));
      if (alt.inicio != null) r.inicio = alt.inicio;
      if (alt.fim != null) r.fim = alt.fim;
      if (alt.resultado) r.resultado = alt.resultado;
      if (alt.notas != null) r.notas = alt.notas;
      return comContactos(r);
    },
  };
}

function semearDemo() {
  const contactos = [
    ['1001', 'Marta Figueiredo', 'Lead'], ['1002', 'Rita Lemos', 'Mediador Imobiliário'], ['1003', 'Paulo Antunes', 'Lead'],
    ['1004', 'Luís Carvalho', 'Lead'], ['1005', 'Sofia Macedo', 'Lead'], ['1006', 'Nuno Pires', 'Mediador Imobiliário'],
    ['1007', 'Ana Duarte', 'Lead'], ['1008', 'Ricardo Moura', 'Lead'], ['1009', 'Carla Nunes', 'Mediador Imobiliário'],
    ['1010', 'Hugo Teixeira', 'Lead'], ['1011', 'Tomás Rocha', 'Lead'], ['1012', 'João Matias', 'Mediador Imobiliário'],
    ['1013', 'Beatriz Lopes', 'Lead'], ['1014', 'Clara Sá', 'Lead'], ['1015', 'Equipa Interna (exemplo)', 'Staff FERCOPOR'],
  ].map(([id, nome, tipo]) => ({ id, nome, email: normalizar(nome).replace(/[^a-z]+/g, '.') + '@exemplo.pt', tipoDeContacto: tipo, ...papelDoContacto(tipo) }));
  const empreendimentos = ['CASA VERDE', 'ENLIGHT', 'FOLIAGE', 'LISBOA', 'LUMARE', 'PRISMA', 'PURE', 'PÁTIO', 'RAIZ', 'SERENITY', 'SOUL', 'VC FORTE', 'VC JARDIM', 'VC PARQUE', 'VC55', 'VILARINHA'];
  return { contactos, empreendimentos, reunioes: [], semeados: new Set(), proximoId: 900001 };
}

function reunioesDemo(ownerId, agora, d) {
  // Segunda-feira da semana atual em Lisboa; cada hora é convertida com o fuso de Lisboa nesse dia
  const hoje = new Date(agora);
  const diaSemana = (hoje.getUTCDay() + 6) % 7;
  const segunda = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - diaSemana);
  const em = (dia, hora) => {
    const utc = segunda + dia * 864e5 + hora * 36e5;
    return utc - desvioLisboaHoras(utc) * 36e5;
  };
  const linhas = [
    // dia, início, fim, empreendimento, tipo, modalidade, contacto, cliente, resultado
    [0, 11, 11.75, 'SERENITY', 'Reunião Comercial', 'presencial', '1011', null, ''],
    [0, 17.5, 18, 'FOLIAGE', 'Reunião Parceiro', 'telefonica', '1012', null, 'SCHEDULED'],
    [1, 12, 12.5, 'SOUL', 'Reunião Follow Up', 'online', '1007', null, 'CANCELED'],
    [2, 10, 11, 'RAIZ', 'Reunião Parceiro', 'presencial', '1009', null, 'COMPLETED'],
    [2, 18, 18.5, 'PRISMA', 'Reunião Comercial', 'telefonica', '1010', null, 'NO_SHOW'],
    [3, 10, 10.75, 'PURE', 'Reunião Comercial', 'presencial', '1001', null, 'SCHEDULED'],
    [3, 14.5, 15.5, 'SERENITY', 'Reunião Parceiro c/ Cliente', 'online', '1002', '1003', 'SCHEDULED'],
    [3, 17, 17.5, 'FOLIAGE', 'Reunião Visita Obra', 'presencial', '1004', null, 'SCHEDULED'],
    [4, 11.5, 12, 'VC FORTE', 'Reunião Visita Obra', 'presencial', '1005', null, 'SCHEDULED'],
    [4, 15, 15.75, 'LUMARE', 'Reunião Parceiro', 'telefonica', '1006', null, 'SCHEDULED'],
    [7, 9.5, 10.5, 'ENLIGHT', 'Reunião Follow Up', 'online', '1007', null, 'SCHEDULED'],
    [7, 16, 16.5, 'PURE', 'Reunião Comercial', 'presencial', '1008', null, 'SCHEDULED'],
    [-3, 10, 10.5, 'PURE', 'Reunião Visita Obra', 'presencial', '1013', null, ''],
    [-4, 15, 16, 'LUMARE', 'Reunião Follow Up', 'presencial', '1006', '1014', 'SCHEDULED'],
  ];
  const contacto = (cid) => d.contactos.find((c) => c.id === cid);
  return linhas.map(([dia, h1, h2, emp, tipo, mod, cid, clid, res]) => ({
    id: String(d.proximoId++), titulo: gerarTitulo(emp, contacto(cid), clid ? contacto(clid) : null), inicio: em(dia, h1), fim: em(dia, h2),
    resultado: res, tipo, ownerId, notas: `Empreendimento: ${emp}`, local: mod === 'presencial' ? 'Showroom FERCOPOR' : '',
    modalidade: mod, ligacao: '', origem: 'DEMO', contactos: [cid, clid].filter(Boolean),
  }));
}

function nomeDoEmail(email) {
  return email.split('@')[0].split(/[._-]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function resumoTexto(t) {
  let h = 2166136261;
  for (const c of t) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}

/* ---------- Idempotência e auditoria (KV) ---------- */

async function lerIdempotencia(env, utilizador, chave) {
  if (!env.REUNIOES_KV) return null;
  return env.REUNIOES_KV.get(`idem:${utilizador.ownerId}:${chave}`);
}

async function guardarIdempotencia(env, utilizador, chave, id) {
  if (!env.REUNIOES_KV) return;
  await env.REUNIOES_KV.put(`idem:${utilizador.ownerId}:${chave}`, String(id), { expirationTtl: 7 * 86400 });
}

async function auditar(env, utilizador, acao, reuniaoId, extra) {
  if (!env.REUNIOES_KV) return;
  const quando = new Date().toISOString();
  const registo = { quando, email: utilizador.email, ownerId: utilizador.ownerId, acao, reuniaoId, ...extra };
  await env.REUNIOES_KV.put(`audit:${quando}:${crypto.randomUUID()}`, JSON.stringify(registo), { expirationTtl: 400 * 86400 });
}

/* ---------- Utilitários ---------- */

function json(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function lerJson(request) {
  const texto = await request.text();
  if (texto.length > 20000) throw new ErroHttp(413, 'Pedido demasiado grande.');
  try { return JSON.parse(texto || '{}'); } catch { throw new ErroHttp(400, 'JSON inválido.'); }
}

function mesmaOrigem(request, url) {
  const origem = request.headers.get('Origin');
  return !origem || origem === url.origin;
}

function listaEmails(texto) {
  return String(texto || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function desvioLisboaHoras(ms) {
  const nome = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Lisbon', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName').value;   // "GMT" ou "GMT+1"
  const m = /GMT([+-]\d+)?/.exec(nome);
  return m && m[1] ? Number(m[1]) : 0;
}

function normalizar(t) {
  return String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function textoBase64Url(s) {
  return new TextDecoder().decode(bytesBase64Url(s));
}

function bytesBase64Url(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function comSeguranca(resposta) {
  const r = new Response(resposta.body, resposta);
  for (const [k, v] of Object.entries(CABECALHOS_SEGURANCA)) r.headers.set(k, v);
  return r;
}

export const _teste = { gerarTitulo, gerarNotas, papelDoContacto, validarNovaReuniao, juntarNotas, tratar, ErroHttp };
