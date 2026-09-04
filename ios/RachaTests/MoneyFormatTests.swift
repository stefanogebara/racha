import Testing
@testable import Racha

@Suite("Formato de dinheiro")
struct MoneyFormatTests {

    @Test("formata em pt-BR com separador de milhar")
    func formatting() {
        #expect(BRL.format(Cents(4750)) == "R$\u{00A0}47,50")
        #expect(BRL.format(Cents(0)) == "R$\u{00A0}0,00")
        #expect(BRL.format(Cents(5)) == "R$\u{00A0}0,05")
        #expect(BRL.format(Cents(123_456)) == "R$\u{00A0}1.234,56")
        #expect(BRL.format(Cents(100_000_000)) == "R$\u{00A0}1.000.000,00")
        #expect(BRL.format(Cents(-4750)) == "−R$\u{00A0}47,50")
    }

    @Test("moedas sem subunidade não ganham vírgula")
    func zeroExponentCurrencies() {
        #expect(BRL.format(Cents(500), currency: .jpy) == "¥\u{00A0}500")
        #expect(BRL.format(Cents(12_000), currency: .clp) == "$\u{00A0}12.000")
    }

    @Test("lê o que as pessoas digitam e colam")
    func parsing() {
        #expect(BRL.parse("47,50") == Cents(4750))
        #expect(BRL.parse("R$ 47,50") == Cents(4750))
        #expect(BRL.parse("1.234,56") == Cents(123_456))
        #expect(BRL.parse("1,234.56") == Cents(123_456))   // formato americano colado
        #expect(BRL.parse("47") == Cents(4700))
        #expect(BRL.parse("47.5") == Cents(4750))
        #expect(BRL.parse("1.234") == Cents(123_400))      // ponto de milhar, não decimal
        #expect(BRL.parse("0,05") == Cents(5))
        #expect(BRL.parse("") == nil)
        #expect(BRL.parse("abc") == nil)
    }

    @Test("nenhum float no caminho: 47.55 não vira 4754")
    func noFloatDrift() {
        // O caso clássico: 47.55 em Double é 47.549999999999997, e um
        // Int(valor * 100) devolve 4754. O parser inteiro não tem esse problema.
        #expect(BRL.parse("47,55") == Cents(4755))
        #expect(BRL.parse("8,70") == Cents(870))
        #expect(BRL.parse("1234,56") == Cents(123_456))
        for cents in 0...2000 {
            let text = BRL.format(Cents(cents), symbol: false)
            #expect(BRL.parse(text) == Cents(cents), "ida e volta falhou em \(cents)")
        }
    }

    @Test("mais casas do que a moeda tem arredonda meio pra cima")
    func extraDecimalsRound() {
        #expect(BRL.parse("47,999") == Cents(4800))
        #expect(BRL.parse("47,994") == Cents(4799))
    }

    @Test("negativo é lido como negativo")
    func negatives() {
        #expect(BRL.parse("-47,50") == Cents(-4750))
    }

    @Test("compacto para o card da timeline")
    func compactForm() {
        #expect(BRL.compact(Cents(123_456)) == "R$\u{00A0}1,2 mil")
        #expect(BRL.compact(Cents(4750)) == "R$\u{00A0}47,50")
    }

    @Test("câmbio converte em inteiro e trava a cotação")
    func fxConversion() {
        let rate = FXRate(from: "EUR", to: "BRL", microsPerUnit: 6_213_500, capturedAt: .now)
        // € 100,00 → R$ 621,35
        #expect(rate.convert(Cents(10_000), fromExponent: 2, toExponent: 2) == Cents(62_135))
        // ¥ 5000 (sem subunidade) → real, com correção de expoente.
        let jpy = FXRate(from: "JPY", to: "BRL", microsPerUnit: 36_400, capturedAt: .now)
        #expect(jpy.convert(Cents(5000), fromExponent: 0, toExponent: 2) == Cents(18_200))
    }
}
