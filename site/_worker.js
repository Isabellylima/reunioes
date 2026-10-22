/* ==========================================================================
   FERCOPOR Reuniões — servidor (Cloudflare Pages, modo avançado _worker.js)

   O que faz:
   1. Login «Iniciar sessão com Microsoft» (Entra ID, OpenID Connect + PKCE):
      valida o id_token (assinatura, emissor, audiência, organização, nonce,
      validade) e cria uma sessão num cookie assinado (HttpOnly, Secure).
      Durante a transição aceita também o Cloudflare Access (AUTH_MODE ≠ "entra").
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
     ENTRA_TENANT_ID        ID do diretório (tenant) Microsoft 365 da FERCOPOR (GUID)  (Text)
     ENTRA_CLIENT_ID        ID da aplicação registada no Entra ID       (Text)
     ENTRA_CLIENT_SECRET    segredo do cliente da aplicação              (Secret)
     SESSION_SECRET         texto aleatório com 32+ caracteres (assina as sessões) (Secret)
     APP_URL                ex.: https://reunioes.fercopor.workers.dev   (Text)
     AUTH_MODE              "entra" desliga o Cloudflare Access no fim da transição (Text, opcional)
     SESSAO_HORAS           duração da sessão, 1–24 (por omissão 12)     (Text, opcional)
     ACCESS_TEAM_DOMAIN     ex.: fercopor.cloudflareaccess.com          (Text, transição)
     ACCESS_AUD             "Application Audience (AUD) Tag" do Access   (Text, transição)
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
  async fetch(request, envOriginal) {
    try {
      const env = await normalizarConfiguracao(envOriginal, request);
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

/* Aceita os nomes MICROSOFT_* (painel) e ENTRA_* (código); completa o que é opcional:
   APP_URL     por omissão, o endereço pelo qual a app foi aberta (tem de coincidir com o redirect registado);
   SESSION_SECRET  por omissão, derivado do client secret (renovar o secret termina as sessões). */
