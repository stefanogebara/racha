#!/bin/bash
# PORTÃO DE MUTAÇÃO DO GUARDA SWIFT.
#
# O `api/__tests__/mutacoes-afirmacao.test.js` muta o CENSO (JS). O guarda que
# chega ao cliente é o Swift, e ninguém tinha apagado peça dele pra ver se o
# corpo compartilhado reage — a medição que envergonhou o desenho JS (três de
# seis peças apagáveis com o corpo verde) nunca tinha sido rodada do outro
# lado. Apontado pela revisão de segurança de 2026-09-13.
#
# Roda fora do Xcode, com `swiftc` sobre os dois arquivos do Agent: dois
# segundos por mutação em vez de trinta.
set -uo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

python3 - "$TMP" <<'PY'
import json, subprocess, sys, os, re
TMP = sys.argv[1]
casos = json.load(open('docs/compliance/afirmacoes.fixture.json'))['casos']
guarda = open('ios/Racha/Agent/RevisaoDeAfirmacoes.swift').read()

MUT = [
 ("negador colado vira negador solto", "regex(ClaimPatterns.negadorColado)", "regex(ClaimPatterns.negadores)"),
 # AS TRÊS ÂNCORAS DO `nega` estavam só na lista JS. `nega` NÃO é gerado — é um
 # gêmeo escrito à mão —, e regressão só do lado Swift é exatamente a falha
 # assimétrica que o gerador existe pra impedir: o que o build pega e o runtime
 # não, chega ao cliente. Apontado pelas duas revisões de 2026-09-14.
 ("âncora do substantivo da gorjeta",
  "            for g in gorjetas where g.location + g.length <= d.location {\n"
  "                ini = max(ini, g.location + g.length); achou = true\n"
  "            }", ""),
 ("âncora da forma direcional", "                ini = max(ini, p); achou = true", ""),
 ("janela do nega volta a ser orçamento de CARACTERES",
  "                while p > 0 && palavras < 3 {\n"
  "                    p -= 1\n"
  "                    if ns.character(at: p) == 32 { palavras += 1 }\n"
  "                }", "                p = max(0, p - 10)"),
 ("âncora do separador interno",
  "            for sep in separadores where sep.location + sep.length <= d.location {\n"
  "                ini = max(ini, sep.location + sep.length); achou = true\n"
  "            }", ""),
 # Sem cobertura, e dito em voz alta — o mesmo veredito que o lado JS já
 # declara: toda entrada que isola esta peça traz também vírgula ou
 # substantivo ancorando no mesmo ponto. Falha FECHADO (tirá-la aperta o
 # guarda), e por isso fica declarada em vez de sumir do relatório.
 ("âncora do destinatário anterior", "var ini = anterior\n            var achou = anterior > 0",
  "var ini = 0\n            var achou = false", 'sem-cobertura'),
 ("nega olha só o primeiro destinatário", "        for d in dests {", "        for d in dests.prefix(1) {"),
 ("janela falha ABERTA", "ini = achou ? max(0, min(ini, d.location)) : d.location", "ini = max(0, min(ini, d.location))"),
 ("repartida olha só a primeira oração", "for (i, o) in partes.enumerated() where casa(destinatario, o) {",
  "for (i, o) in partes.enumerated().prefix(1) where casa(destinatario, o) {"),
 ("forma direcional deixa de ser decisiva",
  "            guard casa(gorjeta, texto) || casa(quantidade, texto) || comecaNaForma\n"
  "            else { continue }\n            if !nega(o) { return true }", ""),
 ("regra 1b deixa de exigir contexto de dinheiro",
  "            guard casa(gorjeta, texto) || casa(quantidade, texto) || comecaNaForma\n"
  "            else { continue }", ""),
 ("negador atrás deixa de olhar a ORDEM (promessa já feita)",
  "        if casa(direcional, antesDoNegador) { return false }", ""),
 ("negador atrás deixa de olhar o CONTRASTE",
  "        return !casa(contrasteColado, resto)", "        _ = resto; return true"),
 ("caminho FRACO deixa de exigir cabeça DIRECIONAL",
  "guard let m = acha(comEvasao ? cabecaDeDestino : cabecaDirecional, o) else { continue }",
  "guard let m = acha(cabecaDeDestino, o) else { continue }"),
 # Sem cobertura, como o gêmeo JS já declara: o corpo não tem caso em que a
 # dispensa do distribuidor no caminho FRACO muda veredito — ela é redundante
 # com o teste de verbo do prefixo contra este corpo. Falha FECHADO.
 ("distribuidor deixa de dispensar no caminho fraco",
  "            if temDistribuidor(o) && !casa(revoga, o) { continue }", "", 'sem-cobertura'),
 ("PREFIXO da cabeça deixa de ser julgado",
  "        if casa(verboFinito, ns.substring(to: m.location)) { return nil }", ""),
 ("PREFIXO do caminho fraco deixa de ser julgado",
  "            guard !casa(verboFinito, ns.substring(to: m.location)) else { continue }", ""),
 ("caminho FORTE deixa de existir",
  "            if cabecaValida(cabecaForte, o) != nil { return true }", ""),
 ("caminho FORTE aceita cabeça SEM quantidade",
  "            if cabecaValida(cabecaForte, o) != nil { return true }",
  "            if cabecaValida(cabecaDeDestino, o) != nil { return true }"),
 ("caminho FRACO deixa de exigir resto sem PREDICAÇÃO",
  "            guard !temPredicacao(resto) else { continue }", ""),
 ("caminho FRACO deixa de exigir quantidade na oração anterior",
  "            guard partes[..<i].contains(where: { casa(quantidade, $0) || casa(gorjeta, $0) })\n            else { continue }", ""),
 ("evasão deixa de revogar a dispensa do genitivo",
  "        if casa(revoga, oracao) { return casa(destinatario, oracao) }", ""),
 ("dispensa do distribuidor deixa de valer por SEGMENTO",
  "            for seg in segmentos(o) where destinatarioNaoAtributivo(seg) {",
  "            for seg in [o] where destinatarioNaoAtributivo(seg) {"),
 ("relativa deixa de sair antes do teste de predicação",
  "        let semRelativa = relativaQualquer.stringByReplacingMatches(\n"
  "            in: resto, range: NSRange(location: 0, length: (resto as NSString).length), withTemplate: \" \")",
  "        let semRelativa = resto"),
 ("pronome regido por preposição volta a contar como sujeito",
  "            if !casa(preposicaoRegendoPronome, ns.substring(to: p)) { return true }",
  "            _ = p; return true", 'sem-cobertura'),
 ("genitivo DESCRITIVO deixa de dispensar",
  "        return casa(destinatario, semGenitivo)", "        return casa(destinatario, oracao)"),
 ("distribuidor volta a valer pela janela toda",
  "                if !nega(o) && (casa(revoga, o) || !casa(distribuidor, seg)) { return true }",
  "                if !nega(o) && !casa(distribuidor, texto) { return true }"),
 ("revogação deixa de valer pela oração inteira",
  "        if casa(revoga, oracao) { return false }", "", 'sem-cobertura'),
 ("pré-condição volta a exigir o substantivo da gorjeta",
  "        guard casa(destinatario, texto) else { return false }",
  "        guard casa(gorjeta, texto), casa(destinatario, texto) else { return false }"),
]


