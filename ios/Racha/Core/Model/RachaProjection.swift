import Foundation

/// Folds an event log into a `RachaState`.
///
/// **Total by construction**: `reduce` never throws and never traps on a stored
/// log. An event that references a participant who was since removed, or carries
/// a contradictory amount, is recorded in `state.anomalies` and skipped. Strict
/// validation belongs at *append* time (`RachaRepository.append`) — by the time a
/// log is on disk, refusing to render it is the worst possible outcome.
enum RachaProjection {

    static func reduce(_ events: [RachaEvent]) -> RachaState? {
        let ordered = events.sorted { $0.seq < $1.seq }
        // A revert must be honoured no matter where it appears in the fold, so the
        // reverted set is resolved up front rather than during the walk.
        var revertedIDs = Set<UUID>()
        for e in ordered {
            if case .reverted(let target, _) = e.body { revertedIDs.insert(target) }
        }

        guard let genesis = ordered.first(where: { if case .created = $0.body { return true }; return false }),
              case .created(let title, let kind, let currency) = genesis.body else { return nil }

        var s = RachaState(id: genesis.rachaID, title: title, kind: kind, currency: currency,
                           createdAt: genesis.at, updatedAt: genesis.at)

        for event in ordered {
            guard !revertedIDs.contains(event.id) else { continue }
            apply(event, to: &s)
            s.updatedAt = max(s.updatedAt, event.at)
        }
        return s
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    private static func apply(_ event: RachaEvent, to s: inout RachaState) {
        func anomaly(_ msg: String) { s.anomalies.append("seq \(event.seq): \(msg)") }

        switch event.body {
        case .created:
            break   // handled by the genesis bootstrap

        case .renamed(let title):
            s.title = title

        case .kindChanged(let kind):
            s.kind = kind

        case .participantAdded(let p):
            guard !s.participants.contains(where: { $0.id == p.id }) else { return }
            s.participants.append(p)

        case .participantRemoved(let id):
            guard s.participants.contains(where: { $0.id == id }) else { return anomaly("remove unknown participant") }
            s.participants.removeAll { $0.id == id }
            // Their claims go with them; the items become unassigned and the UI
            // asks. Silently reassigning someone else's food is worse than asking.
            for key in s.claimsByItem.keys {
                s.claimsByItem[key]?.removeAll { $0.personID == id }
                if s.claimsByItem[key]?.isEmpty == true { s.claimsByItem[key] = nil }
            }

        case .participantRenamed(let id, let name):
            guard let idx = s.participants.firstIndex(where: { $0.id == id }) else { return anomaly("rename unknown participant") }
            s.participants[idx].name = name

        case .pixKeySet(let id, let key):
            guard let idx = s.participants.firstIndex(where: { $0.id == id }) else { return anomaly("pix key for unknown participant") }
            s.participants[idx].pixKey = key

        case .itemsAdded(let items):
            for item in items where !s.items.contains(where: { $0.id == item.id }) {
                s.items.append(item)
            }

        case .itemRemoved(let id):
            guard s.items.contains(where: { $0.id == id }) else { return anomaly("remove unknown item") }
            s.items.removeAll { $0.id == id }
            s.claimsByItem[id] = nil

        case .itemEdited(let id, let name, let quantity, let unitPrice, let total, let category):
            guard let idx = s.items.firstIndex(where: { $0.id == id }) else { return anomaly("edit unknown item") }
            if let name { s.items[idx].name = name }
            if let quantity { s.items[idx].quantity = max(1, quantity) }
            if let unitPrice { s.items[idx].unitPrice = unitPrice }
            if let total { s.items[idx].total = total }
            else if quantity != nil || unitPrice != nil {
                // Recompute only when the caller changed a factor and did NOT pin a
                // total. A pinned total always wins — the receipt is the authority.
                s.items[idx].total = s.items[idx].unitPrice * s.items[idx].quantity
            }
            if let category { s.items[idx].category = category }

        case .claimsSet(let itemID, let claims):
            guard s.items.contains(where: { $0.id == itemID }) else { return anomaly("claims for unknown item") }
            let valid = claims.filter { c in s.participants.contains { $0.id == c.personID } }
            if valid.count != claims.count { anomaly("dropped claim(s) for unknown participant") }
            // Deduplicate by person: two claims for the same person on one item
            // would double their weight and quietly change the money.
            var seen = Set<Participant.ID>()
            s.claimsByItem[itemID] = valid.filter { seen.insert($0.personID).inserted }
            if s.claimsByItem[itemID]?.isEmpty == true { s.claimsByItem[itemID] = nil }

        case .claimsCleared(let itemID):
            s.claimsByItem[itemID] = nil

        case .extraAdded(let extra):
            guard !s.extras.contains(where: { $0.id == extra.id }) else { return }
            s.extras.append(extra)

        case .extraUpdated(let extra):
            guard let idx = s.extras.firstIndex(where: { $0.id == extra.id }) else { return anomaly("update unknown extra") }
            s.extras[idx] = extra

        case .extraRemoved(let id):
            s.extras.removeAll { $0.id == id }

        case .extraToggled(let id, let enabled):
            guard let idx = s.extras.firstIndex(where: { $0.id == id }) else { return anomaly("toggle unknown extra") }
            s.extras[idx].isEnabled = enabled

        case .paymentRecorded(let payment):
            guard s.participants.contains(where: { $0.id == payment.payerID }) else { return anomaly("payment by unknown participant") }
            guard !s.payments.contains(where: { $0.id == payment.id }) else { return }   // idempotent by id
            s.payments.append(payment)

        case .paymentConfirmed(let id, let at):
            guard let idx = s.payments.firstIndex(where: { $0.id == id }) else { return anomaly("confirm unknown payment") }
            if s.payments[idx].confirmedAt == nil { s.payments[idx].confirmedAt = at }

        case .paymentRemoved(let id):
            s.payments.removeAll { $0.id == id }

        case .fxRateSet(let rate):
            s.fxRates[rate.from.uppercased()] = rate

        case .venueSet(let venue):
            s.venue = venue

        case .coverImageSet(let key):
            s.coverAssetKey = key

        case .noteAdded(let note):
            s.notes.append(note)

        case .settled(let at):
            s.settledAt = at

        case .reopened:
            s.settledAt = nil

        case .reverted:
            break   // resolved before the fold
        }
    }
}
