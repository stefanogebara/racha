'use strict';

/**
 * Split engine — the sum invariant is the product. If any of these fail,
 * money is being created or destroyed and nothing else matters.
 */

const { splitEqual, validateCustomSplit, splitByItems, servicoCents, allocateRefund } = require('../_lib/checks/split-engine');

describe('splitEqual — exact largest-remainder division', () => {
  test('divides evenly when possible', () => {
    expect(splitEqual(9000, 3)).toEqual([3000, 3000, 3000]);
  });

  test('distributes remainder centavos, parts differ by at most 1', () => {
    const parts = splitEqual(10000, 3); // R$100,00 / 3
    expect(parts.reduce((s, p) => s + p, 0)).toBe(10000);
    expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
    expect(parts).toEqual([3334, 3333, 3333]);
  });

  test('rotation moves who absorbs the extra centavo', () => {
    expect(splitEqual(100, 3, 0)).toEqual([34, 33, 33]);
    expect(splitEqual(100, 3, 1)).toEqual([33, 34, 33]);
    expect(splitEqual(100, 3, 2)).toEqual([33, 33, 34]);
    expect(splitEqual(100, 3, 3)).toEqual([34, 33, 33]); // wraps
  });

  test('property: sum invariant holds across a sweep of totals and party sizes', () => {
    for (let total = 0; total <= 1000; total += 7) {
      for (let n = 1; n <= 12; n++) {
        const parts = splitEqual(total, n, total % n);
        expect(parts).toHaveLength(n);
        expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
        expect(parts.every((p) => p >= 0)).toBe(true);
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
      }
    }
  });

  test('n=1 returns the whole total', () => {
    expect(splitEqual(12345, 1)).toEqual([12345]);
  });

  test('rejects floats, negatives, zero parties', () => {
    expect(() => splitEqual(100.5, 2)).toThrow(/centavos/);
    expect(() => splitEqual(-1, 2)).toThrow(/centavos/);
    expect(() => splitEqual(100, 0)).toThrow(/positive integer/);
    expect(() => splitEqual(100, 2, -1)).toThrow(/rotate/);
  });
});

describe('validateCustomSplit — diner-entered amounts must cover exactly', () => {
  test('exact cover passes', () => {
    expect(validateCustomSplit(10000, [7000, 3000])).toEqual({ ok: true });
  });

  test('short and over report the signed difference', () => {
    expect(validateCustomSplit(10000, [5000, 4000])).toEqual({ ok: false, diffCents: 1000 });
    expect(validateCustomSplit(10000, [8000, 4000])).toEqual({ ok: false, diffCents: -2000 });
  });

  test('rejects empty and non-integer amounts', () => {
    expect(() => validateCustomSplit(100, [])).toThrow(/non-empty/);
    expect(() => validateCustomSplit(100, [50.5, 49.5])).toThrow(/centavos/);
  });
});

