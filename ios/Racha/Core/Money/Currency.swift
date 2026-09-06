import Foundation

/// A currency the app can hold money in. Trips need this; a churrasco does not.
///
/// `exponent` is the number of minor units per major unit as a power of ten, so
/// `Cents.raw` stays the *minor* unit in every currency: 100 for BRL/USD/EUR,
/// 0 for JPY (no subunit), 3 for a handful of dinar-class currencies. Formatting
/// and parsing both read it, which is why ¥500 never renders as ¥5,00.
struct Currency: Hashable, Codable, Sendable, Identifiable {
    var code: String          // ISO 4217, uppercased
    var symbol: String
    var exponent: Int

    var id: String { code }

    init(code: String, symbol: String, exponent: Int = 2) {
        self.code = code.uppercased()
        self.symbol = symbol
        self.exponent = exponent
    }

    static let brl = Currency(code: "BRL", symbol: "R$")
    static let usd = Currency(code: "USD", symbol: "$")
    static let eur = Currency(code: "EUR", symbol: "€")
    static let gbp = Currency(code: "GBP", symbol: "£")
    static let ars = Currency(code: "ARS", symbol: "$")
    static let clp = Currency(code: "CLP", symbol: "$", exponent: 0)
    static let uyu = Currency(code: "UYU", symbol: "$U")
    static let pyg = Currency(code: "PYG", symbol: "₲", exponent: 0)
    static let jpy = Currency(code: "JPY", symbol: "¥", exponent: 0)
    static let mxn = Currency(code: "MXN", symbol: "$")

    static let known: [Currency] = [.brl, .usd, .eur, .gbp, .ars, .clp, .uyu, .pyg, .jpy, .mxn]

    static func named(_ code: String) -> Currency {
        let up = code.uppercased()
        return known.first { $0.code == up } ?? Currency(code: up, symbol: up)
    }

    /// 10^exponent — the number of minor units in one major unit.
    var minorPerMajor: Int {
        (0..<exponent).reduce(1) { acc, _ in acc * 10 }
    }
}

/// A frozen FX rate attached to a racha, expressed in integer micro-units so the
/// conversion itself never touches a `Double`.
///
/// `microsPerUnit` = how many millionths of the *home* currency one unit of the
/// foreign currency buys. 1 EUR = R$ 6,2135 → 6_213_500.
///
/// Why freeze it: a trip's ledger must not silently re-price itself when the
/// market moves overnight. The rate that was true when the expense was entered is
/// the rate the ledger keeps, and it is shown next to every converted amount.
struct FXRate: Hashable, Codable, Sendable {
    var from: String            // foreign currency code
    var to: String              // home currency code
    var microsPerUnit: Int
    var capturedAt: Date

    /// Convert a minor-unit amount in `from` to a minor-unit amount in `to`,
    /// half-up, with exponent correction. Pure integer math throughout.
    func convert(_ amount: Cents, fromExponent: Int, toExponent: Int) -> Cents {
        // amount is in 10^-fromExponent units of `from`.
        // value_to = amount * microsPerUnit / 10^6, in 10^-fromExponent units of `to`.
        // Then rescale fromExponent -> toExponent.
        let numeratorScale = pow10(Swift.max(0, toExponent - fromExponent))
        let denominatorScale = pow10(Swift.max(0, fromExponent - toExponent))
        let numerator = amount.raw * microsPerUnit * numeratorScale
        let denominator = 1_000_000 * denominatorScale
        return Cents(roundHalfUpDiv(numerator, denominator))
    }

    private func pow10(_ n: Int) -> Int { (0..<n).reduce(1) { acc, _ in acc * 10 } }
}

/// Half-up integer division that behaves symmetrically around zero.
/// `roundHalfUpDiv(5, 10) == 1`, `roundHalfUpDiv(-5, 10) == -1`.
@inlinable
func roundHalfUpDiv(_ numerator: Int, _ denominator: Int) -> Int {
    precondition(denominator > 0, "denominator must be positive")
    if numerator >= 0 {
        return (numerator * 2 + denominator) / (denominator * 2)
    } else {
        return -((-numerator * 2 + denominator) / (denominator * 2))
    }
}
