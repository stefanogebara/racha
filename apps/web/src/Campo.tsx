import type { InputHTMLAttributes, ReactNode } from 'react';

/**
 * UM CAMPO COM RÓTULO VISÍVEL — a moldura do Presence (`.ps-field-row label`).
 *
 * Todo campo desta plataforma era placeholder e mais nada. O rótulo sumia no
 * primeiro caractere, e num formulário de "CNPJ / agência / conta / CPF do
 * responsável" quem volta pra conferir não sabe mais em qual campo está. O
 * `aria-label` que existia resolvia pro leitor de tela e não pra quem enxerga.
 *
 * O componente carrega junto as três coisas que faltavam em todo call site:
 *  · `<label>` DE VERDADE (o `htmlFor` implícito, porque o input é filho) —
 *    então tocar no rótulo foca o campo, que num telefone é metade do alvo;
 *  · `autoComplete`, que é o que faz o teclado do telefone oferecer o valor
 *    que a pessoa já tem guardado — num fluxo de pagamento, cada campo digitado
 *    à mão é uma chance de desistir;
 *  · `aria-invalid` + o recado colado no campo, em vez de uma frase solta no
 *    fim do formulário.
 *
 * A cor NUNCA é a mensagem: `ruim` pinta a moldura E o rótulo, e quem usa o
 * componente escreve o `recado` (WCAG 1.4.1).
 */
export type CampoProps = {
  rotulo: string;
  /** O recado colado no campo — o porquê da recusa, ou uma dica. */
  recado?: ReactNode;
  /** `ruim` quando o valor não serve; só aí a moldura vai pra coral. */
  ruim?: boolean;
  /** `bom` pinta o recado de musgo (um "confere" curto), nunca a moldura. */
  bom?: boolean;
} & InputHTMLAttributes<HTMLInputElement>;

export function Campo({ rotulo, recado, ruim, bom, ...resto }: CampoProps) {
  return (
    <div>
      <label className={`campo${ruim ? ' ruim' : ''}`}>
        <span>{rotulo}</span>
        <input {...resto} aria-invalid={ruim || undefined} />
      </label>
      {recado && <span className={`campo-msg${ruim ? ' ruim' : bom ? ' bom' : ''}`}>{recado}</span>}
    </div>
  );
}
