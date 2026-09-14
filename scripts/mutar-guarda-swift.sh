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

# AS DECISÕES MORAM NUM LUGAR SÓ. Esta lista e a do
# `api/__tests__/mutacoes-afirmacao.test.js` eram duas, escritas à mão, e a
# revisão de segurança de 2026-09-14 mediu a distância: sete decisões nomeadas
# só lá e duas só aqui — uma delas o `soFuncionalAteONucleo` dentro do `nega`,
# a peça que a mesma revisão estava questionando, nunca mutada do lado que
# embarca. Ver `_porque` no `docs/compliance/mutacoes.json`.
DECISOES = json.load(open('docs/compliance/mutacoes.json'))
MUT = [(d['nome'], d['swift']['de'], d['swift']['para'])
       + (('sem-cobertura',) if 'swift' in d.get('sem_cobertura', []) else ())
       for d in DECISOES['decisoes']]


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

def sufixo(nomes, desde):
    """Corta do primeiro `desde` até o fim do literal — para peças cujo texto
    exato muda quando uma componente muda de ordem. Um alargamento ancorado
    num literal longo reporta `não mudou nada` por desatualização, e isso lê
    como portão verde."""
    if isinstance(nomes, str): nomes = [nomes]
    def f(padroes):
        fora = []
        for linha in padroes.split('\n'):
            if any(_re.match(r'\s*static let %s = ' % n, linha) for n in nomes) and desde in linha:
                linha = linha[:linha.index(desde)] + '"'
            fora.append(linha)
        return '\n'.join(fora)
    return f

def _alargamento(spec):
    if spec['tipo'] == 'sufixo': return sufixo(spec['nomes'], spec['desde'])
    if spec['tipo'] == 'troca': return troca(spec['nome'], spec['valor'])
    if spec['tipo'] == 'campo': return campo(spec['nomes'], spec['de'], spec['para'])
    if spec['tipo'] == 'cabeca_qualquer':
        return troca('cabecaDirecional', lit_para_swift(COMPOSTO_CABECA_QUALQUER()))
    raise SystemExit('alargamento de tipo desconhecido: ' + spec['tipo'])

ALARGA = [(a['nome'], _alargamento(a['swift']), a['direcao'])
          for a in DECISOES['alargamentos']]

def roda(fonte, padroes=None):
    open(f'{TMP}/CP.swift','w').write(padroes if padroes is not None else PADROES)
    open(f'{TMP}/Rev.swift','w').write(fonte.replace('enum RevisaoDeAfirmacoes {','public enum RevisaoDeAfirmacoes {',1))
    # A DIREÇÃO DO VERMELHO, não o total. Contar só o total deixava um
    # alargamento ser certificado pelo avesso: `cabeça aceita preposição
    # não-direcional` reportava vermelho e os vermelhos eram todos casos
    # INOCENTES — luz verde que se lia como cobertura do alargamento e era
    # cobertura do contrário. O lado JS corrigiu isso em 2026-09-14 e a
    # correção não tinha atravessado. Apontado pela revisão de segurança.
    corpo = ['import Foundation', 'var escapes = 0', 'var fp = 0',
             'let casos: [(String, Bool)] = [' + ','.join(
                 '(%s, %s)' % (json.dumps(c['texto'], ensure_ascii=False), 'true' if c['recusa'] else 'false') for c in casos) + ']',
             'for (t, esp) in casos where RevisaoDeAfirmacoes.afirmaDestinoSemDistribuidor(t) != esp {',
             '  if esp { escapes += 1 } else { fp += 1 }',
             '}',
             'print("\\(escapes) \\(fp)")']
    open(f'{TMP}/main.swift','w').write('\n'.join(corpo))
    r = subprocess.run(['swiftc','-O',f'{TMP}/CP.swift',f'{TMP}/Rev.swift',f'{TMP}/main.swift','-o',f'{TMP}/p'],
                       capture_output=True, text=True)
    if r.returncode: return None
    e, f = subprocess.run([f'{TMP}/p'], capture_output=True, text=True).stdout.split()
    return {'escapes': int(e), 'fp': int(f), 'total': int(e) + int(f)}

base = roda(guarda)
if base is None or base['total'] != 0:
    print(f'✗ o guarda NÃO passa o corpo sem mutação ({base})'); sys.exit(1)
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
        print(('✓ ' if n['total'] == 0 else '✗ ') + f'{nome}: sem cobertura declarada ({n})')
        if n['total'] != 0: ruim += 1
        continue
    print(('✓ ' if n['total'] > 0 else '✗ ') + f'{nome}: {n}')
    if n['total'] == 0: ruim += 1
for nome, atalho in SOLTA:
    if ANCORA not in guarda:
        print(f'✗ {nome}: a âncora do laço da regra 3 não existe mais'); ruim += 1; continue
    n = roda(guarda.replace(ANCORA, atalho + ANCORA, 1))
    if n is None:
        print(f'✗ {nome}: não compila mutado — o atalho saiu do portão'); ruim += 1; continue
    print(('✓ ' if n['total'] > 0 else '✗ ') + f'{nome}: {n}')
    if n['total'] == 0: ruim += 1
for nome, alargar, direcao in ALARGA:
    mutados = alargar(PADROES)
    if mutados == PADROES:
        print(f'✗ {nome}: o alargamento não mudou nada — a peça saiu do portão'); ruim += 1; continue
    n = roda(guarda, mutados)
    if n is None:
        print(f'✗ {nome}: não compila alargado — a peça saiu do portão'); ruim += 1; continue
    # O VERMELHO TEM QUE VIR DA DIREÇÃO DECLARADA.
    ok = n[direcao] > 0
    print(('✓ ' if ok else '✗ ') + f'{nome}: {direcao} esperado, medido {n}')
    if not ok: ruim += 1

sys.exit(1 if ruim else 0)
PY
