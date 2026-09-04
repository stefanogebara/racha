import Foundation

/// A row on the receipt.
///
/// `quantity` and `unitPrice` are kept alongside `total` rather than derived,
/// because a Brazilian receipt frequently disagrees with itself (weighted items,
/// a manual discount on one row) and the printed total is the number the
/// restaurant will actually charge. When they conflict, `total` wins and the
/// discrepancy is surfaced — never silently recomputed.
struct LineItem: Identifiable, Hashable, Codable, Sendable {
    var id: UUID
    var name: String
    var quantity: Int
    var unitPrice: Cents
    var total: Cents
    /// What the app draws for this row. Inferred at parse time, correctable by the
    /// agent, and the key input to the image pipeline's style choice.
    var category: ItemCategory
    /// Verbatim text from the receipt, kept so a parse can always be audited
    /// against the paper.
    var rawText: String?

    init(id: UUID = UUID(), name: String, quantity: Int = 1,
         unitPrice: Cents, total: Cents? = nil,
         category: ItemCategory = .other, rawText: String? = nil) {
        self.id = id
        self.name = name
        self.quantity = max(1, quantity)
        self.unitPrice = unitPrice
        self.total = total ?? (unitPrice * max(1, quantity))
        self.category = category
        self.rawText = rawText
    }

    /// True when quantity × unit price doesn't reproduce the printed total. The UI
    /// flags these rows rather than hiding the difference.
    var isInconsistent: Bool { unitPrice * quantity != total }
}

/// Drives both the visual language and the agent's understanding of a row.
enum ItemCategory: String, Codable, CaseIterable, Sendable {
    case carne, peixe, massa, petisco, salada, acompanhamento, sobremesa
    case cerveja, drink, vinho, refrigerante, cafe, suco
    case couvert, servico, taxa
    case transporte, hospedagem, ingresso, mercado, combustivel, assinatura
    case other

    /// Which visual world this belongs to — see `ImageStyle`.
    var world: VisualWorld {
        switch self {
        case .carne, .peixe, .massa, .petisco, .salada, .acompanhamento, .sobremesa:
            return .plate
        case .cerveja, .drink, .vinho, .refrigerante, .cafe, .suco:
            return .glass
        case .transporte, .hospedagem, .ingresso, .mercado, .combustivel, .assinatura:
            return .object
        case .couvert, .servico, .taxa, .other:
            return .abstract
        }
    }

    var label: String {
        switch self {
        case .carne: return "Carne"
        case .peixe: return "Peixe"
        case .massa: return "Massa"
        case .petisco: return "Petisco"
        case .salada: return "Salada"
        case .acompanhamento: return "Acompanhamento"
        case .sobremesa: return "Sobremesa"
        case .cerveja: return "Cerveja"
        case .drink: return "Drink"
        case .vinho: return "Vinho"
        case .refrigerante: return "Refrigerante"
        case .cafe: return "Café"
        case .suco: return "Suco"
        case .couvert: return "Couvert"
        case .servico: return "Serviço"
        case .taxa: return "Taxa"
        case .transporte: return "Transporte"
        case .hospedagem: return "Hospedagem"
        case .ingresso: return "Ingresso"
        case .mercado: return "Mercado"
        case .combustivel: return "Combustível"
        case .assinatura: return "Assinatura"
        case .other: return "Outro"
        }
    }
}

/// Who claimed an item, and how much of it.
///
/// `weight` is what makes "o Pedro tomou dois chopps dos quatro" expressible
/// without splitting the row: weights 2 and 1 and 1 across three claimants.
struct Claim: Identifiable, Hashable, Codable, Sendable {
    var id: UUID
    var itemID: LineItem.ID
    var personID: Participant.ID
    var weight: Int

    init(id: UUID = UUID(), itemID: LineItem.ID, personID: Participant.ID, weight: Int = 1) {
        self.id = id
        self.itemID = itemID
        self.personID = personID
        self.weight = max(1, weight)
    }
}
