import Foundation

/// Four tables on first launch.
///
/// Not a tutorial — a populated app. Someone opening Racha for the first time
/// should see the product's shape before they type anything: one table open
/// right now, with a part to pay and people who have not paid yet, and three
/// tables before it, closed, each one paid to the house by everyone at it.
///
/// Every number here goes through the same engine as real money. The seed cannot
/// contain an unbalanced split, because the projection would flag it.
enum SeedData {

    @MainActor
    static func install(into repository: RachaRepository) async {
        await seedCantina(repository)
        await seedChoperia(repository)
        await seedPeixaria(repository)
        await seedBarDoZe(repository)      // last, so it is the most recent: the table you are at
    }

    // MARK: The table you are at — Bar do Zé, mesa 12

    @MainActor
    private static func seedBarDoZe(_ repo: RachaRepository) async {
        guard let id = try? await repo.createRacha(title: "Bar do Zé", kind: .jantar, meName: "Você") else { return }
        let gui = Participant(name: "Gui")
        let ju = Participant(name: "Ju")
        let pedro = Participant(name: "Pedro")
        await add(repo, id, [
            (.venueSet(Venue(name: "Bar do Zé", legalName: "BAR DO ZE LTDA", city: "SAO PAULO",
                             pixKey: "pix@bardoze.com.br", table: 12)), "Mesa 12 do Bar do Zé"),
            (.participantAdded(gui), "Gui sentou"),
            (.participantAdded(ju), "Ju sentou"),
            (.participantAdded(pedro), "Pedro sentou")
        ])

        let picanha = LineItem(name: "Picanha na chapa", quantity: 1, unitPrice: Cents(12900), category: .carne)
        let farofa = LineItem(name: "Farofa da casa", quantity: 1, unitPrice: Cents(2200), category: .acompanhamento)
        let vinagrete = LineItem(name: "Vinagrete", quantity: 1, unitPrice: Cents(1400), category: .acompanhamento)
        let chopp = LineItem(name: "Chopp 500ml", quantity: 4, unitPrice: Cents(1600), category: .cerveja)
        let caipirinha = LineItem(name: "Caipirinha de limão", quantity: 2, unitPrice: Cents(2400), category: .drink)
        let pudim = LineItem(name: "Pudim", quantity: 1, unitPrice: Cents(1800), category: .sobremesa)

        await add(repo, id, [
            (.itemsAdded([picanha, farofa, vinagrete, chopp, caipirinha, pudim]), "6 itens da comanda"),
            (.extraAdded(Extra.servico()), "Serviço 10% da casa"),
            (.extraAdded(Extra.couvert(Cents(1200))), "Couvert R$ 12,00 por pessoa")
        ])

        let trio = [repo.meID, gui.id, ju.id]
        for item in [picanha, farofa, vinagrete] {
            await add(repo, id, [(.claimsSet(itemID: item.id,
                                             claims: trio.map { Claim(itemID: item.id, personID: $0) }),
                                  "\(item.name): você, Gui e Ju")])
        }
        // Pedro arrived late and only drank — the exact case from the brief.
        await add(repo, id, [
            (.claimsSet(itemID: chopp.id, claims: [
                Claim(itemID: chopp.id, personID: gui.id, weight: 2),
                Claim(itemID: chopp.id, personID: pedro.id, weight: 1),
                Claim(itemID: chopp.id, personID: repo.meID, weight: 1)
            ]), "Chopp: Gui ×2, Pedro e você"),
            (.claimsSet(itemID: caipirinha.id, claims: [
                Claim(itemID: caipirinha.id, personID: ju.id),
                Claim(itemID: caipirinha.id, personID: pedro.id)
            ]), "Caipirinha: Ju e Pedro")
        ])
        // The pudim is left unclaimed on purpose: the "sem dono" state and the
        // thread's opening question both need a real case to point at.

        // Ju has already paid the house her part; you, Gui and Pedro have not.
        guard let state = repo.state(id) else { return }
        let juPart = state.share(of: ju.id)
        await add(repo, id, [
            (.paymentRecorded(Payment(payerID: ju.id, amount: juPart, method: .pix,
                                      note: "Pix pra casa", confirmedAt: Date())),
             "Ju pagou \(BRL.format(juPart))")
        ])
    }

