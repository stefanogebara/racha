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
    /// Where the check lives. Taken from the QR's own origin — but only from an
    /// origin we already know. See `allowedHosts`.
    let origin: URL

    /// The hosts a scanned sticker is allowed to name.
    ///
    /// This used to be "any https or http origin", so a venue on a white-label
    /// domain would work without a client release. That convenience is a
    /// payment-redirection primitive: a sticker pasted over a real table's QR,
    /// encoding `https://attacker.example/?t=anything`, points the app at
    /// someone else's server and the app renders the response as a Racha bill —
    /// their amounts, their Pix key, our chrome. It is the ordinary Brazilian
    /// QR-sticker fraud, with the native client removing the one defence a
    /// browser gives: a visible address bar. `http` was accepted too.
    ///
    /// White-label stays possible; it just stops being self-service for whoever
    /// holds a printer. The next step is fetching onboarded domains from our own
    /// API and merging them here — until then the list is what ships.
    /// Found by the security review of 2026-09-10.
    static let allowedHosts: Set<String> = ["racha.app", "www.racha.app", "racha-gray.vercel.app"]

    /// Parse a scanned string. Accepts the printed URL form; a bare token is
    /// accepted only with an explicit fallback origin, which is what the
    /// "type the code" path passes.
    static func parse(_ scanned: String, defaultOrigin: URL? = nil) -> TableQR? {
        let trimmed = scanned.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // `https` only: plaintext would let anyone on the café wifi rewrite the
        // bill on the way to the phone.
        if let url = URL(string: trimmed), url.scheme?.lowercased() == "https" {
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let host = components.host?.lowercased(),
                  allowedHosts.contains(host),
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
