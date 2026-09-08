import Testing
import Foundation
@testable import Racha

/// A CLASSE de defeito que o XCUITest não consegue ver.
///
/// `AnimatedMoney` espelhava o valor num `@State` e dessincronizou: na galeria o
/// herói "Sua parte" ficou em R$ 72,50 enquanto o botão cobrava R$ 90,10, os
/// dois lendo a mesma variável. Doze fluxos de UI passaram verdes porque o
/// componente publica um `.accessibilityLabel` com o valor VERDADEIRO — o
/// XCUITest lê a árvore de acessibilidade, não os pixels. Quem ouve a tela
/// ouvia o número certo; quem olha lia o errado.
///
/// Não dá pra testar pixels aqui, e um teste de fluxo nunca vai pegar isso. O
/// que dá é proibir a CAUSA: um componente de dinheiro não guarda cópia do
/// valor que exibe. Texto derivado não pode divergir.
struct MoneyComponentsTests {

    private func source(_ file: String) throws -> String {
        // O arquivo vive ao lado do alvo; o teste lê a fonte porque a
        // propriedade é sobre a FORMA do componente, não sobre um valor.
        let here = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RachaTests
            .deletingLastPathComponent()   // ios
        return try String(contentsOf: here.appendingPathComponent(file), encoding: .utf8)
    }

    @Test("nenhum componente de dinheiro guarda cópia do valor em @State")
    func moneyViewsDoNotMirrorTheirValue() throws {
        let src = try source("Racha/Design/GlassComponents.swift")
        guard let inicio = src.range(of: "struct AnimatedMoney: View {") else {
            Issue.record("AnimatedMoney não encontrado — o guarda perdeu o alvo")
            return
        }
        let resto = src[inicio.upperBound...]
        let corpo = String(resto.prefix(while: { $0 != "}" }))
        #expect(!corpo.contains("@State"),
                """
                AnimatedMoney voltou a guardar estado. O texto tem que ser DERIVADO de                 `cents`: um espelho dessincroniza e a tela passa a mostrar um valor que                 não é o que se cobra — e o XCUITest não vê, porque o rótulo de                 acessibilidade continua certo.
                """)
        // E o valor exibido sai de `cents`, não de uma variável intermediária.
        #expect(corpo.contains("BRL.format(cents"),
                "o texto exibido tem que vir de `cents` direto")
    }
}

/// Concordância em português — as duas frases que estavam erradas na tela.
struct ThreadCopyTests {

    @Test("um item sem dono fala no singular")
    func singularAgreement() {
        #expect(ThreadCopy.headline(itemCount: 6, unassignedCount: 1) == "Falta 1 item sem dono.")
        #expect(ThreadCopy.headline(itemCount: 6, unassignedCount: 2) == "Faltam 2 itens sem dono.")
    }

    @Test("nada sem dono, e nada de comanda vazia, muda a frase")
    func otherStates() {
        #expect(ThreadCopy.headline(itemCount: 0, unassignedCount: 0).contains("foto da nota"))
        #expect(ThreadCopy.headline(itemCount: 6, unassignedCount: 0) == "Tudo dividido. Quer acertar?")
    }

    @Test("a sugestão de reivindicar não pede gênero ao idioma")
    func claimIsGenderFree() {
        // "a pudim foi minha" errava duas vezes. Não há como saber o gênero de
        // um nome de prato, então a frase não pergunta.
        for prato in ["Pudim", "Picanha", "Chopp artesanal", "Caipirinha", "Moqueca"] {
            let frase = ThreadCopy.claimSuggestion(itemName: prato)
            #expect(frase == "eu pedi \(prato.lowercased())")
            #expect(!frase.contains("minha"))
            #expect(!frase.hasPrefix("a "))
            #expect(!frase.hasPrefix("o "))
        }
    }
}

/// O cartão "Quem deve o quê" tem que FECHAR no total que ele imprime embaixo.
struct LedgerCardArithmeticTests {

    private func state(items: [LineItem], claims: [LineItem.ID: [Claim]],
                       people: [Participant], extras: [Extra]) -> RachaState {
        var s = RachaState(id: UUID(), title: "Teste", kind: .jantar, currency: .brl,
                           createdAt: Date(), updatedAt: Date())
        s.participants = people
        s.items = items
        s.claimsByItem = claims
        s.extras = extras
        return s
    }

    /// As partes somavam R$ 352,70 debaixo de um "Total R$ 372,50", e os
    /// R$ 19,80 que faltavam — o item sem dono mais o serviço que a casa cobra
    /// nele — estavam explicados dois cartões abaixo. Uma coluna que não fecha
    /// com o total impresso embaixo dela manda o leitor procurar um erro nosso.
    ///
    /// O invariante é do MODELO, então dá pra afirmar sem tela: o que o cartão
    /// desenha (uma linha por pessoa, mais a linha sem dono) soma o total.
    @Test("as linhas do cartão somam o total impresso")
    func rowsSumToTheTotal() {
        let gente = [Participant(name: "Você"), Participant(name: "Gui"), Participant(name: "Ju")]
        let picanha = LineItem(name: "Picanha na chapa", unitPrice: Cents(12900))
        let chopp = LineItem(name: "Chopp 500ml", quantity: 4, unitPrice: Cents(1600))
        let pudim = LineItem(name: "Pudim", unitPrice: Cents(1800))
        var claims: [LineItem.ID: [Claim]] = [:]
        claims[picanha.id] = gente.map { Claim(itemID: picanha.id, personID: $0.id) }
        claims[chopp.id] = [Claim(itemID: chopp.id, personID: gente[0].id),
                            Claim(itemID: chopp.id, personID: gente[1].id)]
        // O pudim fica SEM DONO de propósito: é o caso que quebrava a soma.

        let servico = Extra(label: "Serviço", kind: .percentage(bp: 1000), isGratuity: true)
        let split = SplitEngine.split(state(items: [picanha, chopp, pudim], claims: claims,
                                            people: gente, extras: [servico]))

        let somaDasPartes = split.shares.map(\.total).total
        #expect(somaDasPartes + split.unassignedWithExtras == split.total,
                """
                as linhas do cartão não fecham: partes \(somaDasPartes.raw)¢ \
                + sem dono \(split.unassignedWithExtras.raw)¢ ≠ total \(split.total.raw)¢
                """)
        // E a linha sem dono não é zero neste cenário — senão o teste passaria
        // sem exercitar o caso que estava errado.
        #expect(!split.unassignedWithExtras.isZero)
    }

    @Test("sem item órfão, as partes já somam o total sozinhas")
    func noUnownedRow() {
        let gente = [Participant(name: "Você"), Participant(name: "Gui")]
        let picanha = LineItem(name: "Picanha", unitPrice: Cents(10000))
        let claims = [picanha.id: gente.map { Claim(itemID: picanha.id, personID: $0.id) }]
        let split = SplitEngine.split(state(items: [picanha], claims: claims,
                                            people: gente, extras: []))
        #expect(split.unassignedWithExtras.isZero)
        #expect(split.shares.map(\.total).total == split.total)
    }
}
