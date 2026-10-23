# FERCOPOR Reuniões: publicar no Cloudflare

Esta pasta tem:
- `site/`: o que se carrega no Cloudflare (a app e o `_worker.js`, que protege tudo e fala com o HubSpot).
- `tests/`: testes automáticos do servidor (`node --test tests/`). Não carregar.
- `GUIA-CLOUDFLARE.md`: este guia. Não carregar.

## Como funciona e como fica protegido

- **Entrada com Microsoft 365.** A app mostra o seu ecrã «Iniciar sessão» e o login é feito na Microsoft (Entra ID). O servidor valida a sessão (assinatura, emissor, audiência, validade) e só aceita contas `@fercopor.pt`.
- **Lista de autorizados.** Só entram as pessoas da lista (gerida na app, menu «Utilizadores») e as indicadas em `ADMIN_EMAILS`. Cada uma tem de corresponder a um utilizador **ativo** do HubSpot.
- **Cada pessoa só vê e altera as suas reuniões.** O servidor verifica-o em cada pedido. Uma reunião de outra pessoa responde «não encontrada».
- **HubSpot.** A chave fica guardada como segredo no Cloudflare e nunca chega ao browser.
- **Escrita no HubSpot desligada por omissão.** Enquanto `HUBSPOT_WRITE_ENABLED` não for `true`, a app só lê: não cria, não reprograma, não muda resultados.
- **Modo demonstração.** Sem `HUBSPOT_TOKEN`, a app usa dados fictícios em memória e não toca no HubSpot.
- **Cabeçalhos de segurança:** a página não pode ser embutida, não é indexada e só carrega código do próprio site.

## Fase atual (2026-10-22): demonstração

Autorizado: desenvolvimento e testes de leitura. **Não** autorizado: escrever no HubSpot. Publique primeiro **sem** `HUBSPOT_TOKEN` (modo demo).

## Passo 1: carregar o site

1. Cloudflare › **Workers & Pages → Create → Pages → Upload assets**.
2. Nome do projeto, por exemplo `fercopor-reunioes`.
3. Arraste a pasta **`site`**, a que contém o `index.html` e o `_worker.js`.
4. **Deploy**. Até ao Passo 4 o site responde «Configuração em falta». É o comportamento esperado.

## Alternativa: Worker ligado ao GitHub (ex.: `reunioes.<conta>.workers.dev`)

Se o projeto foi criado em **Workers** (e não em Pages), o repositório já inclui o `wrangler.jsonc`, que indica o servidor (`site/_worker.js`) e a pasta da app (`site`). O `site/.assetsignore` impede que o código do servidor seja servido como ficheiro.
- **Settings → Build:** comando de compilação vazio; comando de publicação `npx wrangler deploy` (o habitual); pasta raiz `/`.
- **Variáveis e segredos:** em Settings → Variables and Secrets. O `keep_vars` mantém-nos entre publicações.
- **KV:** crie o namespace e acrescente o seu **id** ao `wrangler.jsonc` (`kv_namespaces`). Uma ligação criada só no painel é retirada na publicação seguinte.
- **Access:** a aplicação Self-hosted usa o domínio `reunioes.<conta>.workers.dev`.

## Passo 2: armazenamento (KV)

1. **Workers & Pages → KV → Create namespace**: `fercopor-reunioes`.
2. No projeto: **Settings → Bindings → Add → KV namespace**. Nome da variável: `REUNIOES_KV`. Namespace: `fercopor-reunioes`.

Guarda a lista de utilizadores, as chaves anti-duplicação (7 dias) e o registo de auditoria (400 dias).

## Passo 3: entrada com Microsoft 365 (Cloudflare Access)

Precisa da TI para o registo no Microsoft Entra ID. É **só para login**: não dá acesso a calendários nem a e-mail.

1. **Entra ID** (TI): App registrations → New registration → «FERCOPOR Reuniões (login)», só esta organização.
   - Redirect URI: `https://<equipa>.cloudflareaccess.com/cdn-cgi/access/callback`.
   - Criar um *client secret*.
   - Permissões delegadas `openid`, `email`, `profile`.
