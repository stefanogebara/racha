/**
 * O que a tela faz com o status de um PaymentIntent do Bizum.
 *
 * Isto existe como função pura, e não como um `if` dentro do componente, porque
 * foi onde estava o bug — e porque um bug de status nesta tela é alguém que
 * pagou ouvindo que não pagou.
 *
 * **O que a API de verdade devolve.** Confirmado no sandbox da Stripe
 * (2026-09-07): confirmar uma cobrança Bizum devolve
 * `status: 'requires_action'` com `next_action.type: 'await_authorization'` —
 * NÃO `processing`. O código original só aceitava `processing` e `succeeded`, e
 * caía no `else` de erro: o cliente autorizava no app do banco e a tela dizia
 * "pagamento não concluído". Nenhum teste pegaria isso, porque a suposição
 * errada estava nos dois lados; só a chamada real pegou.
 *
 * **A regra certa é a inversa.** Não se lista o que é sucesso — lista-se o que
 * é FRACASSO, e todo o resto é espera. O Bizum é assíncrono por natureza: quem
 * confirma é o banco do pagador, depois, por webhook. A tela nunca sabe que foi
 * pago; o razão sabe (inegociável #6). Então a tela só precisa distinguir
 * "acabou mal" de "ainda não acabou", e um status novo que a Stripe inventar
 * amanhã cai em espera, que é o lado seguro: o poll da conta corrige a tela em
 * segundos, enquanto um erro falso manda a pessoa pagar de novo.
 */

/** Status em que a cobrança acabou mal e a pessoa precisa tentar de novo. */
const FAILED = new Set([
  'requires_payment_method', // recusado, ou o pagador desistiu no app do banco
  'canceled',
]);

export type BizumOutcome = 'failed' | 'waiting';

export function bizumOutcome(status: string | null | undefined): BizumOutcome {
  if (!status) return 'failed'; // sem status não há cobrança pra esperar
  return FAILED.has(status) ? 'failed' : 'waiting';
}