    // MARK: Closed tables — everyone paid the house their own part

    @MainActor
    private static func seedCantina(_ repo: RachaRepository) async {
        guard let id = try? await repo.createRacha(title: "Cantina da Vila", kind: .jantar, meName: "Você") else { return }
        let ju = Participant(name: "Ju")
        await add(repo, id, [
            (.venueSet(Venue(name: "Cantina da Vila", legalName: "CANTINA DA VILA LTDA", city: "SAO PAULO",
                             pixKey: "financeiro@cantinadavila.com.br", table: 4)), "Mesa 4 da Cantina da Vila"),
            (.participantAdded(ju), "Ju sentou")
        ])
        let file = LineItem(name: "Filé à parmegiana", quantity: 2, unitPrice: Cents(7900), category: .carne)
        let salada = LineItem(name: "Salada da casa", quantity: 1, unitPrice: Cents(2900), category: .salada)
        let chopp = LineItem(name: "Chopp 300ml", quantity: 3, unitPrice: Cents(1200), category: .cerveja)
        let pudim = LineItem(name: "Pudim", quantity: 1, unitPrice: Cents(1600), category: .sobremesa)
        await add(repo, id, [
            (.itemsAdded([file, salada, chopp, pudim]), "4 itens da comanda"),
            (.extraAdded(Extra.servico()), "Serviço 10% da casa")
        ])
        let both = [repo.meID, ju.id]
        await add(repo, id, [
            (.claimsSet(itemID: file.id, claims: both.map { Claim(itemID: file.id, personID: $0) }), "Filé: você e Ju"),
            (.claimsSet(itemID: salada.id, claims: both.map { Claim(itemID: salada.id, personID: $0) }), "Salada: você e Ju"),
            (.claimsSet(itemID: chopp.id, claims: [Claim(itemID: chopp.id, personID: repo.meID, weight: 2),
                                                   Claim(itemID: chopp.id, personID: ju.id, weight: 1)]), "Chopp: você ×2 e Ju"),
            (.claimsSet(itemID: pudim.id, claims: [Claim(itemID: pudim.id, personID: ju.id)]), "Pudim: Ju")
        ])
        await closeTable(repo, id, daysAgo: 6)
    }

    @MainActor
    private static func seedChoperia(_ repo: RachaRepository) async {
        guard let id = try? await repo.createRacha(title: "Choperia Central", kind: .jantar, meName: "Você") else { return }
        let gui = Participant(name: "Gui")
        let pedro = Participant(name: "Pedro")
        await add(repo, id, [
            (.venueSet(Venue(name: "Choperia Central", legalName: "CHOPERIA CENTRAL LTDA", city: "SAO PAULO",
                             pixKey: "pix@choperiacentral.com.br", table: 22)), "Mesa 22 da Choperia Central"),
            (.participantAdded(gui), "Gui sentou"),
            (.participantAdded(pedro), "Pedro sentou")
        ])
        let chopp = LineItem(name: "Chopp 500ml", quantity: 6, unitPrice: Cents(1600), category: .cerveja)
        let linguica = LineItem(name: "Linguiça na chapa", quantity: 1, unitPrice: Cents(4200), category: .petisco)
        let batata = LineItem(name: "Batata frita", quantity: 1, unitPrice: Cents(3400), category: .petisco)
        let caipirinha = LineItem(name: "Caipirinha de limão", quantity: 2, unitPrice: Cents(2400), category: .drink)
        await add(repo, id, [
            (.itemsAdded([chopp, linguica, batata, caipirinha]), "4 itens da comanda"),
            (.extraAdded(Extra.servico()), "Serviço 10% da casa")
        ])
        let all = [repo.meID, gui.id, pedro.id]
        await add(repo, id, [
            (.claimsSet(itemID: chopp.id, claims: [Claim(itemID: chopp.id, personID: gui.id, weight: 3),
                                                   Claim(itemID: chopp.id, personID: pedro.id, weight: 2),
                                                   Claim(itemID: chopp.id, personID: repo.meID, weight: 1)]), "Chopp: Gui ×3, Pedro ×2 e você"),
            (.claimsSet(itemID: linguica.id, claims: all.map { Claim(itemID: linguica.id, personID: $0) }), "Linguiça: todo mundo"),
            (.claimsSet(itemID: batata.id, claims: all.map { Claim(itemID: batata.id, personID: $0) }), "Batata: todo mundo"),
            (.claimsSet(itemID: caipirinha.id, claims: [Claim(itemID: caipirinha.id, personID: repo.meID),
                                                        Claim(itemID: caipirinha.id, personID: pedro.id)]), "Caipirinha: você e Pedro")
        ])
        await closeTable(repo, id, daysAgo: 12)
    }

