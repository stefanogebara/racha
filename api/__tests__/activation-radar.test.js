'use strict';

/**
 * Radar de ativação — o funil que ninguém vigiava.
 *
 * Contrato: dado o estado de um restaurante, dizer em QUE degrau do funil ele
 * parou e qual é a ÚNICA ação que destrava. Puro: sem I/O, sem relógio próprio
 * (nowMs entra por parâmetro), então o teste é determinístico.
 */

const {
  ESTAGIOS, classificarVenue, montarRadar, DIAS_CARENCIA, DIAS_ESFRIOU,
} = require('../_lib/activation/radar');

const DIA = 24 * 60 * 60 * 1000;
const AGORA = Date.parse('2026-07-25T12:00:00Z');
const diasAtras = (n) => AGORA - n * DIA;

/** Venue "saudável" — cada teste piora UM eixo, então o que quebra fica óbvio. */
const venue = (over = {}) => ({
  id: 'v1',
  name: 'Restaurante Teste',
  recebedorOk: true,
  mesasReais: 3,
  contas: 10,
  pagosConfirmados: 8,
  ultimoPagamentoMs: diasAtras(1),
  criadoMs: diasAtras(30),
  ...over,
});

describe('classificarVenue — degraus do funil, do mais grave pro melhor', () => {
  test('sem recebedor é o mais urgente: não consegue receber dinheiro nenhum', () => {
    const r = classificarVenue(venue({ recebedorOk: false }), AGORA);
    expect(r.estagio).toBe(ESTAGIOS.SEM_RECEBEDOR);
    expect(r.prioridade).toBe(1);
    expect(r.precisaAcao).toBe(true);
    expect(r.acao).toMatch(/recebedor/i);
  });

  test('sem recebedor ganha de tudo — mesmo com mesas, contas e pagamentos', () => {
    // Blindagem: a ordem do funil não pode inverter por causa de métrica boa
    // mais adiante (dado inconsistente não pode esconder o bloqueio de dinheiro).
    const r = classificarVenue(venue({ recebedorOk: false, mesasReais: 0, contas: 0, pagosConfirmados: 0 }), AGORA);
    expect(r.estagio).toBe(ESTAGIOS.SEM_RECEBEDOR);
  });

  test('recebedor ok mas nenhuma mesa real: só treino/inativa não vira dinheiro', () => {
    const r = classificarVenue(venue({ mesasReais: 0, contas: 0, pagosConfirmados: 0 }), AGORA);
    expect(r.estagio).toBe(ESTAGIOS.SEM_MESAS);
    expect(r.prioridade).toBe(2);
    expect(r.precisaAcao).toBe(true);
  });

  test('setup pronto e nunca abriu conta (passada a carência) → sem_uso', () => {
    const r = classificarVenue(
      venue({ contas: 0, pagosConfirmados: 0, ultimoPagamentoMs: null, criadoMs: diasAtras(DIAS_CARENCIA + 1) }),
      AGORA,
    );
    expect(r.estagio).toBe(ESTAGIOS.SEM_USO);
    expect(r.precisaAcao).toBe(true);
    expect(r.acao).toMatch(/QR/i); // o destravador é o QR na mesa
  });

  test('venue recém-criado NÃO vira alerta — carência antes de cobrar uso', () => {
    const r = classificarVenue(
      venue({ contas: 0, pagosConfirmados: 0, ultimoPagamentoMs: null, criadoMs: diasAtras(1) }),
      AGORA,
    );
    expect(r.estagio).toBe(ESTAGIOS.NOVO);
    expect(r.precisaAcao).toBe(false);
  });

  test('abriu contas mas nenhum pagamento confirmou → sem_primeiro_pagamento', () => {
    const r = classificarVenue(
      venue({ contas: 4, pagosConfirmados: 0, ultimoPagamentoMs: null }),
      AGORA,
    );
    expect(r.estagio).toBe(ESTAGIOS.SEM_PRIMEIRO_PAGAMENTO);
    expect(r.precisaAcao).toBe(true);
  });

  test('já pagou, mas faz tempo → esfriou', () => {
    const r = classificarVenue(venue({ ultimoPagamentoMs: diasAtras(DIAS_ESFRIOU + 1) }), AGORA);
    expect(r.estagio).toBe(ESTAGIOS.ESFRIOU);
    expect(r.precisaAcao).toBe(true);
    expect(r.diasSemPagar).toBe(DIAS_ESFRIOU + 1);
  });

  test('pagamento recente → ativo, sem ação', () => {
    const r = classificarVenue(venue(), AGORA);
    expect(r.estagio).toBe(ESTAGIOS.ATIVO);
    expect(r.precisaAcao).toBe(false);
  });

  test('limites: exatamente no corte ainda NÃO alarma (só passa do corte)', () => {
    const noCorteEsfriou = classificarVenue(venue({ ultimoPagamentoMs: diasAtras(DIAS_ESFRIOU) }), AGORA);
    expect(noCorteEsfriou.estagio).toBe(ESTAGIOS.ATIVO);

    const noCorteCarencia = classificarVenue(
      venue({ contas: 0, pagosConfirmados: 0, ultimoPagamentoMs: null, criadoMs: diasAtras(DIAS_CARENCIA) }),
      AGORA,
    );
    expect(noCorteCarencia.estagio).toBe(ESTAGIOS.NOVO);
  });

  test('entrada capenga não explode — campos faltando viram o pior caso, não crash', () => {
    // O radar roda em cron: um venue com dado incompleto não pode derrubar o
    // lote inteiro. Sem recebedor conhecido = tratar como bloqueado.
    const r = classificarVenue({ id: 'x', name: 'Sem dados' }, AGORA);
    expect(r.estagio).toBe(ESTAGIOS.SEM_RECEBEDOR);
    expect(r.precisaAcao).toBe(true);
  });
});

