import Testing
import Foundation
@testable import Racha

/// O guarda de RUNTIME, e o acoplamento dele com `docs/compliance/claims.json`.
///
/// Duas coisas separadas aqui, e a segunda é a que costuma faltar: que a regra
/// funciona, e que ela é a MESMA regra que o censo de build usa. Duas cópias
/// da mesma política em linguagens diferentes divergem sozinhas — foi o que a
/// revisão chamou de "cópia declarada, não cópia esquecida" no
/// `documentos.fixture.json`, e vale igual aqui.
@Suite("Revisão de afirmações em tempo de execução")
struct RevisaoDeAfirmacoesTests {

    private func claims() -> [String: Any] {
        let raiz = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RachaTests
            .deletingLastPathComponent()   // ios
            .deletingLastPathComponent()   // raiz
        let url = raiz.appending(path: "docs/compliance/claims.json")
        let dados = try! Data(contentsOf: url)
        let raiz2 = try! JSONSerialization.jsonObject(with: dados) as! [String: Any]
        return raiz2["gorjeta_destino"] as! [String: Any]
    }

    @Test("toda frase aposentada do claims.json é pega aqui também")
    func mesmaRegraDoCenso() {
        let g = claims()
        let aposentadas = g["frases_aposentadas"] as! [[String: String]]
        #expect(aposentadas.count >= 20, "o corpo encolheu — ou o caminho até o JSON quebrou")
        for f in aposentadas {
            let linha = f["linha"]!
            #expect(RevisaoDeAfirmacoes.afirmaDestinoSemDistribuidor(linha),
                    "escapou do guarda de runtime, mas o censo de build pega: \(linha)")
        }
    }

    @Test("nenhuma frase aprovada é acusada")
    func naoAcusaOCerto() {
        for f in claims()["frases_aprovadas"] as! [String] {
            #expect(!RevisaoDeAfirmacoes.afirmaDestinoSemDistribuidor(f), "falso positivo: \(f)")
        }
    }

    @Test("a oração errada é trocada e o resto da resposta fica de pé")
    func trocaSoAOracao() {
        let bruto = "A sua parte deu R$ 43,00. A gorjeta vai direto pro garçom. Quer pagar por Pix?"
        let saida = RevisaoDeAfirmacoes.corrigir(bruto)
        #expect(saida.contains("R$ 43,00"))
        #expect(saida.contains("Quer pagar por Pix?"))
        #expect(saida.contains(RevisaoDeAfirmacoes.sancionada))
        #expect(!saida.contains("direto pro garçom"))
        #expect(!RevisaoDeAfirmacoes.afirmaDestinoSemDistribuidor(saida))
    }

    @Test("texto sem afirmação nenhuma volta idêntico")
    func naoMexeNoQueEstaCerto() {
        for ok in ["A picanha ficou R$ 92,00 e dá R$ 30,67 pra cada.",
                   "Tirei o serviço. Sua parte agora é R$ 39,10.",
                   "Inclui R$ 12,00 de serviço. O restaurante distribui à equipe, como manda a lei."] {
            #expect(RevisaoDeAfirmacoes.corrigir(ok) == ok, "mexeu no que estava certo: \(ok)")
        }
    }

    @Test("a correção acontece durante o STREAM, não só no fim")
    func corrigeOracaoAOracao() {
        // O texto chega por pedaços. Enquanto a oração não fecha, não há o que
        // corrigir; assim que fecha, a afirmação errada nunca fica legível.
        let completo = "Claro. A gorjeta fica com a equipe. Algo mais?"
        var acumulado = ""
        var vistos: [String] = []
        for ch in completo {
            acumulado.append(ch)
            acumulado = RevisaoDeAfirmacoes.corrigir(acumulado)
            vistos.append(acumulado)
        }
        // Em nenhum instante do stream a afirmação errada esteve inteira na tela.
        for v in vistos {
            #expect(!v.contains("fica com a equipe."),
                    "a afirmação errada apareceu inteira durante o stream: \(v)")
        }
        #expect(vistos.last!.contains(RevisaoDeAfirmacoes.sancionada))
        #expect(vistos.last!.contains("Algo mais?"))
    }
}
