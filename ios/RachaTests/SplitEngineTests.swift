import Foundation
import Testing
@testable import Racha

@Suite("Motor de divisão")
struct SplitEngineTests {

    /// Builds a state directly, bypassing the event log, so the engine is tested
    /// in isolation from persistence.
    private func makeState(items: [LineItem], claims: [LineItem.ID: [Claim]],
                           people: [Participant], extras: [Extra] = []) -> RachaState {
        var state = RachaState(id: UUID(), title: "Teste", kind: .jantar, currency: .brl,
                               createdAt: Date(), updatedAt: Date())
        state.participants = people
        state.items = items
        state.claimsByItem = claims
        state.extras = extras
        return state
    }

    @Test("item dividido entre três soma exatamente o item")
    func sharedItemSumsExactly() {
        let a = Participant(name: "Ana"), b = Participant(name: "Bia"), c = Participant(name: "Cau")
        let item = LineItem(name: "Picanha", unitPrice: Cents(10_000))
        let state = makeState(items: [item],
                              claims: [item.id: [a, b, c].map { Claim(itemID: item.id, personID: $0.id) }],
                              people: [a, b, c])
        let split = state.split
        #expect(split.isBalanced)
        #expect(split.shares.map(\.consumption).total == Cents(10_000))
        #expect(split.shares.map(\.consumption.raw).sorted() == [3333, 3333, 3334])
    }

    @Test("pesos: dois chopps de quatro")
    func weightsSplitProportionally() {
        let gui = Participant(name: "Gui"), ju = Participant(name: "Ju"), pedro = Participant(name: "Pedro")
        let chopp = LineItem(name: "Chopp", quantity: 4, unitPrice: Cents(1600))   // 64,00
        let state = makeState(items: [chopp], claims: [chopp.id: [
            Claim(itemID: chopp.id, personID: gui.id, weight: 2),
            Claim(itemID: chopp.id, personID: ju.id, weight: 1),
            Claim(itemID: chopp.id, personID: pedro.id, weight: 1)
        ]], people: [gui, ju, pedro])
        let split = state.split
        #expect(split.share(for: gui.id)?.consumption == Cents(3200))
        #expect(split.share(for: ju.id)?.consumption == Cents(1600))
        #expect(split.share(for: pedro.id)?.consumption == Cents(1600))
        #expect(split.isBalanced)
    }

    @Test("serviço é proporcional ao consumo, nunca rateado liso")
    func servicoIsProportional() {
        let rico = Participant(name: "Rico"), pobre = Participant(name: "Pobre")
        let caro = LineItem(name: "Wagyu", unitPrice: Cents(8000))
        let barato = LineItem(name: "Água", unitPrice: Cents(2000))
        let state = makeState(
            items: [caro, barato],
            claims: [caro.id: [Claim(itemID: caro.id, personID: rico.id)],
                     barato.id: [Claim(itemID: barato.id, personID: pobre.id)]],
            people: [rico, pobre],
            extras: [Extra.servico(bp: 1000)])
        let split = state.split
        // 10% de 80,00 = 8,00 e 10% de 20,00 = 2,00 — não 5,00 pra cada.
        #expect(split.share(for: rico.id)?.extrasTotal == Cents(800))
        #expect(split.share(for: pobre.id)?.extrasTotal == Cents(200))
        #expect(split.total == Cents(11_000))
    }

    @Test("serviço desligado não entra na conta")
    func disabledServicoIsExcluded() {
        let ana = Participant(name: "Ana")
        let item = LineItem(name: "Prato", unitPrice: Cents(5000))
        let state = makeState(items: [item],
                              claims: [item.id: [Claim(itemID: item.id, personID: ana.id)]],
                              people: [ana],
                              extras: [Extra.servico(bp: 1000, enabled: false)])
        #expect(state.split.total == Cents(5000))
    }

