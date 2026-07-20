'use strict';

/**
 * Métricas de ativação do painel — a série que faz o garçom continuar
 * apresentando o QR (playbook de onboarding: mandar % e valores pro dono em
 * D+3 e D+7; gate do piloto ≥25% das contas via Racha na semana 1).
 *
 * PURO: recebe as linhas de pagamento CONFIRMADAS da casa (já sem mesas de
 * treino) e devolve a janela de 7 dias em América/São_Paulo (UTC-3 fixo,
 * sem horário de verão desde 2019).
 *
 * @param {Array<{amountCents:number, tipCents:number, checkId:string,
 *   confirmedAt:string|null, method?:string}>} confirmed
 * @param {string} [nowIso]
 */
function buildAtivacao(confirmed, nowIso = new Date().toISOString()) {
  const spDay = (iso) => new Date(Date.parse(iso) - 3 * 3600 * 1000).toISOString().slice(0, 10);

  const dias = [];
  const porDia = new Map();
  for (let i = 6; i >= 0; i -= 1) {
    const dia = spDay(new Date(Date.parse(nowIso) - i * 86400000).toISOString());
    const row = { dia, pagamentos: 0, valorCents: 0, gorjetaCents: 0, contas: 0, _contas: new Set() };
    porDia.set(dia, row);
    dias.push(row);
  }

  const metodos = { pix: 0, card: 0, house_account: 0 };
  const contasSemana = new Set();
  let pagamentos = 0; let valorCents = 0; let gorjetaCents = 0;

  for (const p of confirmed) {
    if (!p.confirmedAt) continue; // sem competência, fora da série
    const row = porDia.get(spDay(p.confirmedAt));
    if (!row) continue; // fora da janela de 7 dias
    row.pagamentos += 1;
    row.valorCents += p.amountCents || 0;
    row.gorjetaCents += p.tipCents || 0;
    row._contas.add(p.checkId);
    pagamentos += 1;
    valorCents += p.amountCents || 0;
    gorjetaCents += p.tipCents || 0;
    contasSemana.add(p.checkId);
    if (p.method === 'card') metodos.card += 1;
    else if (p.method === 'house_account') metodos.house_account += 1;
    else metodos.pix += 1;
  }

  return {
    dias: dias.map(({ _contas, ...d }) => ({ ...d, contas: _contas.size })),
    metodos,
    semana: { pagamentos, valorCents, gorjetaCents, contas: contasSemana.size },
  };
}

module.exports = { buildAtivacao };
