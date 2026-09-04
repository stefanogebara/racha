import Foundation

/// What one person owes, decomposed so the UI can show the *derivation* rather
/// than a number the person is asked to trust.
///
/// A bill argument is never about the total; it is about "why is mine higher than
/// yours". Keeping consumption, each extra, and the rounding adjustment as
/// separate fields means the answer is always on screen.
struct PersonShare: Equatable, Sendable, Identifiable {
    var personID: Participant.ID
    /// Sum of the line items assigned to this person.
    var consumption: Cents
    /// Extras (serviço, couvert, taxa, gorjeta, desconto) attributed to them.
    var extras: [ExtraShare]
    /// Minor units this person absorbed from rounding, across all allocations.
    /// Positive = they took the extra centavo. This is the number the app shows
    /// when someone asks "por que a minha deu um centavo a mais?".
    var roundingAdjustment: Cents

    var id: Participant.ID { personID }
    var extrasTotal: Cents { extras.map(\.amount).total }
    var total: Cents { consumption + extrasTotal }
}

struct ExtraShare: Equatable, Sendable {
    var extraID: Extra.ID
    var label: String
    var amount: Cents
    var kind: Extra.Kind
}

/// The full, checked result of splitting a racha.
struct SplitResult: Equatable, Sendable {
    var shares: [PersonShare]
    /// Grand total: every line item plus every enabled extra.
    var total: Cents
    /// Sum of the line items, independent of who claimed what.
    var itemsTotal: Cents
    /// Sum of consumption across all shares. Must equal `itemsTotal - unassignedTotal`.
    var claimedTotal: Cents
    /// Items nobody has claimed yet. Not an error — it is the app's main prompt
    /// ("faltam 2 itens sem dono"), and the reason `total` can exceed the shares.
    var unassigned: [LineItem.ID]
    var unassignedTotal: Cents

    /// The invariant that can actually fail, and therefore the one worth asserting:
    /// **no centavo of a claimed item may disappear between the item and the people**.
    /// A dropped participant, a bad weight, or an allocator regression all show up
    /// here. (Extras cannot fail the same way — `Allocator` guarantees each extra's
    /// parts sum to that extra — so folding them in would only hide this signal.)
    var isBalanced: Bool {
        claimedTotal + unassignedTotal == itemsTotal
            && shares.map(\.total).total + unassignedTotal == total
    }

    /// Everything still without an owner, in reais-facing terms.
    var hasUnassigned: Bool { !unassigned.isEmpty }

    func share(for person: Participant.ID) -> PersonShare? {
        shares.first { $0.personID == person }
    }
}

/// Pure. No I/O, no dates, no randomness. Given the same racha it returns the
/// same split forever — which is what makes an event-sourced ledger replayable.
///
/// Semantics carried over from `api/_lib/checks/split-engine.js`:
/// - a shared item is divided by largest remainder, **rotated by item position**,
///   so the extra centavo walks around the table instead of always landing on
///   whoever happens to sort first;
/// - percentage extras are computed **per share**, never split flat. Someone who
///   ate R$ 80 of a R$ 100 bill pays R$ 8 of the 10%, not R$ 5. The web app calls
///   this out explicitly and it is the behaviour Brazilians expect.
enum SplitEngine {

