'use strict';

/**
 * OS PAPÉIS EM `venue_members` — num lugar só.
 *
 * Quatro leituras dependem de escrever `'owner'` igualzinho: as duas do store
 * de produção, as duas do store de memória. Uma string literal repetida quatro
 * vezes num portão de autorização é a mesma forma de defeito que já rendeu três
 * cópias divergentes do predicado de estorno nesta casa — e aqui a divergência
 * não dá erro, dá ACESSO: um `'Owner'` num dos lados fecha o painel do dono ou,
 * pior, abre o de quem não é.
 *
 * O valor também mora no CHECK da migração 0003. O teste `papel-de-dono` afirma
 * que os dois concordam: um papel que o banco recusa vira um portão que nunca
 * abre, e um que o código não conhece vira um portão que sempre abre.
 */
const PAPEL_DE_DONO = 'owner';

module.exports = { PAPEL_DE_DONO };
