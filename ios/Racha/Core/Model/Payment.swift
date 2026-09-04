import Foundation

/// Money that actually moved — someone put a card down, someone sent a Pix.
///
/// Payments are recorded as events like everything else, and `isConfirmed`
/// distinguishes "I said I'd pay" from "it cleared". Balances only count
/// confirmed money, so an optimistic tap never makes a debt disappear.
struct Payment: Identifiable, Hashable, Codable, Sendable {
    var id: UUID
    var payerID: Participant.ID
    var amount: Cents
    var method: Method
    var note: String?
    var confirmedAt: Date?
    var createdAt: Date

    var isConfirmed: Bool { confirmedAt != nil }

    enum Method: String, Codable, Sendable, CaseIterable {
        case pix, cartao, dinheiro, transferencia, outro

        var label: String {
            switch self {
            case .pix: return "Pix"
            case .cartao: return "Cartão"
            case .dinheiro: return "Dinheiro"
            case .transferencia: return "Transferência"
            case .outro: return "Outro"
            }
        }

        var symbol: String {
            switch self {
            case .pix: return "bolt.horizontal.circle.fill"
            case .cartao: return "creditcard.fill"
            case .dinheiro: return "banknote.fill"
            case .transferencia: return "arrow.left.arrow.right.circle.fill"
            case .outro: return "circle.dashed"
            }
        }
    }

    init(id: UUID = UUID(), payerID: Participant.ID, amount: Cents,
         method: Method = .pix, note: String? = nil,
         confirmedAt: Date? = nil, createdAt: Date = Date()) {
        self.id = id
        self.payerID = payerID
        self.amount = amount
        self.method = method
        self.note = note
        self.confirmedAt = confirmedAt
        self.createdAt = createdAt
    }
}
