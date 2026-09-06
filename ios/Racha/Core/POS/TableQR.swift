import Foundation

/// What the QR sticker on the table actually carries.
///
/// The web app prints `<origin>/?t=<qr_token>` (`apps/web/src/Qrs.tsx`), so the
/// scanner has to accept that URL — and, because a camera in a bar reads
/// whatever is in frame, reject everything else clearly rather than guessing.
///
/// The token is a **rotating** secret: `POST /api/tables/rotate` replaces it and
/// the old one goes dead. That is the whole security model of pay-at-table —
/// possession of the sticker is what proves you are sitting there — so the token
/// is treated as a credential: never logged, never persisted in the event log,
/// never shown in the UI.
struct TableQR: Equatable, Sendable {
    /// The opaque table token. Credential: keep it out of logs and events.
    let token: String
    /// Where the check lives. Taken from the QR's own origin, so a venue on a
    /// white-label domain works without a client release.
    let origin: URL

    /// Parse a scanned string. Accepts the printed URL form; a bare token is
    /// accepted only with an explicit fallback origin, which is what the
    /// "type the code" path passes.
    static func parse(_ scanned: String, defaultOrigin: URL? = nil) -> TableQR? {
        let trimmed = scanned.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
           scheme == "https" || scheme == "http" {
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let token = components.queryItems?.first(where: { $0.name == "t" })?.value,
                  isPlausibleToken(token) else { return nil }
            var originComponents = URLComponents()
            originComponents.scheme = components.scheme
            originComponents.host = components.host
            originComponents.port = components.port
            guard let origin = originComponents.url else { return nil }
            return TableQR(token: token, origin: origin)
        }

        // Not a URL: the manual-entry path, where the origin is the app's own.
        guard let defaultOrigin, isPlausibleToken(trimmed) else { return nil }
        return TableQR(token: trimmed, origin: defaultOrigin)
    }

    /// A cheap shape check so an unrelated QR (a wifi code, a Pix code, a
    /// business card) fails here instead of costing a network round trip.
    static func isPlausibleToken(_ token: String) -> Bool {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        return (4...128).contains(token.count)
            && token.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}