    @Test("couvert é exato por cabeça, sem resto")
    func couvertIsPerHead() {
        let people = (0..<3).map { Participant(name: "P\($0)") }
        let item = LineItem(name: "Prato", unitPrice: Cents(9000))
        let state = makeState(items: [item],
                              claims: [item.id: people.map { Claim(itemID: item.id, personID: $0.id) }],
                              people: people,
                              extras: [Extra.couvert(Cents(1200))])
        let split = state.split
        for share in split.shares { #expect(share.extrasTotal == Cents(1200)) }
        #expect(split.total == Cents(9000 + 3600))
    }

    @Test("desconto reduz a conta e continua fechando")
    func discountBalances() {
        let a = Participant(name: "A"), b = Participant(name: "B")
        let item = LineItem(name: "Rodízio", unitPrice: Cents(20_000))
        let state = makeState(items: [item],
                              claims: [item.id: [a, b].map { Claim(itemID: item.id, personID: $0.id) }],
                              people: [a, b],
                              extras: [Extra(label: "Cupom", kind: .discount(Cents(3333)))])
        let split = state.split
        #expect(split.total == Cents(20_000 - 3333))
        #expect(split.isBalanced)
    }

    @Test("item sem dono fica visível e não é atribuído a ninguém")
    func unassignedIsSurfaced() {
        let a = Participant(name: "A")
        let mine = LineItem(name: "Meu", unitPrice: Cents(1000))
        let orphan = LineItem(name: "Órfão", unitPrice: Cents(2500))
        let state = makeState(items: [mine, orphan],
                              claims: [mine.id: [Claim(itemID: mine.id, personID: a.id)]],
                              people: [a])
        let split = state.split
        #expect(split.unassigned == [orphan.id])
        #expect(split.unassignedTotal == Cents(2500))
        #expect(split.share(for: a.id)?.consumption == Cents(1000))
        #expect(split.isBalanced)
    }

    @Test("o serviço da casa incide no item sem dono, e o total é o da comanda")
    func unassignedCarriesHouseExtras() {
        // The restaurant prints 10% on everything on the slip, including the pudim
        // nobody has claimed. If the bucket did not carry that 10%, the app's total
        // would come out R$ 2,50 short of the bill on the table.
        let a = Participant(name: "A")
        let mine = LineItem(name: "Meu", unitPrice: Cents(1000))
        let orphan = LineItem(name: "Órfão", unitPrice: Cents(2500))
        let state = makeState(items: [mine, orphan],
                              claims: [mine.id: [Claim(itemID: mine.id, personID: a.id)]],
                              people: [a],
                              extras: [Extra.servico(bp: 1000)])
        let split = state.split
        #expect(split.unassignedTotal == Cents(2500))
        #expect(split.unassignedExtras == Cents(250))
        #expect(split.unassignedWithExtras == Cents(2750))
        #expect(split.share(for: a.id)?.total == Cents(1100))
        #expect(split.total == Cents(1100 + 2750))
        #expect(split.isBalanced)
    }

    @Test("couvert e valor fixo não sobram pro balde sem dono")
    func fixedExtrasDoNotLeakIntoUnassigned() {
        let a = Participant(name: "A")
        let orphan = LineItem(name: "Órfão", unitPrice: Cents(2500))
        let state = makeState(items: [orphan], claims: [:], people: [a],
                              extras: [Extra.couvert(Cents(1200)),
                                       Extra(label: "Rolha", kind: .fixed(Cents(3000)))])
        let split = state.split
        #expect(split.unassignedExtras == .zero)
        #expect(split.share(for: a.id)?.total == Cents(4200))
        #expect(split.total == Cents(4200 + 2500))
        #expect(split.isBalanced)
    }

    @Test("propriedade: qualquer conta gerada fecha exatamente")
    func randomBillsAlwaysBalance() {
        var rng = SplitMix64(seed: 20260904)
        for iteration in 0..<400 {
            let peopleCount = 1 + Int(rng.next() % 6)
            let people = (0..<peopleCount).map { Participant(name: "P\($0)") }
            let itemCount = 1 + Int(rng.next() % 9)
            var items: [LineItem] = []
            var claims: [LineItem.ID: [Claim]] = [:]
            for i in 0..<itemCount {
                let price = Cents(Int(rng.next() % 25_000))
                let item = LineItem(name: "Item \(i)", unitPrice: price)
                items.append(item)
                let claimants = people.filter { _ in rng.next() % 3 != 0 }
                if !claimants.isEmpty {
                    claims[item.id] = claimants.map {
                        Claim(itemID: item.id, personID: $0.id, weight: 1 + Int(rng.next() % 3))
                    }
                }
            }
            var extras: [Extra] = []
            if rng.next() % 2 == 0 { extras.append(Extra.servico(bp: Int(rng.next() % 2000))) }
            if rng.next() % 3 == 0 { extras.append(Extra.couvert(Cents(Int(rng.next() % 3000)))) }

            let state = makeState(items: items, claims: claims, people: people, extras: extras)
            let split = state.split
            #expect(split.isBalanced, "iteração \(iteration) não fechou")
            #expect(split.claimedTotal + split.unassignedTotal == split.itemsTotal)
            #expect(split.shares.map(\.total).total + split.unassignedWithExtras == split.total)
            for share in split.shares {
                #expect(share.consumption.raw >= 0, "consumo negativo na iteração \(iteration)")
            }
        }
    }
}

@Suite("Bases de extra")
struct ExtraBaseTests {

