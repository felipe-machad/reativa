// ============================================================
// scheduler.js — o "piloto automático" multi-campanha.
//
// Um relógio único (CRON_TICK, padrão a cada 5 min) olha TODAS as
// campanhas e roda uma rodada em cada uma que estiver liberada.
//
// PROTEÇÃO DO NÚMERO (o ponto mais importante daqui):
//   • nunca sai tudo de uma vez — cada rodada manda no máximo
//     "teto por rodada" mensagens e o resto fica pra próxima;
//   • a pausa entre mensagens é sorteada (ex.: 35 a 95s), nunca fixa;
//   • existe um limite diário para o número inteiro, somando todas
//     as campanhas;
//   • aquecimento: nos primeiros dias o limite diário é menor e vai
//     subindo;
//   • a fila vai embaralhada e o texto tem variações {oi|olá}, então
//     duas pessoas nunca recebem a mesma mensagem no mesmo ritmo;
//   • só envia nos dias e no horário configurados.
// ============================================================
const cron = require("node-cron");
const {
  lerEstado,
  marcarEnvio,
  enviadosHoje,
  lerProtecao,
  gravarProtecao,
  lerLista,
  gravarLista,
  registrarLog,
} = require("./store");
const campanhasRepo = require("./campanhas");
const { getPedidosVendas, getContato, blingConectado } = require("./bling");
const { calculaJanelas, detectaSumidos } = require("./churn");
const { enviarMensagem, avisarAdmin, formatarNumero } = require("./evolution");

const CRON_TICK = process.env.CRON_TICK || "*/5 * * * *";
const TIMEZONE = process.env.TZ || "America/Sao_Paulo";
// contato do Bling sem telefone: espera esses dias antes de tentar de novo
const DIAS_SEM_TELEFONE = parseInt(process.env.DIAS_SEM_TELEFONE || "15", 10);

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const sorteia = (min, max) => min + Math.random() * (max - min);

// ---------------------------------------------------------------
// tempo local (respeitando TZ)
// ---------------------------------------------------------------
const MAPA_DIA = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function agoraLocal() {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const p = {};
  for (const parte of partes) p[parte.type] = parte.value;
  return {
    hora: parseInt(p.hour, 10) % 24,
    minuto: parseInt(p.minute, 10),
    diaSemana: MAPA_DIA[p.weekday] ?? new Date().getDay(),
    data: `${p.year}-${p.month}-${p.day}`,
  };
}

function dentroDaJanela(c) {
  const { hora, diaSemana } = agoraLocal();
  if (Array.isArray(c.diasSemana) && c.diasSemana.length && !c.diasSemana.includes(diaSemana)) {
    return { ok: false, motivo: "hoje não é um dos dias de disparo desta campanha" };
  }
  if (hora < c.horaInicio || hora >= c.horaFim) {
    return { ok: false, motivo: `fora do horário permitido (agora ${hora}h, janela ${c.horaInicio}h–${c.horaFim}h)` };
  }
  return { ok: true };
}

