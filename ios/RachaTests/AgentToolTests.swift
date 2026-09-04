import Foundation
import Testing
@testable import Racha

@Suite("Contrato das ferramentas do agente")
struct AgentToolTests {

    @Test("campo de centavos recusa reais disfarçados")
    func centsFieldRejectsReais() {
        // Um modelo que responde 47.50 num campo de centavos está na unidade
        // errada. Falhar alto é o comportamento certo — cobrar R$ 0,47 não é.
        let wrong = JSONValue.object(["valor_cents": .double(47.50)])
        #expect(wrong.cents("valor_cents") == nil)

        let right = JSONValue.object(["valor_cents": .int(4750)])
        #expect(right.cents("valor_cents") == Cents(4750))

        // Um double exatamente inteiro é aceitável — 4750.0 é 4750.
        let integral = JSONValue.object(["valor_cents": .double(4750)])
        #expect(integral.cents("valor_cents") == Cents(4750))
    }

    @Test("string em campo de centavos passa pelo parser pt-BR")
    func centsFieldAcceptsBrazilianText() {
        #expect(JSONValue.object(["v": .string("4750")]).cents("v") == Cents(4750))
        #expect(JSONValue.object(["v": .string("R$ 47,50")]).cents("v") == Cents(4750))
    }

    @Test("toda ferramenta tem nome único e esquema de objeto")
    func toolsAreWellFormed() {
        let names = AgentTools.all.map(\.name)
        #expect(Set(names).count == names.count, "nome de ferramenta duplicado")
        for tool in AgentTools.all {
            #expect(tool.schema.string("type") == "object", "\(tool.name) sem esquema de objeto")
            #expect(!tool.description.isEmpty)
            #expect(tool.name.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" },
                    "\(tool.name) tem caractere inválido pra API")
        }
    }

    @Test("ferramentas que escrevem dinheiro estão marcadas")
    func moneyToolsAreFlagged() {
        #expect(AgentTools.assignItems.writesMoney)
        #expect(AgentTools.recordPayment.writesMoney)
        #expect(!AgentTools.listSplit.writesMoney)
        #expect(!AgentTools.settleUp.writesMoney)
    }
}

@Suite("Parser SSE")
struct SSEParserTests {

    @Test("junta os fragmentos de JSON e só parseia no fim do bloco")
    func accumulatesToolInput() {
        var parser = SSEParser()
        _ = parser.consume("""
        data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"atribuir_itens"}}
        """)
        _ = parser.consume("""
        data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"atribuicoes\\":[{\\"item\\":\\"Pic"}}
        """)
        _ = parser.consume("""
        data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"anha\\",\\"pessoas\\":[\\"Gui\\"]}]}"}}
        """)
        let events = parser.consume("""
        data: {"type":"content_block_stop","index":0}
        """)

        guard case .toolReady(_, let name, let input)? = events.first else {
            Issue.record("esperava toolReady, veio \(events)")
            return
        }
        #expect(name == "atribuir_itens")
        #expect(input.objects("atribuicoes")?.first?.string("item") == "Picanha")
    }

    @Test("JSON truncado não vira chamada de ferramenta pela metade")
    func truncatedInputFails() {
        var parser = SSEParser()
        _ = parser.consume("""
        data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_2","name":"registrar_pagamento"}}
        """)
        _ = parser.consume("""
        data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pagador\\":\\"Gui\\",\\"valor"}}
        """)
        let events = parser.consume("""
        data: {"type":"content_block_stop","index":0}
        """)
        guard case .failed? = events.first else {
            Issue.record("JSON truncado devia falhar, veio \(events)")
            return
        }
    }

    @Test("ferramenta sem argumentos fecha com objeto vazio")
    func emptyInputIsValid() {
        var parser = SSEParser()
        _ = parser.consume("""
        data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_3","name":"ver_racha"}}
        """)
        let events = parser.consume("""
        data: {"type":"content_block_stop","index":0}
        """)
        guard case .toolReady(_, let name, _)? = events.first else {
            Issue.record("esperava toolReady, veio \(events)")
            return
        }
        #expect(name == "ver_racha")
    }

