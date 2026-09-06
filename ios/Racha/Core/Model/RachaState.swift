import Foundation

/// The derived state of one racha. Never constructed by hand outside the
/// projection — build it by folding events, so the thing on screen and the thing
/// in the log can never disagree.
struct RachaState: Identifiable, Equatable, Sendable {
    var id: UUID
    var title: String
    var kind: RachaKind
    var currency: Currency
    var createdAt: Date
    var updatedAt: Date

    var participants: [Participant] = []
    var items: [LineItem] = []
    var claimsByItem: [LineItem.ID: [Claim]] = [:]
    var extras: [Extra] = []
    var payments: [Payment] = []
    var fxRates: [String: FXRate] = [:]
    /// The house and the table. Nil for a racha that is not a table (a legacy
    /// friends' split); the pay sheet then has no one to pay.
    var venue: Venue? = nil

    var coverAssetKey: String?
    var notes: [String] = []
    var settledAt: Date?

    /// Events that could not be applied (unknown ids, contradictory data). Kept
    /// visible rather than thrown — a malformed event must not make real money
    /// unreadable. Same totality rule as `api/_lib/checks/check-state.js`.
    var anomalies: [String] = []

    // MARK: Derived

    var itemsTotal: Cents { items.map(\.total).total }

    func claims(for item: LineItem.ID) -> [Claim] { claimsByItem[item] ?? [] }

    func participant(_ id: Participant.ID) -> Participant? { participants.first { $0.id == id } }
    func item(_ id: LineItem.ID) -> LineItem? { items.first { $0.id == id } }

    var split: SplitResult { SplitEngine.split(self) }

    var confirmedPaid: Cents { payments.filter(\.isConfirmed).map(\.amount).total }

    var balances: [NetBalance] {
        SettleUp.balances(split: split, payments: payments, participants: participants)
    }

    var settlement: SettlementPlan { SettleUp.plan(balances) }

    /// A table is closed when the house has all of it and nothing is left
    /// unowned. Each diner pays the venue their own part, so there is no second
    /// half to wait for: the restaurant being paid *is* the racha being done.
    /// (Money between friends — one person covering another — is tracked by
    /// `settlement` as information, and never blocks the close.)
    var isSettled: Bool {
        !items.isEmpty && remainingOnTable.isZero && !split.hasUnassigned
    }

    /// The slip's number: four digits, stable per racha, the thing people call
    /// out across a loud room. Derived, so the log never has to carry it.
    var comanda: String { String(abs(id.uuidString.folded.stableHash) % 9000 + 1000) }

    /// What the house is still owed for this table.
    var remainingOnTable: Cents { (split.total - confirmedPaid).clampedNonNegative }

    /// What one person's share came to.
    func share(of person: Participant.ID) -> Cents { split.share(for: person)?.total ?? .zero }

    /// What one person has paid the house, confirmed.
    func paid(by person: Participant.ID) -> Cents {
        payments.filter { $0.payerID == person && $0.isConfirmed }.map(\.amount).total
    }

    /// What one person still owes the house: their share less what they paid.
    func due(of person: Participant.ID) -> Cents { (share(of: person) - paid(by: person)).clampedNonNegative }

    /// Everyone who has not yet paid their part in full, in seating order.
    var unpaidParticipants: [Participant] { participants.filter { !due(of: $0.id).isZero } }

    /// The user's own position: what they paid, what they owed, what's outstanding.
    func position(of me: Participant.ID) -> NetBalance? {
        balances.first { $0.personID == me }
    }

    var enabledGratuity: Cents {
        // Tips reported separately — Lei 13.419/2017, CLAUDE.md non-negotiable #2.
        split.shares.flatMap(\.extras).filter { extra in
            extras.first { $0.id == extra.extraID }?.isGratuity == true
        }.map(\.amount).total
    }
}
