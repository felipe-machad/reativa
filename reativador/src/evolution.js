// ============================================================
// evolution.js — envio de WhatsApp via Evolution API.
// Se tiver imagemUrl configurada, manda imagem com legenda;
// senão manda texto puro. Hyperlink (se houver) vai no fim.
// ============================================================

const URL_BASE = (process.env.EVOLUTION_URL || "").replace(/\/$/, "");
const APIKEY = process.env.EVOLUTION_APIKEY || "";
const INSTANCIA = process.env.EVOLUTION_INSTANCE || "";

function formatarNumero(bruto) {
  const digitos = String(bruto || "").replace(/\D/g, "");
  if (digitos.length < 10) return null;
  return digitos.startsWith("55") ? digitos : `55${digitos}`;
}

function montarTexto(template, nome, hyperlink) {
  const primeiro = String(nome || "").split(" ")[0] || "tudo bem";
  let t = template.replace(/\{nome\}/g, primeiro);
  if (hyperlink) t += `\n\n${hyperlink}`;
  return t;
}

async function postEvolution(caminho, body) {
  const resp = await fetch(`${URL_BASE}${caminho}/${INSTANCIA}`, {
    method: "POST",
    headers: { apikey: APIKEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    return { ok: false, motivo: `evolution ${resp.status}: ${txt.slice(0, 200)}` };
  }
  return { ok: true };
}

async function enviarMensagem({ numeroBruto, nome, texto, imagemUrl, hyperlink }) {
  const numero = formatarNumero(numeroBruto);
  if (!numero) return { ok: false, motivo: "telefone inválido" };

  const corpo = montarTexto(texto, nome, hyperlink);

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
  if (!admin) return;
  await postEvolution("/message/sendText", { number: admin, text: texto });
}

module.exports = { enviarMensagem, avisarAdmin, formatarNumero };