    @Test("deltas de texto saem na ordem")
    func textDeltas() {
        var parser = SSEParser()
        let a = parser.consume(#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Picanha "}}"#)
        let b = parser.consume(#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"dividida."}}"#)
        guard case .textDelta(let first)? = a.first, case .textDelta(let second)? = b.first else {
            Issue.record("esperava textDelta")
            return
        }
        #expect(first + second == "Picanha dividida.")
    }
}

@Suite("Resolução de nomes")
struct ResolverTests {

    @Test("artigo e caixa não atrapalham")
    func resolvesLoosely() {
        let gui = Participant(name: "Guilherme")
        let ju = Participant(name: "Juliana")
        let people = [gui, ju]
        #expect(ParticipantResolver.resolve("Gui", in: people) == .matched(gui.id))
        #expect(ParticipantResolver.resolve("o gui", in: people) == .matched(gui.id))
        #expect(ParticipantResolver.resolve("GUILHERME", in: people) == .matched(gui.id))
        #expect(ParticipantResolver.resolve("a ju", in: people) == .matched(ju.id))
    }

    @Test("acento não separa a mesma pessoa em duas")
    func accentInsensitive() {
        let joao = Participant(name: "João")
        #expect(ParticipantResolver.resolve("joao", in: [joao]) == .matched(joao.id))
        #expect(ParticipantResolver.resolve("JOÃO", in: [joao]) == .matched(joao.id))
    }

    @Test("ambiguidade devolve ambíguo — o agente pergunta em vez de chutar")
    func ambiguityIsReported() {
        let a = Participant(name: "Ju Silva")
        let b = Participant(name: "Ju Santos")
        guard case .ambiguous(let ids) = ParticipantResolver.resolve("Ju", in: [a, b]) else {
            Issue.record("esperava ambíguo")
            return
        }
        #expect(ids.count == 2)
    }

    @Test("quem não está na mesa não é inventado")
    func notFound() {
        #expect(ParticipantResolver.resolve("Fulano", in: [Participant(name: "Ana")]) == .notFound)
    }
}

@Suite("Categorização de itens")
struct CategorizerTests {

    @Test("acerta os itens de uma nota brasileira típica")
    func categorises() {
        #expect(ItemCategorizer.guess("Picanha na chapa") == .carne)
        #expect(ItemCategorizer.guess("CHOPP 500ML") == .cerveja)
        #expect(ItemCategorizer.guess("Caipirinha de limão") == .drink)
        #expect(ItemCategorizer.guess("Farofa da casa") == .acompanhamento)
        #expect(ItemCategorizer.guess("Pudim") == .sobremesa)
        #expect(ItemCategorizer.guess("Uber para o bar") == .transporte)
        #expect(ItemCategorizer.guess("Airbnb 3 noites") == .hospedagem)
        #expect(ItemCategorizer.guess("Couvert artístico") == .couvert)
    }

    @Test("a palavra mais longa ganha — água de coco não é refrigerante")
    func longestKeywordWins() {
        #expect(ItemCategorizer.guess("Água de coco") == .suco)
        #expect(ItemCategorizer.guess("Água com gás") == .refrigerante)
    }

    @Test("item desconhecido não força categoria")
    func unknownStaysOther() {
        #expect(ItemCategorizer.guess("Zzzqq") == .other)
        #expect(ItemCategorizer.guess("") == .other)
    }

    @Test("a chave de cache é do prato, não do item — a segunda picanha é de graça")
    func cacheKeyIsContentAddressed() {
        let a = LineItem(name: "2X PICANHA", unitPrice: Cents(1000), category: .carne)
        let b = LineItem(name: "picanha", unitPrice: Cents(9999), category: .carne)
        #expect(ImageStyle.cacheKey(for: a) == ImageStyle.cacheKey(for: b))
    }

    @Test("limpa o ruído do PDV antes de virar prompt")
    func subjectCleaning() {
        let item = LineItem(name: "2X PICANHA C/ FRITAS **", unitPrice: Cents(1000))
        #expect(ImageStyle.subject(for: item) == "picanha com fritas")
    }
}
