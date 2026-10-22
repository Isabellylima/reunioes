# FERCOPOR Reuniões

Interface simplificada para os coordenadores agendarem, consultarem e atualizarem reuniões comerciais no HubSpot. O HubSpot continua a ser o sistema oficial das reuniões.

- `site/`: aplicação para o Cloudflare Pages (modo avançado, `_worker.js`). Sem dependências e sem passo de compilação.
- `tests/`: testes do servidor (`node --test tests/worker.test.mjs`).
- `tools/servidor-local.mjs`: experimentar localmente em modo demonstração (`node tools/servidor-local.mjs`, depois abrir http://localhost:8787).
- `GUIA-CLOUDFLARE.md`: como publicar e configurar.

## Segurança

- Entrada com conta Microsoft 365 através do Cloudflare Access; o servidor valida a sessão.
- Só utilizadores autorizados, cada um ligado a um utilizador ativo do HubSpot.
- Cada pessoa só vê e altera as suas reuniões.
- Os segredos (token HubSpot) ficam nas variáveis do Cloudflare e **nunca** neste repositório.
- A escrita no HubSpot está desligada por omissão (`HUBSPOT_WRITE_ENABLED`).

## Cloudflare Pages ligado a este repositório

- Framework preset: **None**
- Build command: *(vazio)*
- Build output directory: **`site`**
