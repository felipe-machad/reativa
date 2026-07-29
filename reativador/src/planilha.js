// ============================================================
// planilha.js — tudo que envolve planilha de contatos:
//   lerContatos(buffer, nomeArquivo) -> extrai telefone + nome
//   modeloCsv() / modeloXlsx()       -> arquivo modelo pra download
//   relatorioXlsx(campanha, lista)   -> planilha de resultados
//
// Aceita .xlsx, .csv e .txt. Só precisa ter uma coluna de telefone
// e uma de nome — o nome do cabeçalho pode variar
// (telefone / celular / whatsapp / fone / numero…).
// Sem nenhuma dependência: o .xlsx é lido/gerado pelo xlsx-lite.
// ============================================================
const { lerXlsx, criarXlsx } = require("./xlsx-lite");
const { formatarNumero } = require("./evolution");

// nomes de cabeçalho aceitos, em ordem de preferência
const CABECALHO_TELEFONE = [
  "telefone", "celular", "whatsapp", "whats", "fone", "telefonecelular",
  "numero", "num", "tel", "phone", "mobile", "contato",
];
const CABECALHO_NOME = ["nome", "name", "cliente", "razaosocial", "razao", "nomecliente", "primeironome", "pessoa"];

function normalizar(v) {
  return String(v == null ? "" : v)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Excel no Brasil salva CSV em ANSI (latin1) com frequência. Se o
// arquivo não for UTF-8 válido, decodifica como latin1 pra não
// estragar os acentos.
function decodificarTexto(buffer) {
  let buf = buffer;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8"); // tinha BOM: é UTF-8
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return buf.toString("latin1");
  }
}

function extensaoDe(nomeArquivo) {
  const m = String(nomeArquivo || "").toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : "";
}

// ---------------------------------------------------------------
// CSV: detecta o separador e respeita campos entre aspas
// ---------------------------------------------------------------
function detectarSeparador(texto) {
  const amostra = texto.split(/\r?\n/).slice(0, 5).join("\n");
  const candidatos = [";", ",", "\t", "|"];
  let melhor = ";";
  let maior = -1;
  for (const sep of candidatos) {
    const qtd = amostra.split(sep).length - 1;
    if (qtd > maior) {
      maior = qtd;
      melhor = sep;
    }
  }
  return maior > 0 ? melhor : ";";
}

function lerCsv(texto) {
  const sep = detectarSeparador(texto);
  const linhas = [];
  let campo = "";
  let linha = [];
  let dentroDeAspas = false;

  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];

    if (dentroDeAspas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else dentroDeAspas = false;
      } else campo += ch;
      continue;
    }

    if (ch === '"') { dentroDeAspas = true; continue; }
    if (ch === sep) { linha.push(campo); campo = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { linha.push(campo); linhas.push(linha); linha = []; campo = ""; continue; }
    campo += ch;
  }
  if (campo !== "" || linha.length) { linha.push(campo); linhas.push(linha); }

  // mantém a numeração real das linhas (pra mensagem de erro fazer sentido),
  // só corta as linhas vazias do fim
  const limpas = linhas.map((l) => l.map((c) => String(c).trim()));
  while (limpas.length && limpas[limpas.length - 1].every((c) => c === "")) limpas.pop();
  return limpas;
}

function paraMatriz(buffer, nomeArquivo) {
  const ext = extensaoDe(nomeArquivo);
  if (ext === ".xlsx" || ext === ".xlsm") return lerXlsx(buffer);
  if (ext === ".xls") {
    // .xls antigo (binário) não é suportado — o arquivo é um formato diferente
    if (buffer.subarray(0, 2).toString("hex") !== "504b") {
      throw new Error(
        "Arquivo .xls antigo não é suportado. Abra no Excel e salve como .xlsx (ou CSV) antes de subir."
      );
    }
    return lerXlsx(buffer);
  }
  return lerCsv(decodificarTexto(buffer));
}

function acharColuna(linha, alvos) {
  const normalizadas = (linha || []).map(normalizar);
  for (const alvo of alvos) {
    const i = normalizadas.indexOf(alvo);
    if (i >= 0) return i;
  }
  for (const alvo of alvos) {
    const i = normalizadas.findIndex((c) => c && c.includes(alvo));
    if (i >= 0) return i;
  }
  return -1;
}

function pareceTelefone(v) {
  const d = String(v || "").replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15;
}

/**
 * Lê os contatos de uma planilha.
 * @returns {{contatos, total, invalidos, duplicados, colunas, aviso, exemplosInvalidos}}
 */
