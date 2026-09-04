import Foundation

/// Every change to a racha, as an append-only fact.
///
/// This is CLAUDE.md non-negotiable #6 carried into the app: **payment state is
/// event-sourced; webhooks append, state is derived, nothing overwrites
/// history.** It is also what makes the user's rule enforceable — *"the agent
/// never silently mutates an amount: every agent-driven edit is visible,
/// labeled, and undoable with one gesture."*
///
/// Undo is not a diff-and-patch: it appends a `reverted` marker referencing the
/// event id. The log keeps the mistake, the projection skips it, and a person can
/// see exactly what the agent tried to do. A ledger that forgets is a ledger you
/// cannot argue with.
struct RachaEvent: Identifiable, Codable, Sendable, Equatable {
    var id: UUID
    var rachaID: UUID
    /// Monotonic per racha. The fold order — never the timestamp, which can go
    /// backwards across devices.
    var seq: Int
    var at: Date
    var origin: Origin
    /// Human-readable, pt-BR, shown verbatim in the thread's edit ribbon.
    /// Written at append time so the label can never drift from what happened.
    var summary: String
    var body: Body
    /// Set when a later event reverted this one.
    var revertedBy: UUID?

    var isReverted: Bool { revertedBy != nil }

    enum Origin: String, Codable, Sendable {
        /// The person tapped something. Undoable, but not flagged.
        case user
        /// The agent wrote it in response to a message. Flagged in the UI, always
        /// undoable with one gesture.
        case agent
        /// Receipt OCR / import.
        case scan
        /// The app itself (seeding, migration).
        case system
    }

    indirect enum Body: Codable, Sendable, Equatable {
        case created(title: String, kind: RachaKind, currency: Currency)
        case renamed(title: String)
        case kindChanged(RachaKind)

        case participantAdded(Participant)
        case participantRemoved(Participant.ID)
        case participantRenamed(id: Participant.ID, name: String)
        case pixKeySet(id: Participant.ID, key: String?)

        case itemsAdded([LineItem])
        case itemRemoved(LineItem.ID)
        case itemEdited(id: LineItem.ID, name: String?, quantity: Int?, unitPrice: Cents?, total: Cents?, category: ItemCategory?)

        case claimsSet(itemID: LineItem.ID, claims: [Claim])
        case claimsCleared(itemID: LineItem.ID)

        case extraAdded(Extra)
        case extraUpdated(Extra)
        case extraRemoved(Extra.ID)
        case extraToggled(id: Extra.ID, enabled: Bool)

        case paymentRecorded(Payment)
        case paymentConfirmed(id: Payment.ID, at: Date)
        case paymentRemoved(Payment.ID)

        case fxRateSet(FXRate)
        case coverImageSet(assetKey: String?)
        case noteAdded(String)
        case settled(at: Date)
        case reopened

        /// Marks `target` as undone. Carries the reason so the ribbon can say
        /// "desfeito por você" rather than just vanishing.
        case reverted(target: UUID, reason: String?)
    }
}

enum RachaKind: String, Codable, CaseIterable, Sendable {
    case jantar, churrasco, viagem, casa, rolê, mercado, outro

    var label: String {
        switch self {
        case .jantar: return "Jantar"
        case .churrasco: return "Churrasco"
        case .viagem: return "Viagem"
        case .casa: return "Casa"
        case .rolê: return "Rolê"
        case .mercado: return "Mercado"
        case .outro: return "Outro"
        }
    }

    var symbol: String {
        switch self {
        case .jantar: return "fork.knife"
        case .churrasco: return "flame.fill"
        case .viagem: return "airplane"
        case .casa: return "house.fill"
        case .rolê: return "music.note"
        case .mercado: return "cart.fill"
        case .outro: return "square.grid.2x2"
        }
    }

    /// Recurring rachas (a shared house) never "settle" for good — they close a
    /// cycle and reopen. The timeline treats them differently.
    var isRecurring: Bool { self == .casa }
}
