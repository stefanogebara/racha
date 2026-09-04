import Testing
@testable import Racha

/// The sum invariant is the one property everything else rests on, so it is
/// tested exhaustively rather than by example: every total from 0 to 2000
/// centavos, split every way from 1 to 12, must sum back to itself.
@Suite("Alocação")
struct AllocationTests {

    @Test("divisão igual soma exatamente o total, para toda combinação")
    func equalSumsExactly() {
        for total in stride(from: 0, through: 2000, by: 1) {
            for n in 1...12 {
                let alloc = Allocator.equal(Cents(total), into: n)
                #expect(alloc.parts.count == n)
                #expect(alloc.parts.total == Cents(total),
                        "total \(total) em \(n) partes somou \(alloc.parts.total.raw)")
            }
        }
    }

    @Test("nenhuma parte difere de outra por mais de um centavo")
    func equalPartsDifferByAtMostOne() {
        for total in stride(from: 0, through: 999, by: 7) {
            for n in 1...9 {
                let parts = Allocator.equal(Cents(total), into: n).parts.map(\.raw)
                let spread = (parts.max() ?? 0) - (parts.min() ?? 0)
                #expect(spread <= 1, "total \(total) em \(n): spread \(spread)")
            }
        }
    }

    @Test("o resto é atribuído a alguém — nunca some")
    func remainderIsAttributed() {
        // R$ 100,00 entre 3: 3333, 3333, 3334. Uma pessoa leva o centavo.
        let alloc = Allocator.equal(Cents(10_000), into: 3)
        #expect(alloc.parts.map(\.raw).sorted() == [3333, 3333, 3334])
        #expect(alloc.remainderRecipients.count == 1)
    }

    @Test("a rotação move o centavo extra de posição")
    func rotationMovesRemainder() {
        let a = Allocator.equal(Cents(10), into: 3, rotate: 0)
        let b = Allocator.equal(Cents(10), into: 3, rotate: 1)
        #expect(a.remainderRecipients != b.remainderRecipients)
        #expect(a.parts.total == b.parts.total)
    }

    @Test("proporcional soma exatamente, com pesos quaisquer")
    func proportionalSumsExactly() {
        let weightSets: [[Int]] = [
            [1, 1, 1], [2, 1, 1], [1, 2, 3], [7, 11, 13, 17],
            [1, 0, 0], [0, 0, 0], [5], [100, 1], [3, 3, 3, 3, 3]
        ]
        for total in stride(from: 0, through: 5000, by: 13) {
            for weights in weightSets {
                let alloc = Allocator.proportional(Cents(total), weights: weights)
                #expect(alloc.parts.total == Cents(total),
                        "total \(total) pesos \(weights) somou \(alloc.parts.total.raw)")
            }
        }
    }

    @Test("pesos zerados caem numa divisão igual, sem perder centavo")
    func zeroWeightsDegradeToEqual() {
        let alloc = Allocator.proportional(Cents(1000), weights: [0, 0, 0])
        #expect(alloc.parts.total == Cents(1000))
        #expect(alloc.parts.map(\.raw).sorted() == [333, 333, 334])
    }

    @Test("proporcional respeita a proporção onde ela é exata")
    func proportionalRespectsWeights() {
        // 300 centavos com pesos 2:1 → 200 e 100, sem resto.
        let alloc = Allocator.proportional(Cents(300), weights: [2, 1])
        #expect(alloc.parts.map(\.raw) == [200, 100])
        #expect(alloc.remainderRecipients.isEmpty)
    }

    @Test("valores negativos (estorno) também somam exatamente")
    func negativeTotalsSumExactly() {
        for total in stride(from: -1000, through: -1, by: 7) {
            let alloc = Allocator.proportional(Cents(total), weights: [3, 2, 1])
            #expect(alloc.parts.total == Cents(total))
        }
    }

    @Test("pontos-base arredondam meio pra cima, igual ao backend")
    func basisPointsRoundHalfUp() {
        // Os mesmos casos do servicoCents em split-engine.js.
        #expect(Allocator.basisPoints(Cents(10_000), 1000) == Cents(1000))   // 10% de 100,00
        #expect(Allocator.basisPoints(Cents(3333), 1000) == Cents(333))      // 333,3 → 333
        #expect(Allocator.basisPoints(Cents(3335), 1000) == Cents(334))      // 333,5 → 334
        #expect(Allocator.basisPoints(Cents(0), 1000) == Cents(0))
        #expect(Allocator.basisPoints(Cents(10_000), 0) == Cents(0))
    }

    @Test("divisão meio-pra-cima é simétrica em torno de zero")
    func halfUpIsSymmetric() {
        #expect(roundHalfUpDiv(5, 10) == 1)
        #expect(roundHalfUpDiv(-5, 10) == -1)
        #expect(roundHalfUpDiv(4, 10) == 0)
        #expect(roundHalfUpDiv(-4, 10) == 0)
    }
}