    static func split(_ racha: RachaState) -> SplitResult {
        let people = racha.participants.map(\.id)
        guard !people.isEmpty else {
            return SplitResult(shares: [], total: racha.itemsTotal,
                               itemsTotal: racha.itemsTotal, claimedTotal: .zero,
                               unassigned: racha.items.map(\.id), unassignedTotal: racha.itemsTotal)
        }
        let indexOf = Dictionary(uniqueKeysWithValues: people.enumerated().map { ($1, $0) })

        var consumption = [Cents](repeating: .zero, count: people.count)
        var rounding = [Int](repeating: 0, count: people.count)
        var unassigned: [LineItem.ID] = []
        var unassignedTotal = Cents.zero

        // ---- 1. Line items -------------------------------------------------
        for (position, item) in racha.items.enumerated() {
            let claims = racha.claims(for: item.id).filter { indexOf[$0.personID] != nil }
            guard !claims.isEmpty else {
                unassigned.append(item.id)
                unassignedTotal += item.total
                continue
            }
            // Weights let one person take "2 of the 3 chopps" without splitting the
            // item into three rows. A claim with no explicit weight counts as 1.
            let weights = claims.map { max(0, $0.weight) }
            let alloc = Allocator.proportional(item.total, weights: weights, rotate: position)
            for (i, claim) in claims.enumerated() {
                guard let slot = indexOf[claim.personID] else { continue }
                consumption[slot] += alloc.parts[i]
            }
            for r in alloc.remainderRecipients {
                if let slot = indexOf[claims[r].personID] { rounding[slot] += 1 }
            }
        }

        // ---- 2. Extras -----------------------------------------------------
        //
        // Order matters and is explicit: percentage extras read a base that is
        // itself defined by the extra (`Extra.Base`), so a 10% serviço on top of a
        // couvert is expressible, and so is one that ignores it. Nothing is
        // implicit — CLAUDE.md non-negotiable #3 is that the 10% is never a
        // silent, locked-in charge.
        var extraShares: [[ExtraShare]] = Array(repeating: [], count: people.count)

        for (position, extra) in racha.extras.enumerated() where extra.isEnabled {
            let base: [Cents]
            switch extra.base {
            case .consumption:
                base = consumption
            case .consumptionPlusEarlierExtras:
                base = zip(consumption, extraShares).map { $0 + $1.map(\.amount).total }
            case .equalHeads:
                base = people.map { _ in Cents(1) }   // uniform weights → equal split
            }

            let amount: Cents
            switch extra.kind {
            case .percentage(let bp):
                // Per-share percentage: sum of round(base_i * bp) — NOT round of the
                // sum. This is the "proportional in every mode" rule, and it means
                // the extras column always reconciles against each person's own base.
                var perPerson: [Cents] = []
                for b in base { perPerson.append(Allocator.basisPoints(b.clampedNonNegative, bp)) }
                for (i, v) in perPerson.enumerated() where !v.isZero {
                    extraShares[i].append(ExtraShare(extraID: extra.id, label: extra.label,
                                                     amount: v, kind: extra.kind))
                }
                continue
            case .fixed(let cents), .discount(let cents):
                amount = extra.kind.isDiscount ? -cents : cents
            case .perHead(let cents):
                // Couvert: a flat charge per person present. Exact by construction —
                // no allocation needed, so no remainder to attribute.
                for i in people.indices {
                    extraShares[i].append(ExtraShare(extraID: extra.id, label: extra.label,
                                                     amount: cents, kind: extra.kind))
                }
                continue
            }

            // A fixed amount (a bottle of wine on the house's tab, a delivery fee,
            // a discount) spreads across people in proportion to their base, so the
            // person who ate more carries more of it. Weights are the bases; if all
            // bases are zero it degenerates to an equal split, handled by Allocator.
            let weights = base.map { max(0, $0.raw) }
            let alloc = Allocator.proportional(amount, weights: weights, rotate: position)
            for (i, part) in alloc.parts.enumerated() where !part.isZero {
                extraShares[i].append(ExtraShare(extraID: extra.id, label: extra.label,
                                                 amount: part, kind: extra.kind))
            }
            for r in alloc.remainderRecipients { rounding[r] += 1 }
        }

        let shares = people.enumerated().map { slot, pid in
            PersonShare(personID: pid,
                        consumption: consumption[slot],
                        extras: extraShares[slot],
                        roundingAdjustment: Cents(rounding[slot]))
        }

        let grandTotal = shares.map(\.total).total + unassignedTotal
        let result = SplitResult(shares: shares, total: grandTotal,
                                 itemsTotal: racha.itemsTotal,
                                 claimedTotal: consumption.total,
                                 unassigned: unassigned, unassignedTotal: unassignedTotal)
        assert(result.isBalanced, "split lost money: \(result)")
        return result
    }
}
