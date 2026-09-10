import Testing
import Foundation
@testable import Racha

@Suite("QR da mesa")
struct TableQRTests {

    @Test("lê a URL que o painel imprime")
    func printedURL() {
        let qr = TableQR.parse("https://racha.app/?t=abc123XYZ")
        #expect(qr?.token == "abc123XYZ")
        #expect(qr?.origin.absoluteString == "https://racha.app")
    }

    @Test("a origem vem do QR, mas só se for uma origem que a gente já conhece")
    func originMustBeKnown() {
        // Isto ACEITAVA qualquer domínio, pra uma casa white-label poder
        // imprimir o dela sem release do app. A conveniência é um primitivo de
        // desvio de pagamento: um adesivo colado sobre o QR da mesa, com
        // `https://atacante.example/?t=qualquer`, aponta o app pro servidor de
        // outra pessoa e o app desenha a resposta como conta do Racha. É a
        // fraude de adesivo de QR de sempre, com o app tirando a única defesa
        // que o navegador dava: a barra de endereço.
        #expect(TableQR.parse("https://racha.app/?t=tok_9")?.origin.absoluteString == "https://racha.app")
        #expect(TableQR.parse("https://menu.bardoze.com.br/?t=tok_9") == nil)
        #expect(TableQR.parse("https://racha.app.atacante.example/?t=tok_9") == nil)
        // Sem texto claro: na wifi do bar qualquer um reescreve a conta no meio
        // do caminho.
        #expect(TableQR.parse("http://racha.app/?t=tok_9") == nil)
    }

    @Test("QR que não é do Racha não vira mesa")
    func rejectsForeignCodes() {
        // The things a camera actually sees on a bar table.
        #expect(TableQR.parse("WIFI:S=BarDoZe;T=WPA;P=cerveja123;;") == nil)
        #expect(TableQR.parse("00020101021126400014br.gov.bcb.pix0118pix@bardoze.com.br") == nil)
        #expect(TableQR.parse("https://instagram.com/bardoze") == nil)   // sem ?t=
        #expect(TableQR.parse("") == nil)
    }

    @Test("a lista de release conhece o host que o QR realmente imprime")
    func allowlistCoversWhatWePrint() {
        // O `Qrs.tsx` imprime `PROD_ORIGIN` no cartão da mesa, e por uma rodada
        // esta lista não tinha esse host em release — um build publicado
        // recusaria toda mesa de verdade. Falha fechada, então não era buraco:
        // era o produto quebrado. O par (o que imprime, o que aceita) atravessa
        // dois idiomas e nada os obrigava a concordar; o censo do
        // `data-map.test.js` amarra os dois lados, e isto amarra o lado daqui.
        #expect(TableQR.allowedHosts.contains("racha.app"))
        #expect(TableQR.allowedHosts.contains("racha-gray.vercel.app"))
        #expect(TableQR.parse("https://racha-gray.vercel.app/?t=tok_9")?.token == "tok_9")
    }

    @Test("o código digitado também passa pela lista de permissão")
    func typedPathIsGuardedToo() {
        // O ramo que ficou de fora na primeira versão. `defaultOrigin` entrava
        // direto na struct, e quem o fornece (`RachaEnvironment.origin`)
        // aceitava qualquer host de um `UserDefaults`, `http` incluído. As duas
        // revisões acharam isto separadamente, e a lição é a do próprio commit:
        // a frase que descreve um guarda é escrita a partir do guarda que se
        // estava OLHANDO.
        #expect(TableQR.parse("abc123", defaultOrigin: URL(string: "https://atacante.example")!) == nil)
        #expect(TableQR.parse("abc123", defaultOrigin: URL(string: "http://racha.app")!) == nil)
        #expect(TableQR.parse("abc123", defaultOrigin: URL(string: "https://racha.app")!)?.token == "abc123")
    }

    @Test("token só é aceito sem URL quando alguém digitou")
    func bareTokenNeedsAnExplicitOrigin() {
        #expect(TableQR.parse("abc123") == nil)
        let typed = TableQR.parse("abc123", defaultOrigin: URL(string: "https://racha.app")!)
        #expect(typed?.token == "abc123")
    }

    @Test("recusa token com formato implausível antes de gastar rede")
    func shapeCheck() {
        let origin = URL(string: "https://racha.app")!
        #expect(TableQR.parse("ab", defaultOrigin: origin) == nil)              // curto demais
        #expect(TableQR.parse("tok com espaço", defaultOrigin: origin) == nil)
        #expect(TableQR.parse(String(repeating: "a", count: 200), defaultOrigin: origin) == nil)
    }
}

@Suite("Leitura da comanda")
struct BackendTableSourceTests {

    /// O shape real de `GET /api/check?t=…` (api/_lib/store/memory.js).
    private var payload: [String: Any] {
        [
            "venue": ["name": "Bar do Zé", "servicoBp": 1000],
            "table": ["label": "12"],
            "check": ["id": "chk_1", "items": [
                ["id": "i1", "name": "Picanha na chapa", "priceCents": 12900],
                ["id": "i2", "name": "Chopp 500ml (4x)", "priceCents": 6400]
            ]],
            "state": ["totalCents": 19300, "paidCents": 0, "status": "aberta"]
        ]
    }

