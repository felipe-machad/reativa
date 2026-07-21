# 🔁 Reativador

Mini app **totalmente autônomo** que identifica clientes sumidos no Bling e manda
mensagem de WhatsApp pra eles sozinho, a cada hora, sem depender de n8n nem de
banco de dados externo. Roda num container Docker no seu EasyPanel.

---

## Como funciona (visão geral)

```
 a cada hora (configurável)
        │
        ▼
 Campanha ativa? ──não──► não faz nada
        │sim
        ▼
 Horário comercial? ──não──► não faz nada
        │sim
        ▼
 Busca vendas no Bling (últimos 90d vs 90d anteriores)
        │
        ▼
 Quem comprava antes e sumiu = lista de sumidos
        │
        ▼
 Filtra: opt-out (PARE) e quem já recebeu nos últimos 30 dias
        │
        ▼
 + Números extras cadastrados no painel
        │
        ▼
 Envia (máx. 40 por rodada, pausa de 5s entre cada)
        │
        ▼
 Manda resumo pro seu WhatsApp
```

Toda regra em negrito acima é configurável por variável de ambiente — nada
hardcoded.

---

## O que o usuário configura no painel

O painel é uma página só, pensada pra qualquer pessoa usar:

| Campo | O que é |
|---|---|
| **Campanha ativa** | Liga/desliga o envio automático (interruptor) |
| **Texto da mensagem** | O que o cliente recebe. `{nome}` vira o primeiro nome dele |
| **Imagem** | Link direto de uma imagem (jpg/png). Vazio = manda só texto |
| **Link no fim** | Hyperlink opcional (catálogo, site, promoção) |
| **Outros números** | Números avulsos que também recebem a campanha, além dos sumidos do Bling. Botão "+ Adicionar número", sem mistério |

E tem os botões de **Enviar teste** (manda a mensagem só pra um número seu, pra
conferir como fica) e **Rodar uma rodada agora** (dispara o ciclo completo sem
esperar o relógio).

---

## Onde os dados ficam (sem banco de dados)

Tudo é gravado em arquivos JSON dentro de `/data` (monte um **volume** nessa
pasta no EasyPanel pra nada se perder quando o container reiniciar):

| Arquivo | Conteúdo |
|---|---|
| `config.json` | O que foi salvo no painel |
| `tokens.json` | Tokens OAuth do Bling (renovados automaticamente) |
| `estado.json` | Histórico de envios (pro cooldown), lista de opt-out, log |

---

## Passo a passo do deploy no EasyPanel

### 1. Criar o aplicativo no Bling (uma vez só)

1. Acesse https://developer.bling.com.br e crie um aplicativo
2. Em **URL de redirecionamento**, cadastre:
   `https://SEU-APP.easypanel.host/auth/bling/callback`
   (troque pelo domínio que o EasyPanel vai te dar — dá pra voltar e editar depois)
3. Marque os escopos de leitura de **pedidos de venda** e **contatos**
4. Anote o **Client ID** e o **Client Secret**

### 2. Subir o app no EasyPanel

1. Coloque este projeto num repositório (GitHub) **ou** builde a imagem local
2. No EasyPanel: **New → App**
3. Aponte pro repositório e escolha **Dockerfile** como método de build
4. Na aba **Environment**, cole as variáveis do `.env.example` preenchidas
   (as obrigatórias: `APP_URL`, `BLING_CLIENT_ID`, `BLING_CLIENT_SECRET`,
   `EVOLUTION_URL`, `EVOLUTION_APIKEY`, `EVOLUTION_INSTANCE`,
   `ADMIN_WHATSAPP`, `ADMIN_SENHA`)
5. Na aba **Mounts/Volumes**, monte um volume no caminho **`/data`**
   — sem isso, config e tokens somem a cada restart!
6. Deploy

### 3. Conectar o Bling

1. Abra o painel (`https://SEU-APP.easypanel.host`), entre com a senha
2. Vai aparecer "⚠️ Bling não conectado — clique aqui pra conectar"
3. Clique, autorize no Bling, pronto. O token renova sozinho pra sempre.

### 4. Configurar e testar

1. Escreva o texto, cole o link da imagem, salve
2. Use **Enviar teste** pro seu próprio número e confira no WhatsApp
3. Quando estiver satisfeito, ligue o interruptor **Campanha ativa** e salve
4. A partir daí o app roda sozinho no horário configurado

---

## Opt-out (cliente respondeu "PARE")

O app tem o endpoint `POST /webhook/evolution` que registra opt-out
automaticamente quando alguém responde exatamente **PARE**.

Pra funcionar, configure na sua Evolution API (painel dela ou via API) um
webhook de mensagens recebidas apontando pra:

```
https://SEU-APP.easypanel.host/webhook/evolution
```

Sem o webhook o app funciona normal, mas os PAREs precisariam ser tratados na
mão. Com o webhook, quem pedir pra sair nunca mais recebe nada.

---

## Todas as variáveis de ambiente

Ver `.env.example` — cada uma comentada. Resumo das opcionais:

| Variável | Padrão | Efeito |
|---|---|---|
| `TETO_ENVIOS` | 40 | Máximo de mensagens por rodada |
| `COOLDOWN_DIAS` | 30 | Não repete pro mesmo cliente antes disso |
| `HORARIO_INICIO` / `HORARIO_FIM` | 9 / 19 | Janela de envio |
| `PAUSA_ENTRE_ENVIOS_MS` | 5000 | Pausa entre mensagens |
| `CRON_EXPRESSAO` | `0 * * * *` | Frequência das rodadas (toda hora) |
| `TZ` | America/Sao_Paulo | Fuso horário |

---

## Rotas (referência técnica)

| Rota | O quê |
|---|---|
| `GET /` | Painel |
| `GET /api/status` | Config atual + status do Bling + log |
| `POST /api/config` | Salva a configuração |
| `POST /api/teste` | Envia a mensagem pra 1 número (teste) |
| `POST /api/rodar-agora` | Dispara uma rodada completa imediatamente |
| `GET /auth/bling` | Inicia o OAuth do Bling |
| `GET /auth/bling/callback` | Callback do OAuth (o Bling chama) |
| `POST /webhook/evolution` | Recebe mensagens (detecta PARE) |
| `GET /health` | Healthcheck |

Todas as rotas do painel/API são protegidas pela senha `ADMIN_SENHA`
(Basic Auth). O callback do OAuth e o webhook ficam abertos por necessidade
(são chamados por serviços externos).

---

## Limites conhecidos (honestidade acima de tudo)

- A busca de vendas pega **até 100 pedidos por janela** (1 request, mesma
  decisão dos fluxos n8n — pra não brigar com o rate limit do Bling). Se o
  volume passar disso, os sumidos são calculados sobre o primeiro lote.
- O campo de telefone do contato no Bling pode variar de conta pra conta
  (`telefone` / `celular` / `fone`) — o app tenta os três; se sua conta usar
  outro nome, ajuste em `src/scheduler.js`.
- Um único "tenant": este app atende **uma** loja. Pra oferecer pra outras
  lojas, sobe um container por loja (cada um com seu env) — é literalmente o
  mesmo deploy repetido, o que combina com EasyPanel.
