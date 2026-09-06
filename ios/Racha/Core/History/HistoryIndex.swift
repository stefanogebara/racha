import Foundation

/// Answers the questions the user asks *across* rachas — "quanto o pessoal ainda
/// me deve?", "com quem eu divido conta com mais frequência?", "como é a conta
/// desse lugar normalmente?"
///
/// It is a derived, in-memory index rebuilt from the repository's states. That is
/// a deliberate trade: a racha is small and the phone is fast, and a stale
/// denormalised table that disagrees with the ledger is exactly the class of bug
/// this codebase refuses to ship.
struct HistoryIndex: Sendable {
    var meID: Participant.ID

    /// People the user has split with, most-frequent first.
    var companions: [Companion] = []
    /// Sets of people that recur together — "o grupo do churrasco".
    var recurringGroups: [RecurringGroup] = []
    /// What a given place's receipt usually looks like.
    var venues: [VenueProfile] = []
    /// Net outstanding per person, summed across every unsettled racha.
    var outstanding: [Outstanding] = []

    struct Companion: Identifiable, Sendable {
        var personID: Participant.ID
        var name: String
        var rachaCount: Int
        var lastSeen: Date
        var id: Participant.ID { personID }
    }

    struct RecurringGroup: Identifiable, Sendable {
        var id: String                     // stable: sorted participant ids joined
        var members: [Participant.ID]
        var memberNames: [String]
        var occurrences: Int
        var lastSeen: Date
        var suggestedTitle: String
    }

    struct VenueProfile: Identifiable, Sendable {
        var id: String                     // folded title
        var displayName: String
        var visits: Int
        var medianTotal: Cents
        /// Item names that show up nearly every visit — the "usual".
        var staples: [String]
        /// Serviço rate the place actually charges, in basis points, when consistent.
        var servicoBP: Int?
        var chargesCouvert: Bool
        var lastVisit: Date
    }

    struct Outstanding: Identifiable, Sendable {
        var personID: Participant.ID
        var name: String
        /// Positive: they owe the user. Negative: the user owes them.
        var net: Cents
        var rachaIDs: [UUID]
        var id: Participant.ID { personID }
    }

    // MARK: Build

    static func build(from states: [RachaState], meID: Participant.ID) -> HistoryIndex {
        var index = HistoryIndex(meID: meID)

        var companionCounts: [Participant.ID: (name: String, count: Int, last: Date)] = [:]
        var groupCounts: [String: (members: [Participant], count: Int, last: Date, titles: [String])] = [:]
        var venueVisits: [String: [RachaState]] = [:]
        var netByPerson: [Participant.ID: (name: String, net: Cents, rachas: [UUID])] = [:]

        for state in states {
            // --- companions & groups
            let others = state.participants.filter { $0.id != meID }
            for p in others {
                let existing = companionCounts[p.id]
                companionCounts[p.id] = (p.name, (existing?.count ?? 0) + 1,
                                         max(existing?.last ?? .distantPast, state.updatedAt))
            }
            if others.count >= 2 {
                let key = others.map(\.id.uuidString).sorted().joined(separator: "|")
                let existing = groupCounts[key]
                groupCounts[key] = (others, (existing?.count ?? 0) + 1,
                                    max(existing?.last ?? .distantPast, state.updatedAt),
                                    (existing?.titles ?? []) + [state.title])
            }

            // --- venue profile, only for meal-shaped rachas
            if state.kind == .jantar || state.kind == .rolê {
                venueVisits[state.title.folded, default: []].append(state)
            }

            // --- outstanding, only where money is still moving
            guard !state.isSettled else { continue }
            let plan = state.settlement
            for transfer in plan.transfers {
                if transfer.from == meID, let to = state.participant(transfer.to) {
                    var e = netByPerson[to.id] ?? (to.name, .zero, [])
                    e.net -= transfer.amount           // the user owes them
                    e.rachas.append(state.id)
                    netByPerson[to.id] = e
                } else if transfer.to == meID, let from = state.participant(transfer.from) {
                    var e = netByPerson[from.id] ?? (from.name, .zero, [])
                    e.net += transfer.amount           // they owe the user
                    e.rachas.append(state.id)
                    netByPerson[from.id] = e
                }
            }
        }

        index.companions = companionCounts.map { id, v in
            Companion(personID: id, name: v.name, rachaCount: v.count, lastSeen: v.last)
        }.sorted { ($0.rachaCount, $0.lastSeen) > ($1.rachaCount, $1.lastSeen) }

        index.recurringGroups = groupCounts.filter { $0.value.count >= 2 }.map { key, v in
            RecurringGroup(id: key,
                           members: v.members.map(\.id),
                           memberNames: v.members.map(\.shortName),
                           occurrences: v.count,
                           lastSeen: v.last,
                           suggestedTitle: mostCommon(v.titles) ?? v.members.map(\.shortName).joined(separator: ", "))
        }.sorted { $0.occurrences > $1.occurrences }

        index.venues = venueVisits.compactMap { key, visits in
            guard let latest = visits.max(by: { $0.updatedAt < $1.updatedAt }) else { return nil }
            let totals = visits.map(\.split.total).sorted()
            let servicoRates = visits.compactMap { s -> Int? in
                for extra in s.extras where extra.isGratuity {
                    if case .percentage(let bp) = extra.kind { return bp }
                }
                return nil
            }
            let allItems = visits.flatMap { $0.items.map(\.name.folded) }
            var counts: [String: Int] = [:]
            for name in allItems { counts[name, default: 0] += 1 }
            let threshold = max(2, (visits.count + 1) / 2)
            let staples = counts.filter { $0.value >= threshold }
                .sorted { $0.value > $1.value }
                .prefix(6)
                .map(\.key)

            return VenueProfile(
                id: key,
                displayName: latest.title,
                visits: visits.count,
                medianTotal: totals.isEmpty ? .zero : totals[totals.count / 2],
                staples: Array(staples),
                servicoBP: allEqual(servicoRates) ? servicoRates.first : nil,
                chargesCouvert: visits.contains { s in s.extras.contains { if case .perHead = $0.kind { return true }; return false } },
                lastVisit: latest.updatedAt
            )
        }.sorted { $0.visits > $1.visits }

        index.outstanding = netByPerson.compactMap { id, v in
            v.net.isZero ? nil : Outstanding(personID: id, name: v.name, net: v.net,
                                             rachaIDs: Array(Set(v.rachas)))
        }.sorted { abs($0.net.raw) > abs($1.net.raw) }

        return index
    }

    /// Total the user is owed minus what they owe, across everything open.
    var netPosition: Cents { outstanding.map(\.net).total }
    var totalOwedToMe: Cents { outstanding.filter { !$0.net.isNegative }.map(\.net).total }
    var totalIOwe: Cents { Cents(-outstanding.filter { $0.net.isNegative }.map(\.net).total.raw) }

    func venue(matching query: String) -> VenueProfile? {
        let q = query.folded
        return venues.first { $0.id == q } ?? venues.first { $0.id.contains(q) || q.contains($0.id) }
    }

    private static func mostCommon(_ xs: [String]) -> String? {
        var counts: [String: Int] = [:]
        for x in xs { counts[x, default: 0] += 1 }
        return counts.max { $0.value < $1.value }?.key
    }

    private static func allEqual(_ xs: [Int]) -> Bool {
        guard let first = xs.first else { return false }
        return xs.allSatisfy { $0 == first }
    }
}
