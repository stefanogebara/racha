# tools/carve — como o conjunto de xilogravuras foi feito

Reprodutível de propósito: o conjunto em `ios/Racha/Resources/Carved/` é
provisório (decisão #33) e vai ser refeito, seja com outro prompt, seja pela mão
de um cordelista de verdade. Um conjunto que só existe como PNG no repositório
não pode ser corrigido — só substituído no escuro.

```bash
export FAL_KEY='<id>:<secret>'          # NUNCA commitado; .env e .env.* são ignorados
node tools/carve/carve.mjs              # gera 2 candidatos por categoria em fal/raw/
python3 tools/carve/qc.py fal/raw/*.png # reprova cor vazada e sombra chapada
python3 tools/carve/cut.py <src> <dst>  # vira máscara alfa, normalizada por massa
```

## As três coisas que não são óbvias

**Uma imagem por assunto, não uma folha de contato.** A folha garante uma mão só
por construção, mas nenhum modelo coloca quatro assuntos DIFERENTES numa grade
sem repetir um e perder outro — testado, o peixe aparecia duas vezes. Prompt por
assunto com o mesmo bloco de estilo e a mesma semente segura a mão igual e dá
controle do que sai.

**Os dois modos de falha são silenciosos** (`qc.py`). O arquivo é um PNG válido
nos dois casos e o estrago só aparece como borrão cinza num telefone, num bar:

- *cor vazada* — o modelo ignora "sem cor" justamente onde o assunto É a cor
  dele (limão, folha, suco de laranja). Em escala de cinza o verde vira tinta
  média e a máscara sai lama. Dos 28 primeiros, 10 reprovaram.
- *sombra projetada* — o modelo desenha sombra, que uma gravura em relevo não
  tem. O sinal é uma mancha grande e CHAPADA: massa de tinta de verdade neste
  estilo sempre tem goiva cavada dentro.

**A sombra sai no limiar, não no prompt** (`cut.py`). Medido, essas impressões
voltam bimodais — tinta de verdade em L<0,15 e um segundo pico em L~0,45–0,52,
que é a sombra. Uma gravura de um bloco só é bimodal por construção: ou o bloco
encostou no papel ou não encostou. Todo cinza médio é sombreado que o processo
não sabe fazer. Rampa curta e baixa mata a sombra e preserva a borda da tinta.
