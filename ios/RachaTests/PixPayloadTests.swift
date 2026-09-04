import Testing
@testable import Racha

@Suite("Pix BR Code")
struct PixPayloadTests {

    @Test("CRC-16/CCITT-FALSE bate no vetor canônico")
    func crcMatchesCanonicalVector() {
        // O teste padrão do CRC-16/CCITT-FALSE. Se isso quebra, todo QR gerado
        // pelo app é rejeitado pelo banco.
        #expect(PixPayload.crc16("123456789") == "29B1")
    }

    @Test("payload de exemplo do Bacen produz o CRC esperado")
    func bcbExamplePayload() {
        let body = "00020126360014BR.GOV.BCB.PIX0114+5561988888888"
                 + "520400005303986540510.005802BR5913FULANO DE TAL"
                 + "6008BRASILIA62070503***6304"
        #expect(PixPayload.crc16(body) == "EFA2")
    }

    @Test("o payload gerado se valida a si mesmo")
    func generatedPayloadValidates() {
        let payload = PixPayload.build(.init(
            key: "gui@exemplo.com", receiverName: "Guilherme Alves", city: "SAO PAULO",
            amount: Cents(4334), reference: "RACHABARDOZE", message: nil))
        #expect(PixPayload.isValid(payload))
        #expect(payload.hasPrefix("000201"))
        #expect(payload.contains("br.gov.bcb.pix"))
        #expect(payload.contains("54054334") == false)   // valor vai como "43.34"
        #expect(payload.contains("540543.34"))
    }

    @Test("valor formata a partir do inteiro, sem passar por float")
    func amountFormatting() {
        #expect(PixPayload.decimalString(Cents(4334)) == "43.34")
        #expect(PixPayload.decimalString(Cents(5)) == "0.05")
        #expect(PixPayload.decimalString(Cents(100_000)) == "1000.00")
        #expect(PixPayload.decimalString(Cents(4750)) == "47.50")
    }

    @Test("TLV usa comprimento de dois dígitos")
    func tlvLength() {
        #expect(PixPayload.tlv("00", "01") == "0002" + "01")
        #expect(PixPayload.tlv("59", "FULANO") == "5906FULANO")
    }

    @Test("acentos viram ASCII em vez de sumirem")
    func asciiFolding() {
        #expect(PixPayload.ascii("João Antônio", max: 25) == "JOAO ANTONIO")
        #expect(PixPayload.ascii("São Paulo", max: 15) == "SAO PAULO")
        #expect(PixPayload.ascii("Nome Muito Comprido Demais", max: 10).count <= 10)
    }

    @Test("referência vazia vira ***, que é o que os bancos aceitam")
    func emptyReference() {
        #expect(PixPayload.normalizeReference(nil) == "***")
        #expect(PixPayload.normalizeReference("") == "***")
        #expect(PixPayload.normalizeReference("Bar do Zé!") == "BARDOZE")
    }

    @Test("chaves são normalizadas por tipo")
    func keySanitisation() {
        #expect(PixPayload.sanitizeKey("123.456.789-09") == "12345678909")
        #expect(PixPayload.sanitizeKey("Gui@Exemplo.COM") == "gui@exemplo.com")
        #expect(PixPayload.sanitizeKey("+55 11 98888-7777") == "+5511988887777")
    }

    @Test("sem chave salva, não sai código nenhum")
    func noKeyNoPayload() {
        let receiver = Participant(name: "Ju", pixKey: nil)
        let sender = Participant(name: "Eu")
        let transfer = Transfer(from: sender.id, to: receiver.id, amount: Cents(1000))
        #expect(PixPayload.forSettlement(transfer: transfer, receiver: receiver,
                                         sender: sender, rachaTitle: "Bar") == nil)
    }

    @Test("um byte alterado invalida o payload")
    func tamperingIsDetected() {
        var payload = PixPayload.build(.init(
            key: "12345678909", receiverName: "ANA", city: "RIO",
            amount: Cents(1000), reference: nil, message: nil))
        #expect(PixPayload.isValid(payload))
        payload = payload.replacingOccurrences(of: "10.00", with: "90.00")
        #expect(!PixPayload.isValid(payload))
    }
}
