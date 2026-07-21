// ============================================================
// scheduler.js — o "piloto automático".
// Roda no intervalo do CRON_EXPRESSAO (padrão: 1x por hora).
// A cada rodada:
//   1. Se a campanha estiver DESLIGADA no painel -> não faz nada
//   2. Se estiver fora do horário comercial     -> não faz nada
//   3. Busca sumidos no Bling (janelas de 90d)
//   4. Filtra: opt-out, quem já recebeu dentro do COOLDOWN_DIAS
//   5. Busca telefone de cada um no Bling
//   6. Envia (imagem+legenda ou texto), com pausa entre envios
//   7. Inclui os "números extras" cadastrados no painel
//   8. Respeita o TETO_ENVIOS por rodada
//   9. Manda um resumo pro ADMIN_WHATSAPP
// ============================================================
const cron = require("node-cron");
const { lerConfig, lerEstado, gravarEstado, registrarLog } = require("./store");
const { getPedidosVendas, getContato, blingConectado } = require("./bling");
const { calculaJanelas, detectaSumidos } = require("./churn");
const { enviarMensagem, avisarAdmin, formatarNumero } = require("./evolution");

const TETO_ENVIOS = parseInt(process.env.TETO_ENVIOS || "40", 10);
const COOLDOWN_DIAS = parseInt(process.env.COOLDOWN_DIAS || "30", 10);
const HORARIO_INICIO = parseInt(process.env.HORARIO_INICIO || "9", 10);
const HORARIO_FIM = parseInt(process.env.HORARIO_FIM || "19", 10);
const PAUSA_ENTRE_ENVIOS_MS = parseInt(process.env.PAUSA_ENTRE_ENVIOS_MS || "5000", 10);
const CRON_EXPRESSAO = process.env.CRON_EXPRESSAO || "0 * * * *"; // a cada hora cheia
const TIMEZONE = process.env.TZ || "America/Sao_Paulo";

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function horaLocal() {
  return parseInt(
    new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, hour: "2-digit", hour12: false }).format(new Date()),
    10
  );
}

function dentroDoCooldown(estado, chave) {
  const ultimo = estado.envios[chave];
  if (!ultimo) return false;
  const dias = (Date.now() - new Date(ultimo).getTime()) / 86400000;
  return dias < COOLDOWN_DIAS;
}

let rodando = false; // trava: nunca duas rodadas ao mesmo tempo

async function rodada() {
  if (rodando) { registrarLog("Rodada pulada: a anterior ainda está em andamento."); return; }
  rodando = true;
  try {
    const cfg = lerConfig();

    if (!cfg.ativo) return; // campanha desligada no painel — silêncio total

    const hora = horaLocal();
    if (hora < HORARIO_INICIO || hora >= HORARIO_FIM) {
      registrarLog(`Fora do horário comercial (${hora}h). Nada enviado.`);
      return;
    }

    if (!blingConectado()) {
      registrarLog("Bling não conectado — rodada abortada. Acesse /auth/bling.");
      return;
    }

    // ---- 1. detecta sumidos ----
    const j = calculaJanelas();
    const [rec, ant] = [
      await getPedidosVendas(j.recenteIni, j.recenteFim),
      await getPedidosVendas(j.anteriorIni, j.anteriorFim),
    ];
    const sumidos = detectaSumidos(rec, ant);

    // ---- 2. monta a fila (sumidos + números extras), respeitando filtros ----
    const estado = lerEstado();
    const fila = [];

    for (const c of sumidos) {
      const chave = `bling:${c.id}`;
      if (dentroDoCooldown(estado, chave)) continue;
      fila.push({ chave, nome: c.nome, blingId: c.id, numeroBruto: null });
    }

    for (const extra of cfg.numerosExtras || []) {
      const num = formatarNumero(extra.numero);
      if (!num) continue;
      const chave = `extra:${num}`;
      if (dentroDoCooldown(estado, chave)) continue;
      fila.push({ chave, nome: extra.nome || "", blingId: null, numeroBruto: num });
    }

    const lote = fila.slice(0, TETO_ENVIOS);
    if (lote.length === 0) {
      registrarLog("Rodada sem ninguém pra enviar (cooldown/opt-out/vazio).");
      return;
    }

    // ---- 3. envia um a um ----
    let enviados = 0, pulados = 0;
    const nomesEnviados = [];

    for (const item of lote) {
      // busca telefone no Bling se veio da lista de sumidos
      let numeroBruto = item.numeroBruto;
      if (!numeroBruto && item.blingId) {
        try {
          const contato = await getContato(item.blingId);
          numeroBruto = contato?.telefone || contato?.celular || contato?.fone || "";
        } catch (e) {
          registrarLog(`Erro ao buscar contato ${item.nome}: ${e.message}`);
        }
        await dormir(1000); // folga pro rate limit do Bling
      }

      const numero = formatarNumero(numeroBruto);
      if (!numero) { pulados++; continue; }
      if (estado.optOut.includes(numero)) { pulados++; continue; }

      const r = await enviarMensagem({
        numeroBruto: numero,
        nome: item.nome,
        texto: cfg.texto,
        imagemUrl: cfg.imagemUrl,
        hyperlink: cfg.hyperlink,
      });

      if (r.ok) {
        enviados++;
        nomesEnviados.push(item.nome || numero);
        estado.envios[item.chave] = new Date().toISOString();
        gravarEstado(estado);
      } else {
        pulados++;
        registrarLog(`Falha ao enviar pra ${item.nome || numero}: ${r.motivo}`);
      }

      await dormir(PAUSA_ENTRE_ENVIOS_MS);
    }

    registrarLog(`Rodada concluída: ${enviados} enviado(s), ${pulados} pulado(s).`);

    if (enviados > 0) {
      await avisarAdmin(
        `🔁 *Reativador*\n\n✅ Enviadas: *${enviados}*\n⏭️ Puladas: *${pulados}*\n\n` +
        nomesEnviados.map((n) => `• ${n}`).join("\n")
      );
    }
  } catch (e) {
    registrarLog(`ERRO na rodada: ${e.message}`);
    await avisarAdmin(`⚠️ *Reativador* — erro na rodada:\n${e.message}`).catch(() => {});
  } finally {
    rodando = false;
  }
}

function iniciar() {
  cron.schedule(CRON_EXPRESSAO, rodada, { timezone: TIMEZONE });
  registrarLog(`Agendador iniciado: '${CRON_EXPRESSAO}' (${TIMEZONE}).`);
}

module.exports = { iniciar, rodada };
