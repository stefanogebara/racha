import Testing
import Foundation
@testable import Racha

/// O guarda de RUNTIME, e o acoplamento dele com `docs/compliance/claims.json`.
///
/// O ORÁCULO É A PARTE QUE ERROU ANTES. A versão anterior afirmava
/// `!afirmaDestinoSemDistribuidor(saida)` — e como a saída SEMPRE terminava
/// com a frase sancionada, a própria cauda acrescentada satisfazia o
/// predicado. Apagar a metade destrutiva inteira do guarda deixava 28 das 31
/// frases do corpo verdes. Um teste que não pode falhar é o inegociável #7
/// mudado de lugar.
///
/// Agora as asserções são sobre o que a pessoa LÊ: ou a volta do modelo saiu
/// inteira e idêntica, ou ela não saiu nenhum pedaço. Não há terceiro estado,
/// e é isso que dá pra afirmar sem ambiguidade.
@Suite("Revisão de afirmações em tempo de execução")
struct RevisaoDeAfirmacoesTests {

    private func claims() -> [String: Any] {
        let raiz = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let dados = try! Data(contentsOf: raiz.appending(path: "docs/compliance/claims.json"))
        return (try! JSONSerialization.jsonObject(with: dados) as! [String: Any])["gorjeta_destino"] as! [String: Any]
    }

    /// Como o `AgentSession` monta a tela: acumulador CRU, exibição derivada,
    /// congelada assim que chega perto do assunto, julgada quando fecha.
    private func simularVolta(_ texto: String) -> (quadros: [String], final: String, recusada: Bool) {
        var cru = "", exibido = "", fimAnterior = "", quadros: [String] = []
        var armado = false
        for ch in texto {
            cru.append(ch)
            if !armado { armado = RevisaoDeAfirmacoes.chegouPertoDoAssunto(String(ch) + fimAnterior) }
            if !armado { exibido = RevisaoDeAfirmacoes.parcialExibivel(cru) }
            fimAnterior = String(cru.suffix(40))
            quadros.append(exibido)
        }
        let recusada = RevisaoDeAfirmacoes.afirmaDestinoSemDistribuidor(cru)
        return (quadros, recusada ? RevisaoDeAfirmacoes.respostaSegura : cru, recusada)
    }

    @Test("toda frase aposentada com destinatário de EQUIPE é recusada — e o texto do modelo some")
    func recusaTodaAposentada() {
        // O oráculo: o trecho ofensor tem que estar AUSENTE da saída. Antes se
        // afirmava que a saída "parecia limpa", e a cauda acrescentada
        // garantia isso sozinha, qualquer que fosse a entrada.
        let runtime = try! NSRegularExpression(
            pattern: ClaimPatterns.destinatarioRuntime, options: [.caseInsensitive])
        var cobertas = 0, foraDoRuntime: [String] = []
        for f in claims()["frases_aposentadas"] as! [[String: String]] {
            let linha = f["linha"]!
            let r0 = runtime.rangeOfFirstMatch(in: linha, range: NSRange(linha.startIndex..., in: linha))
            guard r0.location != NSNotFound else { foraDoRuntime.append(linha); continue }
            cobertas += 1
            for (forma, texto) in [("direto", linha),
                                   ("em lista", "Como funciona:\n- \(linha)\nAlgo mais?"),
                                   ("com milhar", linha + " São R$ 1.250,00 no total.")] {
                let r = simularVolta(texto)
                #expect(r.recusada, "não recusou (\(forma)): \(linha)")
                #expect(r.final == RevisaoDeAfirmacoes.respostaSegura,
                        "saída não é a resposta segura (\(forma)): \(r.final)")
                #expect(!r.final.contains(linha), "o texto do modelo vazou (\(forma))")
            }
        }
        #expect(cobertas >= 20, "o corpo encolheu — só \(cobertas) frases exercitam o runtime")