describe('splitByItems — per-person exact allocation', () => {
  test('solo items go entirely to the claimant', () => {
    const { perPerson, totalCents } = splitByItems([
      { id: 'picanha', priceCents: 8990, claimedBy: ['ana'] },
      { id: 'suco', priceCents: 1200, claimedBy: ['bia'] },
    ]);
    expect(perPerson).toEqual({ ana: 8990, bia: 1200 });
    expect(totalCents).toBe(10190);
  });

  test('shared item splits exactly; rotation spreads centavos across items', () => {
    const { perPerson, totalCents } = splitByItems([
      { id: 'a', priceCents: 100, claimedBy: ['p1', 'p2', 'p3'] }, // idx 0 → p1 gets 34
      { id: 'b', priceCents: 100, claimedBy: ['p1', 'p2', 'p3'] }, // idx 1 → p2 gets 34
      { id: 'c', priceCents: 100, claimedBy: ['p1', 'p2', 'p3'] }, // idx 2 → p3 gets 34
    ]);
    expect(perPerson).toEqual({ p1: 100, p2: 100, p3: 100 });
    expect(totalCents).toBe(300);
  });

  test('property: per-person totals always sum to the check total', () => {
    const items = [
      { id: 'i1', priceCents: 4437, claimedBy: ['a', 'b'] },
      { id: 'i2', priceCents: 999, claimedBy: ['a', 'b', 'c'] },
      { id: 'i3', priceCents: 12301, claimedBy: ['c'] },
      { id: 'i4', priceCents: 1, claimedBy: ['a', 'b', 'c'] },
    ];
    const { perPerson, totalCents } = splitByItems(items);
    const sum = Object.values(perPerson).reduce((s, v) => s + v, 0);
    expect(sum).toBe(totalCents);
    expect(totalCents).toBe(4437 + 999 + 12301 + 1);
  });

  test('unclaimed item is an error — the UI resolves claims first', () => {
    expect(() => splitByItems([{ id: 'x', priceCents: 100, claimedBy: [] }])).toThrow(/no claimants/);
  });

  test('a diner named __proto__ keeps their share (review finding: money vanished)', () => {
    const { perPerson, totalCents } = splitByItems([
      { id: 'x', priceCents: 100, claimedBy: ['__proto__'] },
      { id: 'y', priceCents: 250, claimedBy: ['constructor', 'ana'] },
    ]);
    expect(perPerson['__proto__']).toBe(100);
    expect(perPerson['constructor']).toBe(125);
    expect(perPerson['ana']).toBe(125);
    const sum = Object.values(perPerson).reduce((s, v) => s + v, 0);
    expect(sum).toBe(totalCents);
  });

  test('duplicate claimants on one item are rejected', () => {
    expect(() => splitByItems([{ id: 'x', priceCents: 100, claimedBy: ['ana', 'ana'] }]))
      .toThrow(/duplicate claimants/);
  });

  test('non-string claimant ids are rejected', () => {
    expect(() => splitByItems([{ id: 'x', priceCents: 100, claimedBy: [42] }]))
      .toThrow(/non-empty strings/);
  });
});

describe('servicoCents — optional serviço math (basis points, half-up, NO default)', () => {
  test('10% must be passed explicitly (review finding: silent default = implicit charge)', () => {
    expect(servicoCents(10000, 1000)).toBe(1000);
    expect(() => servicoCents(10000)).toThrow(/out of range/); // undefined bp rejected
  });

  test('half-up rounding at the centavo', () => {
    expect(servicoCents(5, 1000)).toBe(1);   // 0.5 → 1
    expect(servicoCents(4, 1000)).toBe(0);   // 0.4 → 0
    expect(servicoCents(12345, 1000)).toBe(1235); // 1234.5 → 1235
  });

  test('other percentages in basis points (12% = 1200)', () => {
    expect(servicoCents(10000, 1200)).toBe(1200);
    expect(servicoCents(10000, 0)).toBe(0);
  });

  test('rejects out-of-range and guards overflow', () => {
    expect(() => servicoCents(10000, 3001)).toThrow(/out of range/);
    expect(servicoCents(10000, 10)).toBe(10); // 10bp = 0.1% — legal, math is exact
    expect(() => servicoCents(Number.MAX_SAFE_INTEGER - 1, 1000)).toThrow(/safe integer range/);
  });
});

