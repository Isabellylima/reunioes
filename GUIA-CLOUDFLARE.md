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
