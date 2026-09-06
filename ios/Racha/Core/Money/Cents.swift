import Foundation

/// Integer centavos. The only money type in the app.
///
/// Non-negotiable #5 from CLAUDE.md: **no floats, anywhere, ever.** `Cents` is a
/// distinct type rather than a `typealias Int` so that a `Double` can never be
/// silently coerced into a money position — the compiler is the first reviewer.
///
/// Mirrors `api/_lib/checks/split-engine.js` semantics, including the
/// `assertCents` guard (safe non-negative integer) at every boundary that the
/// backend guards.
struct Cents: Hashable, Comparable, Codable, Sendable {
    /// The raw signed value in the smallest unit of the currency (centavos for BRL,
    /// cents for USD/EUR, yen for JPY — see `Currency.exponent`).
    var raw: Int

    init(_ raw: Int) { self.raw = raw }

    static let zero = Cents(0)

    // MARK: Arithmetic
    //
    // Deliberately no `/` by another `Cents` and no `*` by a `Double`. Division of
    // money is *allocation*, and allocation lives in `Allocation.swift` where the
    // remainder is named and accounted for. Making the lossy operation unavailable
    // is what keeps "every cent accounted for" true by construction rather than by
    // discipline.

    static func + (a: Cents, b: Cents) -> Cents { Cents(a.raw + b.raw) }
    static func - (a: Cents, b: Cents) -> Cents { Cents(a.raw - b.raw) }
    static func * (a: Cents, k: Int) -> Cents { Cents(a.raw * k) }
    static func * (k: Int, a: Cents) -> Cents { Cents(a.raw * k) }
    static prefix func - (a: Cents) -> Cents { Cents(-a.raw) }
    static func += (a: inout Cents, b: Cents) { a = a + b }
    static func -= (a: inout Cents, b: Cents) { a = a - b }
    static func < (a: Cents, b: Cents) -> Bool { a.raw < b.raw }

    var isZero: Bool { raw == 0 }
    var isNegative: Bool { raw < 0 }
    var magnitude: Cents { Cents(abs(raw)) }
    var signum: Int { raw == 0 ? 0 : (raw > 0 ? 1 : -1) }

    /// Clamped at zero. Used where a negative amount is meaningless (a share of a
    /// bill, a base for serviço) rather than merely unexpected.
    var clampedNonNegative: Cents { Cents(Swift.max(0, raw)) }

    // MARK: Codable — encode as a bare integer, never as an object or a float.

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        raw = try c.decode(Int.self)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(raw)
    }
}

extension Cents {
    /// Sum without a lossy intermediate. `reduce(.zero, +)` spelled once.
    static func sum<S: Sequence>(_ xs: S) -> Cents where S.Element == Cents {
        xs.reduce(Cents.zero) { $0 + $1 }
    }
}

extension Sequence where Element == Cents {
    var total: Cents { Cents.sum(self) }
}

/// Precondition mirroring the backend's `assertCents`: safe, non-negative.
/// Trips in debug; in release the caller's `clampedNonNegative` keeps money readable.
func assertCents(_ v: Cents, _ name: @autoclosure () -> String) {
    assert(v.raw >= 0, "\(name()) must be non-negative centavos, got \(v.raw)")
}
