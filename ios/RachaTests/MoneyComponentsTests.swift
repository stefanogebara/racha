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
