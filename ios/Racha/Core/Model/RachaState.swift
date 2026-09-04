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

    /// A racha is settled when the bill is fully covered and nobody is owed
    /// anything by anybody. Both halves matter: the restaurant being paid does not
    /// mean the friend who fronted it has been made whole.
    var isSettled: Bool {
        let s = settlement
        return s.isComplete && !split.hasUnassigned && !items.isEmpty
    }

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
