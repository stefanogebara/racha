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
    /// Table number as printed on the QR, when there is one.
    var table: Int?

    var tableLabel: String? { table.map { "Mesa \($0)" } }
}
