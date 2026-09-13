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
 ("nega olha só o primeiro destinatário", "        for d in dests {", "        for d in dests.prefix(1) {"),
 ("janela falha ABERTA", "ini = achou ? max(0, min(ini, d.location)) : d.location", "ini = max(0, min(ini, d.location))"),
 ("repartida olha só a primeira oração", "for (i, o) in partes.enumerated() where casa(destinatario, o) {",
  "for (i, o) in partes.enumerated().prefix(1) where casa(destinatario, o) {"),
 ("repartida dispensa marcador e quantidade",
  "guard casa(marcadorDeLista, o) || casa(quantidade, o) || anteriorTemQuantidade else { continue }", ""),
 ("forma direcional deixa de ser decisiva", "        for o in partes where casa(direcional, o) {\n            if !nega(o) { return true }\n        }", ""),
 ("destinatário OBLÍQUO volta a ser resgatável por negador atrás", "let depois = !obliquo &&", "let depois ="),
 ("repartida deixa de exigir FRASE DE DESTINO PURA",
  "            guard casa(fraseDeDestinoPura, ateOSeparador(o)) else { continue }", ""),
 ("pureza deixa de ser medida até o separador interno",
  "casa(fraseDeDestinoPura, ateOSeparador(o))", "casa(fraseDeDestinoPura, o)"),
 ("regência volta a ser adjacência de 14 caracteres",
  "            let obliquo = ini < d.location\n"
  "                && casa(regenciaDeDestino, ns.substring(with: NSRange(\n"
  "                    location: ini, length: d.location - ini)))",
  "            let atras = max(0, d.location - 14)\n"
  "            let obliquo = casa(regex(\"(pra|para|pro|pros|pras|com|de|d[oa]s?|ao|aos)"
  "\\\\s+((o|a|os|as|the|el|la)\\\\s+)?$\"), ns.substring(with: NSRange(\n"
  "                location: atras, length: d.location - atras)))"),
 ("distribuidor volta a valer pela janela toda", "&& !temDistribuidor(o) { return true }", "&& !temDistribuidor(texto) { return true }"),
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
# revisão mediu o antigo `ehFraseCurta` em 3, 4, 5, 6 e 40 palavras e o corpo
# só reagia ABAIXO do valor escolhido. Subir o teto deixava tudo verde, com 48
# de 64 afirmações partidas escapando por cima dele. Aqui a peça é AFROUXADA no
# próprio `ClaimPatterns.swift` e exige-se vermelho.
def alarga_relativa(padroes):
    import json as _j
    G = _j.load(open('docs/compliance/claims.json'))['gorjeta_destino']
    def lit(x): return x.replace('\\', '\\\\').replace('"', '\\"')
    de, para = lit(G['relativa_de_destino']), lit('(que|quem|who|that)\\s+[^,.;]*')
    return padroes.replace(de, para) if de in padroes else padroes

def sem_ancora_de_fim(padroes):
    return '\n'.join(
        (l[:l.rindex('$"')] + '"' if 'fraseDeDestinoPura' in l and '$"' in l else l)
        for l in padroes.split('\n'))

ALARGA = [
 ("aridade do modificador sobe de dois pra nove", lambda p: p.replace('{0,2}', '{0,9}')),
 ("frase pura perde a âncora de FIM e vira prefixo", sem_ancora_de_fim),
 ("relativa passa a engolir até o fim da oração", alarga_relativa),
 # Não é alargamento, é ENCOLHIMENTO — mas mora aqui porque também se faz no
 # `ClaimPatterns.swift`. Meia tradução é pior que nenhuma.
 ("regência perde a metade não-portuguesa",
  lambda p: p.replace('|to|for|with|al|del|de\\\\s+la|of\\\\s+the|a\\\\s+l[oa]s|para\\\\s+el|con', '')),
 ("negador colado volta a ser só português",
  lambda p: p.replace('|not|never|jam[\u00e1a]s|ni', '')),
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
for nome, de, para in MUT:
    if de not in guarda:
        print(f'✗ {nome}: o trecho não existe mais no arquivo'); ruim += 1; continue
    n = roda(guarda.replace(de, para, 1))
    if n is None:
        # NÃO É DESCULPA. Mutação que não compila é peça que saiu do portão em
        # silêncio — a forma "guarda que nunca dispara" aplicada ao próprio
        # instrumento. Apontado pela revisão de segurança de 2026-09-14.
        print(f'✗ {nome}: não compila mutado — a peça saiu do portão'); ruim += 1; continue
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