2. **Cloudflare Zero Trust** › Settings › Authentication › **Add new → Azure AD**: colar o Application (client) ID, o secret e o Directory (tenant) ID.
3. Zero Trust › Access › Applications › **Add → Self-hosted**:
   - domínio `fercopor-reunioes.pages.dev` (ou o subdomínio da empresa);
   - política «Allow», regra **Emails ending in** `@fercopor.pt`;
   - fornecedor de identidade: só o Azure AD.
4. Copie o **Application Audience (AUD) Tag** da aplicação.

## Passo 4: variáveis

Projeto › **Settings → Variables and Secrets** (Production):

| Nome | Tipo | Valor |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | Text | `<equipa>.cloudflareaccess.com` |
| `ACCESS_AUD` | Text | o AUD Tag do Passo 3 |
| `ADMIN_EMAILS` | Text | o e-mail de quem administra a app (separar por vírgulas) |

Só para pré-visualizar **sem** Access, no modo demo, pode usar `DEMO_USER_EMAIL` (o seu e-mail `@fercopor.pt`). **Apague-a** quando o Access estiver ativo.

As variáveis só entram em vigor no deployment seguinte: **Deployments → Create deployment** e arraste de novo a pasta `site`.

## Passo 5: utilizadores

Entre como administrador e abra **Utilizadores**. Acrescente os e-mails autorizados (lista na documentação interna do projeto, SPEC `app-reunioes` §1) e guarde.

Retirar uma pessoa tem efeito imediato.

## Login principal: «Iniciar sessão com Microsoft» (Entra ID)

A app faz o login Microsoft sozinha (OpenID Connect com PKCE). Pede **apenas** `openid profile email`: não acede ao calendário nem ao e-mail. A sessão fica num cookie assinado (`HttpOnly`, `Secure`) e o segredo da aplicação só existe no Cloudflare.

### 1. Registar a aplicação (Entra ID, pela TI ou por quem tiver permissão)
1. https://entra.microsoft.com → **Identity → Applications → App registrations → New registration**.
2. Nome «FERCOPOR Reuniões». **Supported account types:** *Accounts in this organizational directory only* (single tenant).
3. **Redirect URI:** plataforma **Web**, endereço `https://reunioes.fercopor.workers.dev/auth/retorno`. Se a app passar para um subdomínio próprio, acrescentar também esse endereço.
4. Depois de criar, copiar:
   - **Application (client) ID** → `ENTRA_CLIENT_ID`;
   - **Directory (tenant) ID** → `ENTRA_TENANT_ID`.
5. **Certificates & secrets → New client secret** (validade de 12 ou 24 meses; anotar a data de renovação) → copiar o **Value** → `ENTRA_CLIENT_SECRET`.
6. **API permissions:** deixar só `Microsoft Graph → openid, profile, email` (delegadas). Se estiver lá o `User.Read`, pode ficar; não é usado.
7. Opcional, recomendado: **Grant admin consent for FERCOPOR**, para ninguém ver o ecrã de consentimento.

### 2. Variáveis no Worker (Settings → Variables and Secrets)
| Nome (aceite também com `ENTRA_` em vez de `MICROSOFT_`) | Tipo | Valor |
|---|---|---|
| `MICROSOFT_TENANT_ID` | Text | Directory (tenant) ID (FERCOPOR: `756ee2a3-7dc0-460f-a266-cc6738c1bdd7`) |
| `MICROSOFT_CLIENT_ID` | Text | Application (client) ID |
| `MICROSOFT_CLIENT_SECRET` | **Secret** | o **Value** do client secret (não o «Secret ID») |
| `SESSION_SECRET` | Secret, opcional | texto aleatório com 40 ou mais caracteres. Se faltar, deriva-se do client secret: renovar o secret termina as sessões |
| `APP_URL` | Text, opcional | `https://reunioes.fercopor.workers.dev`. Se faltar, usa-se o endereço pelo qual a app foi aberta |

**Deploy.** O login atual (Cloudflare Access) continua a funcionar enquanto existir. Ninguém perde o acesso.