async function normalizarConfiguracao(env, request) {
  const e = { ...env };
  e.ENTRA_TENANT_ID = env.ENTRA_TENANT_ID || env.MICROSOFT_TENANT_ID;
  e.ENTRA_CLIENT_ID = env.ENTRA_CLIENT_ID || env.MICROSOFT_CLIENT_ID;
  e.ENTRA_CLIENT_SECRET = env.ENTRA_CLIENT_SECRET || env.MICROSOFT_CLIENT_SECRET;
  // Espaços ou quebras de linha coladas por engano tornam o segredo inválido (AADSTS7000215)
  e._diagSegredoComEspacos = Boolean(e.ENTRA_CLIENT_SECRET && String(e.ENTRA_CLIENT_SECRET) !== String(e.ENTRA_CLIENT_SECRET).trim());
  for (const k of ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET']) if (e[k]) e[k] = String(e[k]).trim();
  e._diagAppUrl = env.APP_URL ? 'APP_URL' : 'endereço da app';
  e._diagSessionSecret = env.SESSION_SECRET ? 'SESSION_SECRET' : 'derivado do client secret';
  if (e.ENTRA_TENANT_ID || e.ENTRA_CLIENT_ID || e.ENTRA_CLIENT_SECRET) {
    if (!e.APP_URL) e.APP_URL = new URL(request.url).origin;
    if (!e.SESSION_SECRET && e.ENTRA_CLIENT_SECRET) {
      const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(e.ENTRA_CLIENT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const derivado = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode('fercopor-reunioes/sessao/v1'));
      e.SESSION_SECRET = [...new Uint8Array(derivado)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  }
  return e;
}

/* ---------- Encaminhamento ---------- */

async function tratar(request, env) {
  const url = new URL(request.url);
  const caminho = url.pathname;

  // Rotas públicas: login Microsoft e os dois ficheiros da página de entrada (sem dados)
  if (request.method === 'GET') {
    if (caminho === '/auth/entrar' && entraConfigurada(env)) return iniciarLoginMicrosoft(request, env);
    if (caminho === '/auth/retorno' && entraConfigurada(env)) return concluirLoginMicrosoft(request, env);
    if (caminho === '/auth/sair') return terminarSessao(env);
    if (caminho === '/auth/diagnostico') return diagnosticoLogin(request, env);
    if (caminho === '/style.css' || caminho === '/assets/fercopor-logo.svg') return env.ASSETS.fetch(request);
  }

  let utilizador;
  try {
    utilizador = await autenticar(request, env);   // nada mais é entregue sem sessão válida
  } catch (e) {
    // Sem sessão e com login Microsoft configurado: páginas mostram «Iniciar sessão com Microsoft»; a API responde 401
    if (e instanceof ErroHttp && e.status === 401 && !caminho.startsWith('/api/') && entraConfigurada(env)) {
      return paginaEntrada(env, '');
    }
    if (e instanceof ErroHttp && e.status === 403 && !caminho.startsWith('/api/') && entraConfigurada(env)) {
      const h = new Headers();
      h.append('Set-Cookie', cookie(COOKIE_SESSAO, '', 0));
      return paginaEntrada(env, e.message, 403, h);
    }
    throw e;
  }

  if (request.method === 'GET' && caminho === '/auth/calendario/ligar') {
    return iniciarLigacaoCalendario(env, utilizador);
  }

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
    const sair = utilizador.autenticacao === 'access' ? '/cdn-cgi/access/logout' : '/auth/sair';
    return json({ ...utilizador, modo: fonte.modo, escritaAtiva: fonte.escritaAtiva, sair, calendario: await estadoCalendario(env, utilizador) });
  }
  if (m === 'GET' && caminho === '/api/calendario/disponibilidade') {
    const inicio = Date.parse(url.searchParams.get('inicio') || '');
    const fim = Date.parse(url.searchParams.get('fim') || '');
    return json(await disponibilidade(env, utilizador, inicio, fim));
  }
  if (m === 'GET' && caminho === '/api/calendario/verificar') {
    return json(await verificarCalendario(env, utilizador));
  }
  if (m === 'POST' && caminho === '/api/calendario/desligar') {
    return desligarCalendario(env, utilizador);
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
    return json({ reunioes: await marcarDuplicados(env, utilizador, await fonte.listarReunioes(utilizador.ownerId, de, ate)) });
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
    if (m === 'GET' && partes.length === 3) return json({ reuniao, outlook: await resumoOutlook(env, id) });
    if (m === 'PATCH' && partes.length === 3) return reprogramar(request, env, fonte, utilizador, reuniao);
    if (m === 'POST' && partes[3] === 'outlook' && partes.length === 4) return tentarOutlookDeNovo(request, env, fonte, utilizador, reuniao);
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
/*
   Ordem: (1) sessão Microsoft (cookie assinado, criado após login Entra ID / OIDC);
          (2) Cloudflare Access (JWT), só enquanto AUTH_MODE ≠ "entra" (transição);
          (3) modo demo sem Access nem Entra (DEMO_USER_EMAIL, só dados fictícios).
   O login pede apenas "openid profile email". O acesso ao calendário (Graph) será um
   consentimento SEPARADO e posterior, com tokens guardados à parte (ver SPEC §O).
*/

const PADRAO_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DICAS_AADSTS = {
  AADSTS7000215: 'O client secret não é válido: confirme que MICROSOFT_CLIENT_SECRET tem o «Value» (não o «Secret ID»), completo e sem espaços.',
  AADSTS7000222: 'O client secret expirou: crie um novo em Certificates & secrets e atualize MICROSOFT_CLIENT_SECRET.',
  AADSTS700016: 'A aplicação (MICROSOFT_CLIENT_ID) não existe neste diretório: confirme o Application (client) ID e o tenant.',
  AADSTS700025: 'A aplicação está a ser tratada como cliente público: o Redirect URI tem de estar na plataforma «Web» (não «SPA» nem «Mobile and desktop»).',
  AADSTS50011: 'O endereço de retorno não coincide com o registado: use https://reunioes.fercopor.workers.dev/auth/retorno na plataforma Web.',
  AADSTS500112: 'O endereço de retorno não coincide com o registado.',
  AADSTS54005: 'O código de autorização já tinha sido usado (página recarregada?). Volte a iniciar sessão.',
  AADSTS70008: 'O código de autorização expirou. Volte a iniciar sessão.',
  AADSTS65001: 'Falta consentimento para as permissões: peça à TI «Grant admin consent».',
  AADSTS90002: 'O tenant indicado em MICROSOFT_TENANT_ID não existe.',
  AADSTS50194: 'A aplicação não está configurada para este diretório: confirme MICROSOFT_TENANT_ID.',
};

const COOKIE_SESSAO = '__Host-reunioes_sessao';
const COOKIE_OAUTH = '__Host-reunioes_oauth';
const AMBITOS_LOGIN = 'openid profile email';

function entraConfigurada(env) {
  const nomes = ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'SESSION_SECRET', 'APP_URL'];
  const definidas = nomes.filter((n) => env[n]);
  if (definidas.length === 0) return false;
  const emFalta = nomes.filter((n) => !env[n]);
  if (emFalta.length) throw new ErroHttp(503, `Configuração Microsoft incompleta: falta ${emFalta.join(', ')}.`);
  if (String(env.SESSION_SECRET).length < 32) throw new ErroHttp(503, 'SESSION_SECRET tem de ter 32 ou mais caracteres.');
  if (!/^[0-9a-f-]{36}$/i.test(env.ENTRA_TENANT_ID)) throw new ErroHttp(503, 'ENTRA_TENANT_ID tem de ser o ID do diretório (GUID).');
  return true;
}

async function autenticar(request, env) {
  const dominio = (env.ALLOWED_DOMAIN || 'fercopor.pt').toLowerCase();
  const entra = entraConfigurada(env);
  const access = Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) && env.AUTH_MODE !== 'entra';
  let email;
  let autenticacao;

  if (env.AUTH_MODE === 'entra' && !entra) {
    throw new ErroHttp(503, 'AUTH_MODE=entra exige o login Microsoft configurado (MICROSOFT_*).');
  }
  const sessao = entra ? await lerCookieAssinado(request, env, COOKIE_SESSAO) : null;
  if (sessao) {
    email = String(sessao.e || '').toLowerCase();
    autenticacao = 'microsoft';
  } else if (access && request.headers.get('Cf-Access-Jwt-Assertion')) {
    const dados = await verificarJwtAccess(request.headers.get('Cf-Access-Jwt-Assertion'), env);
    email = String(dados.email || '').toLowerCase();
    autenticacao = 'access';
  } else if (entra) {
    throw new ErroHttp(401, 'Sessão em falta. Inicie sessão com a conta Microsoft.');
  } else if (access) {
    throw new ErroHttp(401, 'Sessão em falta. Entre com a conta da empresa.');
  } else if (!env.HUBSPOT_TOKEN && env.DEMO_USER_EMAIL) {
    email = String(env.DEMO_USER_EMAIL).toLowerCase();   // pré-visualização sem login, só com dados fictícios
    autenticacao = 'demo';
  } else {
    throw new ErroHttp(503, 'Configuração em falta: defina o login Microsoft (ENTRA_*) ou o Cloudflare Access (ACCESS_*).');
  }

  if (!email.endsWith('@' + dominio)) throw new ErroHttp(403, 'Conta fora da organização.');

  const lista = await lerAutorizados(env);
  const registo = lista.find((u) => u.email === email);
  const admins = listaEmails(env.ADMIN_EMAILS);
  const admin = admins.includes(email) || Boolean(registo && registo.admin);
  if (!registo && !admin) throw new ErroHttp(403, 'Utilizador sem autorização para esta aplicação.');

  const proprietario = await proprietarioComCache(env, email);
  if (!proprietario) throw new ErroHttp(403, 'Sem utilizador ativo correspondente no HubSpot.');

  return { email, nome: proprietario.nome, ownerId: String(proprietario.id), admin, autenticacao };
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

/* --- Login Microsoft (Entra ID, OpenID Connect, fluxo de código com PKCE) --- */

async function iniciarLoginMicrosoft(request, env) {
  const url = new URL(request.url);
  const volta = destinoSeguro(url.searchParams.get('volta'));
  const estado = aleatorio(24);
  const nonce = aleatorio(24);
  const verificador = aleatorio(48);
  const desafio = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verificador))));
  const temporario = await assinar(env, { s: estado, n: nonce, v: verificador, volta, exp: agoraSeg() + 600 });

  const autorizar = new URL(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/authorize`);
  autorizar.search = new URLSearchParams({
    client_id: env.ENTRA_CLIENT_ID,
    response_type: 'code',
    redirect_uri: enderecoRetorno(env),
    response_mode: 'query',
    scope: AMBITOS_LOGIN,
    state: estado,
    nonce,
    code_challenge: desafio,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();

  return new Response(null, {
    status: 302,
    headers: { Location: autorizar.toString(), 'Set-Cookie': cookie(COOKIE_OAUTH, temporario, 600), 'Cache-Control': 'no-store' },
  });
}

async function concluirLoginMicrosoft(request, env) {
  const url = new URL(request.url);
  const temporario = await lerCookieAssinado(request, env, COOKIE_OAUTH);
  const limpar = cookie(COOKIE_OAUTH, '', 0);
  if (url.searchParams.get('error')) {
    return paginaEntrada(env, 'O início de sessão foi cancelado ou recusado pela Microsoft.', 400, limpar);
  }
  const codigo = url.searchParams.get('code');
  if (!temporario || !codigo || url.searchParams.get('state') !== temporario.s) {
    return paginaEntrada(env, 'O pedido de início de sessão expirou ou é inválido. Tente novamente.', 400, limpar);
  }

  if (PADRAO_GUID.test(env.ENTRA_CLIENT_SECRET)) {
    console.error(JSON.stringify({ evento: 'entra_segredo_parece_secret_id' }));
    return paginaEntrada(env, 'MICROSOFT_CLIENT_SECRET contém o «Secret ID» (formato de GUID) em vez do «Value» do segredo. Em Entra ID › Certificates & secrets, copie a coluna «Value».', 503, limpar);
  }
  if (temporario.t === 'cal') return concluirLigacaoCalendario(request, env, temporario, codigo, limpar);

  const r = await fetch(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.ENTRA_CLIENT_ID,
      client_secret: env.ENTRA_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: codigo,
      redirect_uri: enderecoRetorno(env),
      code_verifier: temporario.v,
      scope: AMBITOS_LOGIN,
    }).toString(),
  });
  if (!r.ok) {
    // Só campos de diagnóstico da resposta de erro da Microsoft (nunca o código, tokens ou segredos)
    let erro = {};
    try { erro = await r.json(); } catch { /* resposta sem JSON */ }
    const codigoAad = (String(erro.error_description || '').match(/AADSTS\d+/) || [])[0]
      || (Array.isArray(erro.error_codes) && erro.error_codes[0] ? `AADSTS${erro.error_codes[0]}` : '');
    console.error(JSON.stringify({
      evento: 'entra_troca_codigo_falhou', http: r.status, erro: erro.error || '', codigo: codigoAad,
      trace_id: erro.trace_id || '', correlation_id: erro.correlation_id || '', redirect_uri: enderecoRetorno(env),
    }));
    const dica = DICAS_AADSTS[codigoAad] || 'Verifique o registo da aplicação no Entra ID.';
    const ref = [codigoAad || erro.error || `HTTP ${r.status}`, erro.trace_id ? `rastreio ${String(erro.trace_id).slice(0, 8)}` : ''].filter(Boolean).join(' · ');
    return paginaEntrada(env, `A Microsoft não confirmou o início de sessão (${ref}). ${dica}`, 502, limpar);
  }
  const resposta = await r.json();
  let dados;
  try {
    dados = await verificarIdTokenEntra(resposta.id_token, env, temporario.n);
  } catch (e) {
    if (!(e instanceof ErroHttp)) throw e;
    return paginaEntrada(env, e.message, e.status, limpar);
  }

  const email = String(dados.email || dados.preferred_username || '').toLowerCase();
  const dominio = (env.ALLOWED_DOMAIN || 'fercopor.pt').toLowerCase();
  if (!email.endsWith('@' + dominio)) {
    return paginaEntrada(env, 'Esta conta não pertence à organização FERCOPOR.', 403, limpar);
  }
  const horas = Math.min(Math.max(Number(env.SESSAO_HORAS) || 12, 1), 24);
  const sessao = await assinar(env, { e: email, o: dados.oid || '', exp: agoraSeg() + horas * 3600 });
  const cabecalhos = new Headers({ Location: temporario.volta || '/', 'Cache-Control': 'no-store' });
  cabecalhos.append('Set-Cookie', cookie(COOKIE_SESSAO, sessao, horas * 3600));
  cabecalhos.append('Set-Cookie', limpar);
  return new Response(null, { status: 302, headers: cabecalhos });
}

// Diagnóstico da configuração do login, sem valores secretos. Só para quem já tem sessão (Access ou Microsoft).
async function diagnosticoLogin(request, env) {
  const temAccess = Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && env.AUTH_MODE !== 'entra' && request.headers.get('Cf-Access-Jwt-Assertion'));
  let autorizado = false;
  if (temAccess) {
    try { await verificarJwtAccess(request.headers.get('Cf-Access-Jwt-Assertion'), env); autorizado = true; } catch { /* inválido */ }
  }
  if (!autorizado && env.SESSION_SECRET && await lerCookieAssinado(request, env, COOKIE_SESSAO)) autorizado = true;
  if (!autorizado) throw new ErroHttp(401, 'Diagnóstico só com sessão iniciada.');
  const segredo = String(env.ENTRA_CLIENT_SECRET || '');
  return json({
    tenantId: env.ENTRA_TENANT_ID || null,
    tenantIdEGuid: PADRAO_GUID.test(String(env.ENTRA_TENANT_ID || '')),
    clientId: env.ENTRA_CLIENT_ID || null,
    clientIdEGuid: PADRAO_GUID.test(String(env.ENTRA_CLIENT_ID || '')),
    clientSecretPresente: Boolean(segredo),
    clientSecretPareceSecretId: PADRAO_GUID.test(segredo),
    clientSecretTinhaEspacos: Boolean(env._diagSegredoComEspacos),
    redirectUri: env.ENTRA_TENANT_ID ? enderecoRetorno(env) : null,
    origemAppUrl: env._diagAppUrl || null,
    origemSessionSecret: env._diagSessionSecret || null,
    accessAtivo: Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD),
    authMode: env.AUTH_MODE || 'transição (Access + Microsoft)',
    sessaoHoras: Math.min(Math.max(Number(env.SESSAO_HORAS) || 12, 1), 24),
    calendarioModo: ['simulacao', 'real'].includes(env.CALENDAR_MODE) ? env.CALENDAR_MODE : 'desligado',
    calendarioUtilizadoresTeste: listaEmails(env.CALENDAR_TEST_EMAILS).length,
    calendarioChaveCifra: env.CALENDAR_TOKEN_KEY ? 'CALENDAR_TOKEN_KEY' : 'derivada do SESSION_SECRET',
  });
}

function terminarSessao(env) {
  const cabecalhos = new Headers({ 'Cache-Control': 'no-store' });
  cabecalhos.append('Set-Cookie', cookie(COOKIE_SESSAO, '', 0));
  cabecalhos.append('Set-Cookie', cookie(COOKIE_OAUTH, '', 0));
  return paginaEntrada(env, 'Sessão terminada.', 200, cabecalhos);
}

async function verificarIdTokenEntra(token, env, nonceEsperado) {
  const tenant = String(env.ENTRA_TENANT_ID).toLowerCase();
  const dados = await verificarJwtRs256(token, `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`);
  if (dados.iss !== `https://login.microsoftonline.com/${tenant}/v2.0`) throw new ErroHttp(401, 'Sessão Microsoft de outro emissor.');
  if (dados.aud !== env.ENTRA_CLIENT_ID) throw new ErroHttp(401, 'Sessão Microsoft para outra aplicação.');
  if (String(dados.tid || '').toLowerCase() !== tenant) throw new ErroHttp(403, 'Conta de outra organização.');
  if (!nonceEsperado || dados.nonce !== nonceEsperado) throw new ErroHttp(401, 'Sessão Microsoft inválida.');
  return dados;
}

