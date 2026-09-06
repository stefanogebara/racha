import Foundation

/// Anything on the bill that isn't a line item: serviço, couvert, taxa de
/// entrega, gorjeta extra, desconto.
///
/// Two rules from CLAUDE.md are encoded here rather than in the UI, so no screen
/// can accidentally violate them:
///
/// - **`isEnabled` is always writable** (non-negotiable #3 — the 10% serviço is
///   optional under the CDC; pre-selected is fine, locked is illegal). Nothing in
///   the model can mark an extra as mandatory.
/// - **`kind == .percentage` is computed per person**, never split flat — see
///   `SplitEngine`. Whoever ate more pays more serviço.
struct Extra: Identifiable, Hashable, Codable, Sendable {
    var id: UUID
    var label: String
    var kind: Kind
    var base: Base
    var isEnabled: Bool
    /// Set when this extra represents staff remuneration. CLAUDE.md
    /// non-negotiable #2: tips are payroll, and the app must be able to report
    /// them separately from consumption. Never routed to a personal Pix key.
    var isGratuity: Bool

    init(id: UUID = UUID(), label: String, kind: Kind,
         base: Base = .consumption, isEnabled: Bool = true, isGratuity: Bool = false) {
        self.id = id
        self.label = label
        self.kind = kind
        self.base = base
        self.isEnabled = isEnabled
        self.isGratuity = isGratuity
    }

    enum Kind: Hashable, Codable, Sendable {
        /// Basis points: 1000 = 10%. Integer so the rate itself is never a float.
        case percentage(bp: Int)
        /// A single amount spread proportionally across the group.
        case fixed(Cents)
        /// A flat amount charged to each person present (couvert artístico).
        case perHead(Cents)
        /// A single amount spread proportionally, applied negatively.
        case discount(Cents)

        var isDiscount: Bool { if case .discount = self { return true }; return false }

        var display: String {
            switch self {
            case .percentage(let bp):
                let whole = bp / 100, frac = bp % 100
                return frac == 0 ? "\(whole)%" : String(format: "%d,%02d%%", whole, frac)
            case .fixed(let c): return BRL.format(c)
            case .perHead(let c): return "\(BRL.format(c)) por pessoa"
            case .discount(let c): return "− \(BRL.format(c))"
            }
        }
    }

    /// What a percentage is a percentage *of*, made explicit because "10% do quê"
    /// is a real and frequently-litigated question at a Brazilian table.
    enum Base: String, Codable, Sendable {
        /// Only what the person consumed. The default and the legally clean one.
        case consumption
        /// Consumption plus extras already applied (so a serviço listed after a
        /// couvert can include it, if the venue prints it that way).
        case consumptionPlusEarlierExtras
        /// Ignore consumption entirely and split evenly per head.
        case equalHeads
    }

    /// The 10% as Brazilian restaurants print it. Optional by construction.
    static func servico(bp: Int = 1000, enabled: Bool = true) -> Extra {
        Extra(label: "Serviço", kind: .percentage(bp: bp), base: .consumption,
              isEnabled: enabled, isGratuity: true)
    }

    static func couvert(_ amount: Cents, enabled: Bool = true) -> Extra {
        Extra(label: "Couvert", kind: .perHead(amount), base: .equalHeads, isEnabled: enabled)
    }
}
