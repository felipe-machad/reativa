// ============================================================
// churn.js — mesma regra validada no n8n:
// janela recente (90d) vs anterior (90-180d). Quem comprava e
// não comprou mais = sumido.
// ============================================================

function calculaJanelas(hoje = new Date()) {
  const menos = (dias) => {
    const d = new Date(hoje);
    d.setDate(d.getDate() - dias);
    return d.toISOString().slice(0, 10);
  };
  return {
    recenteIni: menos(90),
    recenteFim: hoje.toISOString().slice(0, 10),
    anteriorIni: menos(180),
    anteriorFim: menos(91),
  };
}

function agrupa(pedidos) {
  const m = {};
  for (const p of pedidos) {
    const nome = (p?.contato?.nome ?? "Sem nome").trim();
    const id = String(p?.contato?.id ?? nome);
    const v = Number(p?.total ?? 0);
    if (!m[id]) m[id] = { id, nome, total: 0, qtd: 0, ultima: null };
    m[id].total += isNaN(v) ? 0 : v;
    m[id].qtd += 1;
    if (p?.data && (!m[id].ultima || p.data > m[id].ultima)) m[id].ultima = p.data;
  }
  return m;
}

function detectaSumidos(pedidosRecentes, pedidosAnteriores) {
  const rec = agrupa(pedidosRecentes);
  const ant = agrupa(pedidosAnteriores);
  const idsRec = new Set(Object.keys(rec));
  return Object.values(ant)
    .filter((c) => !idsRec.has(c.id))
    .sort((a, b) => b.total - a.total);
}

module.exports = { calculaJanelas, detectaSumidos };