function enderecoRetorno(env) {
  return String(env.APP_URL).replace(/\/$/, '') + '/auth/retorno';
}

function destinoSeguro(v) {
  return typeof v === 'string' && /^\/[^/\\]/.test(v) && v.length < 200 ? v : '/';
}

function paginaEntrada(env, mensagem, status = 200, cabecalhosExtra) {
  const cabecalhos = new Headers(cabecalhosExtra instanceof Headers ? cabecalhosExtra : {});
  if (typeof cabecalhosExtra === 'string') cabecalhos.append('Set-Cookie', cabecalhosExtra);
  cabecalhos.set('Content-Type', 'text/html; charset=utf-8');
  cabecalhos.set('Cache-Control', 'no-store');
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = `<!doctype html>
<html lang="pt-PT"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Entrar · Reuniões FERCOPOR</title><link rel="stylesheet" href="/style.css"></head>
<body class="pagina-entrada">
<header class="topo"><span class="marca"><img src="/assets/fercopor-logo.svg" alt="FERCOPOR" width="128" height="20"><span>Reuniões</span></span></header>
<main class="entrada">
  <h1>Reuniões FERCOPOR</h1>
  <p>Entre com a sua conta Microsoft 365 da FERCOPOR.</p>
  ${mensagem ? `<p class="nota" role="status">${esc(mensagem)}</p>` : ''}
  <a class="botao botao-microsoft" href="/auth/entrar">
    <svg viewBox="0 0 21 21" width="20" height="20" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/><rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg>
    Iniciar sessão com Microsoft
  </a>
  <p class="subtitulo">Só utilizadores autorizados. Não é pedida nenhuma palavra-passe a esta aplicação.</p>
</main>
</body></html>`;
  return new Response(html, { status, headers: cabecalhos });
}

