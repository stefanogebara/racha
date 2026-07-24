/**
 * Split math for the diner UI — pure, integer-centavo, mirrors the backend
 * split-engine (api/_lib/checks/split-engine.js). The backend re-validates
 * everything; this is advisory, but it must agree to the centavo so the number
 * the diner taps "pay" on is the number that gets charged.
 *
 * The serviço (10%) is ALWAYS a percentage of THIS diner's base — so a person
 * paying R$80 of a R$100 bill pays R$8 of serviço and their friend paying R$20
 * pays R$2. Proportional falls out of computing it per-share, in every mode
 * (equal, by-item, custom) — never split flat.
 */

export type SplitMode = 'igual' | 'item' | 'valor';

/** One share of an equal split — base + 1¢ for the first `remainder` positions. */
export function splitEqualLocal(totalCents: number, parts: number, index: number): number {
  const n = Math.max(1, Math.floor(parts));
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  return base + (index < remainder ? 1 : 0);
}

/**
 * The diner's consumption base BEFORE serviço, per mode. Never negative.
 * - igual: an equal slice of what's left;
 * - item:  the sum of the items they tapped as theirs;
 * - valor: the amount they typed (null/invalid → 0, disarms the CTA upstream).
 */
export function shareBaseCents(opts: {
  mode: SplitMode;
  remaining: number;
  people: number;
  customCents: number | null;
  selectedCents: number;
}): number {
  switch (opts.mode) {
    case 'igual':
      return splitEqualLocal(opts.remaining, Math.max(opts.people, 1), 0);
    case 'item':
      return Math.max(0, opts.selectedCents);
    case 'valor':
      return Math.max(0, opts.customCents ?? 0);
    default:
      return 0;
  }
}

/**
 * Serviço on a base, half-up to the centavo. basisPoints: 1000 = 10%. Byte-for-
 * byte the backend's servicoCents so the UI number matches the charge.
 */
export function servicoCents(baseCents: number, servicoBp: number): number {
  if (baseCents <= 0 || servicoBp <= 0) return 0;
  return Math.floor((baseCents * servicoBp + 5000) / 10000);
}

/**
 * Full share for a mode: base capped at what's still owed, serviço on the
 * capped base, and the total to charge. `capped` flags that the base was
 * trimmed to `remaining` (e.g. items already covered by someone else) so the
 * UI can explain the adjusted number instead of silently shrinking it.
 */
export function computeShare(opts: {
  mode: SplitMode;
  remaining: number;
  people: number;
  customCents: number | null;
  selectedCents: number;
  servicoOn: boolean;
  servicoBp: number;
}): { base: number; servico: number; total: number; capped: boolean } {
  const rawBase = shareBaseCents(opts);
  const base = Math.min(rawBase, Math.max(0, opts.remaining));
  const servico = opts.servicoOn ? servicoCents(base, opts.servicoBp) : 0;
  return { base, servico, total: base + servico, capped: rawBase > base };
}
