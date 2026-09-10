import Foundation

/// The real source: Racha's own backend, which owns the POS integration.
///
/// One call, `GET /api/check?t=<token>`, against the origin printed on the QR.
/// The server resolves the venue's POS adapter (manual, Saipos, …), pulls the
/// live check, and answers in one shape — so a venue switching POS never needs
/// an app release.
///
/// Decoding is deliberately strict about money and tolerant about everything
/// else. A missing `name` on a row costs a placeholder; a `priceCents` that is
/// not an integer is a hard failure, because guessing at a price is how someone
/// gets charged the wrong amount.
struct BackendTableSource: TableSource {
    var session: URLSession = .shared
    /// A person is standing at a table waiting. Better a clear failure than a
    /// spinner that never resolves.
    var timeout: TimeInterval = 12

    func openCheck(for qr: TableQR) async throws -> OpenCheck {
        // A ÚLTIMA porta antes do pacote sair do aparelho.
        //
        // O `TableQR.parse` já garante isto, e é de propósito que esteja aqui de
        // novo: a garantia foi escrita uma vez, entrou num ramo da função e não
        // no outro, e a frase que descrevia o guarda ficou mais larga que o
        // guarda. Esta camada é a que sobrevive a um `TableQR` construído por um
        // caminho que ainda não existe.
        guard TableQR.isAllowedOrigin(qr.origin) else { throw TableSourceError.notATable }
        var components = URLComponents(url: qr.origin.appendingPathComponent("api/check"),
                                       resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "t", value: qr.token)]
        guard let url = components?.url else { throw TableSourceError.notATable }

        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // The token travels in the query because that is the contract the web
        // diner already uses; it is a bearer credential either way, which is why
        // nothing below ever puts `url` or `qr.token` into a log line.

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw TableSourceError.unreachable
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 404 { throw TableSourceError.tableNotFound }
        guard (200..<300).contains(status) else { throw TableSourceError.badResponse(status: status) }

        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              root["success"] as? Bool == true,
              let payload = root["data"] as? [String: Any] else {
            throw TableSourceError.badResponse(status: status)
        }
        return try Self.decode(payload)
    }

    /// Map the server's check view into the app's model. Pure and static, so the
    /// contract can be tested without a network.
    static func decode(_ payload: [String: Any]) throws -> OpenCheck {
        let venueJSON = payload["venue"] as? [String: Any] ?? [:]
        let tableJSON = payload["table"] as? [String: Any] ?? [:]
        let checkJSON = payload["check"] as? [String: Any] ?? [:]
        let stateJSON = payload["state"] as? [String: Any] ?? [:]

        guard let checkID = checkJSON["id"] as? String, !checkID.isEmpty else {
            throw TableSourceError.noOpenCheck
        }

        let name = (venueJSON["name"] as? String)?.trimmed ?? "A casa"
        let label = (tableJSON["label"] as? String)?.trimmed
        let venue = Venue(name: name,
                          legalName: PixPayload.ascii(name, max: 25),
                          city: (venueJSON["city"] as? String)?.trimmed ?? "SAO PAULO",
                          // The house's Pix arrives with the payment intent, not
                          // with the check: the PSP issues a cobrança per share.
                          pixKey: venueJSON["pixKey"] as? String,
                          checkID: checkID,
                          label: label)

        let rows = checkJSON["items"] as? [[String: Any]] ?? []
        let items: [LineItem] = try rows.enumerated().map { index, row in
            guard let priceCents = row["priceCents"] as? Int else {
                // A price that is not an integer number of centavos is the one
                // thing worth refusing outright.
                throw TableSourceError.badResponse(status: 200)
            }
            let rawName = (row["name"] as? String)?.trimmed ?? ""
            let name = rawName.isEmpty ? "Item \(index + 1)" : rawName
            let (base, quantity) = Self.splitQuantitySuffix(name)
            return LineItem(name: base,
                            quantity: quantity,
                            unitPrice: Cents(quantity > 1 ? priceCents / quantity : priceCents),
                            total: Cents(priceCents),
                            category: ItemCategorizer.guess(base),
                            rawText: rawName)
        }

        guard let totalCents = stateJSON["totalCents"] as? Int else {
            throw TableSourceError.badResponse(status: 200)
        }
        return OpenCheck(venue: venue,
                         items: items,
                         totalCents: Cents(totalCents),
                         paidCents: Cents(stateJSON["paidCents"] as? Int ?? 0),
                         servicoBP: venueJSON["servicoBp"] as? Int,
                         checkID: checkID)
    }

    /// The Saipos adapter folds quantity into the name — `"Chopp 500ml (4x)"`
    /// (`api/_lib/pos/saipos.js`). Unfold it, so the split engine can weight a
    /// row ("dois dos quatro chopps") instead of treating four beers as one
    /// indivisible line.
    static func splitQuantitySuffix(_ name: String) -> (String, Int) {
        guard name.hasSuffix(")"),
              let open = name.lastIndex(of: "("),
              case let inside = name[name.index(after: open)..<name.index(before: name.endIndex)],
              inside.hasSuffix("x") || inside.hasSuffix("X"),
              case let digits = inside.dropLast(),
              !digits.isEmpty, digits.allSatisfy(\.isNumber),
              let quantity = Int(digits), quantity > 1 else {
            return (name, 1)
        }
        return (String(name[name.startIndex..<open]).trimmed, quantity)
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