/* --- Cloudflare Access (login atual, mantido durante a transição) --- */

async function verificarJwtAccess(token, env) {
  const dominio = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const dados = await verificarJwtRs256(token, `https://${dominio}/cdn-cgi/access/certs`);
  const audiencias = Array.isArray(dados.aud) ? dados.aud : [dados.aud];
  if (!audiencias.includes(env.ACCESS_AUD)) throw new ErroHttp(401, 'Sessão inválida.');
  if (dados.iss !== `https://${dominio}`) throw new ErroHttp(401, 'Sessão inválida.');
  return dados;
}

/* --- JWT RS256 genérico (Access e Entra ID) --- */

const chavesCache = new Map();   // url → { chaves, ate }

async function verificarJwtRs256(token, urlChaves) {
  const partes = String(token || '').split('.');
  if (partes.length !== 3) throw new ErroHttp(401, 'Sessão inválida.');
  let cabecalho;
  let dados;
  try {
    cabecalho = JSON.parse(textoBase64Url(partes[0]));
    dados = JSON.parse(textoBase64Url(partes[1]));
  } catch { throw new ErroHttp(401, 'Sessão inválida.'); }
  if (cabecalho.alg !== 'RS256') throw new ErroHttp(401, 'Sessão inválida.');

  let guardado = chavesCache.get(urlChaves);
  if (!guardado || Date.now() > guardado.ate || !guardado.chaves.some((k) => k.kid === cabecalho.kid)) {
    const r = await fetch(urlChaves);
    if (!r.ok) throw new ErroHttp(503, 'Não foi possível validar a sessão.');
    guardado = { chaves: (await r.json()).keys || [], ate: Date.now() + 36e5 };
    chavesCache.set(urlChaves, guardado);
  }
  const jwk = guardado.chaves.find((k) => k.kid === cabecalho.kid);
  if (!jwk) throw new ErroHttp(401, 'Sessão inválida.');

  const chave = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valido = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', chave, bytesBase64Url(partes[2]), new TextEncoder().encode(partes[0] + '.' + partes[1]),
  );
  if (!valido) throw new ErroHttp(401, 'Sessão inválida.');

  const agora = agoraSeg();
  if (!dados.exp || dados.exp < agora) throw new ErroHttp(401, 'Sessão expirada. Volte a entrar.');
  if (dados.nbf && dados.nbf > agora + 60) throw new ErroHttp(401, 'Sessão inválida.');
  return dados;
}

/* --- Cookies assinados (HMAC-SHA256 com SESSION_SECRET) --- */

