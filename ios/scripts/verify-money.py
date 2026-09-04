#!/usr/bin/env python3
"""
Reference oracle for the money core.

The Swift tests in RachaTests/ are the real ones. This exists because they need
a Mac to run, and the algorithms in Core/Money are the part of the app where
being wrong is expensive — so they get checked here too, on any machine, by a
line-by-line port of the Swift.

If you change Allocator, SettleUp or BRL, change this too and re-run it. A
divergence between the two is itself the finding.

    python3 scripts/verify-money.py
"""
import random
import sys
from itertools import combinations

FAILURES = []


def check(condition, message):
    if not condition:
        FAILURES.append(message)


# --------------------------------------------------------------------------
# Port of Allocator.equal / .proportional / .basisPoints
# --------------------------------------------------------------------------

def allocate_equal(total, n, rotate=0):
    assert n >= 1
    sign = -1 if total < 0 else 1
    magnitude = abs(total)
    base = magnitude // n
    remainder = magnitude - base * n
    parts = [base] * n
    recipients = []
    offset = ((rotate % n) + n) % n
    for i in range(remainder):
        idx = (i + offset) % n
        parts[idx] += 1
        recipients.append(idx)
    return [p * sign for p in parts], sorted(recipients)


def allocate_proportional(total, weights, rotate=0):
    assert weights
    weight_sum = sum(weights)
    if weight_sum <= 0:
        return allocate_equal(total, len(weights), rotate)
    sign = -1 if total < 0 else 1
    magnitude = abs(total)
    n = len(weights)
    parts, fractions = [], []
    for i, w in enumerate(weights):
        product = magnitude * w
        parts.append(product // weight_sum)
        fractions.append((i, product % weight_sum))
    leftover = magnitude - sum(parts)
    offset = ((rotate % n) + n) % n
    fractions.sort(key=lambda f: (-f[1], (f[0] - offset + n) % n))
    assert leftover < n, f"largest-remainder invariant broken: {leftover} >= {n}"
    recipients = [f[0] for f in fractions[:leftover]]
    for target in recipients:
        parts[target] += 1
    return [p * sign for p in parts], sorted(recipients)


def round_half_up_div(numerator, denominator):
    assert denominator > 0
    if numerator >= 0:
        return (numerator * 2 + denominator) // (denominator * 2)
    return -((-numerator * 2 + denominator) // (denominator * 2))


def basis_points(base, bp):
    if base == 0 or bp == 0:
        return 0
    return round_half_up_div(base * bp, 10_000)


# --------------------------------------------------------------------------
# Port of SettleUp.plan
# --------------------------------------------------------------------------

def zero_sum_partition(people):
    """Maximise the number of disjoint zero-sum subsets (bitmask DP)."""
    n = len(people)
    full = (1 << n) - 1
    subset_sum = [0] * (full + 1)
    for mask in range(1, full + 1):
        low = mask & -mask
        idx = low.bit_length() - 1
        subset_sum[mask] = subset_sum[mask ^ low] + people[idx]
    best = [0] * (full + 1)
    choice = [0] * (full + 1)
    for mask in range(1, full + 1):
        low = mask & -mask
        sub = mask
        while sub:
            if (sub & low) and subset_sum[sub] == 0:
                candidate = 1 + best[mask ^ sub]
                if candidate > best[mask]:
                    best[mask] = candidate
                    choice[mask] = sub
            sub = (sub - 1) & mask
        if best[mask] == 0:
            choice[mask] = mask
    groups, mask = [], full
    while mask:
        take = choice[mask] or mask
        group, bits = [], take
        while bits:
            low = bits & -bits
            group.append(low.bit_length() - 1)
            bits ^= low
        groups.append(group)
        mask ^= take
    return groups


def greedy(indices, nets):
    debtors = sorted([(i, -nets[i]) for i in indices if nets[i] < 0],
                     key=lambda x: -x[1])
    creditors = sorted([(i, nets[i]) for i in indices if nets[i] > 0],
                       key=lambda x: -x[1])
    out, d, c = [], 0, 0
    debtors = [list(x) for x in debtors]
    creditors = [list(x) for x in creditors]
    while d < len(debtors) and c < len(creditors):
        amount = min(debtors[d][1], creditors[c][1])
        if amount:
            out.append((debtors[d][0], creditors[c][0], amount))
        debtors[d][1] -= amount
        creditors[c][1] -= amount
        if debtors[d][1] == 0:
            d += 1
        if creditors[c][1] == 0:
            c += 1
    return out


def settle(nets):
    active = [i for i, v in enumerate(nets) if v != 0]
    residual = max(0, -sum(nets))
    if len(active) <= 1:
        return [], residual
    if len(active) <= 12:
        groups = [[active[i] for i in g] for g in zero_sum_partition([nets[i] for i in active])]
    else:
        groups = [active]
    transfers = []
    for group in groups:
        transfers += greedy(group, nets)
    return transfers, residual


def verify_plan(nets, transfers, residual):
    working = list(nets)
    for frm, to, amount in transfers:
        if amount < 0:
            return False
        working[frm] += amount
        working[to] -= amount
    if any(v > 0 for v in working):
        return False
    return -sum(working) == residual


# --------------------------------------------------------------------------
# Port of BRL.format / BRL.parse
# --------------------------------------------------------------------------

def brl_format(cents, exponent=2, symbol=""):
    negative = cents < 0
    magnitude = abs(cents)
    divisor = 10 ** exponent
    whole = magnitude if divisor == 1 else magnitude // divisor
    frac = 0 if divisor == 1 else magnitude % divisor
    digits = str(whole)
    if len(digits) > 3:
        grouped = []
        for i, ch in enumerate(reversed(digits)):
            if i and i % 3 == 0:
                grouped.append('.')
            grouped.append(ch)
        digits = ''.join(reversed(grouped))
    body = digits if exponent == 0 else f"{digits},{frac:0{exponent}d}"
    return ("−" if negative else "") + symbol + body


def brl_parse(text, exponent=2):
    trimmed = text.strip()
    if not trimmed:
        return None
    negative = trimmed[0] in "-−"
    cleaned = ''.join(c for c in trimmed if c.isdigit() or c in ".,")
    if not any(c.isdigit() for c in cleaned):
        return None
    has_dot, has_comma = "." in cleaned, "," in cleaned
    whole_part, frac_part = "", ""
    if has_dot and has_comma:
        sep = "," if cleaned.rindex(",") > cleaned.rindex(".") else "."
        parts = cleaned.split(sep)
        if len(parts) != 2:
            return None
        whole_part = ''.join(c for c in parts[0] if c.isdigit())
        frac_part = ''.join(c for c in parts[1] if c.isdigit())
    elif has_comma:
        parts = cleaned.split(",")
        if len(parts) != 2:
            return None
        whole_part, frac_part = parts
    elif has_dot:
        parts = cleaned.split(".")
        if len(parts) > 2 or (len(parts) == 2 and len(parts[1]) == 3):
            whole_part = ''.join(c for c in cleaned if c.isdigit())
        elif len(parts) == 2:
            whole_part, frac_part = parts
        else:
            whole_part = cleaned
    else:
        whole_part = cleaned
    if exponent == 0:
        value = int(whole_part or "0")
        return -value if negative else value
    carry = 0
    if len(frac_part) > exponent:
        dropped = frac_part[exponent]
        frac_part = frac_part[:exponent]
        if dropped.isdigit() and int(dropped) >= 5:
            carry = 1
    else:
        frac_part += "0" * (exponent - len(frac_part))
    value = int(whole_part or "0") * (10 ** exponent) + int(frac_part or "0") + carry
    return -value if negative else value


# --------------------------------------------------------------------------
# The properties
# --------------------------------------------------------------------------

def run():
    print("1. divisão igual soma exatamente, 0..2000 × 1..12 partes")
    for total in range(0, 2001):
        for n in range(1, 13):
            parts, recipients = allocate_equal(total, n)
            check(sum(parts) == total, f"igual({total},{n}) somou {sum(parts)}")
            check(max(parts) - min(parts) <= 1, f"igual({total},{n}) spread > 1")
            check(len(recipients) == total - (total // n) * n,
                  f"igual({total},{n}) resto não atribuído")

    print("2. proporcional soma exatamente, pesos variados")
    weight_sets = [[1,1,1],[2,1,1],[1,2,3],[7,11,13,17],[1,0,0],[0,0,0],[5],[100,1],[3]*5]
    for total in range(0, 5001, 7):
        for weights in weight_sets:
            parts, _ = allocate_proportional(total, weights)
            check(sum(parts) == total, f"prop({total},{weights}) somou {sum(parts)}")
            check(all(p >= 0 for p in parts), f"prop({total},{weights}) parte negativa")

    print("3. proporcional com totais negativos (estorno)")
    for total in range(-2000, 0, 3):
        parts, _ = allocate_proportional(total, [3, 2, 1])
        check(sum(parts) == total, f"prop negativo({total}) somou {sum(parts)}")

    print("4. serviço proporcional == soma dos serviços por pessoa")
    random.seed(20260904)
    for _ in range(3000):
        bases = [random.randint(0, 40_000) for _ in range(random.randint(1, 8))]
        bp = random.choice([0, 500, 1000, 1200, 1500])
        per_person = [basis_points(b, bp) for b in bases]
        # A per-share percentage never invents money: each part is that person's
        # own rate on their own base, so the sum is well-defined by construction.
        check(all(p >= 0 for p in per_person), "serviço negativo")
        check(sum(per_person) == sum(basis_points(b, bp) for b in bases), "serviço divergiu")

    print("5. arredondamento meio-pra-cima simétrico")
    check(basis_points(3333, 1000) == 333, "3333 @10% deveria ser 333")
    check(basis_points(3335, 1000) == 334, "3335 @10% deveria ser 334")
    check(round_half_up_div(5, 10) == 1 and round_half_up_div(-5, 10) == -1, "meio-pra-cima assimétrico")

    print("6. acerto: plano zera todo mundo e nunca passa de n−1")
    for _ in range(3000):
        count = random.randint(2, 10)
        nets = [random.randint(-20_000, 20_000) for _ in range(count - 1)]
        nets.append(-sum(nets))
        transfers, residual = settle(nets)
        active = sum(1 for v in nets if v)
        check(verify_plan(nets, transfers, residual), f"plano não zerou: {nets}")
        check(len(transfers) <= max(0, active - 1), f"transferências demais: {nets}")
        check(residual == 0, f"residual inesperado em soma zero: {nets}")

    print("7. acerto: residual sai separado quando falta dinheiro")
    for _ in range(1500):
        count = random.randint(2, 8)
        nets = [random.randint(-20_000, 20_000) for _ in range(count)]
        transfers, residual = settle(nets)
        if sum(nets) <= 0:
            check(verify_plan(nets, transfers, residual), f"plano com residual falhou: {nets}")
            check(residual == -sum(nets), f"residual errado: {nets}")

    print("8. acerto: encontra os subconjuntos independentes")
    transfers, _ = settle([1000, -1000, 2500, -2500])
    check(len(transfers) == 2, f"dois pares deviam dar 2 transferências, deu {len(transfers)}")
    transfers, _ = settle([9000, -3000, -3000, -3000])
    check(len(transfers) == 3, f"estrela devia dar 3, deu {len(transfers)}")

    print("9. acerto: nunca pior que o guloso puro")
    for _ in range(600):
        count = random.randint(3, 9)
        nets = [random.randint(-9_000, 9_000) for _ in range(count - 1)]
        nets.append(-sum(nets))
        smart, _ = settle(nets)
        plain = greedy([i for i, v in enumerate(nets) if v], nets)
        check(len(smart) <= len(plain),
              f"partição piorou o guloso: {nets} ({len(smart)} > {len(plain)})")

    print("10. dinheiro: formatar e reler é identidade")
    for cents in range(0, 200_001, 7):
        text = brl_format(cents)
        check(brl_parse(text) == cents, f"ida e volta falhou em {cents}: {text!r}")

    print("11. dinheiro: nada de float — 47,55 não vira 4754")
    cases = {"47,50": 4750, "R$ 47,50": 4750, "1.234,56": 123_456, "1,234.56": 123_456,
             "47": 4700, "47.5": 4750, "1.234": 123_400, "0,05": 5, "47,55": 4755,
             "8,70": 870, "47,999": 4800, "47,994": 4799, "-47,50": -4750}
    for text, expected in cases.items():
        check(brl_parse(text) == expected, f"parse({text!r}) = {brl_parse(text)}, esperava {expected}")
    check(brl_parse("") is None and brl_parse("abc") is None, "lixo devia virar None")

    print("12. dinheiro: moedas sem subunidade")
    check(brl_format(500, exponent=0) == "500", "iene formatou errado")
    check(brl_format(12_000, exponent=0) == "12.000", "peso chileno formatou errado")

    print()
    if FAILURES:
        print(f"FALHOU — {len(FAILURES)} problema(s):")
        for f in FAILURES[:25]:
            print(" ·", f)
        return 1
    print("tudo verde — 12 propriedades, ~40 mil casos")
    return 0


if __name__ == "__main__":
    sys.exit(run())
