import Foundation

/// The result of dividing money between people, with the leftover named.
///
/// The user's rule — "every cent must be accounted for; show where rounding
/// remainders land" — is why this is a struct and not a `[Cents]`. An allocation
/// that returns only the parts loses the one fact a person standing at the table
/// actually argues about: *who got the extra centavo*. Here it is a first-class
/// field the UI renders ("+R$ 0,01 no Gui") and the tests assert on.
struct Allocation: Equatable, Sendable {
    /// One part per recipient, in the order the recipients were given.
    var parts: [Cents]
    /// Indices in `parts` that absorbed one extra minor unit from the remainder.
    var remainderRecipients: [Int]
    /// The total that was divided. `parts.total == total` is the invariant.
    var total: Cents

    var isExact: Bool { parts.total == total }
}

enum Allocator {
    /// Divide `total` into `n` equal parts, differing by at most one minor unit,
    /// summing to exactly `total`.
    ///
    /// `rotate` chooses which positions absorb the leftover. Byte-for-byte the
    /// backend's `splitEqual(totalCents, n, rotate)` — same rotation semantics, so
    /// a split computed on the phone and re-validated on the server agree to the
    /// centavo. Rotation exists so that on a bill of many shared items the same
    /// unlucky person doesn't eat every extra centavo.
    ///
    /// Negative totals are supported (a refund, a credit line): the leftover is
    /// distributed with the same rule, mirrored, so the sum invariant still holds.
    static func equal(_ total: Cents, into n: Int, rotate: Int = 0) -> Allocation {
        precondition(n >= 1, "cannot split into \(n) parts")
        let sign = total.raw < 0 ? -1 : 1
        let magnitude = abs(total.raw)
        let base = magnitude / n
        let remainder = magnitude - base * n
        var parts = [Int](repeating: base, count: n)
        var recipients: [Int] = []
        let offset = ((rotate % n) + n) % n
        for i in 0..<remainder {
            let idx = (i + offset) % n
            parts[idx] += 1
            recipients.append(idx)
        }
        return Allocation(
            parts: parts.map { Cents($0 * sign) },
            remainderRecipients: recipients.sorted(),
            total: total
        )
    }

    /// Divide `total` in proportion to `weights`, summing to exactly `total`.
    ///
    /// This is the *largest-remainder* method (Hamilton's method — the same
    /// algorithm that allocates seats in a parliament, and it has the same virtue
    /// here: the parts are as close to the ideal fractions as integers allow, and
    /// they sum to the whole with nothing invented or lost).
    ///
    /// Ties in the fractional remainder are broken by `rotate` then by index, so
    /// the result is deterministic and replayable — a money bug you cannot
    /// reproduce is a money bug you cannot fix.
    ///
    /// All-zero weights degenerate to an equal split, which is the only sane
    /// reading of "split this between people who each consumed nothing".
    static func proportional(_ total: Cents, weights: [Int], rotate: Int = 0) -> Allocation {
        precondition(!weights.isEmpty, "cannot allocate across zero recipients")
        precondition(weights.allSatisfy { $0 >= 0 }, "weights must be non-negative")

        let weightSum = weights.reduce(0, +)
        guard weightSum > 0 else { return equal(total, into: weights.count, rotate: rotate) }

        let sign = total.raw < 0 ? -1 : 1
        let magnitude = abs(total.raw)

        // floor(total * w / W) for each recipient, plus the fractional remainder
        // kept exactly as an integer numerator so no float ever enters the sort.
        var parts = [Int](repeating: 0, count: weights.count)
        var fractions: [(index: Int, numerator: Int)] = []
        for (i, w) in weights.enumerated() {
            let product = magnitude * w
            parts[i] = product / weightSum
            fractions.append((i, product % weightSum))
        }

        let leftover = magnitude - parts.reduce(0, +)
        let n = weights.count
        let offset = ((rotate % n) + n) % n
        // Largest fractional part first; ties go to the rotated position, which
        // spreads the luck across repeated splits within one racha.
        fractions.sort { a, b in
            if a.numerator != b.numerator { return a.numerator > b.numerator }
            let ra = (a.index - offset + n) % n
            let rb = (b.index - offset + n) % n
            return ra < rb
        }
        // `leftover` is always < weights.count (the floors lose at most one unit
        // each), so the first `leftover` entries of the sorted list are exactly the
        // recipients — no wrap-around, no double-award.
        assert(leftover < n, "largest-remainder invariant broken: leftover \(leftover) >= \(n)")
        let recipients = fractions.prefix(leftover).map(\.index)
        for target in recipients { parts[target] += 1 }

        return Allocation(
            parts: parts.map { Cents($0 * sign) },
            remainderRecipients: recipients.sorted(),
            total: total
        )
    }

    /// A percentage of a base, half-up, in basis points (1000 bp = 10%).
    ///
    /// Basis points rather than a `Double` percentage for the same reason the whole
    /// module is integer: 10% of R$ 33,33 must be one exact number, every time, on
    /// every device. Mirrors the backend's `servicoCents`.
    static func basisPoints(_ base: Cents, _ bp: Int) -> Cents {
        guard base.raw != 0, bp != 0 else { return .zero }
        precondition(bp >= 0 && bp <= 30_000, "basis points out of sane range: \(bp)")
        return Cents(roundHalfUpDiv(base.raw * bp, 10_000))
    }
}