describe('montarRadar — o que o fundador recebe', () => {
  // Um de cada degrau, pra provar a ordenação e a contagem de uma vez só.
  const lote = [
    venue({ id: 'a', name: 'Okay', recebedorOk: false, mesasReais: 1, contas: 0, pagosConfirmados: 0, ultimoPagamentoMs: null, criadoMs: diasAtras(2) }),
    venue({ id: 'b', name: 'Kitos Food', mesasReais: 1, contas: 0, pagosConfirmados: 0, ultimoPagamentoMs: null, criadoMs: diasAtras(5) }),
    venue({ id: 'c', name: 'Beira Mar', mesasReais: 1, contas: 4, pagosConfirmados: 1, ultimoPagamentoMs: diasAtras(10), criadoMs: diasAtras(14) }),
    venue({ id: 'd', name: 'Ativo SA' }),
  ];

  test('ordena por urgência: quem está mais longe do dinheiro vem primeiro', () => {
    const r = montarRadar(lote, AGORA);
    expect(r.alertas[0].name).toBe('Okay'); // sem recebedor = prioridade 1
    expect(r.alertas.every((a) => a.precisaAcao)).toBe(true);
  });

  test('conta ativos e alertas separadamente, e resume o lote', () => {
    const r = montarRadar(lote, AGORA);
    expect(r.total).toBe(4);
    expect(r.ativos).toBe(1);           // só 'Ativo SA'
    expect(r.alertas).toHaveLength(3);  // Okay, Kitos, Beira Mar
    expect(r.porEstagio[ESTAGIOS.SEM_RECEBEDOR]).toBe(1);
    expect(r.porEstagio[ESTAGIOS.SEM_USO]).toBe(1);
    expect(r.porEstagio[ESTAGIOS.ESFRIOU]).toBe(1);
  });

  test('sem nada pra fazer → precisaEnviar false (não incomoda o fundador à toa)', () => {
    const r = montarRadar([venue({ id: 'z' })], AGORA);
    expect(r.alertas).toHaveLength(0);
    expect(r.precisaEnviar).toBe(false);
  });

  test('demo NÃO entra no radar — Bar do Zé não é cliente', () => {
    const r = montarRadar([
      venue({ id: 'demo1', name: 'Bar do Zé [demo ca8c]', recebedorOk: false }),
      venue({ id: 'demo2', name: 'Bar do Racha — demonstração', recebedorOk: false }),
      venue({ id: 'real', name: 'Okay', recebedorOk: false }),
    ], AGORA);
    expect(r.total).toBe(1);
    expect(r.alertas).toHaveLength(1);
    expect(r.alertas[0].name).toBe('Okay');
  });

  test('a mensagem cita cada restaurante travado e a ação dele', () => {
    const r = montarRadar(lote, AGORA);
    expect(r.mensagem).toContain('Okay');
    expect(r.mensagem).toContain('Kitos Food');
    expect(r.mensagem).not.toContain('Ativo SA'); // ativo não vira ruído
  });

  test('lote vazio não quebra', () => {
    const r = montarRadar([], AGORA);
    expect(r.total).toBe(0);
    expect(r.precisaEnviar).toBe(false);
  });
});