describe('allocateRefund — quem perde primeiro num estorno é decisão, não subtração', () => {
  test('as duas partes SOMAM o estorno, sempre — propriedade, não exemplo', () => {
    // A invariante que importa: nenhum centavo é criado nem desaparece no
    // rateio. Mesma disciplina do `splitEqual`, e pelo mesmo motivo.
    for (let consumo = 0; consumo <= 4000; consumo += 137) {
      for (let gorjeta = 0; gorjeta <= 600; gorjeta += 43) {
        const total = consumo + gorjeta;
        for (let estorno = 0; estorno <= total; estorno += Math.max(1, Math.floor(total / 11))) {
          const { amountCents, tipCents } = allocateRefund(consumo, gorjeta, estorno);
          expect(amountCents + tipCents).toBe(estorno);
          expect(amountCents).toBeGreaterThanOrEqual(0);
          expect(tipCents).toBeGreaterThanOrEqual(0);
          // Nunca devolve mais do que aquele lado recebeu.
          expect(amountCents).toBeLessThanOrEqual(consumo);
          expect(tipCents).toBeLessThanOrEqual(gorjeta);
        }
      }
    }
  });

  test('proporcional: a gorjeta devolve a fatia que recebeu, não tudo', () => {
    // O comportamento antigo era `Math.min(gorjeta, estorno)` — gorjeta
    // inteira primeiro. Num estorno de 500 sobre 3082+308 isso raspava os 308.
    expect(allocateRefund(3082, 308, 500)).toEqual({ amountCents: 455, tipCents: 45 });
    // Metade da conta devolve metade da gorjeta.
    expect(allocateRefund(1000, 100, 550)).toEqual({ amountCents: 500, tipCents: 50 });
  });

  test('estorno total devolve exatamente o que foi pago de cada lado', () => {
    expect(allocateRefund(3082, 308, 3390)).toEqual({ amountCents: 3082, tipCents: 308 });
    expect(allocateRefund(1, 1, 2)).toEqual({ amountCents: 1, tipCents: 1 });
  });

  test('sem gorjeta, ou sem consumo, o estorno vai inteiro pro lado que existe', () => {
    expect(allocateRefund(1000, 0, 400)).toEqual({ amountCents: 400, tipCents: 0 });
    expect(allocateRefund(0, 300, 100)).toEqual({ amountCents: 0, tipCents: 100 });
    expect(allocateRefund(0, 0, 0)).toEqual({ amountCents: 0, tipCents: 0 });
  });

  test('estorno maior que o pago ESTOURA, não arredonda', () => {
    // Um PSP dizendo ter devolvido mais do que recebeu é divergência de
    // dinheiro. Inventar um número aqui esconderia isso.
    expect(() => allocateRefund(1000, 100, 1101)).toThrow(/exceeds paid total/);
    expect(() => allocateRefund(1000, 100, -1)).toThrow();
    expect(() => allocateRefund(1000.5, 100, 100)).toThrow();
  });
});

describe('pagamento a MENOR: o serviço é o resíduo', () => {
  const { allocateUnderpayment, allocateRefund } = require('../_lib/checks/split-engine');

  test('o consumo é quitado primeiro; a gorjeta fica com o que sobrar', () => {
    // Conta de 3390 + 339 de serviço. O cliente digita 3390 no app do banco.
    expect(allocateUnderpayment(3390, 339, 3390)).toEqual({ amountCents: 3390, tipCents: 0 });
    // Pagou 3500: comida quitada, 110 de serviço arrecadado.
    expect(allocateUnderpayment(3390, 339, 3500)).toEqual({ amountCents: 3390, tipCents: 110 });
    // Pagou o valor cheio: nada muda.
    expect(allocateUnderpayment(3390, 339, 3729)).toEqual({ amountCents: 3390, tipCents: 339 });
    // Pagou muito pouco: nem a comida fecha, e não há gorjeta nenhuma.
    expect(allocateUnderpayment(3390, 339, 500)).toEqual({ amountCents: 500, tipCents: 0 });
  });

  test('as partes somam o recebido, sempre — em mil combinações', () => {
    for (let i = 0; i < 1000; i += 1) {
      const consumo = Math.floor(Math.random() * 50000);
      const servico = Math.floor(Math.random() * 5000);
      const recebido = Math.floor(Math.random() * (consumo + servico + 1));
      const r = allocateUnderpayment(consumo, servico, recebido);
      expect(r.amountCents + r.tipCents).toBe(recebido);
      expect(r.amountCents).toBeGreaterThanOrEqual(0);
      expect(r.tipCents).toBeGreaterThanOrEqual(0);
      expect(r.amountCents).toBeLessThanOrEqual(consumo);
      expect(r.tipCents).toBeLessThanOrEqual(servico);
    }
  });

  test('receber MAIS do que a conta pediu não é caso desta função', () => {
    // O excedente é outra decisão (restituição, CC art. 876) e tem outro
    // caminho. Aqui é erro de programação, alto.
    expect(() => allocateUnderpayment(3390, 339, 4000)).toThrow(RangeError);
  });

  test('o ESTORNO continua proporcional — é outra pergunta jurídica', () => {
    // No estorno as duas parcelas foram validamente recebidas, então desfazer
    // tira uma fatia de cada. Esta separação é o ponto: as duas funções não
    // podem voltar a ser a mesma.
    expect(allocateRefund(3390, 339, 500)).toEqual({ amountCents: 455, tipCents: 45 });
  });
});
