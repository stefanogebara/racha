#!/usr/bin/env python3
"""
Structural checks over the Swift sources, for machines without Xcode.

This is not a type checker and does not pretend to be one. It catches the
mistakes that are actually plausible when writing a lot of Swift at once:

  1. unbalanced braces/parens/brackets (after stripping strings and comments);
  2. two declarations of the same top-level type;
  3. a type referenced across files that nothing declares and that is not a
     known SDK symbol — the "I renamed it in one place" class of bug;
  4. files with no trailing newline, tabs, or lines over 110 columns.

    python3 scripts/check-swift.py
"""
import re
import sys
from collections import defaultdict
import pathlib
from pathlib import Path

# Run from anywhere: paths resolve against the repo, not the shell's cwd.
import os
os.chdir(pathlib.Path(__file__).resolve().parent.parent)


ROOTS = [Path("Racha"), Path("RachaTests")]

# Top-level only (no leading whitespace): nested types may legitimately share a
# name — `WireMessage.Role` and `ChatMessage.Role` are different types and both
# should exist.
DECL = re.compile(r'^(?:public\s+|internal\s+|private\s+|fileprivate\s+|final\s+|indirect\s+|@\w+\s+)*'
                  r'(?P<kind>struct|class|enum|actor|protocol|extension|typealias)\s+'
                  r'(?P<name>[A-Z]\w*)')

# Symbols that come from the SDK or the language. Not exhaustive — it only has
# to cover what this codebase actually touches, and an unknown name here is a
# prompt to look, not a hard failure.
SDK = {
    # Swift / Foundation
    'String','Int','Double','Bool','Date','UUID','Data','URL','URLRequest','URLSession',
    'Array','Set','Dictionary','Optional','Result','Error','LocalizedError','Task','Sendable',
    'Codable','Decodable','Encodable','Hashable','Equatable','Comparable','Identifiable',
    'JSONEncoder','JSONDecoder','Encoder','Decoder','CodingKey','TypeError','RangeError',
    'FileManager','FileHandle','UserDefaults','Locale','CharacterSet','NSString','NSCache',
    'Character','Sequence','Collection','RandomNumberGenerator','SystemRandomNumberGenerator',
    'CancellationError','TimeInterval','HTTPURLResponse','ProcessInfo','Bundle','Notification',
    'AsyncStream','MainActor','Observable','ObservableObject','Never','Void','Any','AnyObject',
    'UInt16','UInt64','Int64','UInt8','Float','CGFloat','CGPoint','CGSize','CGRect','CGContext',
    'CGGradient','CGColorSpaceCreateDeviceRGB','CGMutablePath','SIMD2','SIMD4','Range','ClosedRange',
    # SwiftUI
    'View','Text','Image','Color','Font','Shader','ShaderLibrary','ViewModifier','Content',
    'ScrollView','LazyVStack','VStack','HStack','ZStack','Spacer','Divider','Button','Group',
    'Rectangle','RoundedRectangle','Capsule','Circle','UnevenRoundedRectangle','LinearGradient',
    'GeometryReader','ScrollViewReader','NavigationStack','App','Scene','WindowGroup','State',
    'Binding','Environment','EnvironmentKey','EnvironmentValues','Namespace','FocusState',
    'GestureState','DragGesture','Gesture','Animation','Namespace','ProposedViewSize','Subviews',
    'Layout','TextRenderer','GraphicsContext','ProposedViewSize','AnyShapeStyle','ShapeStyle',
    'StrokeStyle','TextField','SecureField','Toggle','Label','ToolbarItem','PhotosPicker',
    'PhotosPickerItem','UIPasteboard','ForEach','Transaction','Bindable','Suite','Test','Issue',
    'CADisplayLink','CAFrameRateRange','CACurrentMediaTime','NSObject','UIImage','UIFont','UIColor',
    'UIGraphicsImageRenderer','UIImpactFeedbackGenerator','UISelectionFeedbackGenerator',
    'UINotificationFeedbackGenerator','CHHapticEngine','CHHapticEvent','CHHapticPattern',
    'CHHapticEventParameter','CHHapticParameterCurve','CHHapticTimeImmediate','CMMotionManager',
    'SecItemAdd','SecItemDelete','SecItemCopyMatching','CFDictionary','CFTypeRef','CFArray',
}


def strip(text):
    text = re.sub(r'"""(?:.|\n)*?"""', '""', text)
    text = re.sub(r'#?"(?:[^"\\\n]|\\.)*"#?', '""', text)
    text = re.sub(r'/\*(?:.|\n)*?\*/', '', text)
    text = re.sub(r'//[^\n]*', '', text)
    return text


def main():
    files = sorted(f for root in ROOTS for f in root.rglob("*.swift"))
    problems, style = [], []
    declared = defaultdict(list)
    referenced = defaultdict(set)

    for path in files:
        raw = path.read_text()
        if not raw.endswith("\n"):
            style.append(f"{path}: sem newline no final")
        for i, line in enumerate(raw.splitlines(), 1):
            if "\t" in line:
                style.append(f"{path}:{i}: tab")
            if len(line) > 120:
                style.append(f"{path}:{i}: {len(line)} colunas")

        body = strip(raw)
        for open_ch, close_ch in [("{", "}"), ("(", ")"), ("[", "]")]:
            delta = body.count(open_ch) - body.count(close_ch)
            if delta:
                problems.append(f"{path}: {abs(delta)} '{open_ch if delta > 0 else close_ch}' a mais")

        for line in body.splitlines():
            m = DECL.match(line)
            if m and m.group('kind') != 'extension':
                declared[m.group('name')].append(str(path))
        for name in re.findall(r'\b([A-Z][A-Za-z0-9]{2,})\b', body):
            referenced[name].add(str(path))

    for name, where in sorted(declared.items()):
        if len(where) > 1:
            problems.append(f"{name} declarado em {len(where)} arquivos: {', '.join(where)}")

    unknown = sorted(n for n in referenced
                     if n not in declared and n not in SDK
                     and not n.endswith("Error") and not n.startswith("NS")
                     and not n.startswith("UI") and not n.startswith("CG")
                     and not n.startswith("CH") and not n.startswith("CM"))

    print(f"{len(files)} arquivos Swift · {len(declared)} tipos declarados")
    print(f"linhas: {sum(len(f.read_text().splitlines()) for f in files)}")
    if unknown:
        print(f"\nnomes não declarados aqui (provável SDK, confira se algum for erro de digitação):")
        print("  " + ", ".join(unknown[:60]))
    if style:
        print(f"\nestilo ({len(style)}):")
        for s in style[:20]:
            print("  ·", s)
    if problems:
        print(f"\nPROBLEMAS ({len(problems)}):")
        for p in problems:
            print("  ·", p)
        return 1
    print("\nok — delimitadores balanceados, nenhum tipo duplicado")
    return 0


if __name__ == "__main__":
    sys.exit(main())
