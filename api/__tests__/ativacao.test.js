'use strict';

const { buildAtivacao } = require('../_lib/checks/ativacao');

const NOW = '2026-07-20T18:00:00.000Z'; // 15:00 em SP, dia 2026-07-20

const pay = (confirmedAt, amountCents, tipCents = 0, checkId = 'c1', method = 'pix') =>
  ({ confirmedAt, amountCents, tipCents, checkId, method });

describe('métricas de ativação (7 dias, São Paulo)', () => {
  test('janela sempre tem 7 dias em ordem, zeros incluídos', () => {
    const a = buildAtivacao([], NOW);
    expect(a.dias).toHaveLength(7);
    expect(a.dias[0].dia).toBe('2026-07-14');
    expect(a.dias[6].dia).toBe('2026-07-20');
    expect(a.dias.every((d) => d.pagamentos === 0 && d.valorCents === 0)).toBe(true);
    expect(a.semana).toEqual({ pagamentos: 0, valorCents: 0, gorjetaCents: 0, contas: 0 });
  });

  test('bucketing é pelo dia de SÃO PAULO, não UTC', () => {
    // 01:30Z do dia 20 = 22:30 SP do dia 19 → conta no dia 19
    const a = buildAtivacao([pay('2026-07-20T01:30:00.000Z', 1000)], NOW);
    const d19 = a.dias.find((d) => d.dia === '2026-07-19');
    const d20 = a.dias.find((d) => d.dia === '2026-07-20');
    expect(d19.valorCents).toBe(1000);
    expect(d20.valorCents).toBe(0);
  });

  test('contas distintas, mix de métodos, gorjeta separada, fora-da-janela ignorado', () => {
    const a = buildAtivacao([
      pay('2026-07-20T14:00:00.000Z', 5000, 500, 'cA', 'pix'),
      pay('2026-07-20T15:00:00.000Z', 3000, 0, 'cA', 'card'),      // mesma conta
      pay('2026-07-19T14:00:00.000Z', 2000, 200, 'cB', 'house_account'),
      pay('2026-07-01T14:00:00.000Z', 99999, 0, 'cOld', 'pix'),    // fora da janela
      pay(null, 77777, 0, 'cNull', 'pix'),                          // sem competência
    ], NOW);
    expect(a.semana).toEqual({ pagamentos: 3, valorCents: 10000, gorjetaCents: 700, contas: 2 });
    expect(a.metodos).toEqual({ pix: 1, card: 1, house_account: 1 });
    expect(a.dias.find((d) => d.dia === '2026-07-20').contas).toBe(1);
  });
});
