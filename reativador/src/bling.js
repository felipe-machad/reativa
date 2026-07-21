// ============================================================
// Bling API v3 com OAuth completo:
//   - urlAutorizacao()      -> pra onde mandar o usuário clicar
//   - trocarCodigo(code)    -> troca o code do callback por tokens
//   - tokenValido()         -> devolve access token, renovando se preciso
//   - getPedidosVendas()    -> vendas por período
//   - getContato(id)        -> detalhe do contato (telefone)
// Tokens ficam em tokens.json (via store.js).
// ============================================================
const { lerTokens, gravarTokens, registrarLog } = require("./store");

const BASE = "https://api.bling.com.br/Api/v3";
const AUTH_URL = "https://www.bling.com.br/Api/v3/oauth/authorize";
const TOKEN_URL = "https://www.bling.com.br/Api/v3/oauth/token";

const CLIENT_ID = process.env.BLING_CLIENT_ID || "";
const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || "";
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");

function urlCallback() {
  return `${APP_URL}/auth/bling/callback`;
}

function urlAutorizacao() {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    state: "reativador",
  });
  return `${AUTH_URL}?${params}`;
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
  const data = await chamarTokenEndpoint({
    grant_type: "authorization_code",
    code,
  });
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

  // expirou -> renova com o refresh token
  const data = await chamarTokenEndpoint({
    grant_type: "refresh_token",
    refresh_token: t.refreshToken,
  });
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
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 429) throw new Error("Bling: limite de requisições (429).");
  if (!resp.ok) throw new Error(`Bling: erro ${resp.status} em ${pathRel}`);
  const body = await resp.json();
  const d = body?.data;
  return Array.isArray(d) ? d : d ? [d] : [];
}

async function getPedidosVendas(dataInicial, dataFinal) {
  return blingGet("/pedidos/vendas", { dataInicial, dataFinal, limite: "100" });
}

async function getContato(id) {
  const r = await blingGet(`/contatos/${id}`);
  return r[0] || null;
}

function blingConectado() {
  return !!lerTokens();
}

module.exports = { urlAutorizacao, urlCallback, trocarCodigo, getPedidosVendas, getContato, blingConectado };
