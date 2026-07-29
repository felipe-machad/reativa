// ============================================================
// bling.js — Bling API v3 com OAuth completo:
//   urlAutorizacao()      -> pra onde mandar a pessoa clicar
//   trocarCodigo(code)    -> troca o code do callback por tokens
//   getPedidosVendas()    -> vendas do período (com paginação)
//   getContato(id)        -> detalhe do contato (telefone)
// Tokens ficam em tokens.json (via store.js) e renovam sozinhos.
// ============================================================
const { lerTokens, gravarTokens, registrarLog } = require("./store");

const BASE = "https://api.bling.com.br/Api/v3";
const AUTH_URL = "https://www.bling.com.br/Api/v3/oauth/authorize";
const TOKEN_URL = "https://www.bling.com.br/Api/v3/oauth/token";

const CLIENT_ID = process.env.BLING_CLIENT_ID || "";
const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || "";
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const MAX_PAGINAS = parseInt(process.env.BLING_MAX_PAGINAS || "5", 10); // 5 x 100 = 500 pedidos por janela
const PAUSA_PAGINA_MS = parseInt(process.env.BLING_PAUSA_MS || "400", 10);

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function urlCallback() {
  return `${APP_URL}/auth/bling/callback`;
}

function urlAutorizacao() {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    state: "reativador",
  });
  if (APP_URL) params.set("redirect_uri", urlCallback());
  return `${AUTH_URL}?${params}`;
}

function configurado() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

async function chamarTokenEndpoint(body) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Bling token endpoint ${resp.status}: ${txt.slice(0, 300)}`);
  }
  return resp.json();
}

async function trocarCodigo(code) {
  const data = await chamarTokenEndpoint({ grant_type: "authorization_code", code });
  gravarTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiraEm: Date.now() + (data.expires_in - 60) * 1000, // 60s de folga
  });
  registrarLog("Bling conectado via OAuth.");
}

async function tokenValido() {
  const t = lerTokens();
  if (!t) throw new Error("Bling não conectado. Acesse /auth/bling pra autorizar.");
  if (Date.now() < t.expiraEm) return t.accessToken;

  const data = await chamarTokenEndpoint({ grant_type: "refresh_token", refresh_token: t.refreshToken });
  gravarTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token || t.refreshToken,
    expiraEm: Date.now() + (data.expires_in - 60) * 1000,
  });
  registrarLog("Token do Bling renovado automaticamente.");
  return data.access_token;
}

async function blingGet(pathRel, params = {}) {
  const token = await tokenValido();
  const query = new URLSearchParams(params).toString();
  const resp = await fetch(`${BASE}${pathRel}${query ? "?" + query : ""}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (resp.status === 429) throw new Error("Bling: limite de requisições (429). Tenta na próxima rodada.");
  if (!resp.ok) throw new Error(`Bling: erro ${resp.status} em ${pathRel}`);
  const body = await resp.json();
  const d = body && body.data;
  return Array.isArray(d) ? d : d ? [d] : [];
}

// pagina até MAX_PAGINAS (o Bling devolve no máximo 100 por página)
async function getPedidosVendas(dataInicial, dataFinal) {
  const todos = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const lote = await blingGet("/pedidos/vendas", {
      dataInicial,
      dataFinal,
      limite: "100",
      pagina: String(pagina),
    });
    todos.push(...lote);
    if (lote.length < 100) break;
    await dormir(PAUSA_PAGINA_MS);
  }
  return todos;
}

async function getContato(id) {
  const r = await blingGet(`/contatos/${id}`);
  return r[0] || null;
}

function blingConectado() {
  return !!lerTokens();
}

module.exports = {
  urlAutorizacao,
  urlCallback,
  trocarCodigo,
  getPedidosVendas,
  getContato,
  blingConectado,
  configurado,
};
