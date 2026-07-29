// ============================================================
// campanhas.js — cadastro de campanhas (CRUD) em cima do store.
//
// Dois tipos de campanha:
//   tipo "bling"    -> a automação original: acha quem sumiu no Bling
//                      e manda mensagem. Existe uma só, não se apaga.
//   tipo "planilha" -> a pessoa sobe uma planilha (telefone + nome)
//                      e a campanha envia pra aquela lista.
//
// Dois modos de disparo (vale pros dois tipos):
//   "agendada" -> roda sozinha, nos dias/horário configurados
//   "manual"   -> só roda quando alguém clica em "Disparar agora"
// ============================================================
const crypto = require("crypto");
const {
  lerCampanhas,
  gravarCampanhas,
  lerLista,
  apagarLista,
  apagarArquivoOriginal,
  registrarLog,
  lerConfigAntigo,
} = require("./store");
const { formatarNumero } = require("./evolution");

// Os textos padrão já vêm com variações {a|b}: cada pessoa recebe uma
// combinação diferente, o que ajuda o número a não ser visto como robô.
const TEXTO_PADRAO_BLING =
  "{Oi|Olá|Oi, tudo bem}, {nome}! {Faz um tempo desde sua última compra|Notei que faz um tempinho que você não compra com a gente} " +
  "e queria saber se está tudo certo por aí. Se precisar de reposição, {é só responder aqui|me chama por aqui}. " +
  "_Se preferir não receber mais mensagens, responda PARE._";

const TEXTO_PADRAO_PLANILHA =
  "{Oi|Olá|Bom te falar}, {nome}! {Passando pra avisar de uma novidade|Separei uma novidade} que acho que vai te interessar. " +
  "_Se preferir não receber mais mensagens, responda PARE._";

// padrões que vêm do ambiente
// Teto por rodada baixo de propósito: o envio é fatiado em várias rodadas
// ao longo do dia em vez de sair tudo de uma vez (proteção do número).
const PADRAO_TETO = parseInt(process.env.TETO_ENVIOS || "12", 10);
const PADRAO_COOLDOWN = parseInt(process.env.COOLDOWN_DIAS || "30", 10);
const PADRAO_HORA_INI = parseInt(process.env.HORARIO_INICIO || "9", 10);
const PADRAO_HORA_FIM = parseInt(process.env.HORARIO_FIM || "19", 10);

function novoId() {
  return "cmp_" + crypto.randomBytes(5).toString("hex");
}

function agora() {
  return new Date().toISOString();
}

function inteiro(v, padrao, min, max) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return padrao;
  return Math.min(max, Math.max(min, n));
}

function baseCampanha(tipo) {
  return {
    id: novoId(),
    nome: tipo === "bling" ? "Reativação Bling" : "Nova campanha",
    tipo, // "bling" | "planilha"
    ativo: false,
    modo: "manual", // "agendada" | "manual"

    // mensagem
    texto: tipo === "bling" ? TEXTO_PADRAO_BLING : TEXTO_PADRAO_PLANILHA,
    imagemUrl: "",
    hyperlink: "",

    // ritmo de envio (a pausa entre mensagens fica na Proteção do número)
    tetoPorRodada: PADRAO_TETO, // quantas mensagens por rodada, no máximo
    cooldownDias: tipo === "bling" ? PADRAO_COOLDOWN : 0, // não repete pro mesmo número antes disso
    intervaloMin: tipo === "bling" ? 60 : 20, // espera mínima entre rodadas desta campanha

    // janela de disparo (só usada no modo "agendada")
    diasSemana: [1, 2, 3, 4, 5], // 0=dom … 6=sáb
    horaInicio: PADRAO_HORA_INI,
    horaFim: PADRAO_HORA_FIM,

    // números avulsos, além da planilha/Bling
    numerosExtras: [],

    // específico do tipo bling
    janelaDias: 90,

    // dados da planilha importada (o conteúdo fica em listas/<id>.json)
    arquivo: null, // { nome, importadoEm, total, invalidos, duplicados }

    // controle
    status: "rascunho", // rascunho | pronta | concluida
    emAndamento: false, // ligado pelo botão "Disparar": a lista continua saindo em fatias
    ultimaRodada: null,
    stats: { enviados: 0, erros: 0, rodadas: 0 },
    criadoEm: agora(),
    atualizadoEm: agora(),
  };
}

// ---------------------------------------------------------------
// Migração: primeira subida com esta versão cria a campanha Bling
// aproveitando o que já estava no config.json antigo.
// ---------------------------------------------------------------
function garantirCampanhaBling() {
  let campanhas = lerCampanhas();
  if (campanhas.some((c) => c.tipo === "bling")) return campanhas;

  const c = baseCampanha("bling");
  const antigo = lerConfigAntigo();
  if (antigo) {
    if (typeof antigo.texto === "string" && antigo.texto.trim()) c.texto = antigo.texto;
    if (typeof antigo.imagemUrl === "string") c.imagemUrl = antigo.imagemUrl;
    if (typeof antigo.hyperlink === "string") c.hyperlink = antigo.hyperlink;
    if (Array.isArray(antigo.numerosExtras)) c.numerosExtras = antigo.numerosExtras;
    if (typeof antigo.ativo === "boolean") c.ativo = antigo.ativo;
  }
  c.modo = "agendada"; // a reativação do Bling é automática por natureza
  c.status = "pronta";

  campanhas = [c, ...campanhas];
  gravarCampanhas(campanhas);
  registrarLog(
    antigo
      ? "Configuração antiga migrada para a campanha 'Reativação Bling'."
      : "Campanha 'Reativação Bling' criada (primeira execução)."
  );
  return campanhas;
}

