// ============================================================
// server.js — sobe tudo: painel web, rotas de OAuth do Bling,
// API do painel e webhook de opt-out (PARE), e liga o agendador.
// ============================================================
const express = require("express");
const path = require("path");
const { lerConfig, gravarConfig, lerEstado, gravarEstado, registrarLog } = require("./store");
const { urlAutorizacao, trocarCodigo, blingConectado } = require("./bling");
const { enviarMensagem, formatarNumero } = require("./evolution");
const scheduler = require("./scheduler");

const app = express();
app.use(express.json());
// ---------- healthcheck (EasyPanel usa isso) ----------
app.get("/health", (req, res) => res.json({ ok: true }));
const SENHA = process.env.ADMIN_SENHA || "";

// ---------- auth simples (Basic Auth com a senha do env) ----------
function protegido(req, res, next) {
  if (!SENHA) return next(); // sem senha configurada = aberto (só use assim em rede interna!)
  const header = req.headers.authorization || "";
  const [tipo, cred] = header.split(" ");
  if (tipo === "Basic" && cred) {
    const [, senha] = Buffer.from(cred, "base64").toString().split(":");
    if (senha === SENHA) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Reativador"');
  res.status(401).send("Senha necessária.");
}

// ---------- painel ----------
app.use("/", protegido, express.static(path.join(__dirname, "..", "public")));

// ---------- API do painel ----------
app.get("/api/status", protegido, (req, res) => {
  const cfg = lerConfig();
  const estado = lerEstado();
  res.json({
    blingConectado: blingConectado(),
    config: cfg,
    optOutTotal: estado.optOut.length,
    enviosTotal: Object.keys(estado.envios).length,
    log: estado.log.slice(-30).reverse(),
  });
});

app.post("/api/config", protegido, (req, res) => {
  const atual = lerConfig();
  const { ativo, texto, imagemUrl, hyperlink, numerosExtras } = req.body || {};
  const novo = {
    ...atual,
    ativo: typeof ativo === "boolean" ? ativo : atual.ativo,
    texto: typeof texto === "string" && texto.trim() ? texto : atual.texto,
    imagemUrl: typeof imagemUrl === "string" ? imagemUrl.trim() : atual.imagemUrl,
    hyperlink: typeof hyperlink === "string" ? hyperlink.trim() : atual.hyperlink,
    numerosExtras: Array.isArray(numerosExtras)
      ? numerosExtras
          .map((n) => ({ numero: formatarNumero(n.numero) || "", nome: String(n.nome || "").trim() }))
          .filter((n) => n.numero)
      : atual.numerosExtras,
  };
  gravarConfig(novo);
  registrarLog(`Configuração salva pelo painel (campanha ${novo.ativo ? "ATIVA" : "pausada"}).`);
  res.json({ ok: true, config: novo });
});

// envio de teste — só pro número informado, sem tocar na fila real
app.post("/api/teste", protegido, async (req, res) => {
  const cfg = lerConfig();
  const numero = formatarNumero(req.body?.numero || process.env.ADMIN_WHATSAPP || "");
  if (!numero) return res.status(400).json({ ok: false, motivo: "número inválido" });
  const r = await enviarMensagem({
    numeroBruto: numero,
    nome: req.body?.nome || "Teste",
    texto: cfg.texto,
    imagemUrl: cfg.imagemUrl,
    hyperlink: cfg.hyperlink,
  });
  registrarLog(`Envio de teste para ${numero}: ${r.ok ? "ok" : r.motivo}`);
  res.json(r);
});

// rodar uma rodada agora (sem esperar o cron) — útil pra testar
app.post("/api/rodar-agora", protegido, async (req, res) => {
  registrarLog("Rodada disparada manualmente pelo painel.");
  scheduler.rodada(); // roda em background, resposta volta na hora
  res.json({ ok: true, msg: "Rodada iniciada. Acompanhe pelo log." });
});

// ---------- OAuth do Bling ----------
app.get("/auth/bling", protegido, (req, res) => {
  res.redirect(urlAutorizacao());
});
function urlCallback() {
     return `${process.env.APP_URL}/auth/bling/callback`;
}
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
// pra esta URL. Qualquer mensagem cujo texto seja "PARE" marca opt-out.
app.post("/webhook/evolution", (req, res) => {
  try {
    const dados = req.body?.data || req.body || {};
    const texto = String(
      dados?.message?.conversation ||
      dados?.message?.extendedTextMessage?.text ||
      ""
    ).trim().toUpperCase();
    const remoto = String(dados?.key?.remoteJid || "").split("@")[0];

    if (texto === "PARE" && remoto) {
      const numero = formatarNumero(remoto);
      if (numero) {
        const estado = lerEstado();
        if (!estado.optOut.includes(numero)) {
          estado.optOut.push(numero);
          gravarEstado(estado);
          registrarLog(`Opt-out registrado: ${numero}`);
        }
      }
    }
  } catch (e) {
    registrarLog(`Erro no webhook: ${e.message}`);
  }
  res.json({ ok: true });
});



const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, () => {
  console.log(`Reativador rodando na porta ${PORT}`);
  scheduler.iniciar();
});
