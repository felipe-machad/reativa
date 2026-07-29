// ============================================================
// server.js — sobe tudo:
//   painel web, API de campanhas (CRUD), upload de planilha,
//   download do modelo de planilha e do relatório, OAuth do Bling,
//   webhook de opt-out (PARE) e o agendador.
// ============================================================
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const {
  lerLog,
  lerEstado,
  lerProtecao,
  gravarProtecao,
  PROTECAO_PADRAO,
  adicionarOptOut,
  removerOptOut,
  lerLista,
  gravarLista,
  apagarLista,
  salvarArquivoOriginal,
  caminhoArquivoOriginal,
  apagarArquivoOriginal,
  registrarLog,
} = require("./store");
const { gravarCampanhas } = require("./store");
const campanhas = require("./campanhas");
const { urlAutorizacao, trocarCodigo, blingConectado, configurado: blingConfigurado } = require("./bling");
const { enviarMensagem, formatarNumero, configurado: evolutionConfigurada } = require("./evolution");
const { lerContatos, modeloCsv, modeloXlsx, relatorioXlsx, extensaoDe } = require("./planilha");
const scheduler = require("./scheduler");

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

const MAX_MB = parseInt(process.env.MAX_UPLOAD_MB || "8", 10);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
});

// ---------- healthcheck (o EasyPanel usa isso) ----------
// Aberto de propósito, mas sem nada sensível: só números.
app.get("/health", (req, res) => {
  try {
    const lista = campanhas.listar();
    const relogio = scheduler.agoraLocal();
    const protecao = lerProtecao();
    let pendentes = 0;
    for (const c of lista) if (c.tipo === "planilha") pendentes += lerLista(c.id).contatos.filter((x) => x.status === "pendente").length;
    res.json({
      ok: true,
      campanhas: lista.length,
      ativas: lista.filter((c) => c.ativo || c.emAndamento).length,
      pendentes,
      hoje: scheduler.saldoDeHoje(protecao, relogio.data),
      bling: blingConectado(),
      whatsapp: evolutionConfigurada(),
    });
  } catch (e) {
    res.json({ ok: true, aviso: e.message });
  }
});

const SENHA = process.env.ADMIN_SENHA || "";

