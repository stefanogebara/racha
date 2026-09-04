import Foundation

/// Three rachas on first launch.
///
/// Not a tutorial — a populated app. Someone opening Racha for the first time
/// should see the timeline working, with a settled one, an open one, and a trip
/// in another currency, so the shape of the product is obvious before they type
/// anything. It is also what makes the simulator worth looking at.
///
/// Every number here goes through the same engine as real money. The seed cannot
/// contain an unbalanced split, because the projection would flag it.
enum SeedData {

    @MainActor
    static func install(into repository: RachaRepository) async {
        await seedChurrasco(repository)
        await seedJantar(repository)
        await seedViagem(repository)
    }

    // MARK: A settled churrasco — shows the "fechado" state

    @MainActor
    private static func seedChurrasco(_ repo: RachaRepository) async {
        guard let id = try? await repo.createRacha(title: "Churrasco no Gui", kind: .churrasco,
                                                   meName: "Você") else { return }
        let gui = Participant(name: "Gui", pixKey: "gui@exemplo.com")
        let ju = Participant(name: "Ju", pixKey: "+5511988887777")
        await add(repo, id, [
            (.participantAdded(gui), "Gui entrou no racha"),
            (.participantAdded(ju), "Ju entrou no racha")
        ])

        let picanha = LineItem(name: "Picanha", quantity: 1, unitPrice: Cents(18900), category: .carne)
        let linguica = LineItem(name: "Linguiça", quantity: 2, unitPrice: Cents(2400), category: .carne)
        let carvao = LineItem(name: "Carvão e gelo", quantity: 1, unitPrice: Cents(4200), category: .other)
        let cerveja = LineItem(name: "Cerveja (fardo)", quantity: 2, unitPrice: Cents(5900), category: .cerveja)

        await add(repo, id, [
            (.itemsAdded([picanha, linguica, carvao, cerveja]), "4 itens adicionados")
        ])

        let everyone = [repo.meID, gui.id, ju.id]
        for item in [picanha, linguica, carvao] {
            await add(repo, id, [(.claimsSet(itemID: item.id,
                                             claims: everyone.map { Claim(itemID: item.id, personID: $0) }),
                                  "\(item.name) → todo mundo")])
        }
        // Ju doesn't drink — the classic reason an equal split is wrong.
        await add(repo, id, [(.claimsSet(itemID: cerveja.id,
                                         claims: [repo.meID, gui.id].map { Claim(itemID: cerveja.id, personID: $0) }),
                              "Cerveja → você e o Gui")])

        // The host paid everything up front, then the others settled up.
        guard let state = repo.state(id) else { return }
        let total = state.split.total
        await add(repo, id, [
            (.paymentRecorded(Payment(payerID: gui.id, amount: total, method: .cartao,
                                      note: "pagou tudo no mercado", confirmedAt: Date().addingTimeInterval(-86_400 * 6))),
             "Gui pagou \(BRL.format(total))")
        ])

        guard let afterHost = repo.state(id) else { return }
        for transfer in afterHost.settlement.transfers {
            let who = afterHost.participant(transfer.from)?.shortName ?? "alguém"
            await add(repo, id, [
                (.paymentRecorded(Payment(payerID: transfer.from, amount: transfer.amount,
                                          method: .pix, note: "acerto",
                                          confirmedAt: Date().addingTimeInterval(-86_400 * 5))),
                 "\(who) acertou \(BRL.format(transfer.amount))")
            ])
        }
        await add(repo, id, [(.settled(at: Date().addingTimeInterval(-86_400 * 5)), "Racha fechado")])
    }

    // MARK: An open dinner — the main demo surface

