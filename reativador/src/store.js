// ============================================================
// "Banco de dados" em arquivo JSON — sem dependência externa.
// Tudo fica em DATA_DIR (volume persistente no EasyPanel).
//
//   config.json  -> o que o usuário configura pelo painel
//   tokens.json  -> tokens OAuth do Bling
//   estado.json  -> histórico de envios + opt-outs
// ============================================================
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/data";

function caminho(nome) {
  return path.join(DATA_DIR, nome);
}

function ler(nome, padrao) {
  try {
    return JSON.parse(fs.readFileSync(caminho(nome), "utf8"));
  } catch {
    return padrao;
  }
}

function gravar(nome, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // grava num tmp e renomeia: evita arquivo corrompido se o processo cair no meio
  const tmp = caminho(nome + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, caminho(nome));
}

// ---------- config (o que o painel edita) ----------
const CONFIG_PADRAO = {
  ativo: false,               // campanha ligada/desligada
  texto: "Oi, {nome}! Faz um tempo desde sua última compra e queria saber se está tudo certo por aí. Se precisar de reposição, é só responder aqui. _Se preferir não receber mais mensagens, responda PARE._",
  imagemUrl: "",              // vazio = manda só texto
  hyperlink: "",              // opcional, vai no fim da mensagem
  numerosExtras: [],          // [{ numero: "5551999999999", nome: "Fulano" }]
};

function lerConfig() {
  return { ...CONFIG_PADRAO, ...ler("config.json", {}) };
}
function gravarConfig(cfg) {
  gravar("config.json", cfg);
}

// ---------- tokens OAuth do Bling ----------
function lerTokens() {
  return ler("tokens.json", null);
}
function gravarTokens(t) {
  gravar("tokens.json", t);
}

// ---------- estado (envios + opt-out) ----------
// estado.envios = { [idContato]: "2026-07-21T..." }  (último envio)
// estado.optOut = ["5551999999999", ...]              (números que pediram PARE)
// estado.log    = últimos N eventos pra mostrar no painel
function lerEstado() {
  return ler("estado.json", { envios: {}, optOut: [], log: [] });
}
function gravarEstado(e) {
  // mantém o log enxuto
  e.log = (e.log || []).slice(-200);
  gravar("estado.json", e);
}

function registrarLog(msg) {
  const e = lerEstado();
  e.log.push({ quando: new Date().toISOString(), msg });
  gravarEstado(e);
  console.log(`[log] ${msg}`);
}

module.exports = {
  lerConfig, gravarConfig,
  lerTokens, gravarTokens,
  lerEstado, gravarEstado,
  registrarLog,
};
