// ============================================================
// xlsx-lite.js — leitor e gerador de .xlsx sem nenhuma dependência.
//
// Por que escrever isso em vez de usar uma lib?
//   As bibliotecas populares de xlsx (sheetjs, exceljs) arrastam
//   vulnerabilidades conhecidas e/ou dezenas de pacotes. Aqui a gente
//   só precisa de duas coisas simples: ler uma planilha de contatos
//   (texto em células) e gerar uma planilha simples. Um .xlsx é um
//   zip com XMLs dentro, e o Node já traz zlib.
//
// O que tem aqui:
//   lerXlsx(buffer)  -> matriz de strings [[a1,b1],[a2,b2],…]
//   criarXlsx(abas)  -> Buffer do arquivo .xlsx
// ============================================================
const zlib = require("zlib");

// ---------------------------------------------------------------
// ZIP: leitura
// ---------------------------------------------------------------
function lerZip(buffer) {
  const arquivos = new Map();

  // acha o "End of Central Directory" (varre do fim pra trás)
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Arquivo .xlsx inválido (não parece um arquivo do Excel).");

  const totalEntradas = buffer.readUInt16LE(eocd + 10);
  let ponteiro = buffer.readUInt32LE(eocd + 16);

  for (let n = 0; n < totalEntradas; n++) {
    if (buffer.readUInt32LE(ponteiro) !== 0x02014b50) break;
    const metodo = buffer.readUInt16LE(ponteiro + 10);
    const tamanhoComprimido = buffer.readUInt32LE(ponteiro + 20);
    const tamanhoNome = buffer.readUInt16LE(ponteiro + 28);
    const tamanhoExtra = buffer.readUInt16LE(ponteiro + 30);
    const tamanhoComentario = buffer.readUInt16LE(ponteiro + 32);
    const inicioLocal = buffer.readUInt32LE(ponteiro + 42);
    const nome = buffer.toString("utf8", ponteiro + 46, ponteiro + 46 + tamanhoNome);

    // pula pro cabeçalho local pra descobrir onde os dados começam
    if (buffer.readUInt32LE(inicioLocal) === 0x04034b50) {
      const nomeLocal = buffer.readUInt16LE(inicioLocal + 26);
      const extraLocal = buffer.readUInt16LE(inicioLocal + 28);
      const inicioDados = inicioLocal + 30 + nomeLocal + extraLocal;
      const bruto = buffer.subarray(inicioDados, inicioDados + tamanhoComprimido);
      try {
        arquivos.set(nome, metodo === 0 ? Buffer.from(bruto) : zlib.inflateRawSync(bruto));
      } catch {
        /* entrada corrompida: ignora */
      }
    }
    ponteiro += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }
  return arquivos;
}

// ---------------------------------------------------------------
// ZIP: escrita
// ---------------------------------------------------------------
const TABELA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// data fixa (2020-01-01 00:00) — arquivo gerado é sempre idêntico
const DOS_HORA = 0;
const DOS_DATA = ((2020 - 1980) << 9) | (1 << 5) | 1;

function criarZip(entradas) {
  const locais = [];
  const centrais = [];
  let offset = 0;

  for (const { nome, conteudo } of entradas) {
    const dados = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, "utf8");
    const comprimido = zlib.deflateRawSync(dados, { level: 9 });
    const nomeBuf = Buffer.from(nome, "utf8");
    const crc = crc32(dados);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versão necessária
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_HORA, 10);
    local.writeUInt16LE(DOS_DATA, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nomeBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locais.push(local, nomeBuf, comprimido);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_HORA, 12);
    central.writeUInt16LE(DOS_DATA, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(dados.length, 24);
    central.writeUInt16LE(nomeBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrais.push(central, nomeBuf);

    offset += local.length + nomeBuf.length + comprimido.length;
  }

  const corpo = Buffer.concat(locais);
  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(0, 4);
  fim.writeUInt16LE(0, 6);
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(corpo.length, 16);
  fim.writeUInt16LE(0, 20);

  return Buffer.concat([corpo, diretorio, fim]);
}