### 3. Só login Microsoft (feito a 2026-10-23)
- O `wrangler.jsonc` define `AUTH_MODE` = `entra`: o servidor só aceita a sessão Microsoft. A página de entrada (`/`) mostra o ecrã «Iniciar sessão» da app com o botão «Iniciar sessão com Microsoft».
- No Cloudflare, retire o Access do Worker: **Workers & Pages → reunioes → Access → Manage access → Remove Worker-specific Access**. Sem este passo, o Cloudflare continua a pedir o código por e-mail antes do ecrã da app.
- `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD` deixam de ser usados e podem ser apagados no painel.

### 4. Antes do corte: segredo de sessão próprio
Crie `SESSION_SECRET` (tipo **Secret**, 40 ou mais caracteres, gerado num gestor de palavras-passe; não o cole em conversas nem documentos). Com ele, as sessões deixam de depender do client secret da Microsoft. Criar ou mudar este valor termina as sessões abertas: todos voltam a iniciar sessão uma vez.

### 5. Recuperação se o login Microsoft deixar de funcionar
1. Abra `/auth/diagnostico` (com sessão) ou veja os **Logs** do Worker (`entra_troca_codigo_falhou`, com o código AADSTS).
2. **Causa mais comum: o client secret expirou.** Entra ID → Certificates & secrets → New client secret → atualizar `MICROSOFT_CLIENT_SECRET` → Deploy.
3. **Acesso de emergência:** retire `AUTH_MODE` do `wrangler.jsonc` (publicação a partir do GitHub), volte a ligar o Access do Worker (Access → Manage access → All traffic) e confirme que `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD` existem. O código aceita de novo o Access. Repor `AUTH_MODE` = `entra` quando o login Microsoft estiver corrigido.
4. Anote a data de expiração do client secret e renove-o um mês antes.

## Calendário Outlook e Teams (Microsoft Graph, permissões delegadas)

Cada coordenador liga o **seu** calendário na página inicial («Ligar o meu calendário Outlook»). É um consentimento separado do login.

### Permissões a acrescentar no Entra ID (API permissions → Add → Microsoft Graph → Delegated)
| Permissão | Para quê | Consentimento |
|---|---|---|
| `Calendars.ReadWrite` | Disponibilidade (`getSchedule`), criar e reprogramar eventos, convites aos participantes, ligação Teams (evento com `isOnlineMeeting`) | Delegada, sem consentimento obrigatório de administrador; a política do tenant pode exigir aprovação da TI |
| `offline_access` | Manter a ligação sem pedir novo login todos os dias | Baixo impacto |

Não são precisas `OnlineMeetings.ReadWrite`, `Mail.Send` nem permissões de **aplicação**. A app só atua no calendário de quem autorizou. Se a TI tiver de aprovar, a justificação é: «Delegada, por utilizador, só sobre o próprio calendário, para a app de reuniões criar e atualizar os eventos que o próprio agenda».

### Variáveis
| Nome | Tipo | Valor |
|---|---|---|
| `CALENDAR_MODE` | Text | `simulacao` para experimentar sem tocar no Outlook; `real` só depois da autorização do teste |
| `CALENDAR_TEST_EMAILS` | Text | Com `real`: os únicos utilizadores com Outlook real (ex.: o seu e-mail). Os outros ficam em simulação |
| `CALENDAR_TOKEN_KEY` | Secret, opcional | Chave própria para cifrar as autorizações guardadas. Se faltar, deriva-se do `SESSION_SECRET` |

Sem `CALENDAR_MODE`, o calendário está desligado e a app funciona como antes.

## Campos da reunião no HubSpot: Empreendimento, Tipologia e Orçamento

Ao agendar na app, a reunião criada no HubSpot fica com:
- **Empreendimento** (`empreendimento`, lista): o empreendimento escolhido. As opções da app vêm desta propriedade das reuniões; se não for possível lê-la, vêm de «Empreendimento (Negócio)».
- **Tipologia** (`tipologia`, lista): opcional, com as mesmas opções da propriedade no HubSpot. Uma opção nova no HubSpot aparece na app automaticamente.
- **Orçamento** (`orcamento`, número): opcional, em euros. A app aceita «450000», «450 000 €» ou «450.000».

Os três ficam também nas notas internas, como antes (`Empreendimento: …`, `Tipologia: …`, `Orçamento: 450 000 €`).