# AFROUXAMENTOS — a metade que falta a uma mutação que só APAGA.
#
# Apagar mede cobertura de FALSO POSITIVO: tirar machinery permissiva aperta o
# guarda, e o vermelho vem de um caso `recusa: false`. Uma linha que AFROUXA é
# invisível a esse formato — e foi assim que um retorno precoce permissivo
# sobreviveu no código dos DOIS lados. Aqui o atalho é INSERIDO antes do laço
# da regra 3 e exige-se que o corpo acuse a perda.
ANCORA = "        for (i, o) in partes.enumerated() where casa(destinatario, o) {"
SOLTA = [
 ("atalho: qualquer oração com os dois substantivos encerra o julgamento",
  "        if partes.contains(where: { casa(gorjeta, $0) && casa(destinatario, $0) }) { return false }\n"),
 ("atalho: qualquer distribuidor em qualquer lugar dispensa",
  "        if partes.contains(where: temDistribuidor) { return false }\n"),
 ("atalho: negação em qualquer lugar do texto dispensa",
  "        if partes.contains(where: nega) { return false }\n"),
 ("atalho: só a primeira oração é olhada",
  "        if partes.count > 1 { return false }\n"),
]

PADROES = open('ios/Racha/Agent/ClaimPatterns.swift').read()