// ---------- auth simples (Basic Auth com a senha do env) ----------
function protegido(req, res, next) {
  if (!SENHA) return next(); // sem senha = aberto (só use assim em rede interna!)
  const header = req.headers.authorization || "";
  const [tipo, cred] = header.split(" ");
  if (tipo === "Basic" && cred) {
    const [, senha] = Buffer.from(cred, "base64").toString().split(":");
    if (senha === SENHA) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Reativador"');
  res.status(401).send("Senha necessária.");
}

const erro = (res, codigo, motivo) => res.status(codigo).json({ ok: false, motivo });

function pegarCampanha(req, res) {
  const c = campanhas.buscar(req.params.id);
  if (!c) {
    erro(res, 404, "Campanha não encontrada.");
    return null;
  }
  return c;
}

function resumoLista(id) {
  const lista = lerLista(id);
  const contar = (s) => lista.contatos.filter((c) => c.status === s).length;
  return {
    arquivo: lista.arquivo,
    importadoEm: lista.importadoEm,
    total: lista.contatos.length,
    pendentes: contar("pendente"),
    enviados: contar("enviado"),
    erros: contar("erro"),
    optout: contar("optout"),
    invalidos: contar("invalido"),
    ignoradosNaImportacao: { invalidos: lista.invalidos || 0, duplicados: lista.duplicados || 0 },
  };
}

// ================= API =================

app.get("/api/status", protegido, (req, res) => {
  const estado = lerEstado();
  const protecao = lerProtecao();
  const relogio = scheduler.agoraLocal();
  const dia = scheduler.saldoDeHoje(protecao, relogio.data);

  const lista = campanhas.listar().map((c) => ({
    ...c,
    rodandoAgora: scheduler.estaRodando(c.id),
    janela: scheduler.dentroDaJanela(c),
    lista: c.tipo === "planilha" ? resumoLista(c.id) : null,
  }));

  res.json({
    ok: true,
    ambiente: {
      blingConectado: blingConectado(),
      blingConfigurado: blingConfigurado(),
      evolutionConfigurada: evolutionConfigurada(),
      relogio,
      fuso: process.env.TZ || "America/Sao_Paulo",
      tick: process.env.CRON_TICK || "*/5 * * * *",
      maxUploadMb: MAX_MB,
    },
    protecao,
    dia,
    campanhas: lista,
    optOut: estado.optOut,
    envios: Object.keys(estado.envios).length,
    log: lerLog().slice(-60).reverse(),
  });
});

// ---------- proteção do número (vale pra todas as campanhas) ----------
app.get("/api/protecao", protegido, (req, res) => {
  const protecao = lerProtecao();
  const relogio = scheduler.agoraLocal();
  res.json({ ok: true, protecao, padrao: PROTECAO_PADRAO, dia: scheduler.saldoDeHoje(protecao, relogio.data) });
});

app.put("/api/protecao", protegido, (req, res) => {
  const atual = lerProtecao();
  const b = req.body || {};
  const num = (v, padrao, min, max) => {
    const n = parseInt(v, 10);
    return isNaN(n) ? padrao : Math.min(max, Math.max(min, n));
  };
  const nova = {
    ...atual,
    limiteDiario: num(b.limiteDiario, atual.limiteDiario, 1, 2000),
    pausaMinSeg: num(b.pausaMinSeg, atual.pausaMinSeg, 3, 900),
    pausaMaxSeg: num(b.pausaMaxSeg, atual.pausaMaxSeg, 3, 1800),
    aquecimento: typeof b.aquecimento === "boolean" ? b.aquecimento : atual.aquecimento,
    variarMensagem: typeof b.variarMensagem === "boolean" ? b.variarMensagem : atual.variarMensagem,
    embaralhar: typeof b.embaralhar === "boolean" ? b.embaralhar : atual.embaralhar,
  };
  if (nova.pausaMaxSeg < nova.pausaMinSeg) nova.pausaMaxSeg = nova.pausaMinSeg;
  if (b.reiniciarAquecimento) nova.inicioAquecimento = new Date().toISOString();
  gravarProtecao(nova);
  registrarLog(
    `Proteção do número salva: ${nova.limiteDiario}/dia, pausa ${nova.pausaMinSeg}–${nova.pausaMaxSeg}s, ` +
      `aquecimento ${nova.aquecimento ? "ligado" : "desligado"}.`
  );
  res.json({ ok: true, protecao: nova });
});

// ---------- CRUD de campanhas ----------
app.get("/api/campanhas", protegido, (req, res) => {
  res.json({ ok: true, campanhas: campanhas.listar() });
});

app.post("/api/campanhas", protegido, (req, res) => {
  try {
    const nova = campanhas.criar(req.body || {});
    res.json({ ok: true, campanha: nova });
  } catch (e) {
    erro(res, 400, e.message);
  }
});

app.get("/api/campanhas/:id", protegido, (req, res) => {
  const c = pegarCampanha(req, res);
  if (!c) return;
  res.json({
    ok: true,
    campanha: c,
    lista: c.tipo === "planilha" ? resumoLista(c.id) : null,
    rodandoAgora: scheduler.estaRodando(c.id),
  });
});

app.put("/api/campanhas/:id", protegido, (req, res) => {
  try {
    const c = campanhas.atualizar(req.params.id, req.body || {});
    registrarLog(`Campanha salva pelo painel (${c.ativo ? "ATIVA" : "pausada"}, modo ${c.modo}).`, c.nome);
    res.json({ ok: true, campanha: c });
  } catch (e) {
    erro(res, 400, e.message);
  }
});

app.delete("/api/campanhas/:id", protegido, (req, res) => {
  try {
    campanhas.remover(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    erro(res, 400, e.message);
  }
});

// ---------- planilha da campanha ----------
app.post("/api/campanhas/:id/planilha", protegido, (req, res) => {
  upload.single("arquivo")(req, res, (errUpload) => {
    if (errUpload) {
      return erro(res, 400, errUpload.code === "LIMIT_FILE_SIZE" ? `Arquivo maior que ${MAX_MB} MB.` : errUpload.message);
    }
    const c = pegarCampanha(req, res);
    if (!c) return;
    if (c.tipo !== "planilha") return erro(res, 400, "Só campanhas de planilha aceitam upload de lista.");
    if (!req.file) return erro(res, 400, "Nenhum arquivo enviado (campo 'arquivo').");

    const ext = extensaoDe(req.file.originalname);
    if (![".csv", ".xlsx", ".xls", ".txt"].includes(ext)) {
      return erro(res, 400, "Formato não aceito. Use .xlsx, .xls ou .csv.");
    }

    try {
      const resultado = lerContatos(req.file.buffer, req.file.originalname);

      const lista = {
        arquivo: req.file.originalname,
        importadoEm: new Date().toISOString(),
        total: resultado.total,
        invalidos: resultado.invalidos,
        duplicados: resultado.duplicados,
        contatos: resultado.contatos.map((x) => ({
          numero: x.numero,
          nome: x.nome,
          status: "pendente",
          enviadoEm: null,
          erro: null,
        })),
      };
      gravarLista(c.id, lista);
      salvarArquivoOriginal(c.id, ext, req.file.buffer);

      const atualizada = campanhas.atualizar(c.id, {
        // dispara a revalidação de status (rascunho -> pronta)
      });
      atualizada.arquivo = {
        nome: req.file.originalname,
        importadoEm: lista.importadoEm,
        total: lista.total,
        invalidos: lista.invalidos,
        duplicados: lista.duplicados,
      };
      campanhas.salvar(atualizada);

      registrarLog(
        `Planilha "${req.file.originalname}" importada: ${lista.total} contato(s) válido(s), ` +
          `${lista.invalidos} inválido(s), ${lista.duplicados} repetido(s).`,
        c.nome
      );

      res.json({
        ok: true,
        campanha: campanhas.buscar(c.id),
        resumo: resumoLista(c.id),
        aviso: resultado.aviso || "",
        previa: resultado.contatos.slice(0, 5),
      });
    } catch (e) {
      erro(res, 400, e.message);
    }
  });
});

app.delete("/api/campanhas/:id/planilha", protegido, (req, res) => {
  const c = pegarCampanha(req, res);
  if (!c) return;
  apagarLista(c.id);
  apagarArquivoOriginal(c.id);
  c.arquivo = null;
  c.ativo = false;
  c.status = "rascunho";
  campanhas.salvar(c);
  registrarLog("Planilha removida da campanha.", c.nome);
  res.json({ ok: true, campanha: campanhas.buscar(c.id) });
});

// baixar a planilha original que foi enviada
app.get("/api/campanhas/:id/planilha", protegido, (req, res) => {
  const c = pegarCampanha(req, res);
  if (!c) return;
  const caminho = caminhoArquivoOriginal(c.id);
  if (!caminho) return erro(res, 404, "Nenhuma planilha guardada nesta campanha.");
  res.download(caminho, path.basename(caminho));
});

// contatos (paginado, pro painel mostrar a lista)
app.get("/api/campanhas/:id/contatos", protegido, (req, res) => {
  const c = pegarCampanha(req, res);
  if (!c) return;
  const lista = lerLista(c.id);
  const pagina = Math.max(1, parseInt(req.query.pagina || "1", 10));
  const porPagina = Math.min(500, Math.max(10, parseInt(req.query.porPagina || "50", 10)));
  const filtro = String(req.query.status || "");
  const filtrados = filtro ? lista.contatos.filter((x) => x.status === filtro) : lista.contatos;
  const inicio = (pagina - 1) * porPagina;
  res.json({
    ok: true,
    total: filtrados.length,
    pagina,
    porPagina,
    contatos: filtrados.slice(inicio, inicio + porPagina),
  });
});

// relatório em xlsx
app.get("/api/campanhas/:id/relatorio.xlsx", protegido, (req, res) => {
  const c = pegarCampanha(req, res);
  if (!c) return;
  const lista = lerLista(c.id);
  const buffer = relatorioXlsx(c, lista);
  const nome = `relatorio-${c.nome.replace(/[^a-zA-Z0-9-_]+/g, "-").toLowerCase()}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${nome}"`);
  res.send(buffer);
});

// zerar progresso: todos voltam pra "pendente" (permite reenviar a mesma lista)
app.post("/api/campanhas/:id/reiniciar", protegido, (req, res) => {
  const c = pegarCampanha(req, res);
  if (!c) return;
  const lista = lerLista(c.id);
  if (!lista.contatos.length) return erro(res, 400, "Esta campanha não tem lista importada.");
  const manterOptOut = req.body?.manterOptOut !== false;
  for (const contato of lista.contatos) {
    if (manterOptOut && contato.status === "optout") continue;
    contato.status = "pendente";
    contato.enviadoEm = null;
    contato.erro = null;
  }
  gravarLista(c.id, lista);
  c.status = "pronta";
  c.stats = { enviados: 0, erros: 0, rodadas: 0 };
  campanhas.salvar(c);
  registrarLog("Progresso da lista reiniciado — todos voltaram para 'pendente'.", c.nome);
  res.json({ ok: true, resumo: resumoLista(c.id) });
});

// disparar: manda a primeira fatia agora e deixa a campanha "em andamento"
// — o agendador continua fatiando o resto no ritmo seguro, sozinho.
app.post("/api/campanhas/:id/disparar", protegido, (req, res) => {
  const c = pegarCampanha(req, res);
  if (!c) return;
  if (scheduler.estaRodando(c.id)) return erro(res, 409, "Esta campanha já está enviando agora.");

  const forcar = req.body?.forcar === true;
  const janela = scheduler.dentroDaJanela(c);
  if (!janela.ok && !forcar) {
    return erro(res, 400, `Não disparei: ${janela.motivo}. Ajuste a janela ou marque "enviar fora do horário".`);
  }

  c.emAndamento = true;
  campanhas.salvar(c);
  registrarLog("Disparo iniciado pelo painel — a lista vai sair em fatias, no ritmo seguro.", c.nome);
  scheduler.rodarCampanha(c.id, { manual: true, forcar }); // roda em background
  res.json({ ok: true, msg: "Disparo iniciado. A lista sai em fatias — acompanhe pelo log." });
});

// pausar: para de fatiar a lista (o que já saiu não volta atrás)
app.post("/api/campanhas/:id/pausar", protegido, (req, res) => {
  const c = pegarCampanha(req, res);
  if (!c) return;
  c.emAndamento = false;
  c.ativo = false;
  campanhas.salvar(c);
  registrarLog("Campanha pausada pelo painel.", c.nome);
  res.json({ ok: true, campanha: campanhas.buscar(c.id) });
});

// enviar teste (usa o texto/imagem da campanha, sem tocar na lista)
app.post("/api/campanhas/:id/teste", protegido, async (req, res) => {
  const c = pegarCampanha(req, res);
  if (!c) return;
  const numero = formatarNumero(req.body?.numero || process.env.ADMIN_WHATSAPP || "");
  if (!numero) return erro(res, 400, "Número inválido. Use DDD + número.");
  const r = await enviarMensagem({
    numeroBruto: numero,
    nome: req.body?.nome || "Teste",
    texto: c.texto,
    imagemUrl: c.imagemUrl,
    hyperlink: c.hyperlink,
  });
  registrarLog(`Envio de teste para ${numero}: ${r.ok ? "ok" : r.motivo}`, c.nome);
  res.json(r);
});

// ---------- clonar campanha (útil pra repetir uma campanha que deu certo) ----------
app.post("/api/campanhas/:id/clonar", protegido, (req, res) => {
  const c = pegarCampanha(req, res);
  if (!c) return;
  try {
    const copia = campanhas.criar({
      ...c,
      tipo: "planilha", // a cópia é sempre de planilha (a do Bling é única)
      nome: `${c.nome} (cópia)`,
      ativo: false,
    });
    // copia também a lista de contatos, se pediram
    if (req.body?.copiarLista) {
      const lista = lerLista(c.id);
      if (lista.contatos.length) {
        gravarLista(copia.id, {
          ...lista,
          contatos: lista.contatos.map((x) => ({ ...x, status: "pendente", enviadoEm: null, erro: null })),
        });
        campanhas.atualizar(copia.id, {});
      }
    }
    registrarLog(`Campanha clonada a partir de "${c.nome}".`, copia.nome);
    res.json({ ok: true, campanha: campanhas.buscar(copia.id) });
  } catch (e) {
    erro(res, 400, e.message);
  }
});

// ---------- backup e restauração (o volume pode se perder; isso salva a pele) ----------
app.get("/api/backup.json", protegido, (req, res) => {
  const listas = {};
  for (const c of campanhas.listar()) if (c.tipo === "planilha") listas[c.id] = lerLista(c.id);
  const backup = {
    versao: 2,
    geradoEm: new Date().toISOString(),
    campanhas: campanhas.listar(),
    protecao: lerProtecao(),
    estado: lerEstado(),
    listas,
  };
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="reativador-backup.json"`);
  res.send(JSON.stringify(backup, null, 2));
});

app.post("/api/restaurar", protegido, (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.campanhas)) return erro(res, 400, "Backup inválido: não achei a lista de campanhas.");
  try {
    gravarCampanhas(b.campanhas);
    if (b.protecao) gravarProtecao(b.protecao);
    if (b.listas && typeof b.listas === "object") {
      for (const [id, lista] of Object.entries(b.listas)) if (lista && Array.isArray(lista.contatos)) gravarLista(id, lista);
    }
    if (b.estado && Array.isArray(b.estado.optOut)) {
      for (const n of b.estado.optOut) adicionarOptOut(n);
    }
    registrarLog(`Backup restaurado: ${b.campanhas.length} campanha(s).`);
    res.json({ ok: true, campanhas: campanhas.listar().length });
  } catch (e) {
    erro(res, 400, e.message);
  }
});

// ---------- modelo de planilha (download) ----------
app.get("/api/modelo.csv", protegido, (req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="modelo-contatos.csv"');
  res.send(modeloCsv());
});

app.get("/api/modelo.xlsx", protegido, (req, res) => {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="modelo-contatos.xlsx"');
  res.send(modeloXlsx());
});

// ---------- verificar se o link da imagem ainda está no ar ----------
// A imagem NÃO é hospedada aqui: a pessoa sobe no ImgBB (ou onde quiser)
// e cola o link. Esta rota só confere se o link continua respondendo —
// é exatamente isso que a Evolution vai fazer na hora de enviar.
app.get("/api/verificar-imagem", protegido, async (req, res) => {
  const url = String(req.query.url || "").trim();
  if (!/^https?:\/\/.+/i.test(url)) {
    return res.json({ ok: false, motivo: "Link inválido — precisa começar com http:// ou https://" });
  }
  // a imagem tem que estar na internet pública: a Evolution é quem vai baixá-la
  try {
    const alvo = new URL(url).hostname.toLowerCase();
    const privado =
      /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|\[?::1\]?)/.test(alvo) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(alvo) ||
      alvo.endsWith(".local") ||
      alvo.endsWith(".internal");
    if (privado) {
      return res.json({ ok: false, motivo: "Esse endereço é interno. Use um link público (ImgBB, por exemplo)." });
    }
  } catch {
    return res.json({ ok: false, motivo: "Link inválido." });
  }
  try {
    let resp = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(12000) });
    // alguns servidores não respondem HEAD: tenta GET só do começo do arquivo
    if (resp.status === 405 || resp.status === 501 || resp.status === 403) {
      resp = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-1024" },
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
      });
    }
    const tipo = resp.headers.get("content-type") || "";
    const tamanho = parseInt(resp.headers.get("content-length") || "0", 10);
    if (!resp.ok) return res.json({ ok: false, status: resp.status, motivo: `O link respondeu ${resp.status}.` });
    if (!/^image\//i.test(tipo)) {
      return res.json({
        ok: false,
        status: resp.status,
        tipo,
        motivo: `O link responde, mas não é uma imagem (${tipo || "tipo desconhecido"}). No ImgBB, copie o campo "Link direto".`,
      });
    }
    res.json({
      ok: true,
      status: resp.status,
      tipo,
      tamanhoKb: tamanho ? Math.round(tamanho / 1024) : null,
      motivo: "Link válido — a imagem está no ar.",
    });
  } catch (e) {
    res.json({ ok: false, motivo: `Não consegui abrir o link: ${e.message}` });
  }
});

// ---------- opt-out manual ----------
app.post("/api/optout", protegido, (req, res) => {
  const numero = formatarNumero(req.body?.numero || "");
  if (!numero) return erro(res, 400, "Número inválido.");
  if (req.body?.remover) {
    removerOptOut(numero);
    registrarLog(`Opt-out removido manualmente: ${numero}`);
  } else {
    adicionarOptOut(numero);
    registrarLog(`Opt-out adicionado manualmente: ${numero}`);
  }
  res.json({ ok: true, optOut: lerEstado().optOut });
});

// ---------- OAuth do Bling ----------
app.get("/auth/bling", protegido, (req, res) => {
  res.redirect(urlAutorizacao());
});

app.get("/auth/bling/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) throw new Error("callback sem code");
    await trocarCodigo(String(code));
    res.send("<h3>Bling conectado! ✅</h3><p>Pode fechar esta aba e voltar ao painel.</p>");
  } catch (e) {
    registrarLog(`Erro no OAuth do Bling: ${e.message}`);
    res.status(500).send(`<h3>Erro ao conectar o Bling</h3><pre>${e.message}</pre>`);
  }
});

// ---------- webhook de opt-out (PARE) ----------
// Configure a Evolution API pra mandar eventos de mensagem recebida
// pra esta URL. Mensagens como "PARE" marcam opt-out automaticamente.
// Se WEBHOOK_TOKEN estiver definido, a URL precisa terminar com ?token=…
const PALAVRAS_SAIDA = ["PARE", "PARAR", "SAIR", "DESCADASTRAR", "REMOVER", "STOP", "CANCELAR"];
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "";

app.post("/webhook/evolution", (req, res) => {
  if (WEBHOOK_TOKEN && req.query.token !== WEBHOOK_TOKEN) {
    return res.status(401).json({ ok: false });
  }
  try {
    const dados = req.body?.data || req.body || {};
    const texto = String(
      dados?.message?.conversation || dados?.message?.extendedTextMessage?.text || ""
    )
      .trim()
      .toUpperCase();
    const remoto = String(dados?.key?.remoteJid || "").split("@")[0];

    if (PALAVRAS_SAIDA.includes(texto) && remoto) {
      const numero = formatarNumero(remoto);
      if (numero && adicionarOptOut(numero)) {
        registrarLog(`Opt-out registrado pelo WhatsApp: ${numero}`);
        // marca também nas listas das campanhas de planilha
        for (const c of campanhas.listar()) {
          if (c.tipo !== "planilha") continue;
          const lista = lerLista(c.id);
          let mudou = false;
          for (const contato of lista.contatos) {
            if (contato.numero === numero && contato.status === "pendente") {
              contato.status = "optout";
              contato.erro = "pediu PARE";
              mudou = true;
            }
          }
          if (mudou) gravarLista(c.id, lista);
        }
      }
    }
  } catch (e) {
    registrarLog(`Erro no webhook: ${e.message}`);
  }
  res.json({ ok: true });
});

// ---------- painel (estático, por último) ----------
app.use("/", protegido, express.static(path.join(__dirname, "..", "public")));

// ---------- sobe ----------
const PORT = parseInt(process.env.PORT || "3000", 10);
const servidor = app.listen(PORT, () => {
  console.log(`Reativador rodando na porta ${PORT}`);
  if (!SENHA) console.warn("ATENÇÃO: ADMIN_SENHA vazia — o painel está aberto pra qualquer um!");
  scheduler.iniciar();
});

// ---------- desligamento limpo ----------
// O EasyPanel manda SIGTERM ao atualizar/reiniciar. Aqui a gente para o
// relógio, espera a rodada em andamento acabar e só então sai — assim
// nenhum arquivo do /data fica escrito pela metade.
let desligando = false;
async function desligar(sinal) {
  if (desligando) return;
  desligando = true;
  registrarLog(`Recebi ${sinal} — encerrando com calma.`);
  servidor.close();
  const limpo = await scheduler.parar(30000);
  registrarLog(limpo ? "Encerrado sem rodada pendente." : "Encerrado com uma rodada ainda em andamento.");
  process.exit(0);
}
process.on("SIGTERM", () => desligar("SIGTERM"));
process.on("SIGINT", () => desligar("SIGINT"));
