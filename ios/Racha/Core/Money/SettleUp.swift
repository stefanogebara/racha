import Foundation

/// One "X pays Y" instruction.
struct Transfer: Equatable, Sendable, Identifiable {
    var from: Participant.ID
    var to: Participant.ID
    var amount: Cents
    var id: String { "\(from.uuidString)->\(to.uuidString):\(amount.raw)" }
}

/// Net position per person: positive = they are owed, negative = they owe.
struct NetBalance: Equatable, Sendable, Identifiable {
    var personID: Participant.ID
    var paid: Cents      // what they put on the card / transferred out
    var owed: Cents      // their share of the bill
    var net: Cents       // paid - owed
    var id: Participant.ID { personID }
    var isSettled: Bool { net.isZero }
}

/// The answer to "quem paga quem". `residual` is what the group still owes the
/// restaurant — money no transfer between friends can conjure, so it is reported
/// separately instead of being smeared into someone's debt.
struct SettlementPlan: Equatable, Sendable {
    var transfers: [Transfer]
    var residual: Cents
    var isComplete: Bool { transfers.isEmpty && residual.isZero }
}

enum SettleUp {

    /// What each person paid vs what each person owes, from the split and the
    /// recorded payments. `net` sums to zero across the group whenever payments
    /// cover the bill — the residual is money nobody has put down yet.
    static func balances(split: SplitResult, payments: [Payment],
                         participants: [Participant]) -> [NetBalance] {
        var paid: [Participant.ID: Cents] = [:]
        for p in payments where p.isConfirmed {
            paid[p.payerID, default: .zero] += p.amount
        }
        return participants.map { person in
            let owed = split.share(for: person.id)?.total ?? .zero
            let put = paid[person.id] ?? .zero
            return NetBalance(personID: person.id, paid: put, owed: owed, net: put - owed)
        }
    }

    /// Reduce the balances to the fewest transfers that clear them.
    ///
    /// The exact problem ("minimum number of transactions to settle a debt graph")
    /// is NP-hard — it is set-partition in disguise: any subset of people whose
    /// nets sum to zero can be settled among themselves, and finding the maximum
    /// number of such disjoint subsets is the hard part. So this does the thing
    /// that is both optimal in practice and fast:
    ///
    /// 1. **Exact zero-subset extraction** for small groups (≤ 12 non-zero
    ///    balances, the realistic ceiling for a dinner): find maximal disjoint
    ///    subsets that sum to zero via bitmask DP. Each such subset of size k needs
    ///    exactly k-1 transfers, and splitting the group into more zero-sum subsets
    ///    is precisely what minimises the total.
    /// 2. **Greedy largest-creditor / largest-debtor** inside each subset (and for
    ///    the whole group when it is too big for step 1), which yields n-1
    ///    transfers — the guaranteed upper bound.
    ///
    /// Everything is integer cents, and the output is asserted to clear every
    /// balance exactly: a settle-up plan that leaves a centavo behind is a bug,
    /// not a rounding fact of life.
    static func plan(_ balances: [NetBalance]) -> SettlementPlan {
        let active = balances.filter { !$0.net.isZero }
        let residual = Cents(-balances.map(\.net).total.raw).clampedNonNegative
        guard active.count > 1 else { return SettlementPlan(transfers: [], residual: residual) }

        let groups: [[NetBalance]]
        if active.count <= 12 {
            groups = zeroSumPartition(active)
        } else {
            groups = [active]
        }

        var transfers: [Transfer] = []
        for group in groups {
            transfers.append(contentsOf: greedy(group))
        }

        let plan = SettlementPlan(transfers: transfers, residual: residual)
        assert(verify(plan, against: balances), "settle-up did not clear the ledger")
        return plan
    }

    /// Applying every transfer must leave every person at zero **except** for the
    /// unpaid residual, which by definition cannot be cleared between friends — it
    /// is still owed to the restaurant. The residual left on the debtors' side must
    /// equal the plan's declared residual, to the centavo.
    static func verify(_ plan: SettlementPlan, against balances: [NetBalance]) -> Bool {
        var net: [Participant.ID: Cents] = [:]
        for b in balances { net[b.personID, default: .zero] += b.net }
        for t in plan.transfers {
            guard !t.amount.isNegative else { return false }
            net[t.from, default: .zero] += t.amount   // the debtor's negative net rises
            net[t.to, default: .zero] -= t.amount
        }
        // Nobody may end up owed money after the plan runs; only debts may remain.
        guard net.values.allSatisfy({ !($0.raw > 0) }) else { return false }
        let remainingDebt = Cents(-net.values.map(\.raw).reduce(0, +))
        return remainingDebt == plan.residual
    }

    // MARK: - Greedy settlement inside one group

    private static func greedy(_ group: [NetBalance]) -> [Transfer] {
        var debtors = group.filter { $0.net.isNegative }
            .map { (id: $0.personID, amount: -$0.net) }
            .sorted { $0.amount > $1.amount }
        var creditors = group.filter { !$0.net.isNegative && !$0.net.isZero }
            .map { (id: $0.personID, amount: $0.net) }
            .sorted { $0.amount > $1.amount }

        var out: [Transfer] = []
        var d = 0, c = 0
        while d < debtors.count && c < creditors.count {
            let amount = min(debtors[d].amount, creditors[c].amount)
            if !amount.isZero {
                out.append(Transfer(from: debtors[d].id, to: creditors[c].id, amount: amount))
            }
            debtors[d].amount -= amount
            creditors[c].amount -= amount
            if debtors[d].amount.isZero { d += 1 }
            if creditors[c].amount.isZero { c += 1 }
        }
        return out
    }

    // MARK: - Exact zero-sum partition (bitmask DP)

    /// Split the people into the *largest possible number* of disjoint subsets that
    /// each sum to zero. Total transfers = n - (number of subsets), so maximising
    /// subsets minimises transfers.
    private static func zeroSumPartition(_ people: [NetBalance]) -> [[NetBalance]] {
        let n = people.count
        let full = (1 << n) - 1

        // subsetSum[mask] — cheap to precompute, and lets the DP test "is this
        // subset self-contained?" in O(1).
        var subsetSum = [Int](repeating: 0, count: full + 1)
        for mask in 1...full {
            let low = mask & -mask
            let idx = low.trailingZeroBitCount
            subsetSum[mask] = subsetSum[mask ^ low] + people[idx].net.raw
        }

        // best[mask] = max number of zero-sum subsets that `mask` can be cut into.
        var best = [Int](repeating: 0, count: full + 1)
        // choice[mask] = the submask taken as one group to achieve best[mask].
        var choice = [Int](repeating: 0, count: full + 1)

        for mask in 1...full {
            // Pin the lowest set bit so each partition is enumerated exactly once.
            let low = mask & -mask
            var sub = mask
            while sub != 0 {
                if sub & low != 0 && subsetSum[sub] == 0 {
                    let candidate = 1 + best[mask ^ sub]
                    if candidate > best[mask] {
                        best[mask] = candidate
                        choice[mask] = sub
                    }
                }
                sub = (sub - 1) & mask
            }
            if best[mask] == 0 { choice[mask] = mask }   // no zero-sum cut available
        }

        var groups: [[NetBalance]] = []
        var mask = full
        while mask != 0 {
            let take = choice[mask] == 0 ? mask : choice[mask]
            var group: [NetBalance] = []
            var bits = take
            while bits != 0 {
                let low = bits & -bits
                group.append(people[low.trailingZeroBitCount])
                bits ^= low
            }
            groups.append(group)
            mask ^= take
        }
        return groups
    }
}