# ALARGAMENTOS — a terceira metade, e a que faltava dos dois lados.
#
# Apagar uma peça mede FALSO POSITIVO; inserir um atalho mede o mesmo pelo
# outro lado. Nenhum dos dois enxerga um TETO DE ARIDADE, por construção: a
# revisão mediu o antigo teto de palavras em 3, 4, 5, 6 e 40 e o corpo
# só reagia ABAIXO do valor escolhido. Subir o teto deixava tudo verde, com 48
# de 64 afirmações partidas escapando por cima dele. Aqui a peça é AFROUXADA no
# próprio `ClaimPatterns.swift` e exige-se vermelho.
# CADA ALARGAMENTO NOMEIA A PEÇA, não um literal. A versão anterior fazia
# `padroes.replace('{0,2}', '{0,9}')` sobre o arquivo INTEIRO, e `{0,2}` mora em
# três peças: o vermelho vinha do advérbio da forma direcional e da cauda da
# relativa, e o modificador — a peça que a mutação NOMEIA — não era medido.
# Portão que reporta vermelho pelo motivo errado é portão que mente.
# Achado pela revisão de segurança de 2026-09-14.
import re as _re

def lit_para_swift(x):
    return x.replace('\\', '\\\\').replace('"', '\\"')

def COMPOSTO_CABECA_QUALQUER():
    import subprocess as _s
    return _s.run(['node','-e',
      "const G=require('./docs/compliance/claims.json').gorjeta_destino;"
      "const {COMPOSTOS}=require('./scripts/gen-claim-patterns.js');"
      "process.stdout.write(COMPOSTOS.cabeca_de_destino(G));"],
      capture_output=True, text=True).stdout

def ClaimPatternsPrepDir():
    import json as _j
    return _j.load(open('docs/compliance/claims.json'))['gorjeta_destino']['preposicao_direcional']

def ClaimPatternsPrepDest():
    import json as _j
    return _j.load(open('docs/compliance/claims.json'))['gorjeta_destino']['preposicao_de_destino']

def campo(nomes, de, para):
    """Muta SÓ as linhas `static let <nome> = "..."` nomeadas."""
    if isinstance(nomes, str): nomes = [nomes]
    def f(padroes):
        fora = []
        for linha in padroes.split('\n'):
            if any(_re.match(r'\s*static let %s = ' % n, linha) for n in nomes):
                linha = linha.replace(de, para)
            fora.append(linha)
        return '\n'.join(fora)
    return f

def troca(nome, valor):
    """Substitui o literal INTEIRO de `static let <nome>`."""
    def f(padroes):
        return _re.sub(r'(static let %s = )"(?:[^"\\\\]|\\\\.)*"' % nome,
                       lambda m: m.group(1) + '"' + valor + '"', padroes, count=1)
    return f

ALARGA = [
 # A aridade mora em TRÊS lugares no Swift: no campo próprio (que o
 # `destinoEmQualquerLugar` compõe em tempo de execução) e já expandida dentro
 # das duas cabeças, que são literais pré-compostos. Mutar só o campo media um
 # terço da peça e dava verde.
 ("aridade do modificador cai de dois pra zero",
  campo(['modificadorDeDestino', 'cabecaDeDestino', 'cabecaForte', 'cabecaDirecional'], '{0,2}', '{0,0}')),
 ("cabeça do caminho fraco aceita preposição não-direcional",
  troca('cabecaDirecional', lit_para_swift(COMPOSTO_CABECA_QUALQUER()))),
 ("quantidade DETECTORA deixa de reconhecer notação nenhuma", troca('quantidade', 'zzzznuncacasa')),
 ("verbo finito deixa de ver o sujeito nulo", troca('verboFinito', 'zzzznuncacasa')),
 ("pronome sujeito deixa de contar", troca('pronomeSujeito', 'zzzznuncacasa')),
 ("núcleo de atribuição aceita qualquer substantivo",
  campo('genitivoDescritivo', '= "(', '= "([\\\\wáéíóúâêôãõç-]+|')),
]

