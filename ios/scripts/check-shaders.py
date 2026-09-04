#!/usr/bin/env python3
"""
Cross-checks Racha.metal against RachaShaders.swift.

SwiftUI binds shader arguments *positionally*, with no name or arity checking.
A shader called with one argument too few renders as garbage, or silently as
nothing, with no compiler error and no runtime message. That makes this the
highest-value static check in the repo — so it runs here, without Xcode.

Rules encoded (they are the SwiftUI shader ABI):
  colorEffect       f(float2 position, half4 color, ...extra)
  layerEffect       f(float2 position, SwiftUI::Layer layer, ...extra)
  distortionEffect  f(float2 position, ...extra) -> float2

Only `...extra` is supplied from Swift, so the Swift call must pass exactly the
parameters after the implicit ones. float2 counts as ONE Swift argument
(.float2), each float as one (.float).

    python3 scripts/check-shaders.py
"""
import re
import sys
from pathlib import Path

METAL = Path("Racha/Shaders/Racha.metal")
SWIFT = Path("Racha/Shaders/RachaShaders.swift")

ENTRY = re.compile(
    r'\[\[stitchable\]\]\s+(?P<ret>half4|float2)\s+(?P<name>\w+)\s*\((?P<params>[^)]*)\)',
    re.DOTALL)


def strip_comments(text):
    """Remove // and /* */ comments — the file's own header documents the ABI
    using the same syntax the parser looks for."""
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    return re.sub(r'//[^\n]*', '', text)


def parse_metal():
    text = strip_comments(METAL.read_text())
    out = {}
    for m in ENTRY.finditer(text):
        params = [p.strip() for p in m.group('params').split(',') if p.strip()]
        kinds = []
        for p in params:
            if 'SwiftUI::Layer' in p:
                kinds.append('layer')
            elif p.startswith('float2'):
                kinds.append('float2')
            elif p.startswith('half4'):
                kinds.append('half4')
            elif p.startswith('float'):
                kinds.append('float')
            else:
                kinds.append('?' + p)
        out[m.group('name')] = (m.group('ret'), kinds)
    return out


def parse_swift():
    text = SWIFT.read_text()
    out = {}
    for m in re.finditer(r'ShaderLibrary\.(\w+)\s*\((?P<args>.*?)\)\s*\n?\s*\}', text, re.DOTALL):
        name = m.group(1)
        args = m.group('args')
        kinds = re.findall(r'\.(float2|float|color|image|data|boundingRect)\b', args)
        out[name] = kinds
    return out


def effect_kinds(text, name):
    """Which SwiftUI effect each shader is applied with, from the wrapper file."""
    kinds = set()
    for match in re.finditer(r'(colorEffect|layerEffect|distortionEffect)\s*\(\s*\n?\s*RachaShader\.(\w+)', text):
        kinds.add((match.group(2), match.group(1)))
    return kinds


def main():
    metal = parse_metal()
    swift = parse_swift()
    problems = []

    print(f"{len(metal)} shaders no Metal · {len(swift)} wrappers no Swift\n")

    for name, (ret, kinds) in sorted(metal.items()):
        implicit = []
        if kinds and kinds[0] == 'float2':
            implicit.append('position')
        rest = kinds[1:]
        if rest and rest[0] == 'half4':
            effect = 'colorEffect'
            rest = rest[1:]
        elif rest and rest[0] == 'layer':
            effect = 'layerEffect'
            rest = rest[1:]
        elif ret == 'float2':
            effect = 'distortionEffect'
        else:
            effect = '?'
            problems.append(f"{name}: assinatura não corresponde a nenhum efeito SwiftUI")

        expected = len(rest)
        got = swift.get(name)
        status = "ok"
        if got is None:
            problems.append(f"{name}: sem wrapper em RachaShaders.swift")
            status = "SEM WRAPPER"
        elif len(got) != expected:
            problems.append(f"{name}: Metal espera {expected} argumento(s) extra ({rest}), "
                            f"o Swift passa {len(got)} ({got})")
            status = "ARIDADE ERRADA"
        else:
            # Type-by-type: float2 must meet .float2, float must meet .float.
            for i, (m_kind, s_kind) in enumerate(zip(rest, got)):
                if m_kind != s_kind:
                    problems.append(f"{name}: argumento {i} é {m_kind} no Metal e .{s_kind} no Swift")
                    status = "TIPO ERRADO"

        print(f"  {name:<16} {effect:<17} extras={rest} → {status}")

    for name in swift:
        if name not in metal:
            problems.append(f"{name}: wrapper Swift sem shader correspondente no Metal")

    print()
    if problems:
        print(f"PROBLEMAS ({len(problems)}):")
        for p in problems:
            print(" ·", p)
        return 1
    print("ok — todas as assinaturas batem")
    return 0


if __name__ == "__main__":
    sys.exit(main())