function minutosDesde(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

function dentroDoCooldown(estado, chave, dias) {
  if (!dias || !chave) return false;
  const ultimo = estado.envios[chave];
  if (!ultimo) return false;
  return (Date.now() - new Date(ultimo).getTime()) / 86400000 < dias;
}

// ---------------------------------------------------------------
// AQUECIMENTO: quantas mensagens o número pode mandar hoje
// ---------------------------------------------------------------
const ESCADA_AQUECIMENTO = [20, 30, 50, 70, 100, 130];

function limiteDeHoje(protecao) {
  const teto = Math.max(1, protecao.limiteDiario || 150);
  if (!protecao.aquecimento || !protecao.inicioAquecimento) return teto;
  const dias = Math.floor((Date.now() - new Date(protecao.inicioAquecimento).getTime()) / 86400000);
  if (dias >= ESCADA_AQUECIMENTO.length) return teto;
  return Math.min(teto, ESCADA_AQUECIMENTO[dias]);
}

function saldoDeHoje(protecao, dataLocal) {
  const limite = limiteDeHoje(protecao);
  const jaForam = enviadosHoje(dataLocal);
  return { limite, jaForam, saldo: Math.max(0, limite - jaForam) };
}

function embaralhar(lista) {
  const a = [...lista];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------
// montagem da fila
// ---------------------------------------------------------------
async function filaDaCampanhaBling(c, estado) {
  if (!blingConectado()) throw new Error("Bling não conectado — acesse /auth/bling.");

  const j = calculaJanelas(c.janelaDias);
  const recentes = await getPedidosVendas(j.recenteIni, j.recenteFim);
  const anteriores = await getPedidosVendas(j.anteriorIni, j.anteriorFim);
  const sumidos = detectaSumidos(recentes, anteriores);

  registrarLog(
    `Bling: ${recentes.length} pedido(s) nos últimos ${j.janelaDias}d, ${anteriores.length} na janela anterior, ` +
      `${sumidos.length} cliente(s) sumido(s).`,
    c.nome
  );

  const fila = [];
  for (const s of sumidos) {
    const chave = `bling:${s.id}`;
    if (dentroDoCooldown(estado, chave, c.cooldownDias)) continue;
    // quem já tentamos e não tinha telefone no Bling: não insiste toda rodada
    if (dentroDoCooldown(estado, `semtel:${s.id}`, DIAS_SEM_TELEFONE)) continue;
    fila.push({ origem: "bling", chave, blingId: s.id, nome: s.nome, numero: null });
  }
  return fila;
}

function filaDaPlanilha(c, estado, lista) {
  const fila = [];
  for (let i = 0; i < lista.contatos.length; i++) {
    const contato = lista.contatos[i];
    if (contato.status !== "pendente") continue;
    if (dentroDoCooldown(estado, `num:${contato.numero}`, c.cooldownDias)) continue;
    fila.push({
      origem: "planilha",
      indice: i,
      chave: `num:${contato.numero}`,
      numero: contato.numero,
      nome: contato.nome,
    });
  }
  return fila;
}

function filaDosExtras(c, estado) {
  const fila = [];
  for (const extra of c.numerosExtras || []) {
    const numero = formatarNumero(extra.numero);
    if (!numero) continue;
    const chave = `extra:${c.id}:${numero}`;
    if (dentroDoCooldown(estado, chave, c.cooldownDias || 1)) continue; // extras: no mínimo 1 dia
    fila.push({ origem: "extra", chave, numero, nome: extra.nome || "" });
  }
  return fila;
}

// ---------------------------------------------------------------
// RODADA DE UMA CAMPANHA
// ---------------------------------------------------------------
const rodando = new Set();

async function rodarCampanha(id, { manual = false, forcar = false } = {}) {
  if (rodando.has(id)) {
    return { ok: false, motivo: "Esta campanha já está enviando agora. Aguarde terminar." };
  }
  rodando.add(id);

  let c = campanhasRepo.buscar(id);
  try {
    if (!c) return { ok: false, motivo: "Campanha não encontrada." };

    // ---- trava de horário (vale também pro disparo manual, a não ser que force) ----
    const janela = dentroDaJanela(c);
    if (!janela.ok && !forcar) {
      registrarLog(`Rodada não iniciada: ${janela.motivo}.`, c.nome);
      return { ok: false, motivo: `Rodada não iniciada — ${janela.motivo}.` };
    }

    // ---- trava do limite diário do número ----
    const protecao = lerProtecao();
    const { data: dataLocal } = agoraLocal();
    const { limite, jaForam, saldo } = saldoDeHoje(protecao, dataLocal);
    if (saldo <= 0) {
      const msg = `Limite diário do número atingido (${jaForam}/${limite}). Continua amanhã.`;
      registrarLog(msg, c.nome);
      return { ok: false, motivo: msg };
    }

    const estado = lerEstado();
    const lista = c.tipo === "planilha" ? lerLista(c.id) : null;

    if (c.tipo === "planilha" && (!lista.contatos || !lista.contatos.length)) {
      return { ok: false, motivo: "Nenhuma planilha importada nesta campanha." };
    }

    // ---- monta a fila ----
    let fila;
    if (c.tipo === "bling") fila = await filaDaCampanhaBling(c, estado);
    else fila = filaDaPlanilha(c, estado, lista);

    fila = fila.concat(filaDosExtras(c, estado));
    if (protecao.embaralhar) fila = embaralhar(fila);

    const teto = Math.min(c.tetoPorRodada, saldo);
    const lote = fila.slice(0, teto);

    if (!lote.length) {
      const msg =
        c.tipo === "planilha"
          ? "Nenhum contato pendente — campanha concluída."
          : "Ninguém pra enviar nesta rodada (cooldown, opt-out ou lista vazia).";
      registrarLog(msg, c.nome);
      if (c.tipo === "planilha") {
        c.status = "concluida";
        c.ativo = false;
        c.emAndamento = false;
        campanhasRepo.salvar(c);
      }
      return { ok: true, enviados: 0, pulados: 0, msg };
    }

    registrarLog(
      `Rodada ${manual ? "manual" : "automática"} iniciada: ${lote.length} envio(s) agora, ` +
        `${Math.max(0, fila.length - lote.length)} na espera. Hoje: ${jaForam}/${limite}.`,
      c.nome
    );

    // marca o dia 1 do aquecimento no primeiro envio de todos
    if (protecao.aquecimento && !protecao.inicioAquecimento) {
      gravarProtecao({ ...protecao, inicioAquecimento: new Date().toISOString() });
      registrarLog("Aquecimento do número começou hoje: o limite diário vai subindo aos poucos.");
    }

    // ---- envia, um a um, com pausa sorteada ----
    let enviados = 0;
    let pulados = 0;
    const nomes = [];
    const pausaMin = Math.max(3, protecao.pausaMinSeg || 35) * 1000;
    const pausaMax = Math.max(pausaMin, (protecao.pausaMaxSeg || 95) * 1000);

    for (let k = 0; k < lote.length; k++) {
      const item = lote[k];

      // reconfere o limite diário a cada envio (outra campanha pode ter enviado)
      if (enviadosHoje(dataLocal) >= limite) {
        registrarLog(`Limite diário atingido no meio da rodada (${limite}). O resto fica pra amanhã.`, c.nome);
        break;
      }

      let numero = item.numero;
      let erroContato = null;

      // campanha do Bling: precisa buscar o telefone do contato
      if (!numero && item.blingId) {
        try {
          const contato = await getContato(item.blingId);
          numero = formatarNumero((contato && (contato.telefone || contato.celular || contato.fone)) || "");
        } catch (e) {
          erroContato = e.message;
        }
        await dormir(1000); // folga pro rate limit do Bling
      }

      if (!numero) {
        pulados++;
        if (item.origem === "planilha") {
          lista.contatos[item.indice].status = "invalido";
          lista.contatos[item.indice].erro = erroContato || "telefone inválido";
        }
        if (item.blingId) marcarEnvio([`semtel:${item.blingId}`]); // não insiste toda rodada
        if (erroContato) registrarLog(`Sem telefone para ${item.nome || item.blingId}: ${erroContato}`, c.nome);
        continue;
      }

      if (estado.optOut.includes(numero)) {
        pulados++;
        if (item.origem === "planilha") {
          lista.contatos[item.indice].status = "optout";
          lista.contatos[item.indice].erro = "pediu PARE";
        }
        continue;
      }

      const r = await enviarMensagem({
        numeroBruto: numero,
        nome: item.nome,
        texto: c.texto,
        imagemUrl: c.imagemUrl,
        hyperlink: c.hyperlink,
        variar: protecao.variarMensagem !== false,
      });

      if (r.ok) {
        enviados++;
        nomes.push(item.nome || numero);
        marcarEnvio([item.chave, `num:${numero}`], dataLocal);
        if (item.origem === "planilha") {
          lista.contatos[item.indice].status = "enviado";
          lista.contatos[item.indice].enviadoEm = new Date().toISOString();
          lista.contatos[item.indice].erro = null;
        }
      } else {
        pulados++;
        if (item.origem === "planilha") {
          lista.contatos[item.indice].status = "erro";
          lista.contatos[item.indice].erro = String(r.motivo || "erro").slice(0, 200);
        }
        registrarLog(`Falha ao enviar pra ${item.nome || numero}: ${r.motivo}`, c.nome);
      }

      if (c.tipo === "planilha") gravarLista(c.id, lista);

      // pausa sorteada — nunca o mesmo intervalo duas vezes
      if (k < lote.length - 1) await dormir(sorteia(pausaMin, pausaMax));
    }

    // ---- fecha a rodada ----
    c = campanhasRepo.buscar(id) || c; // relê: alguém pode ter editado no painel
    c.ultimaRodada = new Date().toISOString();
    c.stats = {
      enviados: (c.stats && c.stats.enviados ? c.stats.enviados : 0) + enviados,
      erros: (c.stats && c.stats.erros ? c.stats.erros : 0) + pulados,
      rodadas: (c.stats && c.stats.rodadas ? c.stats.rodadas : 0) + 1,
    };

    let restantes = null;
    if (c.tipo === "planilha") {
      restantes = lerLista(c.id).contatos.filter((x) => x.status === "pendente").length;
      if (restantes === 0) {
        c.status = "concluida";
        c.ativo = false;
        c.emAndamento = false;
      }
    }
    campanhasRepo.salvar(c);

    registrarLog(
      `Rodada concluída: ${enviados} enviado(s), ${pulados} pulado(s)` +
        (restantes !== null ? `, ${restantes} ainda na fila` : "") +
        ".",
      c.nome
    );

    if (enviados > 0) {
      await avisarAdmin(
        `🔁 *${c.nome}*\n\n✅ Enviadas nesta rodada: *${enviados}*\n⏭️ Puladas: *${pulados}*` +
          (restantes !== null ? `\n📋 Faltam na lista: *${restantes}*` : "") +
          `\n📊 Hoje no número: *${enviadosHoje(dataLocal)}/${limite}*\n\n` +
          nomes
            .slice(0, 20)
            .map((n) => `• ${n}`)
            .join("\n") +
          (nomes.length > 20 ? `\n… e mais ${nomes.length - 20}` : "")
      ).catch(() => {});
    }

    return { ok: true, enviados, pulados, restantes };
  } catch (e) {
    registrarLog(`ERRO na rodada: ${e.message}`, c ? c.nome : null);
    await avisarAdmin(`⚠️ *Reativador* — erro na campanha "${c ? c.nome : id}":\n${e.message}`).catch(() => {});
    return { ok: false, motivo: e.message };
  } finally {
    rodando.delete(id);
  }
}

// ---------------------------------------------------------------
// TICK: olha todas as campanhas
//   • modo "agendada" + ativa  -> roda sozinha na janela configurada
//   • modo "manual" + emAndamento (alguém clicou em "Disparar")
//     -> continua fatiando a lista nas rodadas seguintes, no mesmo
//        ritmo seguro, até acabar
// ---------------------------------------------------------------
async function tick() {
  const protecao = lerProtecao();
  const { data: dataLocal } = agoraLocal();
  const { saldo } = saldoDeHoje(protecao, dataLocal);
  if (saldo <= 0) return;

  for (const c of campanhasRepo.listar()) {
    const agendada = c.ativo && c.modo === "agendada";
    const continuando = c.emAndamento === true;
    if (!agendada && !continuando) continue;
    if (rodando.has(c.id)) continue;
    if (!dentroDaJanela(c).ok) continue;
    if (c.intervaloMin && minutosDesde(c.ultimaRodada) < c.intervaloMin) continue;

    await rodarCampanha(c.id, { manual: false }); // uma campanha por vez: um número só
    if (enviadosHoje(dataLocal) >= limiteDeHoje(protecao)) break;
  }
}

let tarefa = null;

function iniciar() {
  campanhasRepo.garantirCampanhaBling();
  tarefa = cron.schedule(
    CRON_TICK,
    () => {
      tick().catch((e) => registrarLog(`ERRO no tick do agendador: ${e.message}`));
    },
    { timezone: TIMEZONE }
  );
  const p = lerProtecao();
  registrarLog(
    `Agendador iniciado (tick '${CRON_TICK}', fuso ${TIMEZONE}). ` +
      `Proteção do número: limite ${p.limiteDiario}/dia, pausa ${p.pausaMinSeg}–${p.pausaMaxSeg}s` +
      `${p.aquecimento ? ", aquecimento ligado" : ""}.`
  );
  if (process.env.CRON_EXPRESSAO) {
    registrarLog(
      "Aviso: CRON_EXPRESSAO não é mais usada. A frequência agora é CRON_TICK + 'intervalo mínimo' de cada campanha."
    );
  }
}

function estaRodando(id) {
  return rodando.has(id);
}

// Desliga com educação: para o relógio e espera a rodada em andamento
// terminar, pra não morrer no meio de uma gravação de arquivo.
async function parar(esperaMaximaMs = 30000) {
  try {
    if (tarefa) await tarefa.stop();
  } catch {}
  const limite = Date.now() + esperaMaximaMs;
  while (rodando.size > 0 && Date.now() < limite) await dormir(500);
  return rodando.size === 0;
}

module.exports = {
  iniciar,
  parar,
  tick,
  rodarCampanha,
  estaRodando,
  agoraLocal,
  dentroDaJanela,
  limiteDeHoje,
  saldoDeHoje,
};