async function chaveHmac(env) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function assinar(env, dados) {
  const corpo = base64Url(new TextEncoder().encode(JSON.stringify(dados)));
  const assinatura = await crypto.subtle.sign('HMAC', await chaveHmac(env), new TextEncoder().encode(corpo));
  return `${corpo}.${base64Url(new Uint8Array(assinatura))}`;
}

async function lerCookieAssinado(request, env, nome) {
  const valor = lerCookie(request, nome);
  if (!valor) return null;
  const [corpo, assinatura] = valor.split('.');
  if (!corpo || !assinatura) return null;
  let valido = false;
  try {
    valido = await crypto.subtle.verify('HMAC', await chaveHmac(env), bytesBase64Url(assinatura), new TextEncoder().encode(corpo));
  } catch { return null; }
  if (!valido) return null;
  try {
    const dados = JSON.parse(textoBase64Url(corpo));
    return dados.exp && dados.exp > agoraSeg() ? dados : null;
  } catch { return null; }
}

function lerCookie(request, nome) {
  const todos = request.headers.get('Cookie') || '';
  for (const parte of todos.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nome) return parte.slice(i + 1).trim();
  }
  return null;
}

function cookie(nome, valor, segundos) {
  return `${nome}=${valor}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${segundos}`;
}

function aleatorio(bytes) {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function agoraSeg() {
  return Math.floor(Date.now() / 1000);
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
  if (jaFeita) return json({ reuniao: await fonte.lerReuniao(jaFeita), repetida: true, outlook: await resumoOutlook(env, jaFeita) });

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

  // Outlook/Teams só depois de a reunião existir no HubSpot. Se falhar, a reunião fica no HubSpot e pode tentar-se de novo.
  let outlook = { estado: 'nao_pedido' };
  let final = criada;
  if (pedido.outlook) {
    const convidados = contactos.filter((c) => pedido.convidar.includes(String(c.id)) && c.email);
    outlook = await criarEventoOutlook(env, utilizador, criada, convidados, chave);
    if (outlook.ligacao && !criada.ligacao) {
      final = await fonte.atualizarReuniao(criada.id, {
        ligacao: outlook.ligacao,
        notas: juntarNotas(criada.notas, linhaNota(utilizador, `Teams: ${outlook.ligacao}`)),
      });
    }
  }
  return json({ reuniao: final, outlook }, 201);
}

async function tentarOutlookDeNovo(request, env, fonte, utilizador, reuniao) {
  exigirEscrita(fonte);
  const corpo = await lerJson(request);
  const pedidos = Array.isArray(corpo.convidar) ? corpo.convidar.map(String) : [];
  const convidados = reuniao.contactos.filter((c) => pedidos.includes(String(c.id)) && c.email);
  const anterior = await lerMapa(env, reuniao.id);
  if (anterior && anterior.estado === 'falhou') await env.REUNIOES_KV.delete(`map:${reuniao.id}`);
  const outlook = await criarEventoOutlook(env, utilizador, reuniao, convidados, `retry-${reuniao.id}`);
  let final = reuniao;
  if (outlook.ligacao && !reuniao.ligacao) {
    final = await fonte.atualizarReuniao(reuniao.id, {
      ligacao: outlook.ligacao, notas: juntarNotas(reuniao.notas, linhaNota(utilizador, `Teams: ${outlook.ligacao}`)),
    });
  }
  return json({ reuniao: final, outlook });
}

async function resumoOutlook(env, reuniaoId) {
  const mapa = await lerMapa(env, reuniaoId);
  if (!mapa) return { estado: 'sem_evento' };
  if (mapa.estado === 'falhou') return { estado: 'falhou', erro: mapa.erro || '' };
  return { estado: mapa.modo === 'simulacao' ? 'simulado' : 'criado', ligacao: mapa.ligacao || '', convidados: mapa.convidados || 0 };
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
  // O mesmo evento Outlook é atualizado (sem criar outro); o Outlook avisa os convidados da nova hora.
  const outlook = await reprogramarEventoOutlook(env, utilizador, reuniao.id, inicio, fim);
  return json({ reuniao: atualizada, outlook });
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
  // Convites: só os contactos explicitamente escolhidos, e só entre os contactos da reunião
  const convidar = Array.isArray(c.convidar) ? [...new Set(c.convidar.map(String))] : [];
  if (convidar.some((id) => id !== contactoId && id !== clienteId)) throw new ErroHttp(400, 'Só pode convidar contactos desta reunião.');
  return {
    empreendimento, tipo, modalidade, inicio, fim, contactoId, clienteId,
    outlook: c.outlook === true,
    convidar,
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
      if (alteracoes.ligacao) propriedades.hs_video_conference_url = alteracoes.ligacao;
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
      if (alt.ligacao) r.ligacao = alt.ligacao;
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

/* ---------- Calendário Outlook / Teams (Microsoft Graph, permissões delegadas) ----------
   Consentimento SEPARADO do login: o utilizador clica «Ligar o meu calendário» e autoriza só
   "offline_access Calendars.ReadWrite" sobre o SEU calendário. O token de renovação fica cifrado (AES-GCM) em KV.
   Modos (CALENDAR_MODE):
     desligado  (omissão) nada é feito no Outlook;
     simulacao  respostas fictícias: nenhum evento é criado, alterado ou consultado no Outlook;
     real       Graph a sério; se CALENDAR_TEST_EMAILS existir, só esses utilizadores (os outros ficam em simulação).
   O cancelamento no Outlook NÃO está implementado (decisão pendente, SPEC §P). */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const AMBITOS_CALENDARIO = 'offline_access Calendars.ReadWrite';
const PROP_HUBSPOT = 'String {6f1f3c5e-4c9a-4b8e-9d2a-0f7e2a9b1c34} Name FercoporHubSpotMeetingId';

function modoCalendario(env, email) {
  const modo = ['simulacao', 'real'].includes(env.CALENDAR_MODE) ? env.CALENDAR_MODE : 'desligado';
  if (modo !== 'real') return modo;
  const teste = listaEmails(env.CALENDAR_TEST_EMAILS);
  return !teste.length || teste.includes(email) ? 'real' : 'simulacao';
}

async function estadoCalendario(env, utilizador) {
  const modo = modoCalendario(env, utilizador.email);
  if (modo === 'desligado') return { modo, ligado: false };
  const guardado = env.REUNIOES_KV ? await env.REUNIOES_KV.get(`cal:${utilizador.email}`, 'json') : null;
  // Em modo real só conta uma autorização real (token); a marca da simulação não serve
  const ligado = modo === 'real' ? Boolean(guardado && guardado.rt) : Boolean(guardado && (guardado.rt || guardado.simulado));
  return { modo, ligado, ambitos: (modo === 'real' && guardado && guardado.ambitos) || null };
}

/* --- Consentimento --- */

async function iniciarLigacaoCalendario(env, utilizador) {
  const modo = modoCalendario(env, utilizador.email);
  if (modo === 'desligado') throw new ErroHttp(403, 'A ligação ao calendário ainda não está ativa.');
  if (!env.REUNIOES_KV) throw new ErroHttp(503, 'Ligação KV (REUNIOES_KV) em falta.');
  if (modo === 'simulacao') {
    await env.REUNIOES_KV.put(`cal:${utilizador.email}`, JSON.stringify({ simulado: true, atualizado: Date.now() }));
    return new Response(null, { status: 302, headers: { Location: '/#/inicio', 'Cache-Control': 'no-store' } });
  }
  if (utilizador.autenticacao !== 'microsoft') throw new ErroHttp(403, 'Inicie sessão com a Microsoft para ligar o calendário.');
  const estado = aleatorio(24);
  const verificador = aleatorio(48);
  const desafio = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verificador))));
  const temporario = await assinar(env, { t: 'cal', s: estado, v: verificador, e: utilizador.email, exp: agoraSeg() + 600 });
  const autorizar = new URL(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/authorize`);
  autorizar.search = new URLSearchParams({
    client_id: env.ENTRA_CLIENT_ID, response_type: 'code', redirect_uri: enderecoRetorno(env), response_mode: 'query',
    scope: AMBITOS_CALENDARIO, state: estado, code_challenge: desafio, code_challenge_method: 'S256', login_hint: utilizador.email,
  }).toString();
  return new Response(null, {
    status: 302,
    headers: { Location: autorizar.toString(), 'Set-Cookie': cookie(COOKIE_OAUTH, temporario, 600), 'Cache-Control': 'no-store' },
  });
}

// Chamado por /auth/retorno quando o pedido temporário é do tipo «cal»
async function concluirLigacaoCalendario(request, env, temporario, codigo, limpar) {
  if (modoCalendario(env, temporario.e) !== 'real') {
    return paginaEntrada(env, 'A ligação real ao calendário não está autorizada para esta conta.', 403, limpar);
  }
  const sessao = await lerCookieAssinado(request, env, COOKIE_SESSAO);
  if (!sessao || String(sessao.e).toLowerCase() !== temporario.e) {
    return paginaEntrada(env, 'Sessão em falta ou diferente: volte a iniciar sessão e a ligar o calendário.', 401, limpar);
  }
  const tokens = await pedirTokenMicrosoft(env, { grant_type: 'authorization_code', code: codigo, code_verifier: temporario.v, scope: AMBITOS_CALENDARIO });
  if (!tokens.ok) return paginaEntrada(env, `A Microsoft não autorizou o acesso ao calendário (${tokens.ref}). ${tokens.dica}`, 502, limpar);
  // O consentimento tem de ser da MESMA pessoa que tem a sessão
  const eu = await fetch(`${GRAPH}/me?$select=id,mail,userPrincipalName`, { headers: { Authorization: `Bearer ${tokens.dados.access_token}` } });
  const perfil = eu.ok ? await eu.json() : {};
  const emailGraph = String(perfil.mail || perfil.userPrincipalName || '').toLowerCase();
  if (emailGraph !== temporario.e) {
    console.error(JSON.stringify({ evento: 'calendario_conta_diferente' }));
    return paginaEntrada(env, 'A conta Microsoft autorizada não é a mesma da sessão. Nada foi guardado.', 403, limpar);
  }
  if (!tokens.dados.refresh_token) return paginaEntrada(env, 'A Microsoft não devolveu a autorização permanente (offline_access).', 502, limpar);
  await env.REUNIOES_KV.put(`cal:${temporario.e}`, JSON.stringify({
    rt: await cifrar(env, tokens.dados.refresh_token), atualizado: Date.now(), oid: perfil.id || '', conta: emailGraph,
    ambitos: String(tokens.dados.scope || '').split(' ').filter(Boolean).map((a) => a.replace(/^https:\/\/graph\.microsoft\.com\//, '')),
  }));
  acessosGraph.delete(temporario.e);
  const h = new Headers({ Location: '/#/inicio', 'Cache-Control': 'no-store' });
  h.append('Set-Cookie', limpar);
  return new Response(null, { status: 302, headers: h });
}

// Verificação SÓ DE LEITURA da ligação real: conta, permissão de escrita no calendário e Teams disponível.
async function verificarCalendario(env, utilizador) {
  if (modoCalendario(env, utilizador.email) !== 'real') return { modo: modoCalendario(env, utilizador.email), verificado: false };
  const registo = env.REUNIOES_KV ? await env.REUNIOES_KV.get(`cal:${utilizador.email}`, 'json') : null;
  const eu = await graph(env, utilizador.email, 'GET', '/me?$select=mail,userPrincipalName');
  const cal = await graph(env, utilizador.email, 'GET', '/me/calendar?$select=name,canEdit,allowedOnlineMeetingProviders,defaultOnlineMeetingProvider');
  const conta = String(eu.mail || eu.userPrincipalName || '').toLowerCase();
  const fornecedores = cal.allowedOnlineMeetingProviders || [];
  return {
    modo: 'real',
    verificado: true,
    contaMicrosoft: conta,
    contaCorrespondeSessao: conta === utilizador.email,
    podeCriarEventos: cal.canEdit === true,
    teamsDisponivel: fornecedores.includes('teamsForBusiness'),
    fornecedoresReuniaoOnline: fornecedores,
    ambitosAutorizados: (registo && registo.ambitos) || [],
  };
}

async function desligarCalendario(env, utilizador) {
  if (env.REUNIOES_KV) await env.REUNIOES_KV.delete(`cal:${utilizador.email}`);
  acessosGraph.delete(utilizador.email);
  await auditar(env, utilizador, 'calendario.desligar', null, {});
  return json({ calendario: await estadoCalendario(env, utilizador) });
}

async function pedirTokenMicrosoft(env, parametros) {
  const r = await fetch(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.ENTRA_CLIENT_ID, client_secret: env.ENTRA_CLIENT_SECRET, redirect_uri: enderecoRetorno(env), ...parametros }).toString(),
  });
  let dados = {};
  try { dados = await r.json(); } catch { /* sem JSON */ }
  if (r.ok) return { ok: true, dados };
  const codigoAad = (String(dados.error_description || '').match(/AADSTS\d+/) || [])[0] || '';
  console.error(JSON.stringify({ evento: 'microsoft_token_falhou', http: r.status, erro: dados.error || '', codigo: codigoAad, trace_id: dados.trace_id || '' }));
  return { ok: false, erro: dados.error || '', ref: codigoAad || dados.error || `HTTP ${r.status}`, dica: DICAS_AADSTS[codigoAad] || '' };
}

/* --- Token de acesso Graph (renovado a partir do token cifrado) --- */

const acessosGraph = new Map();   // email → { token, ate }

async function acessoGraph(env, email) {
  // A autorização em KV é sempre confirmada: desligar o calendário (em qualquer instância) corta o acesso de imediato
  const registo = env.REUNIOES_KV ? await env.REUNIOES_KV.get(`cal:${email}`, 'json') : null;
  if (!registo || !registo.rt) {
    acessosGraph.delete(email);
    throw new ErroHttp(409, 'O calendário Outlook não está ligado. Use «Ligar o meu calendário».');
  }
  const guardado = acessosGraph.get(email);
  if (guardado && guardado.rt === registo.rt && guardado.ate > Date.now() + 60e3) return guardado.token;
  const tokens = await pedirTokenMicrosoft(env, { grant_type: 'refresh_token', refresh_token: await decifrar(env, registo.rt), scope: AMBITOS_CALENDARIO });
  if (!tokens.ok) {
    if (tokens.erro === 'invalid_grant') await env.REUNIOES_KV.delete(`cal:${email}`);
    throw new ErroHttp(409, 'A autorização do calendário expirou ou foi retirada. Ligue de novo o calendário.');
  }
  let rtAtual = registo.rt;
  if (tokens.dados.refresh_token) {
    rtAtual = await cifrar(env, tokens.dados.refresh_token);
    await env.REUNIOES_KV.put(`cal:${email}`, JSON.stringify({ ...registo, rt: rtAtual, atualizado: Date.now() }));
  }
  acessosGraph.set(email, { token: tokens.dados.access_token, rt: rtAtual, ate: Date.now() + (Number(tokens.dados.expires_in) || 3000) * 1000 });
  return tokens.dados.access_token;
}

async function graph(env, email, metodo, caminho, corpo) {
  // Segunda barreira: nenhuma chamada real ao Graph fora de CALENDAR_MODE=real e de CALENDAR_TEST_EMAILS
  if (modoCalendario(env, email) !== 'real') {
    throw new ErroHttp(403, 'Integração real com o Outlook não autorizada para este utilizador.');
  }
  const r = await fetch(GRAPH + caminho, {
    method: metodo,
    headers: { Authorization: `Bearer ${await acessoGraph(env, email)}`, 'Content-Type': 'application/json', Prefer: 'outlook.timezone="UTC"' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (!r.ok) {
    let erro = {};
    try { erro = await r.json(); } catch { /* sem JSON */ }
    console.error(JSON.stringify({ evento: 'graph_falhou', metodo, http: r.status, codigo: (erro.error && erro.error.code) || '' }));
    throw new ErroHttp(502, `O Outlook não respondeu como esperado (${(erro.error && erro.error.code) || r.status}).`);
  }
  return r.status === 204 ? {} : r.json();
}

/* --- Disponibilidade: só períodos ocupados, sem assunto nem detalhes --- */

async function disponibilidade(env, utilizador, inicio, fim) {
  validarHorario(inicio, fim);
  const modo = modoCalendario(env, utilizador.email);
  if (modo === 'desligado') return { modo, ocupados: [], conflito: false };
  let ocupados;
  if (modo === 'simulacao') {
    // Simulação: um compromisso fictício diário das 13:00 às 14:00 (Lisboa)
    const dia = new Date(inicio);
    const base = Date.UTC(dia.getUTCFullYear(), dia.getUTCMonth(), dia.getUTCDate(), 13);
    const i = base - desvioLisboaHoras(base) * 36e5;
    ocupados = [{ inicio: i, fim: i + 36e5, estado: 'busy' }];
  } else {
    const margem = 4 * 36e5;
    const r = await graph(env, utilizador.email, 'POST', '/me/calendar/getSchedule', {
      schedules: [utilizador.email],
      startTime: { dateTime: new Date(inicio - margem).toISOString().replace('Z', ''), timeZone: 'UTC' },
      endTime: { dateTime: new Date(fim + margem).toISOString().replace('Z', ''), timeZone: 'UTC' },
      availabilityViewInterval: 15,
    });
    const itens = ((r.value && r.value[0] && r.value[0].scheduleItems) || []);
    ocupados = itens.filter((x) => x.status && x.status !== 'free').map((x) => ({
      inicio: Date.parse(x.start.dateTime + 'Z'), fim: Date.parse(x.end.dateTime + 'Z'), estado: x.status,
    }));
  }
  const conflito = ocupados.some((o) => o.inicio < fim && o.fim > inicio);
  return { modo, ocupados, conflito };
}

/* --- Eventos Outlook ligados às reuniões HubSpot (mapa em KV, sem propriedades novas no HubSpot) --- */

async function lerMapa(env, reuniaoId) {
  return env.REUNIOES_KV ? env.REUNIOES_KV.get(`map:${reuniaoId}`, 'json') : null;
}

async function guardarMapa(env, utilizador, reuniaoId, mapa) {
  if (!env.REUNIOES_KV) return;
  await env.REUNIOES_KV.put(`map:${reuniaoId}`, JSON.stringify(mapa));
  const chave = `mapdono:${utilizador.ownerId}`;
  const lista = (await env.REUNIOES_KV.get(chave, 'json')) || [];
  const nova = [{ r: String(reuniaoId), i: mapa.inicio }, ...lista.filter((x) => x.r !== String(reuniaoId))].slice(0, 300);
  await env.REUNIOES_KV.put(chave, JSON.stringify(nova));
}

async function criarEventoOutlook(env, utilizador, reuniao, convidados, chave) {
  const modo = modoCalendario(env, utilizador.email);
  if (modo === 'desligado') return { estado: 'desligado' };
  const existente = await lerMapa(env, reuniao.id);
  if (existente && existente.evento) return { estado: existente.modo === 'simulacao' ? 'simulado' : 'criado', ligacao: existente.ligacao || '', repetido: true };
  const online = reuniao.modalidade === 'online';
  let evento;
  try {
    if (modo === 'simulacao') {
      evento = { id: 'SIMULADO-' + aleatorio(9), onlineMeeting: online ? { joinUrl: 'https://teams.microsoft.com/l/meetup-join/SIMULACAO' } : null };
    } else {
      evento = await graph(env, utilizador.email, 'POST', '/me/events', {
        subject: reuniao.titulo,
        // O convite NÃO leva as notas internas (tipologia, orçamento, observações)
        body: { contentType: 'text', content: 'Reunião FERCOPOR. Em caso de impedimento, contacte o seu coordenador.' },
        start: { dateTime: new Date(reuniao.inicio).toISOString().replace('Z', ''), timeZone: 'UTC' },
        end: { dateTime: new Date(reuniao.fim).toISOString().replace('Z', ''), timeZone: 'UTC' },
        location: reuniao.local ? { displayName: reuniao.local } : undefined,
        attendees: convidados.map((c) => ({ emailAddress: { address: c.email, name: c.nome }, type: 'required' })),
        isOnlineMeeting: online,
        onlineMeetingProvider: online ? 'teamsForBusiness' : undefined,
        transactionId: chave,   // a Microsoft não cria um 2.º evento se o pedido for repetido
        singleValueExtendedProperties: [{ id: PROP_HUBSPOT, value: String(reuniao.id) }],
      });
    }
  } catch (e) {
    await guardarMapa(env, utilizador, reuniao.id, { estado: 'falhou', modo, inicio: reuniao.inicio, erro: e.message, quando: Date.now() });
    await auditar(env, utilizador, 'outlook.criar_falhou', reuniao.id, {});
    return { estado: 'falhou', erro: e.message };
  }
  const ligacao = (evento.onlineMeeting && evento.onlineMeeting.joinUrl) || '';
  await guardarMapa(env, utilizador, reuniao.id, {
    evento: evento.id, modo, inicio: reuniao.inicio, ligacao, convidados: convidados.length, quando: Date.now(),
  });
  await auditar(env, utilizador, 'outlook.criar', reuniao.id, { modo, convidados: convidados.length, online });
  return { estado: modo === 'simulacao' ? 'simulado' : 'criado', ligacao };
}

async function reprogramarEventoOutlook(env, utilizador, reuniaoId, inicio, fim) {
  const mapa = await lerMapa(env, reuniaoId);
  if (!mapa || !mapa.evento) return { estado: 'sem_evento' };
  const modo = modoCalendario(env, utilizador.email);
  if (modo === 'desligado') return { estado: 'desligado' };
  try {
    if (mapa.modo === 'real' && modo === 'real') {
      await graph(env, utilizador.email, 'PATCH', `/me/events/${encodeURIComponent(mapa.evento)}`, {
        start: { dateTime: new Date(inicio).toISOString().replace('Z', ''), timeZone: 'UTC' },
        end: { dateTime: new Date(fim).toISOString().replace('Z', ''), timeZone: 'UTC' },
      });
    }
  } catch (e) {
    await auditar(env, utilizador, 'outlook.reprogramar_falhou', reuniaoId, {});
    return { estado: 'falhou', erro: e.message };
  }
  await guardarMapa(env, utilizador, reuniaoId, { ...mapa, inicio, reprogramado: Date.now() });
  await auditar(env, utilizador, 'outlook.reprogramar', reuniaoId, { modo: mapa.modo });
  return { estado: mapa.modo === 'simulacao' ? 'simulado' : 'atualizado' };
}

// Possíveis duplicados: reunião criada pela app (com evento Outlook) + reunião que a sincronização
// HubSpot ↔ Outlook criou a partir desse evento (BIDIRECTIONAL_SYNC), à mesma hora e do mesmo dono.
async function marcarDuplicados(env, utilizador, reunioes) {
  if (!env.REUNIOES_KV || !reunioes.length) return reunioes;
  const nossos = (await env.REUNIOES_KV.get(`mapdono:${utilizador.ownerId}`, 'json')) || [];
  if (!nossos.length) return reunioes;
  const ids = new Set(nossos.map((x) => x.r));
  return reunioes.map((m) => {
    const sincronizada = m.origem === 'BIDIRECTIONAL_SYNC';
    const par = reunioes.find((o) => o.id !== m.id && Math.abs(o.inicio - m.inicio) < 2 * 6e4
      && (sincronizada ? ids.has(o.id) : (ids.has(m.id) && o.origem === 'BIDIRECTIONAL_SYNC')));
    return par ? { ...m, possivelDuplicado: par.id } : m;
  });
}

/* --- Cifra dos tokens de renovação (AES-GCM; chave própria ou derivada do SESSION_SECRET) --- */

async function chaveCifra(env) {
  const material = new TextEncoder().encode('fercopor-reunioes/calendario/v1|' + (env.CALENDAR_TOKEN_KEY || env.SESSION_SECRET));
  const bruto = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', bruto, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function cifrar(env, texto) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cifrado = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await chaveCifra(env), new TextEncoder().encode(texto));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(cifrado))}`;
}

async function decifrar(env, valor) {
  const [iv, dados] = String(valor).split('.');
  try {
    const claro = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytesBase64Url(iv) }, await chaveCifra(env), bytesBase64Url(dados));
    return new TextDecoder().decode(claro);
  } catch {
    throw new ErroHttp(409, 'A autorização do calendário não pôde ser lida (chave alterada). Ligue de novo o calendário.');
  }
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

export const _teste = { gerarTitulo, gerarNotas, papelDoContacto, validarNovaReuniao, juntarNotas, tratar, ErroHttp, marcarDuplicados };
