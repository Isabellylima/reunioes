# FERCOPOR Reuniões: publicar no Cloudflare

Esta pasta tem:
- `site/`: o que se carrega no Cloudflare (a app e o `_worker.js`, que protege tudo e fala com o HubSpot).
- `tests/`: testes automáticos do servidor (`node --test tests/`). Não carregar.
- `GUIA-CLOUDFLARE.md`: este guia. Não carregar.

## Como funciona e como fica protegido

- **Entrada com Microsoft 365.** O Cloudflare Access pede a conta da empresa antes de a app abrir. O servidor volta a validar a sessão (assinatura, audiência, validade) e só aceita contas `@fercopor.pt`.
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

### 3. Migração sem interrupção
1. Com o Access ainda ativo, abra `https://reunioes.fercopor.workers.dev/auth/entrar` e entre com a Microsoft. Confirme que a app abre com o seu nome. Peça o mesmo a um coordenador.
2. Quando estiver tudo bem: Zero Trust → Access → Applications → **apagar ou desativar** a aplicação de `reunioes.fercopor.workers.dev` (ou desligar o Access em Domains & Routes).
3. No Worker, crie `AUTH_MODE` = `entra` (Text) e faça Deploy. A partir daqui só a sessão Microsoft é aceite.
4. Pode apagar `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD`.

Os utilizadores autorizados e a ligação ao HubSpot (e-mail → proprietário) não mudam.

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
