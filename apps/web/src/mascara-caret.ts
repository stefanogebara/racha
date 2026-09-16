/**
 * ONDE O CURSOR FICA DEPOIS QUE A MÁSCARA REESCREVE O CAMPO.
 *
 * Um campo mascarado é um `<input>` controlado cujo valor é REESCRITO a cada
 * tecla: a pessoa digita `5`, o React devolve `529.982.247-25` formatado. O
 * navegador, ao receber um valor novo, põe o cursor no fim — e ninguém repõe.
 *
 * Medido no navegador, com teclas de verdade, em 2026-09-16: com
 * `529.982.247-25` no campo do CPF e o cursor na posição 3, um Backspace
 * (a pessoa corrigindo o terceiro dígito) devolve o valor certo,
 * `529.822.472-5`, e o cursor na posição **13** — o fim. A tecla seguinte cai
 * no lugar errado, e a seguinte também. Na prática não dá pra corrigir um
 * dígito do meio: só apagando tudo. É o que faz um campo parecer travado sem
 * estar lento.
 *
 * Vale pros três campos mascarados da plataforma — o CPF do cliente na tela de
 * pagamento, o CNPJ da casa no cadastro, e o documento do recebedor.
 *
 * ── A REGRA ──────────────────────────────────────────────────────────────────
 * O cursor não é uma posição, é uma CONTAGEM: "depois do enésimo caractere que
 * vale". Pontuação é do formatador, não da pessoa. Então conta-se quantos
 * alfanuméricos existem antes do cursor no texto que a pessoa acabou de editar,
 * e procura-se a posição no texto MASCARADO que tem essa mesma contagem antes
 * de si.
 *
 * Contar POSIÇÕES em vez de alfanuméricos erra sempre que a máscara muda de
 * tamanho — que é o caso toda vez que um grupo abre ou fecha, ou seja, o tempo
 * todo. Contar de trás pra frente ("quantos caracteres faltavam pro fim") é o
 * atalho comum e erra na direção oposta: apagar o último dígito de um grupo
 * some com o separador e o cursor pula um caractere pra esquerda.
 *
 * Apagar um SEPARADOR é o caso de borda conhecido: a contagem de alfanuméricos
 * antes do cursor não muda, o formatador repõe a pontuação, e o cursor volta
 * pro mesmo lugar — um Backspace "sem efeito". O próximo apaga o dígito. É o
 * comportamento de todo campo mascarado que se comporta, e é muito melhor que
 * a alternativa (apagar o dígito vizinho sem a pessoa ter pedido).
 */

/** Um caractere que a PESSOA digitou, e não o formatador. */
const vale = (c: string) => /[0-9A-Za-z]/.test(c);

/**
 * @param editado   o texto como ficou logo depois da tecla, antes da máscara.
 * @param posicao   onde o cursor estava nesse texto (`selectionStart`).
 * @param mascarado o texto depois da máscara — o que vai pra tela.
 * @returns a posição do cursor no texto mascarado.
 */
export function caretDepoisDaMascara(editado: string, posicao: number, mascarado: string): number {
  const alvo = [...editado.slice(0, Math.max(0, posicao))].filter(vale).length;
  if (alvo === 0) {
    // Cursor antes de qualquer caractere que valha: vai pro começo, e não
    // depois da pontuação que o formatador porventura tenha posto ali.
    return 0;
  }
  let vistos = 0;
  for (let i = 0; i < mascarado.length; i++) {
    if (vale(mascarado[i])) {
      vistos++;
      if (vistos === alvo) return i + 1;
    }
  }
  // A máscara encurtou o texto (o campo cortou no `maxLength`, por exemplo):
  // o fim é o lugar honesto.
  return mascarado.length;
}
