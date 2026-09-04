import Foundation
import Testing
@testable import Racha

@Suite("Acerto de contas")
struct SettleUpTests {

    private func balances(_ nets: [Int]) -> [NetBalance] {
        nets.map { net in
            NetBalance(personID: UUID(), paid: Cents(max(0, net)), owed: Cents(max(0, -net)),
                       net: Cents(net))
        }
    }

    @Test("plano zera todo mundo quando a soma é zero")
    func planClearsEveryone() {
        let b = balances([5000, -2000, -3000])
        let plan = SettleUp.plan(b)
        #expect(plan.residual.isZero)
        #expect(SettleUp.verify(plan, against: b))
    }

    @Test("nunca mais que n−1 transferências")
    func neverMoreThanNMinusOne() {
        var rng = SplitMix64(seed: 77)
        for _ in 0..<200 {
            let count = 2 + Int(rng.next() % 9)
            var nets: [Int] = []
            for _ in 0..<(count - 1) { nets.append(Int(rng.next() % 20_000) - 10_000) }
            nets.append(-nets.reduce(0, +))        // força soma zero
            let b = balances(nets)
            let plan = SettleUp.plan(b)
            let active = b.filter { !$0.net.isZero }.count
            #expect(plan.transfers.count <= max(0, active - 1))
            #expect(SettleUp.verify(plan, against: b))
        }
    }

    @Test("encontra os subconjuntos que se resolvem sozinhos")
    func findsZeroSumSubsets() {
        // Dois pares independentes: A deve pro B, C deve pro D. O ótimo é 2
        // transferências, não 3 — o guloso sozinho daria 3 aqui em alguns casos.
        let b = balances([1000, -1000, 2500, -2500])
        let plan = SettleUp.plan(b)
        #expect(plan.transfers.count == 2)
        #expect(SettleUp.verify(plan, against: b))
    }

    @Test("um credor e três devedores dá exatamente três transferências")
    func starTopology() {
        let b = balances([9000, -3000, -3000, -3000])
        let plan = SettleUp.plan(b)
        #expect(plan.transfers.count == 3)
        #expect(SettleUp.verify(plan, against: b))
    }

    @Test("o que falta pro restaurante sai como residual, não vira dívida de amigo")
    func residualIsSeparate() {
        // Duas pessoas devem 50,00 cada; ninguém pagou nada.
        let b = balances([-5000, -5000])
        let plan = SettleUp.plan(b)
        #expect(plan.transfers.isEmpty)
        #expect(plan.residual == Cents(10_000))
        #expect(SettleUp.verify(plan, against: b))
    }

    @Test("residual parcial: acerta o que dá, reporta o resto")
    func partialResidual() {
        // Alguém adiantou 30,00; o grupo deve 100,00 no total.
        let b = balances([3000, -6500, -6500])
        let plan = SettleUp.plan(b)
        #expect(plan.residual == Cents(10_000))
        // Os 30,00 adiantados voltam pra quem adiantou.
        #expect(plan.transfers.map(\.amount).total == Cents(3000))
        #expect(SettleUp.verify(plan, against: b))
    }

    @Test("todo mundo quite não gera transferência nenhuma")
    func allSettled() {
        let plan = SettleUp.plan(balances([0, 0, 0]))
        #expect(plan.isComplete)
    }

    @Test("um centavo de diferença ainda gera uma transferência de um centavo")
    func singleCentIsNotSweptUnderTheRug() {
        let b = balances([1, -1])
        let plan = SettleUp.plan(b)
        #expect(plan.transfers.count == 1)
        #expect(plan.transfers[0].amount == Cents(1))
    }
}
