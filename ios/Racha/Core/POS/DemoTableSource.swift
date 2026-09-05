import Foundation

/// A check without a server.
///
/// The app has always run with no key and no network — that is what makes the
/// simulator and a pilot demo on a bad connection worth anything. This is the
/// same promise for the scanner: any Racha-shaped QR (and the demo token the
/// web app prints, `demoracha`) opens a real check that goes through the real
/// split engine. Only the source of the items is fictional.
struct DemoTableSource: TableSource {
    /// Deterministic per token, so scanning the same sticker twice in a demo
    /// gives the same table rather than a new random one.
    func openCheck(for qr: TableQR) async throws -> OpenCheck {
        // A beat, so the scanner's "lendo a mesa…" state is visible and the
        // demo doesn't look like it faked the read. It did, but honestly.
        try? await Task.sleep(for: .milliseconds(450))

        var rng = SplitMix64(seed: UInt64(abs(qr.token.folded.stableHash)))
        let houses = [
            ("Bar do Zé", "BAR DO ZE LTDA", "SAO PAULO"),
            ("Cantina da Vila", "CANTINA DA VILA LTDA", "SAO PAULO"),
            ("Choperia Central", "CHOPERIA CENTRAL LTDA", "SAO PAULO"),
            ("Peixaria do Porto", "PEIXARIA DO PORTO LTDA", "SANTOS")
        ]
        let house = houses[Int(rng.next() % UInt64(houses.count))]
        let menu: [(String, Int, Int)] = [
            ("Picanha na chapa", 1, 12900), ("Farofa da casa", 1, 2200),
            ("Vinagrete", 1, 1400), ("Chopp 500ml", 4, 1600),
            ("Caipirinha de limão", 2, 2400), ("Pudim", 1, 1800),
            ("Batata frita", 1, 3400), ("Linguiça na chapa", 1, 4200)
        ]
        let count = 4 + Int(rng.next() % 3)
        let items = menu.prefix(count).map { name, quantity, unit in
            LineItem(name: name, quantity: quantity, unitPrice: Cents(unit),
                     category: ItemCategorizer.guess(name))
        }
        let total = items.map(\.total).total
        return OpenCheck(
            venue: Venue(name: house.0, legalName: house.1, city: house.2,
                         pixKey: "pix@\(house.0.folded.filter(\.isLetter).lowercased()).com.br",
                         checkID: "demo-\(qr.token)",
                         label: String(1 + rng.next() % 30)),
            items: Array(items),
            totalCents: total,
            paidCents: .zero,
            servicoBP: 1000,
            checkID: "demo-\(qr.token)")
    }
}
