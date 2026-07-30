// ============================================================
// testes/smoke.js — testes rápidos, sem framework.
// Rode com: npm run teste
// ============================================================
process.env.DATA_DIR = process.env.DATA_DIR || "/tmp/reativador-teste";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const { formatarNumero, montarTexto, primeiroNome, aplicarVariacoes } = require("../src/evolution");
const { lerContatos, modeloCsv, modeloXlsx, relatorioXlsx, lerCsv } = require("../src/planilha");
const { lerXlsx, criarXlsx } = require("../src/xlsx-lite");
const { calculaJanelas, detectaSumidos } = require("../src/churn");

let passou = 0;
function ok(nome, fn) {
  try {
    fn();
    passou++;
    console.log(`  ✓ ${nome}`);
  } catch (e) {
    console.error(`  ✗ ${nome}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("\n telefone");
ok("celular com DDD", () => assert.equal(formatarNumero("51999990001"), "5551999990001"));
ok("já com 55", () => assert.equal(formatarNumero("5551999990001"), "5551999990001"));
ok("formatado", () => assert.equal(formatarNumero("(51) 99999-0001"), "5551999990001"));
ok("com zero de operadora", () => assert.equal(formatarNumero("051999990001"), "5551999990001"));
ok("fixo com DDD", () => assert.equal(formatarNumero("5133334444"), "555133334444"));
ok("curto demais", () => assert.equal(formatarNumero("99990001"), null));
ok("vazio", () => assert.equal(formatarNumero(""), null));
ok("internacional", () => assert.equal(formatarNumero("351912345678"), "351912345678"));

console.log("\n mensagem");
ok("primeiro nome limpo", () => assert.equal(primeiroNome("MARIA DA SILVA LTDA"), "Maria"));
ok("nome vazio", () => assert.equal(primeiroNome(""), ""));
ok("substitui {nome}", () => assert.equal(montarTexto("Oi, {nome}!", "joão pereira", "", false), "Oi, João!"));
ok("sem nome tira o vocativo", () => assert.equal(montarTexto("Oi, {nome}! Tudo bem?", "", "", false), "Oi! Tudo bem?"));
ok("hyperlink no fim", () => assert.ok(montarTexto("Oi", "X", "https://a.com", false).endsWith("https://a.com")));
ok("variações sorteiam uma opção", () => {
  const saidas = new Set();
  for (let i = 0; i < 60; i++) saidas.add(aplicarVariacoes("{oi|olá|e aí} tudo bem"));
  assert.ok(saidas.size > 1, "deveria variar entre execuções");
  for (const s of saidas) assert.ok(/^(oi|olá|e aí) tudo bem$/.test(s), `saída estranha: ${s}`);
});

console.log("\n csv");
ok("ponto e vírgula com cabeçalho", () => {
  const r = lerContatos(Buffer.from("telefone;nome\n51999990001;Maria\n11988887777;João\n", "utf8"), "a.csv");
  assert.equal(r.total, 2);
  assert.equal(r.contatos[0].numero, "5551999990001");
  assert.equal(r.contatos[1].nome, "João");
});
ok("vírgula, colunas trocadas e cabeçalho alternativo", () => {
  const r = lerContatos(Buffer.from("Nome,Celular\nMaria Silva,(51) 99999-0001\n", "utf8"), "a.csv");
  assert.equal(r.total, 1);
  assert.equal(r.contatos[0].numero, "5551999990001");
  assert.equal(r.contatos[0].nome, "Maria Silva");
});
ok("latin1 mantém acento", () => {
  const r = lerContatos(Buffer.from("telefone;nome\r\n51999990001;João Ração\r\n", "latin1"), "a.csv");
  assert.equal(r.contatos[0].nome, "João Ração");
});
ok("campos entre aspas com vírgula dentro", () => {
  const r = lerContatos(Buffer.from('telefone,nome\n51999990001,"Silva, Maria"\n', "utf8"), "a.csv");
  assert.equal(r.contatos[0].nome, "Silva, Maria");
});
ok("sem cabeçalho", () => {
  const r = lerContatos(Buffer.from("51999990001;Maria\n11988887777;João\n", "utf8"), "a.csv");
  assert.equal(r.total, 2);
  assert.ok(r.aviso);
});
ok("duplicados e inválidos contados", () => {
  const r = lerContatos(
    Buffer.from("telefone;nome\n51999990001;Maria\n51999990001;Maria 2\nabc;Zé\n123;Nope\n", "utf8"),
    "a.csv"
  );
  assert.equal(r.total, 1);
  assert.equal(r.duplicados, 1);
  assert.equal(r.invalidos, 2);
});
ok("planilha só com inválidos dá erro claro", () => {
  assert.throws(
    () => lerContatos(Buffer.from("telefone;nome\nabc;Zé\n", "utf8"), "a.csv"),
    /Nenhum telefone válido/
  );
});
ok("tabulação", () => {
  const r = lerContatos(Buffer.from("telefone\tnome\n51999990001\tMaria\n", "utf8"), "a.txt");
  assert.equal(r.total, 1);
});

console.log("\n xlsx (leitura e escrita próprias)");
ok("round-trip: escreve e lê de volta", () => {
  const buf = criarXlsx([
    { nome: "contatos", linhas: [["telefone", "nome"], ["51999990001", "Maria & Cia <ok>"], ["11988887777", "João"]] },
  ]);
  const matriz = lerXlsx(buf);
  assert.deepEqual(matriz[0], ["telefone", "nome"]);
  assert.equal(matriz[1][1], "Maria & Cia <ok>");
  assert.equal(matriz[2][0], "11988887777");
});
ok("modelo .xlsx é lido como contatos", () => {
  const r = lerContatos(modeloXlsx(), "modelo.xlsx");
  assert.equal(r.total, 3);
  assert.equal(r.contatos[0].numero, "5551999990001");
});
ok("modelo .csv é lido como contatos", () => {
  const r = lerContatos(modeloCsv(), "modelo.csv");
  assert.equal(r.total, 3);
});
ok("relatório gera duas abas legíveis", () => {
  const buf = relatorioXlsx(
    { nome: "Teste", tipo: "planilha" },
    {
      arquivo: "lista.xlsx",
      importadoEm: "2026-07-29T10:00:00.000Z",
      invalidos: 1,
      duplicados: 2,
      contatos: [
        { numero: "5551999990001", nome: "Maria", status: "enviado", enviadoEm: "2026-07-29T12:00:00.000Z", erro: null },
        { numero: "5551999990002", nome: "João", status: "pendente", enviadoEm: null, erro: null },
      ],
    }
  );
  const matriz = lerXlsx(buf); // primeira aba = resumo
  assert.equal(matriz[0][0], "Campanha");
  assert.equal(matriz[0][1], "Teste");
  fs.writeFileSync("/tmp/relatorio-teste.xlsx", buf);
});
ok("acha os contatos mesmo quando estão na 2ª aba", () => {
  const buf = criarXlsx([
    { nome: "instruções", linhas: [["Leia antes de preencher"], ["Preencha a aba ao lado."]] },
    { nome: "contatos", linhas: [["telefone", "nome"], ["51999990001", "Maria"], ["11988887777", "João"]] },
  ]);
  const r = lerContatos(buf, "lista.xlsx");
  assert.equal(r.total, 2);
  assert.equal(r.aba, "contatos");
  assert.match(r.aviso, /aba "contatos"/);
});
ok("planilha sem telefone em nenhuma aba dá erro claro", () => {
  const buf = criarXlsx([
    { nome: "a", linhas: [["produto", "preço"], ["camiseta", "79,90"]] },
    { nome: "b", linhas: [["obs"], ["nada aqui"]] },
  ]);
  assert.throws(() => lerContatos(buf, "x.xlsx"), /Nenhum telefone válido/);
});
ok("arquivo corrompido dá erro amigável", () => {
  assert.throws(() => lerXlsx(Buffer.from("não sou um zip")), /inválido/i);
});
ok("xls antigo orienta a salvar como xlsx", () => {
  const falso = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(200)]);
  assert.throws(() => lerContatos(falso, "antigo.xls"), /salve como \.xlsx/i);
});

console.log("\n churn (quem sumiu)");
ok("janelas de 90 dias", () => {
  const j = calculaJanelas(90, new Date("2026-07-29T12:00:00Z"));
  assert.equal(j.recenteFim, "2026-07-29");
  assert.equal(j.recenteIni, "2026-04-30");
  assert.equal(j.anteriorFim, "2026-04-29");
  assert.equal(j.anteriorIni, "2026-01-30");
});
ok("detecta quem comprava e parou", () => {
  const antes = [
    { contato: { id: 1, nome: "Maria" }, total: 100, data: "2026-02-01" },
    { contato: { id: 2, nome: "João" }, total: 500, data: "2026-02-02" },
  ];
  const agora = [{ contato: { id: 1, nome: "Maria" }, total: 50, data: "2026-06-01" }];
  const sumidos = detectaSumidos(agora, antes);
  assert.equal(sumidos.length, 1);
  assert.equal(sumidos[0].nome, "João");
});

console.log("\n store + campanhas (grava em disco de verdade)");
const store = require("../src/store");
const campanhas = require("../src/campanhas");
ok("cria a campanha do Bling na primeira subida", () => {
  const lista = campanhas.garantirCampanhaBling();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].tipo, "bling");
});
ok("não duplica a campanha do Bling", () => {
  campanhas.garantirCampanhaBling();
  assert.equal(campanhas.listar().filter((c) => c.tipo === "bling").length, 1);
});
ok("não deixa criar uma segunda campanha do Bling", () => {
  assert.throws(() => campanhas.criar({ tipo: "bling", nome: "Outra" }), /já existe/i);
});
ok("cria campanha de planilha como rascunho", () => {
  const c = campanhas.criar({ nome: "Promo julho", texto: "Oi {nome}", ativo: true });
  assert.equal(c.tipo, "planilha");
  assert.equal(c.status, "rascunho");
  assert.equal(c.ativo, false, "não pode ativar sem lista");
});
ok("importa lista e vira 'pronta'", () => {
  const c = campanhas.listar().find((x) => x.tipo === "planilha");
  const r = lerContatos(Buffer.from("telefone;nome\n51999990001;Maria\n11988887777;João\n", "utf8"), "l.csv");
  store.gravarLista(c.id, {
    arquivo: "l.csv",
    importadoEm: new Date().toISOString(),
    total: r.total,
    invalidos: r.invalidos,
    duplicados: r.duplicados,
    contatos: r.contatos.map((x) => ({ ...x, status: "pendente", enviadoEm: null, erro: null })),
  });
  const atualizada = campanhas.atualizar(c.id, { ativo: true });
  assert.equal(atualizada.status, "pronta");
  assert.equal(atualizada.ativo, true);
});
ok("opt-out não duplica", () => {
  assert.equal(store.adicionarOptOut("5551999990001"), true);
  assert.equal(store.adicionarOptOut("5551999990001"), false);
  assert.equal(store.lerEstado().optOut.length, 1);
});
ok("contador diário soma por dia", () => {
  store.marcarEnvio(["num:5551999990001"], "2026-07-29");
  store.marcarEnvio(["num:5551999990002"], "2026-07-29");
  assert.equal(store.enviadosHoje("2026-07-29"), 2);
  assert.equal(store.enviadosHoje("2026-07-30"), 0);
});
ok("log não perde eventos ao gravar estado", () => {
  const antes = store.lerLog().length;
  store.registrarLog("evento 1");
  store.marcarEnvio(["num:5551999990003"], "2026-07-29");
  store.registrarLog("evento 2");
  assert.equal(store.lerLog().length, antes + 2);
});
ok("proteção do número tem padrão e salva", () => {
  const p = store.lerProtecao();
  assert.ok(p.limiteDiario > 0 && p.pausaMinSeg > 0);
  store.gravarProtecao({ ...p, limiteDiario: 77 });
  assert.equal(store.lerProtecao().limiteDiario, 77);
});
ok("aquecimento limita o dia 1", () => {
  const scheduler = require("../src/scheduler");
  assert.equal(scheduler.limiteDeHoje({ limiteDiario: 500, aquecimento: true, inicioAquecimento: new Date().toISOString() }), 20);
  assert.equal(scheduler.limiteDeHoje({ limiteDiario: 500, aquecimento: false }), 500);
  const seteDiasAtras = new Date(Date.now() - 7 * 86400000).toISOString();
  assert.equal(scheduler.limiteDeHoje({ limiteDiario: 500, aquecimento: true, inicioAquecimento: seteDiasAtras }), 500);
});
ok("não remove a campanha do Bling", () => {
  const bling = campanhas.listar().find((c) => c.tipo === "bling");
  assert.throws(() => campanhas.remover(bling.id), /não pode ser excluída/i);
});
ok("remove campanha de planilha e a lista dela", () => {
  const c = campanhas.listar().find((x) => x.tipo === "planilha");
  campanhas.remover(c.id);
  assert.equal(campanhas.listar().length, 1);
  assert.equal(store.lerLista(c.id).contatos.length, 0);
});

console.log(`\n ${passou} teste(s) passaram.\n`);
