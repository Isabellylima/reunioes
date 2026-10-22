/* FERCOPOR Reuniões — interface (sem dependências externas).
   Todo o texto vindo do servidor é escapado antes de entrar no HTML. Sem estilos inline (CSP). */
(() => {
  'use strict';

  const TIPOS = ['Reunião Comercial', 'Reunião Follow Up', 'Reunião Parceiro', 'Reunião Parceiro c/ Cliente', 'Reunião Visita Obra'];
  const RESULTADOS = { SCHEDULED: 'Programados', COMPLETED: 'Concluído', RESCHEDULED: 'Reprogramado', NO_SHOW: 'Não compareceu', CANCELED: 'Cancelado' };
  const FINAIS = ['COMPLETED', 'RESCHEDULED', 'NO_SHOW', 'CANCELED'];
  const MODALIDADES = { presencial: 'Presencial', telefonica: 'Telefónica', online: 'Online' };
  const CLASSE_TIPO = {
    'Reunião Comercial': 'tipo-comercial', 'Reunião Follow Up': 'tipo-followup', 'Reunião Parceiro': 'tipo-parceiro',
    'Reunião Parceiro c/ Cliente': 'tipo-parceirocliente', 'Reunião Visita Obra': 'tipo-visita',
  };
  const H_INICIO = 8, H_FIM = 21, PX_HORA = 56;

  const conteudo = document.getElementById('conteudo');
  const estado = { eu: null, empreendimentos: [], semana: 0, vistaDia: null, separador: 'hoje', pendentes: null };

  /* ---------- Utilitários ---------- */
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (ms, op) => new Intl.DateTimeFormat('pt-PT', { timeZone: 'Europe/Lisbon', ...op }).format(new Date(ms));
  const hora = (ms) => fmt(ms, { hour: '2-digit', minute: '2-digit' });
  const diaLongo = (ms) => fmt(ms, { weekday: 'long', day: 'numeric', month: 'long' });
  const diaCurto = (ms) => fmt(ms, { weekday: 'short', day: 'numeric', month: 'short' });
  const maiuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const iniciais = (nome) => String(nome || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  const inicioDoDia = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const segundaDe = (d) => { const x = inicioDoDia(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const somarDias = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const doisDigitos = (n) => String(n).padStart(2, '0');
  const dataInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}`; };
  const horaInput = (ms) => { const d = new Date(ms); return `${doisDigitos(d.getHours())}:${doisDigitos(d.getMinutes())}`; };
  const paraIso = (data, h) => new Date(`${data}T${h}`).toISOString();
  const chaveNova = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2, 18));
  const podeEscrever = () => estado.eu && estado.eu.escritaAtiva;

  async function api(caminho, opcoes = {}) {
    const r = await fetch(caminho, {
      method: opcoes.method || 'GET',
      headers: { Accept: 'application/json', ...(opcoes.body ? { 'Content-Type': 'application/json' } : {}), ...(opcoes.headers || {}) },
      body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
      credentials: 'same-origin',
    });
    let dados = {};
    try { dados = await r.json(); } catch { /* resposta sem JSON */ }
    if (!r.ok) throw new Error(dados.erro || `Erro ${r.status}`);
    return dados;
  }

  let temporizadorMensagem;
  function mensagem(texto, erro = false) {
    const el = document.querySelector('[data-mensagem]');
    el.textContent = texto;
    el.classList.toggle('erro', erro);
    el.hidden = false;
    clearTimeout(temporizadorMensagem);
    temporizadorMensagem = setTimeout(() => { el.hidden = true; }, erro ? 6000 : 3500);
  }

  function chip(resultado) {
    const r = resultado && RESULTADOS[resultado] ? resultado : 'VAZIO';
    return `<span class="chip r-${r}">${esc(r === 'VAZIO' ? 'Sem resultado' : RESULTADOS[r])}</span>`;
  }

  function cartao(m) {
    const pendente = m.fim < Date.now() && (!m.resultado || m.resultado === 'SCHEDULED');
    const meta = [m.tipo || 'Sem tipo', MODALIDADES[m.modalidade]].filter(Boolean).join(' · ');
    return `<a class="cartao" href="#/reuniao/${esc(m.id)}">
      <div class="horas"><strong>${esc(hora(m.inicio))}</strong><span>${esc(hora(m.fim))}</span></div>
      <div class="corpo"><span class="titulo">${esc(m.titulo)}</span><span class="meta">${esc(meta)}</span>${pendente ? chip('') : chip(m.resultado)}</div>
    </a>`;
  }

  function agruparPorDia(reunioes) {
    const grupos = [];
    for (const m of reunioes) {
      const dia = maiuscula(diaLongo(m.inicio));
      let g = grupos.find((x) => x.dia === dia);
      if (!g) { g = { dia, itens: [] }; grupos.push(g); }
      g.itens.push(m);
    }
    return grupos;
  }

  function listaAgrupada(reunioes, vazio) {
    if (!reunioes.length) return `<p class="vazio">${esc(vazio)}</p>`;
    return agruparPorDia(reunioes).map((g) => `<h2 class="etiqueta-dia">${esc(g.dia)}</h2><div class="lista-reunioes">${g.itens.map(cartao).join('')}</div>`).join('');
  }

  async function reunioesEntre(de, ate) {
    const d = await api(`/api/reunioes?de=${encodeURIComponent(de.toISOString())}&ate=${encodeURIComponent(ate.toISOString())}`);
    return d.reunioes;
  }

  async function atualizarContadorPendentes() {
    try {
      const d = await api('/api/reunioes/por-classificar');
      estado.pendentes = d.reunioes.length;
    } catch { estado.pendentes = null; }
    const el = document.querySelector('[data-contador]');
    el.textContent = estado.pendentes || '';
    el.hidden = !estado.pendentes;
  }

  /* ---------- Ecrã: início ---------- */
  async function ecraInicio() {
    const hoje = inicioDoDia(new Date());
    const [doDia, proximas, pendentes] = await Promise.all([
      reunioesEntre(hoje, somarDias(hoje, 1)),
      reunioesEntre(somarDias(hoje, 1), somarDias(hoje, 15)),
      api('/api/reunioes/por-classificar').then((d) => d.reunioes),
    ]);
    const primeiroNome = String(estado.eu.nome || '').split(' ')[0];
    const saudacao = new Date().getHours() < 13 ? 'Bom dia' : (new Date().getHours() < 20 ? 'Boa tarde' : 'Boa noite');
    return `
      <div><h1 class="titulo-pagina">${esc(saudacao)}, ${esc(primeiroNome)}</h1><p class="subtitulo">${esc(maiuscula(diaLongo(Date.now())))}</p></div>
      <a class="botao botao-principal botao-grande" href="#/agendar">+ Agendar reunião</a>
      <div class="resumo">
        <a href="#/lista/hoje"><strong>${doDia.length}</strong><span>Hoje</span></a>
        <a href="#/lista/proximas"><strong>${proximas.length}</strong><span>Próximas</span></a>
        <a class="ambar" href="#/por-classificar"><strong>${pendentes.length}</strong><span>Por classificar</span></a>
      </div>
      <section class="lista-reunioes" aria-labelledby="t-hoje">
        <div class="cabecalho-seccao"><h2 id="t-hoje">Hoje</h2><a href="#/semana">Ver semana</a></div>
        ${doDia.length ? doDia.map(cartao).join('') : '<p class="vazio">Sem reuniões hoje.</p>'}
      </section>
      ${pendentes.length ? `<a class="faixa-ambar" href="#/por-classificar"><span><strong>${pendentes.length} ${pendentes.length === 1 ? 'reunião' : 'reuniões'} por classificar</strong>Já passaram e ainda não têm resultado</span><span aria-hidden="true">›</span></a>` : ''}
    `;
  }

  /* ---------- Ecrã: semana ---------- */
  async function ecraSemana() {
    const segunda = somarDias(segundaDe(new Date()), estado.semana * 7);
    const domingoFim = somarDias(segunda, 7);
    const reunioes = await reunioesEntre(segunda, domingoFim);
    const dias = Array.from({ length: 7 }, (_, i) => somarDias(segunda, i));
    const hojeTxt = inicioDoDia(new Date()).getTime();
    const titulo = `${fmt(segunda, { day: 'numeric', month: 'long' })} – ${fmt(somarDias(segunda, 6), { day: 'numeric', month: 'long', year: 'numeric' })}`;

    const barra = `<div class="barra-semana">
      <div class="navegar">
        <button type="button" class="botao quadrado" data-acao="semana-anterior" aria-label="Semana anterior">‹</button>
        <button type="button" class="botao quadrado" data-acao="semana-seguinte" aria-label="Semana seguinte">›</button>
        <button type="button" class="botao" data-acao="semana-atual">Hoje</button>
        <h1>${esc(titulo)}</h1>
      </div>
      <div class="grupo-vista" role="group" aria-label="Vista">
        <button type="button" data-acao="vista-dia" aria-pressed="${estado.vistaDia !== null}">Dia</button>
        <button type="button" data-acao="vista-semana" aria-pressed="${estado.vistaDia === null}">Semana</button>
      </div>
    </div>`;

    if (estado.vistaDia !== null) {
      const dia = dias[estado.vistaDia] || dias[0];
      const doDia = reunioes.filter((m) => inicioDoDia(m.inicio).getTime() === dia.getTime());
      const seletor = `<div class="separadores" role="tablist" aria-label="Dia">${dias.map((d, i) => `<button type="button" role="tab" data-acao="escolher-dia" data-indice="${i}" aria-selected="${i === estado.vistaDia}">${esc(maiuscula(diaCurto(d)))}</button>`).join('')}</div>`;
      return barra + seletor + `<div class="lista-reunioes">${doDia.length ? doDia.map(cartao).join('') : '<p class="vazio">Sem reuniões neste dia.</p>'}</div>`;
    }

    const cabecalhos = dias.map((d) => `<div class="cab-dia${d.getTime() === hojeTxt ? ' hoje' : ''}"><span>${esc(fmt(d, { weekday: 'short' }).replace('.', ''))}</span><strong>${d.getDate()}</strong></div>`).join('');
    const horas = Array.from({ length: H_FIM - H_INICIO }, (_, i) => `<span class="hora" data-topo="${i * PX_HORA + 4}">${doisDigitos(H_INICIO + i)}:00</span>`).join('');
    const colunas = dias.map((d) => {
      const evs = reunioes.filter((m) => inicioDoDia(m.inicio).getTime() === d.getTime()).map((m) => {
        const ini = new Date(m.inicio), fim = new Date(m.fim);
        const hIni = Math.max(ini.getHours() + ini.getMinutes() / 60, H_INICIO);
        const hFim = Math.min(fim.getHours() + fim.getMinutes() / 60 || 24, H_FIM);
        const topo = (hIni - H_INICIO) * PX_HORA + 2;
        const altura = Math.max((hFim - hIni) * PX_HORA - 4, 40);
        const pendente = m.fim < Date.now() && (!m.resultado || m.resultado === 'SCHEDULED');
        const quem = m.titulo.replace(/^FERCOPOR \| /, '');
        return `<a class="evento ${CLASSE_TIPO[m.tipo] || 'tipo-outro'}${pendente ? ' pendente' : ''}" href="#/reuniao/${esc(m.id)}" data-topo="${topo}" data-altura="${altura}">
          <strong>${esc(hora(m.inicio))}–${esc(hora(m.fim))}</strong><span>${esc(quem)}</span><small>${esc([m.tipo ? m.tipo.replace('Reunião ', '') : 'Sem tipo', MODALIDADES[m.modalidade]].filter(Boolean).join(' · '))}${pendente ? ' · por classificar' : ''}</small>
        </a>`;
      }).join('');
      return `<div class="coluna-dia${d.getTime() === hojeTxt ? ' hoje' : ''}">${evs}</div>`;
    }).join('');
    const legenda = `<div class="legenda">${TIPOS.map((t) => `<span class="${CLASSE_TIPO[t]}"><i></i>${esc(t)}</span>`).join('')}<span><i class="pendente-legenda"></i>Tracejado: por classificar</span></div>`;
    return barra + `<div class="calendario"><div class="grelha-semana"><div></div>${cabecalhos}<div class="coluna-horas">${horas}</div>${colunas}</div></div>` + legenda
      + `<p class="subtitulo">Mostra as reuniões do HubSpot entre as ${H_INICIO}:00 e as ${H_FIM}:00. Outros compromissos do Outlook não aparecem nesta fase.</p>`;
  }

  /* ---------- Ecrã: lista ---------- */
  async function ecraLista(separador) {
    if (separador) estado.separador = separador;
    const s = estado.separador;
    const hoje = inicioDoDia(new Date());
    let reunioes;
    if (s === 'hoje') reunioes = await reunioesEntre(hoje, somarDias(hoje, 1));
    else if (s === 'proximas') reunioes = (await reunioesEntre(new Date(), somarDias(hoje, 31)));
    else if (s === 'realizadas') reunioes = (await reunioesEntre(somarDias(hoje, -30), new Date())).filter((m) => FINAIS.includes(m.resultado)).reverse();
    else reunioes = (await api('/api/reunioes/por-classificar')).reunioes;
    const seps = [['hoje', 'Hoje'], ['proximas', 'Próximas'], ['realizadas', 'Realizadas'], ['atualizar', 'Por atualizar']];
    return `
      <div class="cabecalho-seccao"><h1 class="titulo-pagina">As minhas reuniões</h1><a class="botao botao-principal" href="#/agendar">+ Agendar</a></div>
      <div class="separadores" role="tablist" aria-label="Filtro">${seps.map(([id, t]) => `<button type="button" role="tab" data-acao="separador" data-id="${id}" aria-selected="${s === id}">${t}</button>`).join('')}</div>
      ${listaAgrupada(reunioes, 'Sem reuniões neste filtro.')}
    `;
  }

  /* ---------- Ecrã: agendar ---------- */
  let formulario = null;

  function novoFormulario() {
    const amanha = somarDias(inicioDoDia(new Date()), 1);
    amanha.setHours(10, 0, 0, 0);
    return {
      chave: chaveNova(), principal: null, cliente: null, comCliente: false,
      empreendimento: '', tipo: 'Reunião Comercial', tipoManual: false, modalidade: 'presencial',
      data: dataInput(amanha), inicio: '10:00', fim: '11:00', local: '', ligacao: '',
      tipologia: '', orcamento: '', observacoes: '', titulo: '', tituloManual: false, mais: false, aEnviar: false, feito: null,
    };
  }

  function tituloSugerido(f) {
    const emp = f.empreendimento || '[EMPREENDIMENTO]';
    if (!f.principal) return `FERCOPOR | ${emp} - [CONTACTO]`;
    if (f.principal.papel === 'parceiro') {
      return f.comCliente && f.cliente ? `FERCOPOR | ${emp} - Parceiro ${f.principal.nome} - ${f.cliente.nome}` : `FERCOPOR | ${emp} - Parceiro ${f.principal.nome}`;
    }
    return `FERCOPOR | ${emp} - ${f.principal.nome}`;
  }

  function sugerirTipo(f) {
    if (f.tipoManual || !f.principal) return;
    f.tipo = f.principal.papel === 'parceiro' ? (f.comCliente ? 'Reunião Parceiro c/ Cliente' : 'Reunião Parceiro') : 'Reunião Comercial';
  }

  function blocoContacto(f, qual) {
    const c = f[qual];
    const rotulo = qual === 'principal' ? 'Contacto ou parceiro' : 'Cliente apresentado';
    if (c) {
      return `<div class="contacto-escolhido"><span class="iniciais" aria-hidden="true">${esc(iniciais(c.nome))}</span>
        <span class="dados"><strong>${esc(c.nome)}</strong><span>${c.papel === 'parceiro' ? 'Parceiro · Mediador Imobiliário' : 'Cliente · ' + esc(c.tipoDeContacto || 'Contacto')}</span></span>
        <button type="button" class="botao-texto" data-acao="trocar-contacto" data-qual="${qual}">Trocar</button></div>`;
    }
    return `<label class="campo">${rotulo}
        <input type="search" autocomplete="off" placeholder="Nome ou e-mail (mín. 2 letras)" data-pesquisa="${qual}">
      </label>
      <div class="resultados-pesquisa" data-resultados="${qual}" hidden></div>`;
  }

  function ecraAgendar() {
    if (!formulario) formulario = novoFormulario();
    const f = formulario;
    if (f.feito) {
      const m = f.feito;
      return `<div class="detalhe">
          <h1>Reunião registada no HubSpot</h1>
          <div class="linhas"><span>${esc(m.titulo)}</span><span>${esc(maiuscula(diaLongo(m.inicio)))} · ${esc(hora(m.inicio))}–${esc(hora(m.fim))}</span><span>Resultado: Programados</span></div>
        </div>
        <a class="botao botao-principal botao-grande" href="#/inicio">Voltar ao início</a>
        <button type="button" class="botao" data-acao="agendar-outra">Agendar outra</button>`;
    }
    if (!f.tituloManual) f.titulo = tituloSugerido(f);
    const desativado = !podeEscrever();
    return `
      <a class="voltar" href="#/inicio">‹ Voltar</a>
      <h1 class="titulo-pagina">Agendar reunião</h1>
      ${desativado ? '<p class="nota">A escrita no HubSpot ainda não está autorizada. Pode preencher o formulário, mas não confirmar.</p>' : ''}
      <form class="formulario" data-formulario="agendar" novalidate>
        <fieldset><legend>Com quem?</legend>
          ${blocoContacto(f, 'principal')}
          <p class="subtitulo">Não encontra o contacto? Registe-o primeiro no HubSpot. A app não cria contactos.</p>
          ${f.principal && f.principal.papel === 'parceiro' ? `
            <label class="caixa-check"><input type="checkbox" data-campo="comCliente" ${f.comCliente ? 'checked' : ''}> Apresenta um cliente</label>
            ${f.comCliente ? blocoContacto(f, 'cliente') : ''}` : ''}
        </fieldset>

        <div class="grelha-2">
          <label class="campo">Empreendimento
            <select data-campo="empreendimento" required>
              <option value="">Escolher…</option>
              ${estado.empreendimentos.map((e) => `<option value="${esc(e)}" ${e === f.empreendimento ? 'selected' : ''}>${esc(e)}</option>`).join('')}
            </select>
          </label>
          <label class="campo">Tipo
            <select data-campo="tipo">${TIPOS.map((t) => `<option value="${esc(t)}" ${t === f.tipo ? 'selected' : ''}>${esc(t.replace('Reunião ', ''))}</option>`).join('')}</select>
          </label>
        </div>

        <fieldset><legend>Modalidade</legend>
          <div class="grelha-3">${Object.entries(MODALIDADES).map(([id, t]) => `<button type="button" class="botao opcao" data-acao="modalidade" data-id="${id}" aria-pressed="${f.modalidade === id}">${t}</button>`).join('')}</div>
          ${f.modalidade === 'presencial' ? `<label class="campo">Morada<input type="text" data-campo="local" value="${esc(f.local)}" maxlength="300" placeholder="Ex.: Showroom FERCOPOR"></label>` : ''}
          ${f.modalidade === 'telefonica' ? `<label class="campo">Telefone (opcional)<input type="tel" data-campo="local" value="${esc(f.local)}" maxlength="40"></label>` : ''}
          ${f.modalidade === 'online' ? `<label class="campo">Ligação Teams (colar)<input type="url" data-campo="ligacao" value="${esc(f.ligacao)}" maxlength="500" placeholder="https://teams.microsoft.com/…"><span class="ajuda">A criação automática da ligação Teams fica para uma fase seguinte.</span></label>` : ''}
        </fieldset>

        <div class="grelha-3">
          <label class="campo">Data<input type="date" data-campo="data" value="${esc(f.data)}" required></label>
          <label class="campo">Início<input type="time" data-campo="inicio" value="${esc(f.inicio)}" step="300" required></label>
          <label class="campo">Fim<input type="time" data-campo="fim" value="${esc(f.fim)}" step="300" required></label>
        </div>

        <button type="button" class="botao" data-acao="mais" aria-expanded="${f.mais}">${f.mais ? '−' : '+'} Mais detalhes (tipologia, orçamento, notas)</button>
        ${f.mais ? `<div class="grelha-2">
            <label class="campo">Tipologia<input type="text" data-campo="tipologia" value="${esc(f.tipologia)}" maxlength="40" placeholder="Ex.: T3"></label>
            <label class="campo">Orçamento<input type="text" data-campo="orcamento" value="${esc(f.orcamento)}" maxlength="60" placeholder="Ex.: 450 000 €"></label>
          </div>
          <label class="campo">Observações internas<textarea rows="3" data-campo="observacoes" maxlength="2000">${esc(f.observacoes)}</textarea></label>` : ''}

        <section class="pre-visualizacao" aria-label="Título no HubSpot">
          <span class="rotulo">Título no HubSpot</span>
          <label class="campo"><span class="so-leitor">Título</span><input type="text" data-campo="titulo" value="${esc(f.titulo)}" maxlength="200"></label>
          <span class="subtitulo">Empreendimento, tipologia e orçamento ficam também nas notas internas.</span>
        </section>

        <div class="rodape-fixo"><button type="submit" class="botao botao-principal botao-grande" ${desativado || f.aEnviar ? 'disabled' : ''}>${f.aEnviar ? 'A registar…' : 'Confirmar agendamento'}</button></div>
      </form>`;
  }

  let temporizadorPesquisa;
  async function pesquisar(qual, texto) {
    const caixa = conteudo.querySelector(`[data-resultados="${qual}"]`);
    if (!caixa) return;
    if (texto.trim().length < 2) { caixa.hidden = true; caixa.innerHTML = ''; return; }
    try {
      const { contactos } = await api(`/api/contactos?q=${encodeURIComponent(texto.trim())}`);
      const lista = qual === 'cliente' ? contactos.filter((c) => c.papel !== 'parceiro') : contactos;
      formulario._resultados = formulario._resultados || {};
      formulario._resultados[qual] = lista;
      caixa.innerHTML = lista.length
        ? lista.map((c, i) => `<button type="button" data-acao="escolher-contacto" data-qual="${qual}" data-indice="${i}"><strong>${esc(c.nome)}</strong><span class="subtitulo">${c.papel === 'parceiro' ? 'Parceiro' : 'Cliente'} · ${esc(c.email || c.tipoDeContacto)}</span></button>`).join('')
        : '<p class="vazio">Nenhum contacto encontrado. Registe-o primeiro no HubSpot.</p>';
      caixa.hidden = false;
    } catch (e) { mensagem(e.message, true); }
  }

  async function submeterAgendamento() {
    const f = formulario;
    if (!f.principal) return mensagem('Escolha o contacto ou parceiro.', true);
    if (f.comCliente && !f.cliente) return mensagem('Escolha o cliente apresentado ou desmarque a opção.', true);
    if (!f.empreendimento) return mensagem('Escolha o empreendimento.', true);
    if (!f.data || !f.inicio || !f.fim) return mensagem('Indique a data e as horas.', true);
    const inicio = paraIso(f.data, f.inicio), fim = paraIso(f.data, f.fim);
    if (Date.parse(fim) <= Date.parse(inicio)) return mensagem('A hora de fim tem de ser depois da hora de início.', true);
    f.aEnviar = true; desenhar();
    try {
      const corpo = {
        contactoId: f.principal.id, clienteId: f.comCliente && f.cliente ? f.cliente.id : null,
        empreendimento: f.empreendimento, tipo: f.tipo, modalidade: f.modalidade, inicio, fim,
        local: f.modalidade === 'online' ? '' : f.local, ligacao: f.modalidade === 'online' ? f.ligacao : '',
        tipologia: f.tipologia, orcamento: f.orcamento, observacoes: f.observacoes,
        titulo: f.tituloManual ? f.titulo : '',
      };
      const { reuniao } = await api('/api/reunioes', { method: 'POST', body: corpo, headers: { 'Idempotency-Key': f.chave } });
      f.feito = reuniao;
      mensagem('Reunião registada no HubSpot.');
      atualizarContadorPendentes();
    } catch (e) {
      mensagem(e.message, true);   // a mesma chave é reutilizada numa nova tentativa: não duplica
    } finally {
      f.aEnviar = false; desenhar();
    }
  }

  /* ---------- Ecrã: reunião (resultado e reprogramação) ---------- */
  let detalhe = null;

  async function ecraReuniao(id) {
    if (!detalhe || detalhe.id !== id) {
      const { reuniao } = await api(`/api/reunioes/${encodeURIComponent(id)}`);
      detalhe = { id, reuniao, escolhido: FINAIS.includes(reuniao.resultado) ? reuniao.resultado : '', observacao: '', reprogramar: false };
    }
    const m = detalhe.reuniao;
    const contactos = m.contactos.length ? m.contactos.map((c) => `${c.nome} (${c.papel === 'parceiro' ? 'parceiro' : 'cliente'})`).join(' · ') : 'Sem contactos associados';
    const desativado = !podeEscrever();
    return `
      <a class="voltar" href="#/lista">‹ Voltar</a>
      <section class="detalhe">
        <span class="tipo">${esc(m.tipo || 'Sem tipo')}</span>
        <h1>${esc(m.titulo)}</h1>
        <div class="linhas">
          <span>${esc(maiuscula(diaLongo(m.inicio)))} · ${esc(hora(m.inicio))}–${esc(hora(m.fim))}</span>
          <span>${esc([MODALIDADES[m.modalidade], m.local].filter(Boolean).join(' · ') || 'Modalidade não indicada')}</span>
          ${m.ligacao ? `<span><a href="${esc(m.ligacao)}" target="_blank" rel="noopener noreferrer">Abrir ligação da reunião</a></span>` : ''}
          <span>${esc(contactos)}</span>
          <span>Resultado atual: ${chip(m.resultado)}</span>
        </div>
        <button type="button" class="botao-texto" data-acao="abrir-reprogramar" aria-expanded="${detalhe.reprogramar}" ${desativado ? 'disabled' : ''}>Alterar data ou hora</button>
        ${detalhe.reprogramar ? `<form class="formulario" data-formulario="reprogramar">
            <div class="grelha-3">
              <label class="campo">Data<input type="date" name="data" value="${esc(dataInput(m.inicio))}" required></label>
              <label class="campo">Início<input type="time" name="inicio" value="${esc(horaInput(m.inicio))}" step="300" required></label>
              <label class="campo">Fim<input type="time" name="fim" value="${esc(horaInput(m.fim))}" step="300" required></label>
            </div>
            <p class="nota">Atualiza esta mesma reunião. O resultado não muda para «Reprogramado» e o Outlook não é alterado nesta fase.</p>
            <button type="submit" class="botao botao-principal">Guardar nova data</button>
          </form>` : ''}
        ${m.notas ? `<pre class="notas">${esc(m.notas)}</pre>` : ''}
      </section>

      <form class="formulario" data-formulario="resultado">
        <fieldset><legend>Resultado</legend>
          <div class="resultados">${FINAIS.map((r) => `<button type="button" class="botao opcao" data-acao="escolher-resultado" data-id="${r}" aria-pressed="${detalhe.escolhido === r}"><span class="ponto p-${r}" aria-hidden="true"></span>${RESULTADOS[r]}</button>`).join('')}</div>
          ${detalhe.escolhido === 'CANCELED' ? '<p class="nota">A reunião fica no HubSpot como «Cancelado». Não é eliminada, o evento no Outlook não é cancelado e o participante não é avisado automaticamente.</p>' : ''}
        </fieldset>
        <label class="campo">Observação<textarea rows="4" data-campo-detalhe="observacao" maxlength="2000" placeholder="Ex.: cliente interessado no T3, pediu nova visita">${esc(detalhe.observacao)}</textarea>
          <span class="ajuda">Acrescentada às notas internas com data e autor. As notas anteriores mantêm-se.</span></label>
        <div class="rodape-fixo"><button type="submit" class="botao botao-principal botao-grande" ${desativado || !detalhe.escolhido ? 'disabled' : ''}>Guardar resultado</button></div>
      </form>`;
  }

  async function guardarResultado(id, resultado, observacao) {
    const { reuniao } = await api(`/api/reunioes/${encodeURIComponent(id)}/resultado`, { method: 'POST', body: { resultado, observacao } });
    return reuniao;
  }

  /* ---------- Ecrã: por classificar ---------- */
  let classificadas = {};

  async function ecraPorClassificar() {
    const { reunioes } = await api('/api/reunioes/por-classificar');
    const restantes = reunioes.filter((m) => !classificadas[m.id]).length;
    const resumo = restantes === 0 ? 'Tudo classificado. Obrigado!' : `${restantes} ${restantes === 1 ? 'reunião já passou e não tem' : 'reuniões já passaram e não têm'} resultado.`;
    const desativado = !podeEscrever();
    const lista = [...Object.values(classificadas).filter((c) => !reunioes.some((m) => m.id === c.id)), ...reunioes];
    return `
      <div><h1 class="titulo-pagina">Por classificar</h1><p class="subtitulo">${esc(resumo)}</p></div>
      ${lista.map((m) => {
        const feito = classificadas[m.id];
        return `<article class="classificar">
          <div class="topo-cartao"><span class="quando">${esc(maiuscula(diaCurto(m.inicio)))} · ${esc(hora(m.inicio))}</span><span class="tipo">${esc(m.tipo || 'Sem tipo')}</span></div>
          <h2><a href="#/reuniao/${esc(m.id)}">${esc(m.titulo)}</a></h2>
          ${feito
            ? `<div class="feito">${chip(feito.resultado)}<button type="button" class="botao-texto" data-acao="anular" data-id="${esc(m.id)}" ${desativado ? 'disabled' : ''}>Anular</button></div>`
            : `<div class="acoes">${['COMPLETED', 'NO_SHOW', 'RESCHEDULED', 'CANCELED'].map((r) => `<button type="button" class="t-${r}" data-acao="classificar" data-id="${esc(m.id)}" data-resultado="${r}" ${desativado ? 'disabled' : ''}>${RESULTADOS[r]}</button>`).join('')}</div>`}
        </article>`;
      }).join('') || '<p class="vazio">Não há reuniões por classificar.</p>'}
      <p class="subtitulo">Reuniões dos últimos 90 dias já terminadas, com resultado vazio ou «Programados». É apenas um filtro: nada novo é criado no HubSpot.</p>`;
  }

  /* ---------- Ecrã: administração de utilizadores ---------- */
  let admin = null;

  async function ecraAdmin() {
    if (!estado.eu.admin) return '<p class="vazio">Só administradores.</p>';
    if (!admin) admin = (await api('/api/admin/utilizadores')).utilizadores;
    return `
      <h1 class="titulo-pagina">Utilizadores autorizados</h1>
      <p class="subtitulo">Só entram contas @fercopor.pt desta lista que correspondam a um utilizador ativo do HubSpot. Os administradores definidos no Cloudflare (ADMIN_EMAILS) entram sempre.</p>
      <div class="caixa-tabela"><table class="tabela">
        <thead><tr><th scope="col">E-mail</th><th scope="col">Administrador</th><th scope="col"><span class="so-leitor">Ações</span></th></tr></thead>
        <tbody>${admin.map((u, i) => `<tr><td>${esc(u.email)}</td>
          <td><input type="checkbox" aria-label="Administrador ${esc(u.email)}" data-acao="admin-flag" data-indice="${i}" ${u.admin ? 'checked' : ''}></td>
          <td><button type="button" class="botao-texto" data-acao="admin-remover" data-indice="${i}">Retirar</button></td></tr>`).join('') || '<tr><td colspan="3">Lista vazia.</td></tr>'}</tbody>
      </table></div>
      <form class="formulario" data-formulario="admin-adicionar">
        <label class="campo">Acrescentar e-mail<input type="email" name="email" placeholder="nome@fercopor.pt" required></label>
        <div class="grelha-2"><button type="submit" class="botao">Acrescentar</button><button type="button" class="botao botao-principal" data-acao="admin-guardar">Guardar lista</button></div>
      </form>`;
  }

  /* ---------- Encaminhamento e desenho ---------- */
  function rotaAtual() {
    const partes = (location.hash.replace(/^#\/?/, '') || 'inicio').split('/');
    return { nome: partes[0], arg: partes[1] };
  }

  let pedidoDesenho = 0;
  async function desenhar() {
    const { nome, arg } = rotaAtual();
    const meu = ++pedidoDesenho;
    document.querySelectorAll('[data-rota]').forEach((a) => a.classList.toggle('ativo', a.dataset.rota === (nome === 'reuniao' ? 'lista' : nome)));
    conteudo.classList.toggle('estreito', !['semana', 'admin'].includes(nome));
    try {
      let html;
      if (nome === 'semana') html = await ecraSemana();
      else if (nome === 'lista') html = await ecraLista(arg);
      else if (nome === 'agendar') html = ecraAgendar();
      else if (nome === 'reuniao' && arg) html = await ecraReuniao(arg);
      else if (nome === 'por-classificar') html = await ecraPorClassificar();
      else if (nome === 'admin') html = await ecraAdmin();
      else html = await ecraInicio();
      if (meu !== pedidoDesenho) return;   // houve outra navegação entretanto
      const foco = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.campo : null;
      conteudo.innerHTML = html;
      posicionar();
      if (foco) { const el = conteudo.querySelector(`[data-campo="${foco}"]`); if (el) el.focus(); }
    } catch (e) {
      if (meu !== pedidoDesenho) return;
      conteudo.innerHTML = `<p class="vazio">${esc(e.message)}</p>`;
    }
  }

  function posicionar() {
    // Posições do calendário aplicadas via CSSOM (permitido pela CSP, ao contrário de style="" no HTML)
    conteudo.querySelectorAll('[data-topo]').forEach((el) => { el.style.top = el.dataset.topo + 'px'; });
    conteudo.querySelectorAll('[data-altura]').forEach((el) => { el.style.height = el.dataset.altura + 'px'; });
  }

  /* ---------- Eventos ---------- */
  conteudo.addEventListener('click', async (ev) => {
    const alvo = ev.target.closest('[data-acao]');
    if (!alvo) return;
    const acao = alvo.dataset.acao;
    const f = formulario;
    try {
      switch (acao) {
        case 'semana-anterior': estado.semana--; return desenhar();
        case 'semana-seguinte': estado.semana++; return desenhar();
        case 'semana-atual': estado.semana = 0; return desenhar();
        case 'vista-dia': estado.vistaDia = (new Date().getDay() + 6) % 7; return desenhar();
        case 'vista-semana': estado.vistaDia = null; return desenhar();
        case 'escolher-dia': estado.vistaDia = Number(alvo.dataset.indice); return desenhar();
        case 'separador': location.hash = `#/lista/${alvo.dataset.id}`; return;
        case 'modalidade': f.modalidade = alvo.dataset.id; f.local = ''; f.ligacao = ''; return desenhar();
        case 'mais': f.mais = !f.mais; return desenhar();
        case 'trocar-contacto': f[alvo.dataset.qual] = null; if (alvo.dataset.qual === 'principal') { f.cliente = null; f.comCliente = false; } sugerirTipo(f); return desenhar();
        case 'escolher-contacto': {
          const c = f._resultados[alvo.dataset.qual][Number(alvo.dataset.indice)];
          f[alvo.dataset.qual] = c;
          if (alvo.dataset.qual === 'principal' && c.papel !== 'parceiro') { f.comCliente = false; f.cliente = null; }
          sugerirTipo(f); return desenhar();
        }
        case 'agendar-outra': formulario = novoFormulario(); return desenhar();
        case 'abrir-reprogramar': detalhe.reprogramar = !detalhe.reprogramar; return desenhar();
        case 'escolher-resultado': detalhe.escolhido = alvo.dataset.id; return desenhar();
        case 'classificar': {
          alvo.disabled = true;
          const r = await guardarResultado(alvo.dataset.id, alvo.dataset.resultado, '');
          classificadas[r.id] = r;
          mensagem(`Guardado: ${RESULTADOS[r.resultado]}`);
          atualizarContadorPendentes();
          return desenhar();
        }
        case 'anular': {
          await guardarResultado(alvo.dataset.id, 'SCHEDULED', 'Resultado anulado na app');
          delete classificadas[alvo.dataset.id];
          atualizarContadorPendentes();
          return desenhar();
        }
        case 'admin-flag': admin[Number(alvo.dataset.indice)].admin = alvo.checked; return;
        case 'admin-remover': admin.splice(Number(alvo.dataset.indice), 1); return desenhar();
        case 'admin-guardar': admin = (await api('/api/admin/utilizadores', { method: 'PUT', body: { utilizadores: admin } })).utilizadores; mensagem('Lista guardada.'); return desenhar();
        default: return;
      }
    } catch (e) {
      mensagem(e.message, true);
      if (acao === 'classificar') alvo.disabled = false;
    }
  });

  conteudo.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.dataset.pesquisa) {
      clearTimeout(temporizadorPesquisa);
      temporizadorPesquisa = setTimeout(() => pesquisar(el.dataset.pesquisa, el.value), 300);
      return;
    }
    if (el.dataset.campoDetalhe && detalhe) { detalhe[el.dataset.campoDetalhe] = el.value; return; }
    const campo = el.dataset.campo;
    if (!campo || !formulario) return;
    if (campo === 'titulo') { formulario.titulo = el.value; formulario.tituloManual = true; return; }
    if (el.type !== 'checkbox' && el.tagName !== 'SELECT') formulario[campo] = el.value;
  });

  conteudo.addEventListener('change', (ev) => {
    const el = ev.target;
    const campo = el.dataset.campo;
    if (!campo || !formulario) return;
    if (campo === 'comCliente') { formulario.comCliente = el.checked; if (!el.checked) formulario.cliente = null; sugerirTipo(formulario); return desenhar(); }
    if (campo === 'tipo') { formulario.tipo = el.value; formulario.tipoManual = true; return; }
    if (campo === 'empreendimento') { formulario.empreendimento = el.value; return desenhar(); }
    if (campo === 'inicio' && formulario.fim <= el.value) {
      const [h, m] = el.value.split(':').map(Number);
      formulario.inicio = el.value;
      formulario.fim = `${doisDigitos(Math.min(h + 1, 23))}:${doisDigitos(m)}`;
      return desenhar();
    }
  });

  conteudo.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const tipo = form.dataset.formulario;
    try {
      if (tipo === 'agendar') return submeterAgendamento();
      if (tipo === 'resultado') {
        const r = await guardarResultado(detalhe.id, detalhe.escolhido, detalhe.observacao);
        detalhe = { ...detalhe, reuniao: r, observacao: '' };
        mensagem(`Resultado guardado no HubSpot: ${RESULTADOS[r.resultado]}`);
        atualizarContadorPendentes();
        return desenhar();
      }
      if (tipo === 'reprogramar') {
        const dados = new FormData(form);
        const inicio = paraIso(dados.get('data'), dados.get('inicio'));
        const fim = paraIso(dados.get('data'), dados.get('fim'));
        const { reuniao } = await api(`/api/reunioes/${encodeURIComponent(detalhe.id)}`, { method: 'PATCH', body: { inicio, fim } });
        detalhe = { ...detalhe, reuniao, reprogramar: false };
        mensagem('Data e hora atualizadas.');
        return desenhar();
      }
      if (tipo === 'admin-adicionar') {
        const email = String(new FormData(form).get('email') || '').trim().toLowerCase();
        if (!email.endsWith('@fercopor.pt')) return mensagem('Só contas @fercopor.pt.', true);
        if (!admin.some((u) => u.email === email)) admin.push({ email, admin: false });
        return desenhar();
      }
    } catch (e) { mensagem(e.message, true); }
  });

  window.addEventListener('hashchange', () => {
    if (!location.hash.startsWith('#/reuniao/')) detalhe = null;
    if (!location.hash.startsWith('#/agendar') && formulario && formulario.feito) formulario = null;
    if (!location.hash.startsWith('#/por-classificar')) classificadas = {};
    desenhar();
    conteudo.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });

  /* ---------- Arranque ---------- */
  (async () => {
    try {
      estado.eu = await api('/api/me');
      document.querySelector('[data-avatar]').textContent = iniciais(estado.eu.nome);
      document.querySelectorAll('[data-so-admin]').forEach((el) => { el.hidden = !estado.eu.admin; });
      const aviso = document.querySelector('[data-aviso]');
      if (estado.eu.modo === 'demo') { aviso.textContent = 'Modo de demonstração: dados fictícios, nada é gravado no HubSpot.'; aviso.hidden = false; }
      else if (!estado.eu.escritaAtiva) { aviso.textContent = 'Só leitura: a escrita no HubSpot ainda não está autorizada.'; aviso.hidden = false; }
      estado.empreendimentos = (await api('/api/empreendimentos')).empreendimentos;
      atualizarContadorPendentes();
      desenhar();
    } catch (e) {
      conteudo.innerHTML = `<p class="vazio">${esc(e.message)}</p>`;
    }
  })();
})();