    private func state(consumption: [Cents], extras: [Extra]) -> RachaState {
        let people = consumption.indices.map { Participant(name: "P\($0)") }
        var s = RachaState(id: UUID(), title: "Teste", kind: .jantar, currency: .brl,
                           createdAt: Date(), updatedAt: Date())
        s.participants = people
        s.extras = extras
        // One item per person, each claimed only by them: consumption is exact.
        for (i, amount) in consumption.enumerated() {
            let item = LineItem(name: "Item \(i)", unitPrice: amount)
            s.items.append(item)
            s.claimsByItem[item.id] = [Claim(itemID: item.id, personID: people[i].id)]
        }
        return s
    }

    @Test("percentual sobre base de cabeças usa dinheiro real, não some")
    func percentageOnEqualHeads() {
        // Regressão: uma base de peso 1 dava 10% de um centavo = zero, e o extra
        // desaparecia em silêncio.
        let s = state(consumption: [Cents(8000), Cents(2000)],
                      extras: [Extra(label: "Taxa igual", kind: .percentage(bp: 1000),
                                     base: .equalHeads)])
        let split = s.split
        // 10% de R$ 50,00 (metade de R$ 100,00) para cada um.
        for share in split.shares { #expect(share.extrasTotal == Cents(500)) }
        #expect(split.total == Cents(11_000))
    }

    @Test("percentual sobre consumo continua proporcional")
    func percentageOnConsumption() {
        let s = state(consumption: [Cents(8000), Cents(2000)],
                      extras: [Extra.servico(bp: 1000)])
        let split = s.split
        #expect(split.shares[0].extrasTotal == Cents(800))
        #expect(split.shares[1].extrasTotal == Cents(200))
    }

    @Test("percentual pode incidir sobre extras anteriores quando a nota faz isso")
    func percentageOnEarlierExtras() {
        let s = state(consumption: [Cents(10_000)],
                      extras: [Extra.couvert(Cents(1200)),
                               Extra(label: "Serviço", kind: .percentage(bp: 1000),
                                     base: .consumptionPlusEarlierExtras, isGratuity: true)])
        let split = s.split
        // 10% de (100,00 + 12,00) = 11,20 · mais o couvert de 12,00.
        #expect(split.shares[0].extrasTotal == Cents(1200 + 1120))
    }

    @Test("valor fixo rateia proporcional ao consumo e fecha exatamente")
    func fixedSpreadsProportionally() {
        let s = state(consumption: [Cents(7000), Cents(3000)],
                      extras: [Extra(label: "Entrega", kind: .fixed(Cents(1000)))])
        let split = s.split
        #expect(split.shares[0].extrasTotal == Cents(700))
        #expect(split.shares[1].extrasTotal == Cents(300))
        #expect(split.total == Cents(11_000))
    }
}