function listar() {
  return lerCampanhas();
}

function buscar(id) {
  return lerCampanhas().find((c) => c.id === id) || null;
}

function criar(dados = {}) {
  const tipo = dados.tipo === "bling" ? "bling" : "planilha";
  if (tipo === "bling" && lerCampanhas().some((c) => c.tipo === "bling")) {
    throw new Error("Já existe a campanha de reativação do Bling. Edite a existente.");
  }
  const nova = aplicar(baseCampanha(tipo), dados, true);
  const campanhas = lerCampanhas();
  campanhas.push(nova);
  gravarCampanhas(campanhas);
  registrarLog(`Campanha criada: "${nova.nome}".`, nova.nome);
  return nova;
}

// aplica só os campos que vieram, validando cada um
function aplicar(atual, dados, criando = false) {
  const c = { ...atual };

  if (typeof dados.nome === "string" && dados.nome.trim()) c.nome = dados.nome.trim().slice(0, 80);
  if (typeof dados.ativo === "boolean") c.ativo = dados.ativo;
  if (dados.modo === "agendada" || dados.modo === "manual") c.modo = dados.modo;

  if (typeof dados.texto === "string" && dados.texto.trim()) c.texto = dados.texto.slice(0, 4000);
  if (typeof dados.imagemUrl === "string") c.imagemUrl = dados.imagemUrl.trim();
  if (typeof dados.hyperlink === "string") c.hyperlink = dados.hyperlink.trim();

  if (dados.tetoPorRodada !== undefined) c.tetoPorRodada = inteiro(dados.tetoPorRodada, c.tetoPorRodada, 1, 200);
  if (dados.cooldownDias !== undefined) c.cooldownDias = inteiro(dados.cooldownDias, c.cooldownDias, 0, 3650);
  if (typeof dados.emAndamento === "boolean") c.emAndamento = dados.emAndamento;
  if (dados.intervaloMin !== undefined) c.intervaloMin = inteiro(dados.intervaloMin, c.intervaloMin, 0, 10080);
  if (dados.janelaDias !== undefined) c.janelaDias = inteiro(dados.janelaDias, c.janelaDias, 7, 365);

  if (dados.horaInicio !== undefined) c.horaInicio = inteiro(dados.horaInicio, c.horaInicio, 0, 23);
  if (dados.horaFim !== undefined) c.horaFim = inteiro(dados.horaFim, c.horaFim, 1, 24);
  if (c.horaFim <= c.horaInicio) c.horaFim = Math.min(24, c.horaInicio + 1);

  if (Array.isArray(dados.diasSemana)) {
    const dias = [...new Set(dados.diasSemana.map((d) => parseInt(d, 10)).filter((d) => d >= 0 && d <= 6))];
    c.diasSemana = dias.length ? dias.sort() : c.diasSemana;
  }

  if (Array.isArray(dados.numerosExtras)) {
    c.numerosExtras = dados.numerosExtras
      .map((n) => ({
        numero: formatarNumero(n && n.numero) || "",
        nome: String((n && n.nome) || "").trim().slice(0, 80),
      }))
      .filter((n) => n.numero);
  }

  // status derivado: campanha de planilha sem planilha é rascunho
  if (c.tipo === "planilha") {
    const lista = criando ? { contatos: [] } : lerLista(c.id);
    const pendentes = (lista.contatos || []).filter((x) => x.status === "pendente").length;
    const total = (lista.contatos || []).length;
    if (!total) c.status = "rascunho";
    else if (pendentes === 0) c.status = "concluida";
    else c.status = "pronta";
  } else {
    c.status = "pronta";
  }

  // não deixa ativar campanha de planilha sem contatos pendentes
  if (c.ativo && c.tipo === "planilha" && c.status !== "pronta") c.ativo = false;
  if (c.status === "concluida") c.emAndamento = false;

  c.atualizadoEm = agora();
  return c;
}

function atualizar(id, dados) {
  const campanhas = lerCampanhas();
  const i = campanhas.findIndex((c) => c.id === id);
  if (i < 0) throw new Error("Campanha não encontrada.");
  campanhas[i] = aplicar(campanhas[i], dados);
  gravarCampanhas(campanhas);
  return campanhas[i];
}

// salva o objeto inteiro (usado pelo agendador pra gravar stats/progresso)
function salvar(campanha) {
  const campanhas = lerCampanhas();
  const i = campanhas.findIndex((c) => c.id === campanha.id);
  if (i < 0) return null;
  campanhas[i] = { ...campanha, atualizadoEm: agora() };
  gravarCampanhas(campanhas);
  return campanhas[i];
}

function remover(id) {
  const campanhas = lerCampanhas();
  const alvo = campanhas.find((c) => c.id === id);
  if (!alvo) throw new Error("Campanha não encontrada.");
  if (alvo.tipo === "bling") throw new Error("A campanha de reativação do Bling não pode ser excluída — desative-a se não quiser usar.");
  gravarCampanhas(campanhas.filter((c) => c.id !== id));
  apagarLista(id);
  apagarArquivoOriginal(id);
  registrarLog(`Campanha excluída: "${alvo.nome}".`, alvo.nome);
  return true;
}

module.exports = {
  garantirCampanhaBling,
  listar,
  buscar,
  criar,
  atualizar,
  salvar,
  remover,
  TEXTO_PADRAO_PLANILHA,
  TEXTO_PADRAO_BLING,
};
