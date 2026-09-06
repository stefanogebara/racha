import Foundation
import Testing
@testable import Racha

@Suite("Projeção do log de eventos")
struct ProjectionTests {

    private var rachaID = UUID()

    private func event(_ seq: Int, _ body: RachaEvent.Body,
                       origin: RachaEvent.Origin = .user, id: UUID = UUID()) -> RachaEvent {
        RachaEvent(id: id, rachaID: rachaID, seq: seq, at: Date(timeIntervalSince1970: Double(seq)),
                   origin: origin, summary: "s\(seq)", body: body)
    }

    @Test("dobra os eventos na ordem de seq, não de data")
    func foldsBySeq() {
        let events = [
            event(3, .renamed(title: "Terceiro")),
            event(1, .created(title: "Primeiro", kind: .jantar, currency: .brl)),
            event(2, .renamed(title: "Segundo"))
        ]
        let state = RachaProjection.reduce(events)
        #expect(state?.title == "Terceiro")
    }

    @Test("sem evento de criação não há estado")
    func noGenesisNoState() {
        #expect(RachaProjection.reduce([event(1, .renamed(title: "Sem gênese"))]) == nil)
    }

    @Test("reversão apaga o efeito e mantém o fato no log")
    func revertSkipsButKeeps() {
        let target = UUID()
        let events = [
            event(1, .created(title: "Bar", kind: .jantar, currency: .brl)),
            event(2, .renamed(title: "Errado"), id: target),
            event(3, .reverted(target: target, reason: "desfeito"))
        ]
        let state = RachaProjection.reduce(events)
        #expect(state?.title == "Bar")
        #expect(events.count == 3)   // nada foi apagado
    }

    @Test("reversão vale mesmo aparecendo antes do alvo na ordenação")
    func revertIsResolvedUpFront() {
        let target = UUID()
        let events = [
            event(1, .created(title: "Bar", kind: .jantar, currency: .brl)),
            event(2, .reverted(target: target, reason: nil)),
            event(3, .renamed(title: "Errado"), id: target)
        ]
        #expect(RachaProjection.reduce(events)?.title == "Bar")
    }

    @Test("evento sobre entidade inexistente vira anomalia visível, não crash")
    func unknownEntityBecomesAnomaly() {
        let events = [
            event(1, .created(title: "Bar", kind: .jantar, currency: .brl)),
            event(2, .itemRemoved(UUID())),
            event(3, .participantRenamed(id: UUID(), name: "Fantasma"))
        ]
        let state = RachaProjection.reduce(events)
        #expect(state != nil)
        #expect(state?.anomalies.count == 2)
    }

    @Test("pagamento é idempotente por id — webhook repetido não cobra duas vezes")
    func paymentIdempotency() {
        let ana = Participant(name: "Ana")
        let payment = Payment(payerID: ana.id, amount: Cents(5000), confirmedAt: Date())
        let events = [
            event(1, .created(title: "Bar", kind: .jantar, currency: .brl)),
            event(2, .participantAdded(ana)),
            event(3, .paymentRecorded(payment)),
            event(4, .paymentRecorded(payment))
        ]
        let state = RachaProjection.reduce(events)
        #expect(state?.payments.count == 1)
        #expect(state?.confirmedPaid == Cents(5000))
    }

    @Test("pagamento de gente que não está no racha vira anomalia")
    func paymentByStranger() {
        let events = [
            event(1, .created(title: "Bar", kind: .jantar, currency: .brl)),
            event(2, .paymentRecorded(Payment(payerID: UUID(), amount: Cents(100))))
        ]
        let state = RachaProjection.reduce(events)
        #expect(state?.payments.isEmpty == true)
        #expect(state?.anomalies.count == 1)
    }

    @Test("dois pedidos do mesmo item pela mesma pessoa não dobram o peso")
    func duplicateClaimsAreCollapsed() {
        let ana = Participant(name: "Ana")
        let item = LineItem(name: "Prato", unitPrice: Cents(1000))
        let events = [
            event(1, .created(title: "Bar", kind: .jantar, currency: .brl)),
            event(2, .participantAdded(ana)),
            event(3, .itemsAdded([item])),
            event(4, .claimsSet(itemID: item.id, claims: [
                Claim(itemID: item.id, personID: ana.id),
                Claim(itemID: item.id, personID: ana.id)
            ]))
        ]
        let state = RachaProjection.reduce(events)
        #expect(state?.claims(for: item.id).count == 1)
    }

    @Test("tirar uma pessoa devolve os itens dela pro estado sem dono")
    func removingPersonUnclaimsTheirItems() {
        let ana = Participant(name: "Ana")
        let item = LineItem(name: "Prato", unitPrice: Cents(1000))
        let events = [
            event(1, .created(title: "Bar", kind: .jantar, currency: .brl)),
            event(2, .participantAdded(ana)),
            event(3, .itemsAdded([item])),
            event(4, .claimsSet(itemID: item.id, claims: [Claim(itemID: item.id, personID: ana.id)])),
            event(5, .participantRemoved(ana.id))
        ]
        let state = RachaProjection.reduce(events)
        #expect(state?.claims(for: item.id).isEmpty == true)
        #expect(state?.split.unassigned == [item.id])
    }

    @Test("total fixado na nota vence o recálculo por quantidade")
    func printedTotalWins() {
        let item = LineItem(name: "Peso", quantity: 1, unitPrice: Cents(1000), total: Cents(1730))
        let events = [
            event(1, .created(title: "Bar", kind: .jantar, currency: .brl)),
            event(2, .itemsAdded([item])),
            event(3, .itemEdited(id: item.id, name: nil, quantity: 2, unitPrice: nil,
                                 total: Cents(3460), category: nil))
        ]
        #expect(RachaProjection.reduce(events)?.item(item.id)?.total == Cents(3460))
    }

    @Test("mudar a quantidade sem fixar total recalcula")
    func quantityChangeRecomputes() {
        let item = LineItem(name: "Chopp", quantity: 1, unitPrice: Cents(1600))
        let events = [
            event(1, .created(title: "Bar", kind: .jantar, currency: .brl)),
            event(2, .itemsAdded([item])),
            event(3, .itemEdited(id: item.id, name: nil, quantity: 4, unitPrice: nil,
                                 total: nil, category: nil))
        ]
        #expect(RachaProjection.reduce(events)?.item(item.id)?.total == Cents(6400))
    }
}
