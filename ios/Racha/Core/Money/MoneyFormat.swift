import Foundation

/// pt-BR money formatting and parsing, integer-in / integer-out.
///
/// Mirrors `apps/web/src/api.ts` (`brl`, `parseBrlToCents`) so the phone and the
/// web app read a bill the same way. Notably: parsing goes text → `Cents`
/// directly. There is no `Double` in the middle, which is the usual place a
/// centavo goes missing ("47.55" → 47.549999999999997 → 4754).
enum BRL {
    /// R$ 1.234,56 — non-breaking space after the symbol, as Brazilian typography
    /// wants, so the amount never wraps away from its currency.
    static func format(_ cents: Cents, symbol: Bool = true) -> String {
        format(cents, currency: .brl, symbol: symbol)
    }

    static func format(_ cents: Cents, currency: Currency, symbol: Bool = true) -> String {
        let negative = cents.raw < 0
        let magnitude = abs(cents.raw)
        let divisor = currency.minorPerMajor
        let whole = divisor == 1 ? magnitude : magnitude / divisor
        let frac = divisor == 1 ? 0 : magnitude % divisor

        var digits = String(whole)
        // Thousands separators, inserted by hand: NumberFormatter would route the
        // value through a Double on the way in.
        if digits.count > 3 {
            var grouped: [Character] = []
            for (i, ch) in digits.reversed().enumerated() {
                if i > 0 && i % 3 == 0 { grouped.append(".") }
                grouped.append(ch)
            }
            digits = String(grouped.reversed())
        }

        let body = currency.exponent == 0
            ? digits
            : digits + "," + String(format: "%0\(currency.exponent)d", frac)

        let sign = negative ? "−" : ""
        return symbol ? "\(sign)\(currency.symbol)\u{00A0}\(body)" : "\(sign)\(body)"
    }

    /// Compact form for dense surfaces (timeline cards): "R$ 1,2 mil".
    static func compact(_ cents: Cents, currency: Currency = .brl) -> String {
        let major = abs(cents.raw) / max(1, currency.minorPerMajor)
        guard major >= 1000 else { return format(cents, currency: currency) }
        let thousands = major / 1000
        let tenths = (major % 1000) / 100
        let sign = cents.raw < 0 ? "−" : ""
        let body = tenths == 0 ? "\(thousands)" : "\(thousands),\(tenths)"
        return "\(sign)\(currency.symbol)\u{00A0}\(body) mil"
    }

    /// Text → cents. Accepts the shapes a person actually types or pastes:
    /// "47,50", "R$ 47.50", "1.234,56", "1,234.56", "47", "47.5".
    ///
    /// The ambiguous case is a lone separator with exactly three digits after it —
    /// "1.234" is one thousand two hundred and thirty-four reais in Brazil, not
    /// R$ 1,23. That reading is applied only to `.`, because a Brazilian typing a
    /// comma means decimals.
    static func parse(_ text: String, currency: Currency = .brl) -> Cents? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let negative = trimmed.hasPrefix("-") || trimmed.hasPrefix("−")
        let cleaned = trimmed.filter { $0.isNumber || $0 == "." || $0 == "," }
        guard cleaned.contains(where: \.isNumber) else { return nil }

        let hasDot = cleaned.contains("."), hasComma = cleaned.contains(",")
        var wholePart = "", fracPart = ""

        if hasDot && hasComma {
            // Whichever separator comes last is the decimal one.
            let lastDot = cleaned.lastIndex(of: ".")!
            let lastComma = cleaned.lastIndex(of: ",")!
            let decimalSep: Character = lastComma > lastDot ? "," : "."
            let parts = cleaned.split(separator: decimalSep, omittingEmptySubsequences: false)
            guard parts.count == 2 else { return nil }
            wholePart = parts[0].filter(\.isNumber)
            fracPart = parts[1].filter(\.isNumber)
        } else if hasComma {
            let parts = cleaned.split(separator: ",", omittingEmptySubsequences: false)
            guard parts.count == 2 else { return nil }
            wholePart = String(parts[0]); fracPart = String(parts[1])
        } else if hasDot {
            let parts = cleaned.split(separator: ".", omittingEmptySubsequences: false)
            if parts.count > 2 || (parts.count == 2 && parts[1].count == 3) {
                wholePart = cleaned.filter(\.isNumber)   // thousands grouping
            } else if parts.count == 2 {
                wholePart = String(parts[0]); fracPart = String(parts[1])
            } else {
                wholePart = cleaned
            }
        } else {
            wholePart = cleaned
        }

        guard currency.exponent > 0 else {
            guard let whole = Int(wholePart.isEmpty ? "0" : wholePart) else { return nil }
            return Cents(negative ? -whole : whole)
        }

        // Pad or truncate the fraction to the currency's exponent, half-up on the
        // digit that falls off, so "47,999" on a 2-exponent currency is R$ 48,00.
        var frac = fracPart
        var carry = 0
        if frac.count > currency.exponent {
            let keepIndex = frac.index(frac.startIndex, offsetBy: currency.exponent)
            let dropped = frac[keepIndex]
            frac = String(frac[frac.startIndex..<keepIndex])
            if let d = dropped.wholeNumberValue, d >= 5 { carry = 1 }
        } else {
            frac += String(repeating: "0", count: currency.exponent - frac.count)
        }

        guard let whole = Int(wholePart.isEmpty ? "0" : wholePart),
              let fraction = Int(frac.isEmpty ? "0" : frac) else { return nil }
        let value = whole * currency.minorPerMajor + fraction + carry
        return Cents(negative ? -value : value)
    }
}
