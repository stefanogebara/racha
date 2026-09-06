#!/usr/bin/env python3
"""
O contrato entre o servidor e o app, conferido de verdade.

`BackendTableSource.decode` lê chaves de um JSON que quem produz é
`api/_lib/store/memory.js` (`getCheckByQrToken`) — dois arquivos, duas
linguagens, nenhum compilador olhando os dois. Renomear `priceCents` no
servidor não quebra build nenhum: o app simplesmente lê uma conta vazia, num
sábado à noite, na mesa de alguém.

Este script fecha essa fresta. Ele extrai as chaves que o Swift lê e as chaves
que o servidor escreve, e falha se o Swift pedir algo que o servidor não manda.

Não é um parser de JS nem de Swift — é leitura de texto com regex, deliberada:
o alvo é uma função pequena e estável de cada lado, e um parser de verdade aqui
seria mais código pra manter do que o que ele protege.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SWIFT = ROOT / "ios/Racha/Core/POS/BackendTableSource.swift"
SERVER = ROOT / "api/_lib/store/memory.js"

# Seções do JSON e a variável Swift que carrega cada uma.
SECTIONS = {
    "venue": "venueJSON",
    "table": "tableJSON",
    "check": "checkJSON",
    "state": "stateJSON",
}


def swift_keys(text):
    """Chaves lidas pelo decoder, por seção: `venueJSON["name"]`."""
    out = {section: set() for section in SECTIONS}
    for section, var in SECTIONS.items():
        for match in re.finditer(rf'{var}\["([^"]+)"\]', text):
            out[section].add(match.group(1))
    # As linhas dos itens saem de `row["..."]` dentro do map.
    out["check.items"] = set(re.findall(r'row\["([^"]+)"\]', text))
    return out


def object_keys(source):
    """Chaves de um literal de objeto JS, incluindo shorthand.

    `{ status: X, totalCents, paidCents: 0 }` declara três chaves; só a forma
    com dois-pontos é óbvia. O shorthand (`totalCents,`) é o mesmo contrato e
    ignorá-lo faz este script acusar divergência onde não há — foi exatamente o
    que ele fez na primeira execução.
    """
    with_colon = set(re.findall(r"(\w+)\s*:", source))
    shorthand = set(re.findall(r"(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*(?=[,}\n])", source))
    return with_colon | shorthand


def server_keys(text):
    """Chaves emitidas por getCheckByQrToken, por seção."""
    start = text.index("async getCheckByQrToken")
    body = text[start:text.index("async loadEvents", start)]
    ret = body[body.index("return {"):]

    def section(name):
        # `venue: { name: venue.name, servicoBp: ... }` numa linha só.
        match = re.search(rf"{name}:\s*\{{([^}}]*)\}}", ret)
        if not match:
            return None
        return object_keys(match.group(1))

    out = {}
    for name in ("venue", "table", "check"):
        keys = section(name)
        if keys is None:
            sys.exit(f"FALHA: não achei a seção '{name}' em getCheckByQrToken")
        out[name] = keys
    # `state: reduce(log)` — o shape vem de emptyOpenState em check-state.js.
    state_src = (ROOT / "api/_lib/checks/check-state.js").read_text()
    empty = state_src[state_src.index("function emptyOpenState"):]
    empty = empty[empty.index("return {"):empty.index("\n}", empty.index("return {"))]
    out["state"] = object_keys(empty)
    # Os itens são gravados por normalizeItems (check-service.js).
    norm_src = (ROOT / "api/_lib/checks/check-service.js").read_text()
    norm = norm_src[norm_src.index("function normalizeItems"):]
    norm = norm[:norm.index("\n}")]
    out["check.items"] = object_keys(norm)
    return out


def main():
    swift = swift_keys(SWIFT.read_text())
    server = server_keys(SERVER.read_text())

    # Chaves que o app tolera ausentes por decisão explícita (têm default no
    # decoder) e que o servidor de fato não promete hoje.
    OPTIONAL = {
        "venue": {"city", "pixKey"},   # a chave Pix vem com a cobrança do PSP
    }

    problems = []
    for section, keys in swift.items():
        emitted = server.get(section, set())
        missing = keys - emitted - OPTIONAL.get(section, set())
        if missing:
            problems.append(f"  {section}: o Swift lê {sorted(missing)}, o servidor não manda")

    if problems:
        print("FALHA — contrato POS divergente entre servidor e app:")
        print("\n".join(problems))
        print("\nOu o servidor mudou de shape, ou o decoder pediu algo que nunca existiu.")
        return 1

    total = sum(len(v) for v in swift.values())
    print(f"ok — contrato POS confere ({total} chaves lidas pelo app, todas emitidas pelo servidor)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
