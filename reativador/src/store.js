// ============================================================
// store.js — "banco de dados" em arquivos JSON dentro de DATA_DIR.
// Nenhuma dependência externa, nenhum banco. Tudo persiste no
// volume montado em /data no EasyPanel.
//
// Estrutura de DATA_DIR:
//   campanhas.json               -> lista de campanhas cadastradas
//   tokens.json                  -> tokens OAuth do Bling
//   estado.json                  -> histórico de envios (cooldown) + opt-out
//   log.json                     -> últimos eventos (mostrados no painel)
//   listas/<idCampanha>.json     -> contatos da planilha + status de cada um
//   arquivos/<idCampanha>.<ext>  -> a planilha original, como foi enviada
// ============================================================
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/data";
const DIR_LISTAS = path.join(DATA_DIR, "listas");
const DIR_ARQUIVOS = path.join(DATA_DIR, "arquivos");

function garantirPastas() {
  for (const d of [DATA_DIR, DIR_LISTAS, DIR_ARQUIVOS]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch (e) {
      console.error(`[store] não consegui criar ${d}: ${e.message}`);
    }
  }
}
garantirPastas();

function ler(rel, padrao) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, rel), "utf8"));
  } catch {
    return padrao;
  }
}

// grava num .tmp e renomeia: se o container cair no meio da escrita,
// o arquivo bom continua lá (rename é atômico no mesmo filesystem)
function gravar(rel, obj) {
  garantirPastas();
  const destino = path.join(DATA_DIR, rel);
  const tmp = `${destino}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, destino);
}

// ---------------------------------------------------------------
// LOG (arquivo próprio — assim nunca briga com escritas de estado)
// ---------------------------------------------------------------
const LOG_MAX = parseInt(process.env.LOG_MAX || "300", 10);

function lerLog() {
  const l = ler("log.json", []);
  return Array.isArray(l) ? l : [];
}

function registrarLog(msg, campanha = null) {
  const log = lerLog();
  log.push({ quando: new Date().toISOString(), msg, campanha });
  gravar("log.json", log.slice(-LOG_MAX));
  console.log(`[log]${campanha ? ` (${campanha})` : ""} ${msg}`);
}

// ---------------------------------------------------------------
// TOKENS OAUTH DO BLING
// ---------------------------------------------------------------
function lerTokens() {
  return ler("tokens.json", null);
}
function gravarTokens(t) {
  gravar("tokens.json", t);
}

// ---------------------------------------------------------------
// ESTADO GLOBAL: histórico de envios (pro cooldown) + opt-out
//   estado.envios = { "<chave>": "2026-07-29T12:00:00.000Z" }
//     chaves: "bling:<idContato>" e "num:<telefone>"
//   estado.optOut = ["5551999999999", ...]
// Toda mutação relê do disco antes de gravar: nada se perde quando
// duas coisas acontecem quase ao mesmo tempo.
// ---------------------------------------------------------------
function lerEstado() {
  const e = ler("estado.json", {});
  return {
    envios: e.envios && typeof e.envios === "object" ? e.envios : {},
    optOut: Array.isArray(e.optOut) ? e.optOut : [],
    diario: e.diario && typeof e.diario === "object" ? e.diario : { data: null, enviados: 0 },
  };
}

// registra o envio (cooldown) e soma no contador do dia (proteção do número).
// `dataLocal` no formato AAAA-MM-DD, no fuso configurado.
function marcarEnvio(chaves, dataLocal = null) {
  const lista = Array.isArray(chaves) ? chaves : [chaves];
  const estado = lerEstado();
  const agora = new Date().toISOString();
  for (const c of lista) if (c) estado.envios[c] = agora;
  if (dataLocal) {
    if (estado.diario.data !== dataLocal) estado.diario = { data: dataLocal, enviados: 0 };
    estado.diario.enviados += 1;
  }
  gravar("estado.json", estado);
}

// quantas mensagens já saíram hoje (no fuso local)
function enviadosHoje(dataLocal) {
  const { diario } = lerEstado();
  return diario.data === dataLocal ? diario.enviados : 0;
}

function adicionarOptOut(numero) {
  if (!numero) return false;
  const estado = lerEstado();
  if (estado.optOut.includes(numero)) return false;
  estado.optOut.push(numero);
  gravar("estado.json", estado);
  return true;
}

function removerOptOut(numero) {
  const estado = lerEstado();
  const antes = estado.optOut.length;
  estado.optOut = estado.optOut.filter((n) => n !== numero);
  if (estado.optOut.length !== antes) {
    gravar("estado.json", estado);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------
// PROTEÇÃO DO NÚMERO (vale pra todas as campanhas — é um WhatsApp só)
// Fica em protecao.json, editável pelo painel.
// ---------------------------------------------------------------
const PROTECAO_PADRAO = {
  limiteDiario: parseInt(process.env.LIMITE_DIARIO || "150", 10), // máximo de mensagens por dia, no número
  pausaMinSeg: parseInt(process.env.PAUSA_MIN_SEG || "35", 10), // pausa mínima entre mensagens
  pausaMaxSeg: parseInt(process.env.PAUSA_MAX_SEG || "95", 10), // pausa máxima (sorteia entre as duas)
  aquecimento: true, // primeiros dias com limite menor
  inicioAquecimento: null, // gravado no primeiro envio de todos
  variarMensagem: true, // usa as variações {oi|olá} do texto
  embaralhar: true, // manda em ordem aleatória, não na ordem da planilha
};

function lerProtecao() {
  const p = ler("protecao.json", {});
  return { ...PROTECAO_PADRAO, ...(p && typeof p === "object" ? p : {}) };
}

function gravarProtecao(p) {
  gravar("protecao.json", p);
}

// ---------------------------------------------------------------
// CAMPANHAS
// ---------------------------------------------------------------
function lerCampanhas() {
  const c = ler("campanhas.json", []);
  return Array.isArray(c) ? c : [];
}
function gravarCampanhas(lista) {
  gravar("campanhas.json", lista);
}

// ---------------------------------------------------------------
// LISTAS DE CONTATOS (uma por campanha, vinda da planilha)
//   { arquivo, importadoEm, total, invalidos, duplicados,
//     contatos: [{ numero, nome, status, enviadoEm, erro }] }
// ---------------------------------------------------------------
const LISTA_VAZIA = { arquivo: null, importadoEm: null, total: 0, invalidos: 0, duplicados: 0, contatos: [] };

function lerLista(idCampanha) {
  const l = ler(path.join("listas", `${idCampanha}.json`), null);
  if (!l || !Array.isArray(l.contatos)) return { ...LISTA_VAZIA };
  return { ...LISTA_VAZIA, ...l };
}
function gravarLista(idCampanha, lista) {
  gravar(path.join("listas", `${idCampanha}.json`), lista);
}
function apagarLista(idCampanha) {
  try {
    fs.unlinkSync(path.join(DIR_LISTAS, `${idCampanha}.json`));
  } catch {}
}

// ---------------------------------------------------------------
// ARQUIVO ORIGINAL DA PLANILHA (pra pessoa poder baixar de volta)
// ---------------------------------------------------------------
const EXTENSOES = [".xlsx", ".xls", ".csv", ".txt"];

function salvarArquivoOriginal(idCampanha, extensao, buffer) {
  garantirPastas();
  for (const ext of EXTENSOES) {
    if (ext !== extensao) {
      try {
        fs.unlinkSync(path.join(DIR_ARQUIVOS, `${idCampanha}${ext}`));
      } catch {}
    }
  }
  fs.writeFileSync(path.join(DIR_ARQUIVOS, `${idCampanha}${extensao}`), buffer);
}

function caminhoArquivoOriginal(idCampanha) {
  for (const ext of EXTENSOES) {
    const p = path.join(DIR_ARQUIVOS, `${idCampanha}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function apagarArquivoOriginal(idCampanha) {
  const p = caminhoArquivoOriginal(idCampanha);
  if (p) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
}

// ---------------------------------------------------------------
// MIGRAÇÃO do formato antigo (config.json, uma campanha só)
// Roda uma vez: transforma o que já estava configurado na campanha
// "Reativação Bling" — nada do que foi configurado se perde.
// ---------------------------------------------------------------
function lerConfigAntigo() {
  return ler("config.json", null);
}

module.exports = {
  DATA_DIR,
  DIR_LISTAS,
  DIR_ARQUIVOS,
  lerLog,
  registrarLog,
  lerTokens,
  gravarTokens,
  lerEstado,
  marcarEnvio,
  enviadosHoje,
  lerProtecao,
  gravarProtecao,
  PROTECAO_PADRAO,
  adicionarOptOut,
  removerOptOut,
  lerCampanhas,
  gravarCampanhas,
  lerLista,
  gravarLista,
  apagarLista,
  salvarArquivoOriginal,
  caminhoArquivoOriginal,
  apagarArquivoOriginal,
  lerConfigAntigo,
};
