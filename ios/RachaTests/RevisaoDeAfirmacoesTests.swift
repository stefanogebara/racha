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

    @Test("toda frase aposentada é pega quando chega por STREAM, e em lista")
    func pegaEmFormatoDeVerdade() {
        // A v1 só passava as frases pelo `afirmaDestinoSemDistribuidor`, nunca
        // pelo `corrigir`, e nunca em formato de resposta de modelo. A detecção
        // era por ORAÇÃO, então bastava a afirmação atravessar um `.` ou uma
        // quebra de linha pra passar inteira: lista em Markdown, `R$ 1.250,00`,
        // um `etc.`. É como um modelo responde "pra onde vai o serviço?" na
        // maior parte das vezes. Achado pela revisão de segurança de 2026-09-13.
        for f in claims()["frases_aposentadas"] as! [[String: String]] {
            let linha = f["linha"]!
            for (forma, texto) in [("direto", linha),
                                   ("em lista", "Como funciona:\n- \(linha)\nAlgo mais?"),
                                   ("com milhar", linha + " São R$ 1.250,00 no total.")] {
                let saida = RevisaoDeAfirmacoes.corrigir(texto)
                #expect(!RevisaoDeAfirmacoes.afirmaDestinoSemDistribuidor(saida),
                        "sobrou afirmação (\(forma)): \(saida)")
            }
        }
    }

    @Test("nada do que o modelo disse é APAGADO — nem valor, nem confirmação")
    func naoApaga() {
        // Substituir a oração inteira fabricava afirmação num falso positivo e
        // apagava a verdade num verdadeiro: "Pronto, removi os 10% de serviço —
        // pode avisar a equipe." virava a frase da distribuição. O cliente pede
        // pra tirar o serviço (inegociável #3), o app tira, e o guarda apagava a
        // confirmação. Agora suprime só forma DIRECIONAL e ACRESCENTA o resto.
        let casos: [(String, [String])] = [
            ("Pronto, removi os 10% de serviço — pode avisar a equipe.", ["removi os 10% de serviço"]),
            ("O serviço de 10% dá R$ 24,00 e a equipe agradece.", ["R$ 24,00"]),
            ("A sua parte deu R$ 43,00. A gorjeta vai direto pro garçom. Quer pagar por Pix?",
             ["R$ 43,00", "Quer pagar por Pix?"]),
        ]
        for (entrada, precisaSobrar) in casos {
            let saida = RevisaoDeAfirmacoes.corrigir(entrada)
            for t in precisaSobrar {
                #expect(saida.contains(t), "apagou \(t) de: \(entrada) → \(saida)")
            }
        }
    }

    @Test("a frase sancionada sai sem artigo dobrado")
    func semArtigoDobrado() {
        // `"O " + sancionada` produzia "O o restaurante distribui…" — invisível
        // pros testes porque todos afirmavam `contains(sancionada)`, que um
        // prefixo dobrado satisfaz. É a única frase que o produto pode dizer
        // sobre gorjeta e saía com erro de digitação.
        let saida = RevisaoDeAfirmacoes.corrigir("A gorjeta vai direto pro garçom.")
        #expect(!saida.lowercased().contains("o o restaurante"), "\(saida)")
        #expect(saida.contains("O restaurante distribui à equipe, como manda a lei."), "\(saida)")
    }

    @Test("durante o stream a afirmação NUNCA fica legível, e o correto não é mutilado")
    func streamSeguro() {
        // Dois defeitos na mesma linha antes: o `AgentSession` realimentava o
        // corrigido no acumulador, e a oração EM CURSO era corrigida. Frase
        // correta cuja cláusula do distribuidor chega por último era cortada ao
        // meio e emendada na substituição. Agora o cru fica cru e a oração em
        // curso é SEGURADA — some por um instante em vez de aparecer errada.
        let textos = [
            "A gorjeta fica com a equipe — o restaurante distribui em folha, como manda a lei. Quer pagar por Pix?",
            "Como funciona:\n- 10% de serviço\n- vai direto pro garçom\nAlgo mais?",
            "A sua parte deu R$ 43,00. A gorjeta vai direto pro garçom. Pode pagar por Pix.",
        ]
        for texto in textos {
            var cru = ""
            for ch in texto {
                cru.append(ch)   // o acumulador NUNCA recebe o corrigido de volta
                let naTela = RevisaoDeAfirmacoes.corrigir(cru, parcial: true)
                #expect(!RevisaoDeAfirmacoes.afirmaDestinoSemDistribuidor(naTela),
                        "vazou durante o stream: \(naTela)")
            }
            let fim = RevisaoDeAfirmacoes.corrigir(cru)
            #expect(!RevisaoDeAfirmacoes.afirmaDestinoSemDistribuidor(fim), "\(fim)")
            #expect(fim.contains("Quer pagar por Pix?") || fim.contains("Algo mais?")
                    || fim.contains("Pode pagar por Pix."), "perdeu o resto da resposta: \(fim)")
        }
    }

    @Test("texto sem afirmação nenhuma volta idêntico")
    func naoMexeNoQueEstaCerto() {
        for ok in ["A picanha ficou R$ 92,00 e dá R$ 30,67 pra cada.",
                   "Tirei o serviço. Sua parte agora é R$ 39,10.",
                   "Inclui R$ 12,00 de serviço. O restaurante distribui à equipe, como manda a lei."] {
            #expect(RevisaoDeAfirmacoes.corrigir(ok) == ok, "mexeu no que estava certo: \(ok)")
        }
    }
}
