import Foundation

/// Where an open check comes from.
///
/// The iOS counterpart of `api/_lib/pos/adapter.js`: one interface, several
/// providers, callers provider-agnostic. The crucial difference from the server
/// adapters is **who holds the POS credentials**. Saipos' `idPartner`/`secret`
/// live in the server's environment and never leave it; the phone only ever
/// presents a table token it scanned off a sticker and receives a check. A
/// diner's phone with POS credentials on it would be one lost phone away from a
/// venue-wide incident.
///
/// So the provider list here is not "manual / saipos / colibri" — that choice is
/// the server's, per venue, behind `GET /api/check`. Here it is "where does this
/// build get a check": the backend, or a bundled demo.
protocol TableSource: Sendable {
    /// Fetch the open check for a scanned table.
    ///
    /// Throws `TableSourceError`; a nil return is not used, because "no check"
    /// and "could not ask" must never look the same to a person standing at a
    /// table with a phone in their hand.
    func openCheck(for qr: TableQR) async throws -> OpenCheck
}

/// A live check, in the app's own terms. Money is integer centavos across the
/// wire and stays integer here — `Cents` has no `Double` initialiser, so a
/// float can't enter through this door.
struct OpenCheck: Equatable, Sendable {
    var venue: Venue
    var items: [LineItem]
    /// The total the POS says. Kept alongside the items rather than derived,
    /// because a Brazilian check frequently disagrees with itself and the
    /// printed total is what the restaurant will actually charge.
    var totalCents: Cents
    /// What the house has already received on this check.
    var paidCents: Cents
    /// Serviço rate the venue charges, in basis points, when it publishes one.
    var servicoBP: Int?
    /// The check's own id, for reconciliation against the venue's ledger.
    var checkID: String

    /// True when the item rows don't reproduce the printed total. Surfaced, not
    /// silently corrected: the difference is the restaurant's to explain.
    var isInconsistent: Bool { items.map(\.total).total != totalCents }
}

enum TableSourceError: LocalizedError, Equatable {
    /// Scanned something that isn't a Racha table QR.
    case notATable
    /// Token was valid-looking but the server doesn't know it: rotated sticker,
    /// deactivated table, or a photo of an old QR.
    case tableNotFound
    /// The table has no open check — nobody has ordered yet.
    case noOpenCheck
    /// Reachable server, unusable answer. Carries the status for the log.
    case badResponse(status: Int)
    /// No network, or the server didn't answer in time.
    case unreachable

    var errorDescription: String? {
        switch self {
        case .notATable:
            return "Esse QR não é de uma mesa do Racha."
        case .tableNotFound:
            return "Essa mesa não está mais ativa. Peça o QR novo pro garçom."
        case .noOpenCheck:
            return "A mesa ainda não tem conta aberta. Peça pro garçom abrir."
        case .badResponse:
            return "A conta veio num formato que eu não sei ler. Tenta de novo?"
        case .unreachable:
            return "Não consegui falar com o servidor. Confere a internet?"
        }
    }
}