function lerContatos(buffer, nomeArquivo) {
  const matriz = paraMatriz(buffer, nomeArquivo);
  if (!matriz.length) throw new Error("A planilha não tem nenhuma linha com conteúdo.");

  let idxTel = -1;
  let idxNome = -1;
  let linhaInicial = 0;
  let aviso = "";

  // procura o cabeçalho nas 6 primeiras linhas
  for (let i = 0; i < Math.min(6, matriz.length); i++) {
    const t = acharColuna(matriz[i], CABECALHO_TELEFONE);
    if (t >= 0) {
      idxTel = t;
      idxNome = acharColuna(matriz[i], CABECALHO_NOME);
      if (idxNome === idxTel) idxNome = -1;
      linhaInicial = i + 1;
      break;
    }
  }

  // sem cabeçalho reconhecível: assume coluna A = telefone, B = nome
  if (idxTel < 0) {
    const primeira = matriz.findIndex((l) => l && l.some((c) => String(c).trim() !== ""));
    const linha0 = matriz[primeira] || [];
    idxTel = 0;
    idxNome = linha0.length > 1 ? 1 : -1;
    linhaInicial = pareceTelefone(linha0[0]) ? primeira : primeira + 1;
    aviso =
      "Não encontrei as colunas 'telefone' e 'nome' no cabeçalho — usei a 1ª coluna como telefone e a 2ª como nome. Confira a prévia.";
  }

  const contatos = [];
  const vistos = new Set();
  const exemplosInvalidos = [];
  let invalidos = 0;
  let duplicados = 0;

  for (let i = linhaInicial; i < matriz.length; i++) {
    const linha = matriz[i] || [];
    const bruto = linha[idxTel];
    if (bruto == null || String(bruto).trim() === "") continue;

    const numero = formatarNumero(bruto);
    if (!numero) {
      invalidos++;
      if (exemplosInvalidos.length < 5) exemplosInvalidos.push(`linha ${i + 1}: "${String(bruto).slice(0, 30)}"`);
      continue;
    }
    if (vistos.has(numero)) {
      duplicados++;
      continue;
    }
    vistos.add(numero);

    const nome = idxNome >= 0 ? String(linha[idxNome] == null ? "" : linha[idxNome]).trim() : "";
    contatos.push({ numero, nome });
  }

  if (!contatos.length) {
    throw new Error(
      "Nenhum telefone válido encontrado. A planilha precisa de uma coluna 'telefone' (com DDD) e uma coluna 'nome'." +
        (exemplosInvalidos.length ? ` Exemplos do que não deu: ${exemplosInvalidos.join("; ")}` : "")
    );
  }

  return {
    contatos,
    total: contatos.length,
    invalidos,
    duplicados,
    colunas: { telefone: idxTel, nome: idxNome },
    aviso,
    exemplosInvalidos,
  };
}

// ---------------------------------------------------------------
// MODELO PRA DOWNLOAD
// ---------------------------------------------------------------
const EXEMPLOS = [
  ["51999990001", "Maria Silva"],
  ["11988887777", "João Pereira"],
  ["5551997776666", "Ana Souza"],
];

const INSTRUCOES = [
  ["Como preencher esta planilha"],
  [""],
  ["1. Use a aba 'contatos'. Não mude os nomes das colunas: telefone e nome."],
  ["2. telefone: sempre com DDD. Pode ser 51999990001 ou 5551999990001, com ou sem parênteses e traço."],
  ["3. nome: opcional, mas recomendado. É o que entra no lugar de {nome} na mensagem."],
  ["4. Apague as 3 linhas de exemplo antes de subir a planilha."],
  ["5. Salve como .xlsx (ou CSV) e envie no painel, dentro da campanha."],
  [""],
  ["Telefones repetidos são enviados uma única vez."],
  ["Quem já respondeu PARE nunca recebe, mesmo estando na planilha."],
  ["Telefones sem DDD ou incompletos são ignorados e aparecem no relatório."],
];

function modeloCsv() {
  // ';' como separador e BOM na frente: abre certinho no Excel em português
  const linhas = [["telefone", "nome"], ...EXEMPLOS].map((l) => l.join(";"));
  return Buffer.from("\uFEFF" + linhas.join("\r\n") + "\r\n", "utf8");
}

function modeloXlsx() {
  return criarXlsx([
    { nome: "contatos", linhas: [["telefone", "nome"], ...EXEMPLOS], larguras: [22, 34] },
    { nome: "como preencher", linhas: INSTRUCOES, larguras: [110], congelarPrimeiraLinha: false },
  ]);
}

// ---------------------------------------------------------------
// RELATÓRIO DE ENVIOS DA CAMPANHA
// ---------------------------------------------------------------
const ROTULO_STATUS = {
  pendente: "Na fila",
  enviado: "Enviado",
  erro: "Erro no envio",
  optout: "Pediu PARE",
  invalido: "Telefone inválido",
};

function relatorioXlsx(campanha, lista) {
  const contatos = lista.contatos || [];
  const conta = (s) => contatos.filter((c) => c.status === s).length;

  const dados = [["telefone", "nome", "status", "enviado em", "observação"]];
  for (const c of contatos) {
    dados.push([
      c.numero,
      c.nome || "",
      ROTULO_STATUS[c.status] || c.status || "",
      c.enviadoEm ? c.enviadoEm.slice(0, 19).replace("T", " ") : "",
      c.erro || "",
    ]);
  }

  const resumo = [
    ["Campanha", campanha.nome],
    ["Tipo", campanha.tipo === "bling" ? "Reativação Bling" : "Lista de planilha"],
    ["Planilha importada", lista.arquivo || "—"],
    ["Importada em", lista.importadoEm ? lista.importadoEm.slice(0, 19).replace("T", " ") : "—"],
    [""],
    ["Contatos na lista", String(contatos.length)],
    ["Enviados", String(conta("enviado"))],
    ["Na fila", String(conta("pendente"))],
    ["Erros", String(conta("erro"))],
    ["Pediram PARE", String(conta("optout"))],
    ["Telefones inválidos", String(conta("invalido"))],
    [""],
    ["Ignorados na importação (inválidos)", String(lista.invalidos || 0)],
    ["Ignorados na importação (repetidos)", String(lista.duplicados || 0)],
  ];

  return criarXlsx([
    { nome: "resumo", linhas: resumo, larguras: [38, 46], congelarPrimeiraLinha: false },
    { nome: "contatos", linhas: dados, larguras: [18, 30, 18, 20, 50] },
  ]);
}

module.exports = { lerContatos, modeloCsv, modeloXlsx, relatorioXlsx, extensaoDe, lerCsv };