// ---------------------------------------------------------------
// XML: utilidades
// ---------------------------------------------------------------
function desescapar(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

function escapar(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // remove caracteres de controle que o Excel rejeita
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

// junta todos os <t>…</t> de um bloco (cobre texto com formatação misturada)
function textoDosT(xml) {
  const partes = [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => desescapar(m[1]));
  return partes.join("");
}

function colunaParaIndice(ref) {
  const letras = String(ref || "").match(/^[A-Z]+/i);
  if (!letras) return null;
  let n = 0;
  for (const ch of letras[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function indiceParaColuna(i) {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// número do Excel -> texto legível (evita 5.19999E+10 em telefone)
function numeroParaTexto(v) {
  if (!/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(v)) return v;
  const n = Number(v);
  if (!isFinite(n)) return v;
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toLocaleString("fullwide", { useGrouping: false });
  return String(n);
}

// ---------------------------------------------------------------
// LEITURA DE .XLSX
//   lerAbas(buffer)  -> [{ nome, matriz }] na ordem do arquivo
//   lerXlsx(buffer)  -> matriz da primeira aba (atalho)
// ---------------------------------------------------------------
function lerAbas(buffer) {
  const zip = lerZip(buffer);

  // textos compartilhados
  const compartilhados = [];
  const ss = zip.get("xl/sharedStrings.xml");
  if (ss) {
    const xml = ss.toString("utf8");
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) compartilhados.push(textoDosT(m[1]));
  }

  // descobre as abas na ordem do workbook (nome + arquivo de cada uma)
  const abas = [];
  const wb = zip.get("xl/workbook.xml");
  const rels = zip.get("xl/_rels/workbook.xml.rels");
  if (wb && rels) {
    const textoRels = rels.toString("utf8");
    for (const m of wb.toString("utf8").matchAll(/<sheet\b([^>]*)\/?>/g)) {
      const attrs = m[1];
      const idRel = (attrs.match(/r:id="([^"]+)"/) || [])[1];
      const nome = desescapar((attrs.match(/name="([^"]*)"/) || [])[1] || "");
      if (!idRel) continue;
      const rel = textoRels.match(new RegExp(`<Relationship[^>]*Id="${idRel}"[^>]*Target="([^"]+)"`));
      if (!rel) continue;
      const caminho = ("xl/" + rel[1].replace(/^\/?xl\//, "").replace(/^\//, "")).replace(/\/{2,}/g, "/");
      if (zip.has(caminho)) abas.push({ nome, caminho });
    }
  }
  if (!abas.length) {
    for (const k of zip.keys()) if (/^xl\/worksheets\/.*\.xml$/.test(k)) abas.push({ nome: k, caminho: k });
  }
  if (!abas.length) throw new Error("Não achei nenhuma aba dentro do arquivo .xlsx.");

  return abas.map(({ nome, caminho }) => ({
    nome,
    matriz: lerMatriz(zip.get(caminho).toString("utf8"), compartilhados),
  }));
}

function lerMatriz(xml, compartilhados) {
  const matriz = [];

  for (const linhaMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const attrs = linhaMatch[1];
    const conteudo = linhaMatch[2];
    const numeroLinha = parseInt((attrs.match(/\br="(\d+)"/) || [])[1] || "0", 10);
    const linha = [];
    let proximaColuna = 0;

    for (const celulaMatch of conteudo.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrsCelula = celulaMatch[1];
      const dentro = celulaMatch[2] || "";
      const ref = (attrsCelula.match(/\br="([A-Z]+\d+)"/i) || [])[1];
      const tipo = (attrsCelula.match(/\bt="([^"]+)"/) || [])[1] || "n";
      const coluna = ref ? colunaParaIndice(ref) : proximaColuna;
      proximaColuna = coluna + 1;

      let valor = "";
      if (tipo === "s") {
        const idx = parseInt(textoEntre(dentro, "v") || "-1", 10);
        valor = compartilhados[idx] != null ? compartilhados[idx] : "";
      } else if (tipo === "inlineStr") {
        valor = textoDosT(dentro);
      } else if (tipo === "str") {
        valor = desescapar(textoEntre(dentro, "v") || "");
      } else if (tipo === "b") {
        valor = textoEntre(dentro, "v") === "1" ? "VERDADEIRO" : "FALSO";
      } else {
        const cru = textoEntre(dentro, "v");
        valor = cru == null ? "" : numeroParaTexto(desescapar(cru));
      }
      linha[coluna] = valor;
    }

    // preenche buracos com string vazia
    for (let i = 0; i < linha.length; i++) if (linha[i] == null) linha[i] = "";
    if (numeroLinha > 0) matriz[numeroLinha - 1] = linha;
    else matriz.push(linha);
  }

  // mantém a posição real das linhas (buracos viram []), só corta o vazio do fim
  for (let i = 0; i < matriz.length; i++) if (!matriz[i]) matriz[i] = [];
  while (matriz.length && matriz[matriz.length - 1].every((c) => String(c).trim() === "")) matriz.pop();
  return matriz;
}

function textoEntre(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

// atalho: matriz da primeira aba
function lerXlsx(buffer) {
  const abas = lerAbas(buffer);
  return abas.length ? abas[0].matriz : [];
}

// ---------------------------------------------------------------
// GERAÇÃO DE .XLSX
//   abas: [{ nome, linhas: [[...]], larguras: [20, 32] }]
//   Tudo é gravado como texto (inlineStr): telefone nunca vira
//   número em notação científica.
// ---------------------------------------------------------------
function limparNomeAba(nome, indice) {
  const limpo = String(nome || `Planilha${indice + 1}`)
    .replace(/[\\\/\?\*\[\]:]/g, " ")
    .trim()
    .slice(0, 31);
  return limpo || `Planilha${indice + 1}`;
}

function xmlDaAba(aba) {
  const cols =
    aba.larguras && aba.larguras.length
      ? `<cols>${aba.larguras
          .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Number(w) || 16}" customWidth="1"/>`)
          .join("")}</cols>`
      : "";

  const linhas = (aba.linhas || [])
    .map((linha, l) => {
      const celulas = (linha || [])
        .map((valor, c) => {
          const texto = valor == null ? "" : String(valor);
          if (texto === "") return "";
          return `<c r="${indiceParaColuna(c)}${l + 1}" t="inlineStr"><is><t xml:space="preserve">${escapar(
            texto
          )}</t></is></c>`;
        })
        .join("");
      return `<row r="${l + 1}">${celulas}</row>`;
    })
    .join("");

  const congelar =
    aba.congelarPrimeiraLinha === false
      ? ""
      : `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${congelar}${cols}<sheetData>${linhas}</sheetData></worksheet>`;
}

function criarXlsx(abas) {
  const lista = (Array.isArray(abas) ? abas : [abas]).map((a, i) => ({
    ...a,
    nome: limparNomeAba(a.nome, i),
  }));

  const entradas = [];

  entradas.push({
    nome: "[Content_Types].xml",
    conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${lista
  .map(
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )
  .join("\n")}
</Types>`,
  });

  entradas.push({
    nome: "_rels/.rels",
    conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  });

  entradas.push({
    nome: "xl/workbook.xml",
    conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${lista
      .map((a, i) => `<sheet name="${escapar(a.nome)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("")}</sheets>
</workbook>`,
  });

  entradas.push({
    nome: "xl/_rels/workbook.xml.rels",
    conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${lista
  .map(
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${
        i + 1
      }.xml"/>`
  )
  .join("\n")}
</Relationships>`,
  });

  lista.forEach((aba, i) => {
    entradas.push({ nome: `xl/worksheets/sheet${i + 1}.xml`, conteudo: xmlDaAba(aba) });
  });

  return criarZip(entradas);
}

module.exports = { lerXlsx, lerAbas, criarXlsx, lerZip, criarZip };