    @MainActor
    private static func seedPeixaria(_ repo: RachaRepository) async {
        guard let id = try? await repo.createRacha(title: "Peixaria do Porto", kind: .jantar, meName: "Você") else { return }
        let ju = Participant(name: "Ju")
        let gui = Participant(name: "Gui")
        let pedro = Participant(name: "Pedro")
        await add(repo, id, [
            (.venueSet(Venue(name: "Peixaria do Porto", legalName: "PEIXARIA DO PORTO LTDA", city: "SANTOS",
                             pixKey: "pix@peixariadoporto.com.br", table: 7)), "Mesa 7 da Peixaria do Porto"),
            (.participantAdded(ju), "Ju sentou"),
            (.participantAdded(gui), "Gui sentou"),
            (.participantAdded(pedro), "Pedro sentou")
        ])
        let peixe = LineItem(name: "Peixe na brasa", quantity: 2, unitPrice: Cents(8200), category: .peixe)
        let farofa = LineItem(name: "Farofa de dendê", quantity: 1, unitPrice: Cents(1800), category: .acompanhamento)
        let caipirinha = LineItem(name: "Caipirinha de caju", quantity: 3, unitPrice: Cents(2400), category: .drink)
        let cerveja = LineItem(name: "Cerveja 600ml", quantity: 4, unitPrice: Cents(1500), category: .cerveja)
        await add(repo, id, [
            (.itemsAdded([peixe, farofa, caipirinha, cerveja]), "4 itens da comanda"),
            (.extraAdded(Extra.servico()), "Serviço 10% da casa"),
            (.extraAdded(Extra.couvert(Cents(800))), "Couvert R$ 8,00 por pessoa")
        ])
        let all = [repo.meID, ju.id, gui.id, pedro.id]
        await add(repo, id, [
            (.claimsSet(itemID: peixe.id, claims: all.map { Claim(itemID: peixe.id, personID: $0) }), "Peixe: todo mundo"),
            (.claimsSet(itemID: farofa.id, claims: all.map { Claim(itemID: farofa.id, personID: $0) }), "Farofa: todo mundo"),
            (.claimsSet(itemID: caipirinha.id, claims: [repo.meID, gui.id, pedro.id].map { Claim(itemID: caipirinha.id, personID: $0) }), "Caipirinha: você, Gui e Pedro"),
            (.claimsSet(itemID: cerveja.id, claims: [Claim(itemID: cerveja.id, personID: gui.id, weight: 2),
                                                     Claim(itemID: cerveja.id, personID: pedro.id, weight: 2)]), "Cerveja: Gui ×2 e Pedro ×2")
        ])
        await closeTable(repo, id, daysAgo: 20)
    }

    // MARK: Helpers

    /// Everyone pays the house their own part, and the table closes. This is the
    /// only way a table closes in the product: the house has all of it.
    @MainActor
    private static func closeTable(_ repo: RachaRepository, _ id: UUID, daysAgo: Double) async {
        guard let state = repo.state(id) else { return }
        let when = Date().addingTimeInterval(-86_400 * daysAgo)
        for share in state.split.shares where !share.total.isZero {
            let who = state.participant(share.personID)?.shortName ?? "alguém"
            await add(repo, id, [
                (.paymentRecorded(Payment(payerID: share.personID, amount: share.total, method: .pix,
                                          note: "Pix pra casa", confirmedAt: when)),
                 "\(who) pagou \(BRL.format(share.total))")
            ])
        }
        await add(repo, id, [(.settled(at: when), "Mesa fechada")])
    }

    @MainActor
    private static func add(_ repo: RachaRepository, _ id: UUID,
                            _ entries: [(RachaEvent.Body, String)]) async {
        _ = try? await repo.appendBatch(id, entries, origin: .system)
    }
}