def roda(fonte, padroes=None):
    open(f'{TMP}/CP.swift','w').write(padroes if padroes is not None else PADROES)
    open(f'{TMP}/Rev.swift','w').write(fonte.replace('enum RevisaoDeAfirmacoes {','public enum RevisaoDeAfirmacoes {',1))
    corpo = ['import Foundation', 'var falhas = 0',
             'let casos: [(String, Bool)] = [' + ','.join(
                 '(%s, %s)' % (json.dumps(c['texto'], ensure_ascii=False), 'true' if c['recusa'] else 'false') for c in casos) + ']',
             'for (t, esp) in casos where RevisaoDeAfirmacoes.afirmaDestinoSemDistribuidor(t) != esp { falhas += 1 }',
             'print(falhas)']
    open(f'{TMP}/main.swift','w').write('\n'.join(corpo))
    r = subprocess.run(['swiftc','-O',f'{TMP}/CP.swift',f'{TMP}/Rev.swift',f'{TMP}/main.swift','-o',f'{TMP}/p'],
                       capture_output=True, text=True)
    if r.returncode: return None
    return int(subprocess.run([f'{TMP}/p'], capture_output=True, text=True).stdout.strip())

base = roda(guarda)
if base != 0:
    print(f'✗ o guarda NÃO passa o corpo sem mutação ({base} falhas)'); sys.exit(1)
print(f'✓ sem mutação: {len(casos)} casos, 0 falhas')
ruim = 0
SEM_COBERTURA = {m[0] for m in MUT if len(m) > 3}
for m in MUT:
    nome, de, para = m[0], m[1], m[2]
    if de not in guarda:
        print(f'✗ {nome}: o trecho não existe mais no arquivo'); ruim += 1; continue
    n = roda(guarda.replace(de, para, 1))
    if n is None:
        # NÃO É DESCULPA. Mutação que não compila é peça que saiu do portão em
        # silêncio — a forma "guarda que nunca dispara" aplicada ao próprio
        # instrumento. Apontado pela revisão de segurança de 2026-09-14.
        print(f'✗ {nome}: não compila mutado — a peça saiu do portão'); ruim += 1; continue
    if nome in SEM_COBERTURA:
        # Declarada sem cobertura: se um dia ela PASSAR a ficar vermelha é
        # porque alguém escreveu o caso, e aí a marca tem que sair. Exceção que
        # sobrevive à própria razão é a dívida de sempre.
        print(('✓ ' if n == 0 else '✗ ') + f'{nome}: sem cobertura declarada ({n} vermelhos)')
        if n != 0: ruim += 1
        continue
    print(('✓ ' if n > 0 else '✗ ') + f'{nome}: {n} casos vermelhos')
    if n == 0: ruim += 1
for nome, atalho in SOLTA:
    if ANCORA not in guarda:
        print(f'✗ {nome}: a âncora do laço da regra 3 não existe mais'); ruim += 1; continue
    n = roda(guarda.replace(ANCORA, atalho + ANCORA, 1))
    if n is None:
        print(f'✗ {nome}: não compila mutado — o atalho saiu do portão'); ruim += 1; continue
    print(('✓ ' if n > 0 else '✗ ') + f'{nome}: {n} casos vermelhos')
    if n == 0: ruim += 1
for nome, alargar in ALARGA:
    mutados = alargar(PADROES)
    if mutados == PADROES:
        print(f'✗ {nome}: o alargamento não mudou nada — a peça saiu do portão'); ruim += 1; continue
    n = roda(guarda, mutados)
    if n is None:
        print(f'✗ {nome}: não compila alargado — a peça saiu do portão'); ruim += 1; continue
    print(('✓ ' if n > 0 else '✗ ') + f'{nome}: {n} casos vermelhos')
    if n == 0: ruim += 1

sys.exit(1 if ruim else 0)
PY
