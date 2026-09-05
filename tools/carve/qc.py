#!/usr/bin/env python3
"""
Quality gate for a generated block print, before it becomes an app asset.

Both failure modes here are SILENT — the file is a valid PNG either way, and
the damage only shows up as grey mush on a phone in a dark bar:

  colour   the model ignored "no colour" and printed green limes; greyscaling
           flattens the hue into mid-ink and the mask comes out as sludge.
  shadow   the model added a cast shadow. A relief print has none — it is ink
           stamped on flat paper. The tell is a big SOLID dark region with no
           gouges cut into it: real ink mass in this style is always carved.

Both are reported per file so the set is curated on evidence, not on vibes.
"""
import sys, pathlib
import numpy as np
from PIL import Image
from scipy import ndimage

def report(path):
    rgb = np.asarray(Image.open(path).convert('RGB')).astype(np.float32) / 255.0
    mx, mn = rgb.max(2), rgb.min(2)
    sat = np.where(mx > 0.04, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    colour = float((sat > 0.25).mean())          # fraction of clearly coloured pixels

    g = np.asarray(Image.open(path).convert('L')).astype(np.float32) / 255.0
    edge = np.concatenate([g[:8].ravel(), g[-8:].ravel(), g[:, :8].ravel(), g[:, -8:].ravel()])
    paper = float(np.median(edge))
    dark = g < paper * 0.45
    lab, n = ndimage.label(dark)
    worst = 0.0
    for i in range(1, n + 1):
        comp = lab == i
        area = comp.sum()
        if area < dark.size * 0.01:              # ignore specks
            continue
        # A carved mass has paper cut INTO it: holes in the filled component.
        holes = ndimage.binary_fill_holes(comp).sum() - area
        gouge = holes / max(area, 1)
        if gouge < 0.02:                         # solid slab, nothing carved out
            worst = max(worst, area / dark.size)
    return colour, worst, float(dark.mean())

if __name__ == '__main__':
    bad = []
    for p in sorted(sys.argv[1:]):
        colour, slab, ink = report(p)
        flags = []
        if colour > 0.02: flags.append(f'COR {colour*100:.1f}%')
        if slab   > 0.03: flags.append(f'CHAPADO {slab*100:.1f}%')
        name = pathlib.Path(p).name
        print(f'{name:26} tinta {ink*100:5.1f}%  {" ".join(flags) or "ok"}')
        if flags: bad.append(name)
    print(f'\n{len(bad)} reprovadas: {", ".join(bad) if bad else "-"}')
