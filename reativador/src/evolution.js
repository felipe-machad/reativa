// ============================================================
// evolution.js — envio de WhatsApp via Evolution API.
// Se a campanha tiver imagemUrl, manda imagem com legenda;
// senão manda texto puro. Hyperlink (se houver) vai no fim.
// ============================================================

const URL_BASE = (process.env.EVOLUTION_URL || "").replace(/\/$/, "");
const APIKEY = process.env.EVOLUTION_APIKEY || "";
const INSTANCIA = process.env.EVOLUTION_INSTANCE || "";
const TIMEOUT_MS = parseInt(process.env.EVOLUTION_TIMEOUT_MS || "25000", 10);

/**
 * Normaliza telefone brasileiro pro formato que a Evolution espera (55DDDNÚMERO).
 * Aceita "(51) 99999-9999", "051999999999", "5551999999999", etc.
 * Devolve null se não parecer telefone.
 */
function formatarNumero(bruto) {
  let d = String(bruto == null ? "" : bruto).replace(/\D/g, "");
  if (!d) return null;
  d = d.replace(/^0+/, ""); // tira zero de operadora / zero à esquerda

  if (d.length >= 12 && d.startsWith("55")) {
    const resto = d.slice(2);
    if (resto.length === 10 || resto.length === 11) return "55" + resto;
    return null;
  }
  if (d.length === 10 || d.length === 11) return "55" + d; // fixo ou celular com DDD
  if (d.length >= 12 && d.length <= 15) return d; // internacional: usa como veio
  return null;
}

/**
 * Primeiro nome apresentável: "MARIA DA SILVA ME" -> "Maria".
 * Ignora sufixos de empresa e palavras de ligação.
 */
function primeiroNome(nome) {
  const limpo = String(nome || "")
    .replace(/\b(ltda|me|mei|eireli|s\.?a\.?|epp|cia|comercio|comércio|distribuidora)\b/gi, " ")
    .replace(/[^\p{L}\s'-]/gu, " ")
    .trim();
  const partes = limpo.split(/\s+/).filter((p) => p.length > 1);
  const p = partes[0];
  if (!p) return "";
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

/**
 * Variações da mensagem: {Oi|Olá|E aí} sorteia uma das opções em cada envio.
 * Duas pessoas nunca recebem exatamente o mesmo texto — isso reduz muito
 * o risco de o WhatsApp marcar o número como disparo em massa.
 */
function aplicarVariacoes(texto) {
  return String(texto || "").replace(/\{([^{}]*\|[^{}]*)\}/g, (_, grupo) => {
    const opcoes = grupo.split("|").map((o) => o.trim());
    return opcoes[Math.floor(Math.random() * opcoes.length)] || "";
  });
}

function montarTexto(template, nome, hyperlink, variar = true) {
  let t = String(template || "");
  if (variar) t = aplicarVariacoes(t);

  const primeiro = primeiroNome(nome);
  // sem nome na planilha: tira o vocativo em vez de escrever "Oi, !"
  t = primeiro
    ? t.replace(/\{nome\}/g, primeiro)
    : t.replace(/,?\s*\{nome\}/g, "").replace(/\{nome\}/g, "");

  if (hyperlink) t += `\n\n${hyperlink}`;
  return t.replace(/[ \t]+\n/g, "\n").trim();
}

function configurado() {
  return !!(URL_BASE && APIKEY && INSTANCIA);
}

async function postEvolution(caminho, body) {
  if (!configurado()) {
    return { ok: false, motivo: "Evolution API não configurada (EVOLUTION_URL / APIKEY / INSTANCE)." };
  }
  try {
    const resp = await fetch(`${URL_BASE}${caminho}/${INSTANCIA}`, {
      method: "POST",
      headers: { apikey: APIKEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return { ok: false, motivo: `evolution ${resp.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, motivo: `falha de rede na Evolution: ${e.message}` };
  }
}

async function enviarMensagem({ numeroBruto, nome, texto, imagemUrl, hyperlink, variar = true }) {
  const numero = formatarNumero(numeroBruto);
  if (!numero) return { ok: false, motivo: "telefone inválido" };
  if (!String(texto || "").trim()) return { ok: false, motivo: "texto da mensagem vazio" };

  const corpo = montarTexto(texto, nome, hyperlink, variar);

  if (imagemUrl) {
    return postEvolution("/message/sendMedia", {
      number: numero,
      mediatype: "image",
      mimetype: "image/jpeg",
      media: imagemUrl,
      caption: corpo,
    });
  }
  return postEvolution("/message/sendText", { number: numero, text: corpo });
}

async function avisarAdmin(texto) {
  const admin = formatarNumero(process.env.ADMIN_WHATSAPP || "");
  if (!admin) return { ok: false, motivo: "ADMIN_WHATSAPP não configurado" };
  return postEvolution("/message/sendText", { number: admin, text: texto });
}

module.exports = {
  enviarMensagem,
  avisarAdmin,
  formatarNumero,
  configurado,
  montarTexto,
  primeiroNome,
  aplicarVariacoes,
};
