import type { InputHTMLAttributes, ReactNode } from 'react';
import { useMascara } from './useMascara';

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
  /**
   * CAMPO MASCARADO. Quando isto existe, o `Campo` assume o cursor.
   *
   * Um `<input>` controlado cujo valor é reescrito a cada tecla perde o cursor
   * pro fim do texto. Medido no navegador, com teclas de verdade, em
   * 2026-09-16: com `529.982.247-25` no campo do CPF e o cursor na posição 3,
   * um Backspace devolvia o valor certo e o cursor na posição **13** — o fim.
   * A tecla seguinte caía no lugar errado, e a seguinte também: não dava pra
   * corrigir um dígito do meio sem apagar tudo. Um campo que briga assim é
   * lido como "travou", e foi essa a pergunta que abriu esta investigação.
   *
   * O `value` que chega continua sendo o do chamador; quem formata pra tela é
   * este componente, e quem repõe o cursor também. Ver `mascara-caret.ts` — a
   * conta é pura e tem teste próprio.
   */
  mascara?: (bruto: string) => string;
} & InputHTMLAttributes<HTMLInputElement>;

export function Campo({ rotulo, recado, ruim, bom, mascara, value, onChange, ...resto }: CampoProps) {
  // O gancho roda SEMPRE (regra dos hooks); quando não há máscara, o que ele
  // devolve é ignorado logo abaixo.
  const mascarado = useMascara(mascara ?? ((v) => v), String(value ?? ''), () => {});
  const comMascara = mascara
    ? {
      ref: mascarado.ref,
      value: mascarado.value,
      onChange: (e: Parameters<typeof mascarado.onChange>[0]) => {
        mascarado.onChange(e);
        onChange?.(e);
      },
    }
    // O `ref` vai nos DOIS ramos: sem ele, um componente cujo `mascara` aparece
    // ou some entre renders desanexa e reanexa o ref do DOM. Inerte hoje (nenhum
    // chamador alterna), e de graça.
    : { ref: mascarado.ref, value, onChange };

  return (
    <div>
      <label className={`campo${ruim ? ' ruim' : ''}`}>
        <span>{rotulo}</span>
        <input {...resto} {...comMascara} aria-invalid={ruim || undefined} />
      </label>
      {recado && <span className={`campo-msg${ruim ? ' ruim' : bom ? ' bom' : ''}`}>{recado}</span>}
    </div>
  );
}
