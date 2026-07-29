<p align="center">
  <img src="public/img/logo.png" alt="Oceania" width="140">
</p>

# 🔁 Reativador

App de **campanhas de WhatsApp** que roda sozinho num container Docker, sem n8n e
**sem banco de dados** — tudo é gravado em arquivos JSON num volume persistente.

Duas coisas convivem no mesmo painel:

1. **Reativação automática do Bling** — acha quem comprava e sumiu e manda mensagem.
2. **Campanhas de planilha** — a pessoa sobe um Excel/CSV com `telefone` e `nome`
   e a campanha envia pra aquela lista.

E, acima de tudo, **proteção do número**: nada sai em bloco.

---

## Índice

- [Como funciona](#como-funciona)
- [Proteção do número (leia isso)](#proteção-do-número-leia-isso)
- [A planilha de contatos](#a-planilha-de-contatos)
- [A imagem da campanha](#a-imagem-da-campanha)
- [Onde os dados ficam](#onde-os-dados-ficam)
- [Deploy no EasyPanel](#deploy-no-easypanel)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Rotas da API](#rotas-da-api)
- [Rodando local](#rodando-local)
- [Limites conhecidos](#limites-conhecidos)

---

## Como funciona

```
 a cada 5 min (CRON_TICK) o app olha TODAS as campanhas
        │
        ▼
 campanha ativa (ou "em andamento")? ──não──► pula
        │sim
        ▼
 hoje é dia de disparo? está no horário? ──não──► pula
        │sim
        ▼
 já bateu o limite diário do número? ──sim──► pára até amanhã
        │não
        ▼
 monta a fila
   • tipo planilha: contatos "pendentes" da lista importada
   • tipo bling:    quem comprava na janela anterior e não na recente
   • + números extras cadastrados na campanha
        │
        ▼
 filtra: opt-out (PARE), cooldown, telefone inválido
        │
        ▼
 embaralha, corta no "teto por rodada" e envia um a um,
 com pausa SORTEADA entre cada mensagem
        │
        ▼
 grava o resultado de cada contato e manda o resumo pro seu WhatsApp
        │
        ▼
 sobrou gente? fica pra próxima rodada
 (a lista sai em fatias, ao longo dos dias)
```

### Os dois modos de disparo

| Modo | O que faz |
|---|---|
| **Automática** | Roda sozinha nos dias e no horário configurados, enquanto tiver alguém na fila. |
| **Manual** | Só começa quando alguém clica em **Disparar**. A partir daí a lista **continua saindo em fatias** nas rodadas seguintes, no mesmo ritmo seguro, até acabar. Dá pra pausar quando quiser. |

---

## Proteção do número (leia isso)

Disparo em massa é o jeito mais rápido de perder um número no WhatsApp. O app foi
feito pra ser **lento de propósito**. Tudo isso fica no card "Proteção do número",
vale pra todas as campanhas (é um número só) e pode ser ajustado no painel:

| Mecanismo | Padrão | Por quê |
|---|---|---|
| **Limite diário** | 150/dia | Teto do número somando todas as campanhas. Ao bater, tudo para até o dia seguinte. |
| **Pausa sorteada** | 35 a 95s | Intervalo aleatório entre mensagens. Ritmo fixo é assinatura de robô. |
| **Teto por rodada** | 12 | Cada rodada manda pouco; o resto fica pra próxima. Uma lista de 500 leva dias — e é isso que salva o número. |
| **Intervalo entre rodadas** | 20 min | Espaça as fatias ao longo do dia. |
| **Aquecimento** | ligado | Nos primeiros dias o limite é menor e vai subindo: 20 → 30 → 50 → 70 → 100 → 130 → limite cheio. Essencial em número novo. |
| **Variação da mensagem** | ligado | `{Oi\|Olá\|E aí}` sorteia uma opção por envio: duas pessoas nunca recebem texto idêntico. |
| **Ordem aleatória** | ligado | Não segue a ordem da planilha. |
| **Janela de dias/horário** | seg–sex, 9h–19h | Ninguém dispara promoção às 3h da manhã. |
| **Opt-out automático** | — | Quem responde PARE (ou SAIR, PARAR, CANCELAR, STOP…) nunca mais recebe nada, em nenhuma campanha. |
| **Cooldown** | 30 dias no Bling | Não repete pro mesmo número antes do prazo. |

O painel mostra a **estimativa em dias** de cada lista com as configurações atuais.
Se a conta der "1 dia" pra 2.000 contatos, algo está agressivo demais.

### Escrevendo a mensagem

```
{Oi|Olá|Bom dia}, {nome}! {Separei|Preparei} uma novidade que acho que te interessa.
_Se preferir não receber mais mensagens, responda PARE._
```

- `{nome}` → primeiro nome do contato, já limpo ("MARIA DA SILVA LTDA" → "Maria").
  Sem nome na planilha, o vocativo é removido em vez de virar "Oi, !".
- `{a|b|c}` → sorteia uma das opções em cada envio.
- Sempre deixe a saída explícita (o "responda PARE"). Além de educado, reduz denúncia —
  e denúncia é o que realmente derruba número.

O botão **👁 Ver como fica** mostra três exemplos, do jeito que cada pessoa receberia.

---

## A planilha de contatos

Duas colunas: **telefone** e **nome**. O modelo pronto está no painel
(**Modelo Excel** e **Modelo CSV**) e também em `/api/modelo.xlsx` e `/api/modelo.csv`.

O leitor é tolerante:

- Formatos: `.xlsx` e `.csv` (`.txt` com tabulação também). `.xls` antigo não —
  abra no Excel e salve como `.xlsx`.
- O cabeçalho pode variar: `telefone`, `celular`, `whatsapp`, `fone`, `numero`, `tel`…
  e `nome`, `cliente`, `razão social`… Maiúsculas e acentos não importam.
- Ordem das colunas não importa. Se não achar cabeçalho, usa a 1ª coluna como
  telefone e a 2ª como nome, e avisa na tela.
- Telefone com ou sem `55`, com ou sem `(51) 99999-9999`, com zero de operadora — resolve.
- CSV salvo pelo Excel em ANSI (acento quebrado) é detectado e convertido.
- Repetidos entram uma vez só. Inválidos são ignorados e aparecem no relatório,
  com o número da linha.

Cada contato tem seu próprio status: `pendente`, `enviado`, `erro`, `optout`, `invalido`.
Dá pra baixar o **relatório .xlsx** com tudo isso, e o botão **Zerar progresso** devolve
todos pra fila (quem pediu PARE continua de fora).

---

## A imagem da campanha

O app **não hospeda imagem** — de propósito, pra não encher o disco do servidor.
O fluxo pensado pra quem não é técnico:

1. No editor da campanha, clique em **🖼 Hospedar imagem no ImgBB** (abre https://pt-br.imgbb.com/).
2. Suba o arquivo lá e copie o campo **"Link direto"** (termina em `.jpg` / `.png`).
3. Cole no campo Imagem e salve. **O link fica guardado na campanha.**
4. Quando quiser, clique em **🔍 Verificar se o link está válido** — o servidor confere
   se a imagem ainda responde (é exatamente o que a Evolution faz na hora de enviar) e
   mostra tipo e tamanho. O botão **↗ Abrir o link** abre numa aba nova, e a prévia
   aparece ali embaixo.

Com imagem preenchida, o envio é imagem + legenda; vazio, é só texto.

---

## Onde os dados ficam

Tudo em `DATA_DIR` (padrão `/data`) — **monte um volume nessa pasta no EasyPanel**,
senão tudo se perde a cada restart:

| Arquivo | Conteúdo |
|---|---|
| `campanhas.json` | Todas as campanhas cadastradas |
| `protecao.json` | Configuração da proteção do número |
| `tokens.json` | Tokens OAuth do Bling (renovados sozinhos) |
| `estado.json` | Histórico de envios (cooldown), opt-outs e contador do dia |
| `log.json` | Últimos eventos, mostrados no painel |
| `listas/<id>.json` | Contatos importados de cada campanha, com status de cada um |
| `arquivos/<id>.xlsx` | A planilha original, como foi enviada |

Toda gravação é atômica (escreve num `.tmp` e renomeia): container caindo no meio da
escrita não corrompe arquivo. E o app desliga com educação no SIGTERM — espera a
rodada em andamento terminar antes de sair.

Tem **backup** também: *Baixar backup* (`/api/backup.json`) leva tudo num arquivo só e
*Restaurar backup* devolve. Serve pra trocar de servidor ou se o volume for perdido.

---

## Deploy no EasyPanel

### 1. Criar o aplicativo no Bling (só se for usar a reativação automática)

1. Acesse https://developer.bling.com.br e crie um aplicativo.
2. Em **URL de redirecionamento**, cadastre `https://SEU-APP/auth/bling/callback`.
3. Marque os escopos de leitura de **pedidos de venda** e **contatos**.
4. Anote o **Client ID** e o **Client Secret**.

### 2. Subir o app

1. Coloque este projeto num repositório Git.
2. No EasyPanel: **New → App**, aponte pro repositório, método de build **Dockerfile**.
3. Na aba **Environment**, cole as variáveis do `.env.example` preenchidas.
4. Na aba **Mounts/Volumes**, monte um volume no caminho **`/data`**. Sem isso,
   campanhas e listas somem a cada deploy.
5. Deploy.

### 3. Conectar o Bling (opcional)

Abra o painel, entre com a senha e clique em **⚠️ conectar Bling** no topo.
Autorize e pronto — o token renova sozinho pra sempre.

### 4. Webhook do PARE (recomendado)

Na Evolution API, configure um webhook de **mensagens recebidas** apontando pra:

```
https://SEU-APP/webhook/evolution
```

Se você preencher `WEBHOOK_TOKEN`, use `https://SEU-APP/webhook/evolution?token=SEU-TOKEN`.

Sem o webhook o app funciona, mas os PAREs teriam que ser lançados à mão no painel.

### 5. Primeira campanha

1. **+ Nova campanha** → nome, mensagem (com `{nome}` e variações), imagem (opcional).
2. **Salvar** → suba a planilha → confira o resumo da importação.
3. **Enviar teste** pro seu número e olhe no WhatsApp.
4. Escolha o modo, os dias e o horário, confira a estimativa de dias.
5. **Disparar** (manual) ou ligue o interruptor **Campanha ativa** (automática).

---

## Variáveis de ambiente

Todas comentadas no [`.env.example`](.env.example). Obrigatórias: `APP_URL`,
`ADMIN_SENHA`, `EVOLUTION_URL`, `EVOLUTION_APIKEY`, `EVOLUTION_INSTANCE`,
`ADMIN_WHATSAPP` (+ `BLING_CLIENT_ID` / `BLING_CLIENT_SECRET` se usar o Bling).

> A antiga `CRON_EXPRESSAO` não é mais usada: a frequência agora é `CRON_TICK`
> (de quanto em quanto tempo o app olha as campanhas) + o **intervalo entre rodadas**
> de cada campanha. O app avisa no log se achar a variável antiga.

---

## Rotas da API

Tudo protegido por Basic Auth (`ADMIN_SENHA`), menos `/health`, o callback do Bling e o webhook.

| Rota | O quê |
|---|---|
| `GET /` | Painel |
| `GET /health` | Healthcheck com números (campanhas, pendentes, envios de hoje) |
| `GET /api/status` | Estado completo: campanhas, proteção, saldo do dia, opt-outs, log |
| `GET /api/protecao` · `PUT /api/protecao` | Proteção do número |
| `GET /api/campanhas` · `POST /api/campanhas` | Listar e criar |
| `GET /api/campanhas/:id` · `PUT` · `DELETE` | Ver, editar, excluir |
| `POST /api/campanhas/:id/planilha` | Upload da planilha (multipart, campo `arquivo`) |
| `GET /api/campanhas/:id/planilha` · `DELETE` | Baixar a planilha original · remover a lista |
| `GET /api/campanhas/:id/contatos` | Contatos com status (paginado) |
| `GET /api/campanhas/:id/relatorio.xlsx` | Relatório de envios |
| `POST /api/campanhas/:id/disparar` | Dispara agora (aceita `{"forcar":true}` fora do horário) |
| `POST /api/campanhas/:id/pausar` | Para de fatiar a lista |
| `POST /api/campanhas/:id/reiniciar` | Todos voltam pra fila (mantém quem pediu PARE) |
| `POST /api/campanhas/:id/clonar` | Duplica a campanha (`{"copiarLista":true}` copia os contatos) |
| `POST /api/campanhas/:id/teste` | Envia a mensagem pra 1 número |
| `GET /api/modelo.xlsx` · `GET /api/modelo.csv` | Modelo de planilha |
| `GET /api/verificar-imagem?url=` | Confere se o link da imagem está no ar |
| `POST /api/optout` | Adiciona/remove número da lista de PARE |
| `GET /api/backup.json` · `POST /api/restaurar` | Backup e restauração |
| `GET /auth/bling` · `GET /auth/bling/callback` | OAuth do Bling |
| `POST /webhook/evolution` | Mensagens recebidas (detecta PARE) |

---

## Rodando local

```bash
npm install
npm run teste                 # 42 testes, sem framework, não manda mensagem nenhuma

DATA_DIR=./data ADMIN_SENHA=123 \
EVOLUTION_URL=http://localhost:4444 EVOLUTION_APIKEY=k EVOLUTION_INSTANCE=i \
npm start
# painel em http://localhost:3000 (usuário vazio, senha 123)
```

Não há dependência para ler/gerar Excel: `src/xlsx-lite.js` faz isso com o `zlib` do
próprio Node. O projeto fica com **3 dependências** (express, multer, node-cron) e
**zero vulnerabilidades** no `npm audit` — as libs populares de xlsx têm CVEs abertas,
e é planilha de terceiro que entra aqui.

### Estrutura

```
src/
  server.js      rotas (painel, API, OAuth, webhook) e desligamento limpo
  scheduler.js   o piloto automático: tick, rodadas e proteção do número
  campanhas.js   cadastro de campanhas (CRUD + validação)
  planilha.js    leitura de CSV/XLSX, modelo e relatório
  xlsx-lite.js   leitor/gerador de .xlsx sem dependências
  store.js       persistência em JSON no volume
  bling.js       Bling API v3 + OAuth com refresh automático
  churn.js       a regra de "quem sumiu"
  evolution.js   envio no WhatsApp, variações e normalização de telefone
public/
  index.html     painel inteiro num arquivo
  img/           logo Oceania
testes/
  smoke.js       testes
```

---

## Limites conhecidos

- A busca de vendas no Bling pega até **500 pedidos por janela** (5 páginas de 100,
  ajustável em `BLING_MAX_PAGINAS`). Acima disso, os sumidos saem do que veio.
- O campo de telefone do contato no Bling varia de conta pra conta
  (`telefone` / `celular` / `fone`) — o app tenta os três. Contato sem telefone entra
  numa espera de `DIAS_SEM_TELEFONE` antes de ser consultado de novo.
- `.xls` antigo (binário, pré-2007) não é lido: salve como `.xlsx` ou CSV.
- Uma instância atende **uma** loja / um número de WhatsApp. Pra outra loja, sobe outro
  container com seu próprio env e volume.
- Listas gigantes funcionam, mas o arquivo da lista é lido e gravado inteiro a cada
  envio — acima de ~50 mil contatos vale quebrar em campanhas.
- Nenhum ritmo garante que o WhatsApp não bloqueie um número. O que derruba mais rápido
  é gente denunciando: mande pra quem espera ser contatado.
