#!/usr/bin/env python3
"""
Validates Racha.xcodeproj/project.pbxproj without Xcode.

A pbxproj is an OpenStep (ASCII) property list, a format Python's `plistlib`
does not read. This is a small parser for it, plus the four checks that catch
essentially every hand-edit mistake:

  1. it parses at all (balanced braces, quoting, semicolons);
  2. every object id referenced anywhere actually exists (no dangling refs —
     the failure that makes Xcode show an empty project with no error);
  3. every object has an `isa`;
  4. each target's build phases and configuration list resolve.

    python3 scripts/check-pbxproj.py [path]
"""
import re
import sys
import pathlib
from pathlib import Path

# Run from anywhere: paths resolve against the repo, not the shell's cwd.
import os
os.chdir(pathlib.Path(__file__).resolve().parent.parent)


TOKEN = re.compile(r'''
      (?P<comment>/\*.*?\*/)
    | (?P<string>"(?:[^"\\]|\\.)*")
    | (?P<punct>[{}()=;,])
    | (?P<bare>[A-Za-z0-9_./$<>:@+*-]+)
    | (?P<space>\s+)
''', re.VERBOSE | re.DOTALL)


def tokenize(text):
    pos, out = 0, []
    if text.startswith('//'):                      # the // !$*UTF8*$! header
        pos = text.index('\n') + 1
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m:
            raise SyntaxError(f"token inesperado em {pos}: {text[pos:pos+40]!r}")
        pos = m.end()
        kind = m.lastgroup
        if kind in ('comment', 'space'):
            continue
        value = m.group()
        if kind == 'string':
            value = value[1:-1].replace('\\"', '"').replace('\\\\', '\\')
        out.append((kind, value))
    return out


class Parser:
    def __init__(self, tokens):
        self.t, self.i = tokens, 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else (None, None)

    def take(self, expected=None):
        kind, value = self.peek()
        if expected and value != expected:
            raise SyntaxError(f"esperava {expected!r}, veio {value!r} (token {self.i})")
        self.i += 1
        return value

    def value(self):
        kind, value = self.peek()
        if value == '{':
            return self.dictionary()
        if value == '(':
            return self.array()
        self.i += 1
        return value

    def dictionary(self):
        self.take('{')
        out = {}
        while self.peek()[1] != '}':
            key = self.take()
            self.take('=')
            out[key] = self.value()
            self.take(';')
        self.take('}')
        return out

    def array(self):
        self.take('(')
        out = []
        while self.peek()[1] != ')':
            out.append(self.value())
            if self.peek()[1] == ',':
                self.take(',')
        self.take(')')
        return out


def check(path):
    text = Path(path).read_text()
    root = Parser(tokenize(text)).dictionary()
    objects = root['objects']

    problems = []
    print(f"objectVersion {root['objectVersion']} · {len(objects)} objetos")

    for oid, obj in objects.items():
        if not isinstance(obj, dict) or 'isa' not in obj:
            problems.append(f"objeto {oid} sem isa")

    ids = set(objects)
    dangling = []

    def walk(node, trail):
        if isinstance(node, str):
            if re.fullmatch(r'[0-9A-F]{24}|RA[0-9A-F]{22}', node) and node not in ids:
                dangling.append(f"{trail} → {node}")
        elif isinstance(node, dict):
            for k, v in node.items():
                walk(v, f"{trail}.{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{trail}[{i}]")

    walk(root, 'root')
    problems += [f"referência morta: {d}" for d in dangling]

    project = objects[root['rootObject']]
    print(f"projeto: {project['isa']} · região {project.get('developmentRegion')}")

    for tid in project['targets']:
        target = objects[tid]
        phases = [objects[p]['isa'] for p in target['buildPhases']]
        synced = [objects[g]['path'] for g in target.get('fileSystemSynchronizedGroups', [])]
        configs = objects[target['buildConfigurationList']]['buildConfigurations']
        names = [objects[c]['name'] for c in configs]
        print(f"  alvo {target['name']}: {target['productType']}")
        print(f"    fases: {', '.join(phases)}")
        print(f"    pastas sincronizadas: {synced or '(nenhuma)'}")
        print(f"    configurações: {', '.join(names)}")
        if not synced:
            problems.append(f"alvo {target['name']} não tem pasta sincronizada nem arquivos")
        if 'PBXSourcesBuildPhase' not in phases:
            problems.append(f"alvo {target['name']} sem fase de Sources")

    if problems:
        print("\nPROBLEMAS:")
        for p in problems:
            print(" ·", p)
        return 1
    print("\nok — projeto íntegro")
    return 0


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "Racha.xcodeproj/project.pbxproj"
    sys.exit(check(target))
