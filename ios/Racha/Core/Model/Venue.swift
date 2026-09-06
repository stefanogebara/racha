import Foundation

/// The house. A racha is a table at a venue: the QR on the table names the venue
/// and the table, and every diner pays the venue their own part through the
/// PSP's split rules. Nothing about this struct is a person: the Pix key is the
/// restaurant's (its CNPJ or a key the PSP issued for it), never a waiter's and
/// never a friend's — CLAUDE.md non-negotiables #2 and #4.
struct Venue: Hashable, Codable, Sendable {
    /// Display name — "Bar do Zé".
    var name: String
    /// Legal name for the Pix payload, ≤ 25 chars per spec — "BAR DO ZE LTDA".
    var legalName: String
    /// City for the Pix payload, ≤ 15 chars — "SAO PAULO".
    var city: String
    /// The venue's Pix key. In production the PSP issues a cobrança per share and
    /// this is the fallback for a static code; in the demo it is the venue's key.
    var pixKey: String?
    /// The POS's own id for this check, when the table came from a scan. The
    /// key that makes a re-scan a merge instead of a second copy of dinner, and
    /// the reference the venue reconciles against.
    var checkID: String?
    /// The table as the venue labels it. Free text on purpose: `POST /api/tables`
    /// takes any `label`, and real venues use "Varanda 2", "Balcão", "12". A
    /// number here would quietly drop half of them.
    var label: String?

    /// How the table is named on screen. A bare number gets "Mesa" in front of
    /// it; anything the venue already spelled out is left alone.
    var tableLabel: String? {
        guard let label = label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty else { return nil }
        return label.allSatisfy(\.isNumber) ? "Mesa \(label)" : label
    }
}