## Página inicial: lembretes e indicadores (só leitura)

O Início mostra, por esta ordem: boas-vindas, «+ Agendar reunião», resumo (Hoje, Próximas, Por classificar), Lembretes, Situação das Leads (só o Ruben), Meus Negócios e Reuniões realizadas. Tudo é lido do HubSpot pelo servidor (`/api/inicio`), sempre com o proprietário HubSpot da pessoa com sessão iniciada, e guardado 2 minutos por utilizador.

| Secção | Regra |
|---|---|
| Aniversários | contactos com `proprietario_do_acompanhamento` = utilizador e `data_de_nascimento` no dia de hoje (Lisboa) |
| Contactar futuramente | `status_atendimento` = «Contactar futuramente», `data_do_proximo_contacto` ≤ hoje; separa hoje / em atraso |
| Leads recebidas no mês | `tipo_de_contacto` ∋ Lead, `proprietario_do_acompanhamento` = utilizador, `createdate` no mês |
| Leads com interesse | idem, `interesse` ∈ Interessado c/condição · c/condição noutros projetos · condição indefinida (acumulado) |
| Novos acompanhamentos | idem, `status_atendimento` = Novo (situação atual) |
| Negócios fechados | `hubspot_owner_id` = utilizador e `status_do_negocio` = Concluído (`Vendida`), sem olhar à fase do pipeline. No mês: `data_cpcv` no mês; sem Data CPCV, `closedate` no mês até agora |
| Reuniões realizadas | `hubspot_owner_id` = utilizador, `hs_meeting_outcome` = COMPLETED, início no mês; uma linha por opção de `hs_activity_type` e «Sem tipo definido» |

Variáveis opcionais (Text): `LEADS_OWNER_IDS` (omissão `77041306`, Ruben Costa), `DEALS_STATUS_FECHADO` (omissão `Vendida`; vários separados por vírgulas, ex. `Vendida,Permuta`), `HUBSPOT_PORTAL_ID` (omissão `27006740`, para as ligações às fichas).

## Agendar: convidar outras pessoas

Além do contacto, o coordenador pode convidar pessoas da equipa (utilizadores ativos do HubSpot) ou qualquer outro e-mail. A **Gabriela Matos** vem pré-selecionada em cada nova reunião e pode ser retirada (variável `CONVIDADOS_PREDEFINIDOS`, omissão `gabriela.matos@fercopor.pt`).
- **HubSpot:** as pessoas da equipa ficam como participantes da reunião (`hs_attendee_owner_ids`); todos os convidados ficam na linha `Convidados:` das notas internas. Não são criados contactos.
- **Outlook:** com o evento Outlook ligado, todos recebem o convite. Sem evento Outlook, nenhum convite é enviado.

A Private App do HubSpot tem de poder **ler** contactos, negócios (`crm.objects.deals.read`) e reuniões. Se faltar uma permissão, só essa secção mostra um aviso.

## Mais tarde, só com autorização: ligar ao HubSpot

1. **Leitura:** Private App «FERCOPOR Reuniões» com âmbitos de leitura de contactos, de proprietários, do esquema de negócios (opções de «Empreendimento») e de reuniões.
   - Segredo `HUBSPOT_TOKEN`.
   - Sem `HUBSPOT_WRITE_ENABLED`, a app mostra as reuniões reais e recusa escritas.
2. **Escrita:** depois dos testes T-01 a T-07 autorizados, acrescentar à Private App a escrita de reuniões e definir `HUBSPOT_WRITE_ENABLED` = `true`.
   - O servidor só escreve **reuniões** do próprio utilizador e nunca contactos, negócios ou propriedades.
   - Confirmar no T-08 o tipo de associação reunião → contacto (`200`).

## Testar (modo demo)

1. Abra o site: deve pedir a conta Microsoft 365. Uma conta de fora → recusada. Uma conta `@fercopor.pt` fora da lista → «sem autorização».
2. Agende uma reunião: o título é gerado e aparece na semana e na lista.
3. Marque um resultado em «Por classificar» e use «Anular».
4. Os dados de demonstração voltam ao início quando o Cloudflare reinicia o servidor. É normal.