        // A LACUNA, PINADA. As frases que sobram apontam pra um DINER pronoun
        // ("pra gente", "com você", "deles") — palavras que, na boca do
        // assistente, querem dizer as pessoas da mesa, e que por isso saíram
        // da lista de runtime. Não é descuido: está escrito em
        // `_porque_lista_runtime`, e o censo de BUILD continua pegando todas.
        // Fica afirmado aqui pra que a lacuna não possa crescer em silêncio.
        let pronome = try! NSRegularExpression(
            pattern: "pra gente|para n[óo]s|\\bto us\\b|para nosotros|\\bdeles\\b|\\bdelas\\b|com voc[êe]|\\beles\\b|pessoal",
            options: [.caseInsensitive])
        for linha in foraDoRuntime {
            let r = pronome.rangeOfFirstMatch(in: linha, range: NSRange(linha.startIndex..., in: linha))
            #expect(r.location != NSNotFound,
                    "frase fora do runtime sem ser da classe pronome — a lacuna cresceu: \(linha)")
        }
        // Seis hoje, todas da classe pronome. O número é afirmado pra que
        // acrescentar uma sétima seja uma decisão, não um efeito colateral.
        #expect(foraDoRuntime.count <= 6, "a lacuna do runtime cresceu pra \(foraDoRuntime.count)")
    }

    @Test("texto legítimo sai IDÊNTICO — byte a byte, nada recortado")
    func legitimoSaiIntacto() {
        // Inclui os casos em que a versão anterior apagava valores: oração
        // unida por vírgula, e `fica com a gente` como ATRIBUIÇÃO DA DIVISÃO
        // num app cujo propósito é dizer de quem é cada item.
        let legitimos = [
            "A picanha ficou R$ 92,00 e dá R$ 30,67 pra cada.",
            "Tirei o serviço. Sua parte agora é R$ 39,10.",
            "Inclui R$ 12,00 de serviço. O restaurante distribui à equipe, como manda a lei.",
            "Já tirei o serviço. A sobremesa de R$ 32,00 fica com a gente e o resto, R$ 118,40, com você.",
            "A gorjeta arrecadada é remuneração do time e passa pela folha de pagamento da casa.",
            "O serviço de 10% está incluído. A sobremesa fica com você, e o café fica com a gente.",
        ]
        for texto in legitimos {
            let r = simularVolta(texto)
            #expect(!r.recusada, "recusou o que estava certo: \(texto)")
            #expect(r.final == texto, "mexeu no texto: \(r.final)")
        }
    }

    @Test("se a volta mudou, nenhum valor foi reescrito — ou sai inteiro, ou não sai")
    func nuncaReescreveValor() {
        // A propriedade que faltava. A versão anterior tinha três casos
        // escolhidos a dedo, todos com o valor numa oração DIFERENTE da do
        // gatilho, e por isso não via o caso da vírgula.
        let comValores = [
            "Beleza! O serviço de R$ 24,00 é do pessoal, e o Gui te deve R$ 51,20.",
            "A gorjeta de R$ 40,00 vai direto pro garçom. Sua parte é R$ 210,00.",
            "Já tirei o serviço. A sobremesa de R$ 32,00 fica com a gente.",
        ]
        for texto in comValores {
            let r = simularVolta(texto)
            let valores = texto.split(separator: " ").filter { $0.contains(",") && $0.first!.isNumber }
            if r.final == texto { continue }            // saiu inteiro: nada a conferir
            // Mudou ⇒ a volta foi RECUSADA por inteiro, e a resposta segura não
            // finge carregar número nenhum do modelo.
            #expect(r.recusada, "mudou o texto sem recusar a volta: \(r.final)")
            for v in valores {
                #expect(!r.final.contains(v),
                        "a saída carrega um valor do modelo num texto recusado: \(v)")
            }
        }
    }

    @Test("durante o stream, nenhum quadro mostra afirmação — nem meia palavra")
    func streamNaoVaza() {
        // Três ordens, porque a versão anterior só testava a que tinha os dois
        // substantivos na mesma oração: a afirmação ANTES do substantivo da
        // gorjeta ficava congelada na tela o resto da volta.
        let textos = [
            "A gorjeta vai direto pro garçom. Pode pagar por Pix.",
            "Fica com a equipe, sim.\nÉ o serviço de 10%.",
            "Vai direto pra equipe. São os 10% de serviço que você deixou.",
            "Como funciona:\n- 10% de serviço\n- vai direto pro garçom\nAlgo mais?",
        ]
        let direcional = try! NSRegularExpression(
            pattern: ClaimPatterns.formaDirecional, options: [.caseInsensitive])
        for texto in textos {
            for quadro in simularVolta(texto).quadros {
                let r = direcional.rangeOfFirstMatch(
                    in: quadro, range: NSRange(quadro.startIndex..., in: quadro))
                #expect(r.location == NSNotFound, "quadro legível com a afirmação: \(quadro)")
            }
        }
    }

    @Test("o guarda usa os MESMOS padrões do censo de build")
    func mesmaRegraDoCenso() {
        let g = claims()
        #expect(g["substantivo_gorjeta"] as! String == ClaimPatterns.substantivoGorjeta)
        #expect(g["substantivo_destinatario"] as! String == ClaimPatterns.substantivoDestinatario)
        #expect(g["substantivo_destinatario_runtime"] as! String == ClaimPatterns.destinatarioRuntime)
        #expect(g["distribuidor_com_sujeito"] as! String == ClaimPatterns.distribuidorComSujeito)
        #expect((g["frases_aposentadas"] as! [[String: String]]).count >= 30)
    }

    @Test("nenhuma frase aprovada é recusada")
    func naoRecusaOCerto() {
        for f in claims()["frases_aprovadas"] as! [String] {
            #expect(!RevisaoDeAfirmacoes.afirmaDestinoSemDistribuidor(f), "falso positivo: \(f)")
        }
    }
}