    @MainActor
    private static func seedJantar(_ repo: RachaRepository) async {
        guard let id = try? await repo.createRacha(title: "Bar do Zé", kind: .jantar,
                                                   meName: "Você") else { return }
        let gui = Participant(name: "Gui", pixKey: "gui@exemplo.com")
        let ju = Participant(name: "Ju", pixKey: "+5511988887777")
        let pedro = Participant(name: "Pedro")
        await add(repo, id, [
            (.participantAdded(gui), "Gui entrou no racha"),
            (.participantAdded(ju), "Ju entrou no racha"),
            (.participantAdded(pedro), "Pedro entrou no racha")
        ])

        let picanha = LineItem(name: "Picanha na chapa", quantity: 1, unitPrice: Cents(12900), category: .carne)
        let farofa = LineItem(name: "Farofa da casa", quantity: 1, unitPrice: Cents(2200), category: .acompanhamento)
        let vinagrete = LineItem(name: "Vinagrete", quantity: 1, unitPrice: Cents(1400), category: .acompanhamento)
        let chopp = LineItem(name: "Chopp 500ml", quantity: 4, unitPrice: Cents(1600), category: .cerveja)
        let caipirinha = LineItem(name: "Caipirinha de limão", quantity: 2, unitPrice: Cents(2400), category: .drink)
        let pudim = LineItem(name: "Pudim", quantity: 1, unitPrice: Cents(1800), category: .sobremesa)

        await add(repo, id, [
            (.itemsAdded([picanha, farofa, vinagrete, chopp, caipirinha, pudim]), "6 itens da nota"),
            (.extraAdded(Extra.servico()), "Serviço 10% da nota"),
            (.extraAdded(Extra.couvert(Cents(1200))), "Couvert R$ 12,00 por pessoa")
        ])

        let table = [repo.meID, gui.id, ju.id]
        for item in [picanha, farofa, vinagrete] {
            await add(repo, id, [(.claimsSet(itemID: item.id,
                                             claims: table.map { Claim(itemID: item.id, personID: $0) }),
                                  "\(item.name) → você, Gui, Ju")])
        }
        // Pedro arrived late and only drank — the exact case from the brief.
        await add(repo, id, [
            (.claimsSet(itemID: chopp.id, claims: [
                Claim(itemID: chopp.id, personID: gui.id, weight: 2),
                Claim(itemID: chopp.id, personID: pedro.id, weight: 1),
                Claim(itemID: chopp.id, personID: repo.meID, weight: 1)
            ]), "Chopp → Gui×2, Pedro, você"),
            (.claimsSet(itemID: caipirinha.id, claims: [
                Claim(itemID: caipirinha.id, personID: ju.id),
                Claim(itemID: caipirinha.id, personID: pedro.id)
            ]), "Caipirinha → Ju e Pedro")
        ])
        // The pudim is left unclaimed on purpose: the timeline's "sem dono" badge
        // and the thread's opening suggestion both need a real case to point at.

        await add(repo, id, [
            (.paymentRecorded(Payment(payerID: repo.meID, amount: Cents(15000), method: .pix,
                                      note: "adiantei", confirmedAt: Date())),
             "Você pagou R$ 150,00")
        ])
    }

    // MARK: A trip in euros — multi-currency

    @MainActor
    private static func seedViagem(_ repo: RachaRepository) async {
        guard let id = try? await repo.createRacha(title: "Lisboa", kind: .viagem,
                                                   currency: .eur, meName: "Você") else { return }
        let ju = Participant(name: "Ju", pixKey: "+5511988887777")
        await add(repo, id, [
            (.participantAdded(ju), "Ju entrou no racha"),
            (.fxRateSet(FXRate(from: "EUR", to: "BRL", microsPerUnit: 6_213_500, capturedAt: Date())),
             "1 EUR travado em R$ 6,21")
        ])

        let airbnb = LineItem(name: "Airbnb — 3 noites", quantity: 3, unitPrice: Cents(8400), category: .hospedagem)
        let aluguel = LineItem(name: "Aluguel de carro", quantity: 1, unitPrice: Cents(11200), category: .transporte)
        let jantar = LineItem(name: "Jantar na Bica", quantity: 1, unitPrice: Cents(6750), category: .peixe)
        let ingresso = LineItem(name: "Ingresso Mosteiro", quantity: 2, unitPrice: Cents(1000), category: .ingresso)

        await add(repo, id, [(.itemsAdded([airbnb, aluguel, jantar, ingresso]), "4 gastos da viagem")])

        let both = [repo.meID, ju.id]
        for item in [airbnb, aluguel, jantar, ingresso] {
            await add(repo, id, [(.claimsSet(itemID: item.id,
                                             claims: both.map { Claim(itemID: item.id, personID: $0) }),
                                  "\(item.name) → dividido")])
        }
        await add(repo, id, [
            (.paymentRecorded(Payment(payerID: repo.meID, amount: Cents(36400), method: .cartao,
                                      note: "cartão da viagem", confirmedAt: Date())),
             "Você pagou € 364,00")
        ])
    }

    // MARK: Helper

    @MainActor
    private static func add(_ repo: RachaRepository, _ id: UUID,
                            _ entries: [(RachaEvent.Body, String)]) async {
        _ = try? await repo.appendBatch(id, entries, origin: .system)
    }
}
