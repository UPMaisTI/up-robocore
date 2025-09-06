# UP RoboCore

Controlador de robôs em **NestJS + TypeScript** rodando **tudo no mesmo processo** (sem Redis, sem filas externas, sem PM2). Inclui o robô **whatsapp-spam**, que conversa com a **WhatsApp Max API** para envio de mensagens.

## Sumário

* [Requisitos](#requisitos)
* [Instalação & Execução](#instalação--execução)
* [Variáveis de Ambiente](#variáveis-de-ambiente)
* [Banco de Dados (opcional)](#banco-de-dados-opcional)

  * [Tabelas](#tabelas)
  * [O que cada coluna faz](#o-que-cada-coluna-faz)
* [WhatsApp Max API (integração)](#whatsapp-max-api-integração)
* [Autostart de robôs](#autostart-de-robôs)
* [API do RoboCore](#api-do-robocore)

  * [Health](#health)
  * [Robots](#robots)
  * [Admin do whatsapp-spam](#admin-do-whatsapp-spam)
* [Semântica dos campos da sessão (whatsapp-spam)](#semântica-dos-campos-da-sessão-whatsapp-spam)
* [Ciclos e limites](#ciclos-e-limites)
* [Logs e Diagnóstico](#logs-e-diagnóstico)
* [Exemplos (cURL)](#exemplos-curl)
* [Dicas & Troubleshooting](#dicas--troubleshooting)

---

## Requisitos

* **Node.js 22+**
* **npm 9+**
* Oracle opcional (Instant Client no Docker de produção)
* Windows (dev) e Linux (prod) suportados

---

## Instalação & Execução

```bash
# instalar dependências
npm install

# desenvolvimento (watch)
npm run start:dev

# build
npm run build

# produção (usa dist/)
npm run start:prod
```

Gerador de robôs (boilerplate):

```bash
npm run robot:create <nome>
```

---

## Variáveis de Ambiente

Essenciais (mínimo):

```
NODE_ENV=development
PORT=3000
TZ=America/Sao_Paulo

# WhatsApp Max
WHATS_API_BASE=http://localhost:3000
WHATS_API_KEY= # opcional; se a API exigir, preencha
```

Oracle (opcional — o app sobe mesmo sem Oracle):

```
DB_USER=
DB_PASSWORD=
DB_CONNECT_STRING=        # ou DB_SERVICE_NAME=
DB_POOL_MIN=1
DB_POOL_MAX=10
DB_POOL_INCREMENT=1
DB_POOL_TIMEOUT=60
DB_QUEUE_TIMEOUT=120000
```

> Obs.: no **Docker** de produção você usará um único `Dockerfile` (com Instant Client) e o **mesmo `.env`** — nenhuma variante separada.

---

## Banco de Dados (opcional)

O **whatsapp-spam** usa o Oracle **se disponível** para:

* Ler configurações de sessão (UP\_WHATS\_SESSIONS)
* Ler os destinos da “fazendinha” (UP\_WHATS\_FARM\_TARGETS)
* (Modo fila) “Pegar e marcar” mensagens em `sankhya.envia_whats`

Se o Oracle não estiver configurado, o app sobe; mas o **whatsapp-spam** precisa dessas tabelas para funcionar no modo DB.

### Tabelas

```sql
-- Sessões controladas pelo robô
CREATE TABLE UP_WHATS_S
ESSIONS (
  SESSION_ID   VARCHAR2(64)   PRIMARY KEY,
  ENABLED      CHAR(1)        DEFAULT 'Y' CHECK (ENABLED IN ('Y','N')),
  NUM_ORIGEM   NUMBER         NOT NULL,
  RUN_MODE     VARCHAR2(16)   DEFAULT 'simple',
  INTERVAL_MS  NUMBER         DEFAULT 5000,
  MAX_PER_DAY  NUMBER         DEFAULT 250,
  SEND_NORMAL  CHAR(1)        DEFAULT 'Y' CHECK (SEND_NORMAL IN ('Y','N')),
  UPDATED_AT   TIMESTAMP      DEFAULT SYSTIMESTAMP,
  CONSTRAINT CK_UP_WHATS_RUN_MODE CHECK (RUN_MODE IN ('simple','fast','medium','slow'))
);

-- Destinos “fazendinha” (usados quando SEND_NORMAL = 'N')
CREATE TABLE UP_WHATS_FARM_TARGETS (
  SESSION_ID   VARCHAR2(64) NOT NULL,
  CHAT_ID      VARCHAR2(128) NOT NULL, -- ex.: 1203...@g.us ou ...@c.us
  INTERVAL_MS  NUMBER        DEFAULT 600000,
  CONSTRAINT PK_UP_WHATS_FARM_TARGETS PRIMARY KEY (SESSION_ID, CHAT_ID),
  CONSTRAINT FK_UP_WHATS_FARM_TARGETS_SESS FOREIGN KEY (SESSION_ID) REFERENCES UP_WHATS_SESSIONS(SESSION_ID)
);

-- Índices úteis para a fila
CREATE INDEX IX_ENVIA_WHATS_PEND    ON sankhya.envia_whats (data_envio, erro, numorigem);
CREATE INDEX IX_ENVIA_WHATS_CRIACAO ON sankhya.envia_whats (data_criacao);
```

### O que cada coluna faz

* **UP\_WHATS\_SESSIONS**

  * `SESSION_ID`: ID da sessão do WhatsApp Max (ex.: `ROBOCELL7`).
  * `ENABLED`: `'Y'` ativa / `'N'` desativa a sessão no robô.
  * `NUM_ORIGEM`: número/código para marcar em `sankhya.envia_whats.NUMORIGEM` quando a fila for usada.
  * `RUN_MODE`: perfil de ritmo do loop (`simple` | `fast` | `medium` | `slow`).
  * `INTERVAL_MS`: base do loop em milissegundos (ver “Ciclos e limites”).
  * `MAX_PER_DAY`: limite de envios por dia para essa sessão.
  * `SEND_NORMAL`: `'Y'` usa **fila** `sankhya.envia_whats`; `'N'` usa **“fazendinha”** (alvos fixos).

* **UP\_WHATS\_FARM\_TARGETS**

  * `SESSION_ID`: a que sessão pertence o alvo.
  * `CHAT_ID`: destino final (`...@g.us` para grupos, `...@c.us` para contatos).
  * `INTERVAL_MS`: período mínimo entre envios para este **alvo**.

---

## WhatsApp Max API (integração)

Endpoints utilizados (fixos):

* `GET /sessions/:id/status` → precisa retornar `status: "READY"` quando a sessão estiver pronta
* `GET /messages/:sessionId/resolve?phone=...` → resolve número para `chatId`
* `POST /messages/send` → envia texto ou mídia
* Header opcional `x-api-key: <sua-chave>` se a API exigir (configurada via `WHATS_API_KEY`)

Base URL da API: `WHATS_API_BASE`, ex.: `http://localhost:3000`.

> O robô **não cria nem exclui** sessões no WhatsApp Max. Ele **consulta status** e **envia**.

---

## Autostart de robôs

O RoboCore lê `robots.manifest.json` no boot. Exemplo:

```json
{
  "whatsapp-spam": { "enabled": true }
}
```

Se `enabled: true`, o robô **sobe automaticamente** e:

1. lê suas sessões do Oracle (UP\_WHATS\_SESSIONS);
2. para cada sessão `ENABLED='Y'`, inicia o loop;
3. só envia quando `GET /sessions/:id/status` retornar `READY`.

---

## API do RoboCore

### Health

* `GET /health/live`
* `GET /health/ready`

### Robots

* `GET /robots` → `{ name, status, lastError? }[]`
* `POST /robots/:name/start`
* `POST /robots/:name/stop`
* `GET /robots/:name/status`

### Admin do whatsapp-spam

Sessões (tabela `UP_WHATS_SESSIONS`):

* `GET  /whatsapp-spam/sessions`
* `POST /whatsapp-spam/sessions`
  Body:

  ```json
  {
    "sessionId": "ROBOCELL7",
    "enabled": true,
    "numOrigem": 7,
    "mode": "simple",
    "intervalMs": 5000,
    "maxPerDay": 500,
    "sendNormal": true
  }
  ```
* `PATCH /whatsapp-spam/sessions/:id`
  Body parcial (qualquer campo acima).
* `DELETE /whatsapp-spam/sessions/:id`

Targets da fazendinha (tabela `UP_WHATS_FARM_TARGETS`):

* `GET    /whatsapp-spam/sessions/:id/targets`
* `POST   /whatsapp-spam/sessions/:id/targets`
  Body:

  ```json
  { "chatId": "1203XXXXXXXXXXXX@g.us", "intervalMs": 900000 }
  ```
* `DELETE /whatsapp-spam/sessions/:id/targets/:chatId`

---

## Semântica dos campos da sessão (whatsapp-spam)

```json
{
  "sessionId": "ROBOCELL7",
  "enabled": true,
  "numOrigem": 7,
  "mode": "simple",
  "intervalMs": 5000,
  "maxPerDay": 500,
  "sendNormal": true
}
```

* **sessionId**: ID da sessão no WhatsApp Max (deve existir e estar `READY` para enviar).
* **enabled**:

  * `true`: a sessão entra no loop e tenta enviar (respeitando `READY`).
  * `false`: a sessão fica inativa (`idle`).
* **numOrigem**: valor gravado em `sankhya.envia_whats.NUMORIGEM` quando a mensagem da fila é finalizada. Útil para rastrear “de qual robô” saiu.
* **mode**:

  * Controla o **ritmo base** do loop de checagem/ação. Mapeamento:

    * `fast`: `tick = max(1000, intervalMs)`
    * `simple`: `tick = max(2000, intervalMs)`
    * `medium`: `tick = max(3000, intervalMs)`
    * `slow`: `tick = max(7000, intervalMs)`
* **intervalMs**:

  * Base para o cálculo acima.
  * Na **fazendinha**, o envio “de tempos em tempos” por **alvo** respeita o `INTERVAL_MS` do target. O `intervalMs` da sessão é a frequência do loop (checagem).
* **maxPerDay**:

  * Limite diário de envios por sessão. Zera à meia-noite (horário do servidor).
* **sendNormal**:

  * `true` → **Fila**: consome de `sankhya.envia_whats` (campos `DESTINO`, `MENSAGEM`, `ANEXO`), reclama um item (marca `NUMORIGEM`) e finaliza (`DATA_ENVIO`, `ERRO`).
  * `false` → **Fazendinha**: envia textos (versos aleatórios de `UP_MENSAGENS_BIBLIA_WHATS` ou `WHATS_FARM_TEXT`) para os **targets** cadastrados (alternando e respeitando o `INTERVAL_MS` de cada target).

---

## Ciclos e limites

* **READY obrigatório**: cada tick verifica `GET /sessions/:id/status`; só envia quando `status === "READY"`.
* **Reset diário**: contador de envios por sessão é zerado a cada dia.
* **Fila**:

  * Seleciona o item mais antigo pendente (`data_envio IS NULL AND erro IS NULL AND numorigem IS NULL`).
  * Reclama o item setando `NUMORIGEM = :numOrigem`.
  * Envia; grava `DATA_ENVIO` e `ERRO` (vazio em caso de sucesso).
* **Fazendinha**:

  * Para cada `chatId` da sessão, mantém um relógio interno e só envia novamente após `INTERVAL_MS` daquele alvo.

---

## Logs e Diagnóstico

* Console do app mostra eventos por sessão:

  * início do loop, `READY`/não `READY`, target escolhido, envio OK/erro, próximo disparo, etc.
* `GET /robots/whatsapp-spam/status` retorna por sessão:

  ```json
  {
    "running": true,
    "sessions": [
      {
        "sessionId": "ROBOCELL7",
        "enabled": true,
        "state": "ready",
        "sentToday": 3,
        "intervalMs": 5000,
        "lastTickAt": 1694012345678,
        "lastEvent": "fazendinha ok -> 1203...@g.us",
        "lastError": null
      }
    ]
  }
  ```

---

## Exemplos (cURL)

Criar/atualizar sessão:

```bash
curl -X POST http://localhost:3000/whatsapp-spam/sessions \
 -H "Content-Type: application/json" \
 -d '{ "sessionId":"ROBOCELL7","enabled":true,"numOrigem":7,"mode":"simple","intervalMs":5000,"maxPerDay":500,"sendNormal":false }'

curl -X PATCH http://localhost:3000/whatsapp-spam/sessions/ROBOCELL7 \
 -H "Content-Type: application/json" \
 -d '{ "sendNormal": false, "enabled": true }'
```

Targets (fazendinha):

```bash
curl -X POST http://localhost:3000/whatsapp-spam/sessions/ROBOCELL7/targets \
 -H "Content-Type: application/json" \
 -d '{ "chatId":"1203XXXXXXXXXXXX@g.us", "intervalMs":900000 }'

curl http://localhost:3000/whatsapp-spam/sessions/ROBOCELL7/targets
```

Robô:

```bash
curl -X POST http://localhost:3000/robots/whatsapp-spam/start
curl http://localhost:3000/robots/whatsapp-spam/status
```

---

## Dicas & Troubleshooting

* **Não envia e log mostra “aguardando READY”**
  Garanta que na WhatsApp Max API `GET /sessions/:id/status` retorne `{"status":"READY"}`. Se exigir API key, configure `WHATS_API_KEY`.

* **“\[object Object]” no texto**
  Resolvido: CLOB é convertido para string via `fetchTypeHandler` e o robô normaliza o texto antes de enviar.

* **ORA-01745 (\:mode)**
  Corrigido para `:runMode` e coluna `RUN_MODE`.

* **Sem envios na fazendinha**
  Verifique:

  1. `SEND_NORMAL='N'` na sessão
  2. targets em `UP_WHATS_FARM_TARGETS`
  3. `status=READY` da sessão
  4. `MAX_PER_DAY` não atingido

* **Fila parada**
  Veja se há pendências em `sankhya.envia_whats` e se o robô está marcando `NUMORIGEM`. Índices recomendados acima.

* **CORS/Segurança**
  O RoboCore expõe apenas as rotas do controlador. A WhatsApp Max API pode exigir `x-api-key`. Restrinja acesso por rede e key.

---