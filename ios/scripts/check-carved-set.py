#!/usr/bin/env python3
"""
The carved set must agree with the category enum, in both directions.

Two silent failures this catches, neither of which the compiler sees:

  · CarvedSet lists a category with no PNG behind it. `UIImage(named:)` returns
    nil at runtime and the row falls back to the grey placeholder box — on a
    phone, in a bar, forever, and nobody notices because it still "works".
  · A PNG sits in Resources/Carved that no category names. Dead weight in the
    bundle, and usually the sign of a rename that only got done on one side.

Also checks the files really are alpha masks. A cream-backgrounded PNG would
render as a pale rectangle on the app's near-black ground, and that is exactly
the mistake the mask format exists to prevent — so it is worth asserting rather
than trusting.
"""
import pathlib, re, sys, struct, zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
CARVED = ROOT / 'Racha/Resources/Carved'
SWIFT = (ROOT / 'Racha/Imagery/CarvedSet.swift').read_text()
ENUM = (ROOT / 'Racha/Core/Model/LineItem.swift').read_text()

fail = []

cases = set()
m = re.search(r'enum ItemCategory[^{]*\{(.*?)\n\s*(?:var|func|static)', ENUM, re.S)
for line in re.findall(r'^\s*case ([a-zA-Z, ]+)$', m.group(1), re.M):
    cases |= {c.strip() for c in line.split(',') if c.strip()}

listed = set(re.findall(r'\.(\w+)', re.search(r'carved: Set<ItemCategory> = \[(.*?)\]', SWIFT, re.S).group(1)))
files = {p.stem.removeprefix('carved-') for p in CARVED.glob('carved-*.png')}

for k in sorted(listed - cases):
    fail.append(f'CarvedSet lista .{k}, que não é um ItemCategory')
for k in sorted(listed - files):
    fail.append(f'CarvedSet lista .{k}, mas não há carved-{k}.png — vira caixa cinza no telefone')
for k in sorted(files - listed):
    fail.append(f'carved-{k}.png existe mas nenhuma categoria o nomeia — peso morto no bundle')

def is_alpha_mask(path):
    """Read the PNG header without Pillow: colour type 6 (RGBA) or 4 (grey+A)."""
    with path.open('rb') as f:
        if f.read(8) != b'\x89PNG\r\n\x1a\n':
            return False, 'não é PNG'
        length = struct.unpack('>I', f.read(4))[0]
        if f.read(4) != b'IHDR':
            return False, 'IHDR ausente'
        ihdr = f.read(length)
        colour = ihdr[9]
    return colour in (4, 6), f'colour type {colour} — sem canal alfa'

for p in sorted(CARVED.glob('carved-*.png')):
    ok, why = is_alpha_mask(p)
    if not ok:
        fail.append(f'{p.name}: {why}')

if fail:
    print('\n'.join('  · ' + f for f in fail))
    sys.exit(f'\ncheck-carved-set: {len(fail)} problema(s)')
print(f'ok — {len(files)} blocos, alfa puro, casando com ItemCategory')