    @Test("mapeia a conta viva pro modelo do app")
    func decodes() throws {
        let check = try BackendTableSource.decode(payload)
        #expect(check.venue.name == "Bar do Zé")
        #expect(check.venue.tableLabel == "Mesa 12")
        #expect(check.checkID == "chk_1")
        #expect(check.servicoBP == 1000)
        #expect(check.totalCents == Cents(19300))
        #expect(check.items.count == 2)
        #expect(!check.isInconsistent)
    }

    @Test("desdobra a quantidade que o Saipos embute no nome")
    func unfoldsQuantity() throws {
        // O adaptador Saipos escreve "Chopp 500ml (4x)" com o preço JÁ
        // multiplicado. Desdobrar é o que deixa o motor pesar "dois dos quatro".
        let check = try BackendTableSource.decode(payload)
        let chopp = try #require(check.items.first { $0.name.hasPrefix("Chopp") })
        #expect(chopp.name == "Chopp 500ml")
        #expect(chopp.quantity == 4)
        #expect(chopp.total == Cents(6400))
        #expect(chopp.unitPrice == Cents(1600))
        #expect(!chopp.isInconsistent)
    }

    @Test("preço que não é centavo inteiro é recusado, não adivinhado")
    func refusesNonIntegerPrice() {
        var bad = payload
        bad["check"] = ["id": "chk_1", "items": [["name": "Pudim", "priceCents": 18.5]]]
        #expect(throws: TableSourceError.self) { try BackendTableSource.decode(bad) }
    }

    @Test("conta sem id é mesa sem conta aberta")
    func noOpenCheck() {
        var empty = payload
        empty["check"] = ["items": []]
        #expect(throws: TableSourceError.noOpenCheck) { try BackendTableSource.decode(empty) }
    }

    @Test("rótulo de mesa é texto livre, como o servidor guarda")
    func freeTextLabel() throws {
        var varanda = payload
        varanda["table"] = ["label": "Varanda 2"]
        let check = try BackendTableSource.decode(varanda)
        #expect(check.venue.tableLabel == "Varanda 2")   // não vira "Mesa Varanda 2"
    }

    @Test("divergência entre itens e total é exposta, não corrigida")
    func inconsistencyIsSurfaced() throws {
        var off = payload
        off["state"] = ["totalCents": 20000, "paidCents": 0]
        let check = try BackendTableSource.decode(off)
        #expect(check.isInconsistent)
        #expect(check.totalCents == Cents(20000))       // o total impresso manda
    }
}

@Suite("Importar e re-escanear")
struct CheckImportTests {

    private func item(_ name: String, _ quantity: Int, _ cents: Int) -> LineItem {
        LineItem(name: name, quantity: quantity, unitPrice: Cents(cents / max(1, quantity)),
                 total: Cents(cents))
    }

    private func check(_ items: [LineItem]) -> OpenCheck {
        OpenCheck(venue: Venue(name: "Bar do Zé", legalName: "BAR DO ZE", city: "SAO PAULO",
                               pixKey: nil, checkID: "chk_1", label: "12"),
                  items: items, totalCents: items.map(\.total).total, paidCents: .zero,
                  servicoBP: 1000, checkID: "chk_1")
    }

    @Test("re-escanear não duplica o jantar")
    func rescanAddsOnlyWhatIsNew() {
        let picanha = item("Picanha na chapa", 1, 12900)
        let chopp = item("Chopp 500ml", 4, 6400)
        let existing = [picanha, chopp]
        // O garçom trouxe mais uma rodada.
        let novo = item("Caipirinha de limão", 2, 4800)
        let news = CheckImport.newItems(in: check([picanha, chopp, novo]), existing: existing)
        #expect(news.count == 1)
        #expect(news.first?.name == "Caipirinha de limão")
    }

    @Test("segunda rodada idêntica conta como item novo")
    func multiplicityCounts() {
        // Uma mesa pede mesmo dois chopps iguais em momentos diferentes; casar
        // só por nome esconderia o segundo.
        let chopp = item("Chopp 500ml", 1, 1600)
        let news = CheckImport.newItems(in: check([chopp, chopp]), existing: [chopp])
        #expect(news.count == 1)
    }

    @Test("nada novo, nada a acrescentar")
    func idempotent() {
        let picanha = item("Picanha na chapa", 1, 12900)
        #expect(CheckImport.newItems(in: check([picanha]), existing: [picanha]).isEmpty)
    }

    @Test("casa por nome dobrado, não pelo id do POS")
    func matchesOnFoldedName() {
        // O Saipos regenera ids entre leituras; acentuação e caixa variam.
        let existing = [item("Caipirinha de Limão", 2, 4800)]
        let scanned = [item("caipirinha de limao", 2, 4800)]
        #expect(CheckImport.newItems(in: check(scanned), existing: existing).isEmpty)
    }
}
