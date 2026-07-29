// ============================================================
// churn.js — a regra de "quem sumiu", igual à validada no n8n:
// janela recente (últimos N dias) vs janela anterior (N a 2N dias).
// Quem comprava na anterior e não aparece na recente = sumido.
// ============================================================

function calculaJanelas(janelaDias = 90, hoje = new Date()) {
  const dias = Math.max(7, parseInt(janelaDias, 10) || 90);
  const menos = (n) => {
    const d = new Date(hoje);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  return {
    janelaDias: dias,
    recenteIni: menos(dias),
    recenteFim: hoje.toISOString().slice(0, 10),
    anteriorIni: menos(dias * 2),
    anteriorFim: menos(dias + 1),
  };
}

function agrupa(pedidos) {
  const m = {};
  for (const p of pedidos) {
    const nome = String((p && p.contato && p.contato.nome) || "Sem nome").trim();
    const id = String((p && p.contato && p.contato.id) || nome);
    const v = Number((p && p.total) || 0);
    if (!m[id]) m[id] = { id, nome, total: 0, qtd: 0, ultima: null };
    m[id].total += isNaN(v) ? 0 : v;
    m[id].qtd += 1;
    if (p && p.data && (!m[id].ultima || p.data > m[id].ultima)) m[id].ultima = p.data;
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
