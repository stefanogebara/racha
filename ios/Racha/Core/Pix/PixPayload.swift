import Foundation

/// Builds a Pix **BR Code** (copia-e-cola / QR payload) per the Banco Central
/// spec, which is EMVCo's Merchant-Presented QR with a Brazilian merchant account
/// template.
///
/// The format is TLV all the way down: every field is `ID(2) + length(2) +
/// value`, nested. The last field is always `63` — the CRC16, computed over the
/// entire payload *including* the literal "6304" header of the CRC field itself.
/// That self-referential detail is the classic bug: build the string, append
/// "6304", CRC the whole thing, then append the four hex digits.
///
/// Two things this deliberately does NOT do:
///
/// - It never routes a gratuity to a personal key. CLAUDE.md non-negotiable #2:
///   the 10% is employee remuneration settled to the restaurant's CNPJ through
///   payroll. `PixPayload.forVenue` pays the *house*, gratuity included, to the
///   house's own key; `forSettlement` builds friend-to-friend transfers for the
///   case where one person covered another, and never carries the 10%.
/// - It never invents a key. A payload without a real key would produce a QR that
///   scans and then fails in the bank app, which is worse than no QR.
enum PixPayload {

    struct Input {
        /// The receiver's Pix key: CPF/CNPJ (digits), phone (+55…), e-mail, or
        /// a 32-char EVP random key.
        var key: String
        /// Receiver's name, ≤ 25 chars per spec.
        var receiverName: String
        /// Receiver's city, ≤ 15 chars per spec.
        var city: String
        /// The amount. Omit for a "receiver types the value" code.
        var amount: Cents?
        /// Free-text reference, ≤ 25 chars, uppercase alphanumeric in practice.
        var reference: String?
        /// Optional message shown in the payer's bank app.
        var message: String?
    }

    /// Emit the copia-e-cola string.
    static func build(_ input: Input) -> String {
        var payload = ""
        payload += tlv("00", "01")                                    // payload format indicator
        // 01 = static (reusable); "12" would mark it single-use. A split code is
        // scanned once by one person, but static keeps it re-openable if their
        // bank app drops the sheet — which happens, in a loud bar, at 15% battery.
        payload += tlv("01", "11")

        var merchant = tlv("00", "br.gov.bcb.pix")
        merchant += tlv("01", sanitizeKey(input.key))
        if let message = input.message, !message.isEmpty {
            merchant += tlv("02", ascii(message, max: 72))
        }
        payload += tlv("26", merchant)

        payload += tlv("52", "0000")                                  // merchant category: unspecified
        payload += tlv("53", "986")                                   // ISO 4217 numeric for BRL
        if let amount = input.amount, amount.raw > 0 {
            payload += tlv("54", decimalString(amount))
        }
        payload += tlv("58", "BR")
        payload += tlv("59", ascii(input.receiverName, max: 25))
        payload += tlv("60", ascii(input.city, max: 15))

        let reference = normalizeReference(input.reference)
        payload += tlv("62", tlv("05", reference))

        payload += "6304"
        return payload + crc16(payload)
    }

    /// A diner's share, payable to the house. This is the product's payment: the
    /// venue's key, the venue's legal name, the amount of one person's part, and
    /// the comanda as the reference so the restaurant can reconcile it. Returns
    /// nil when the venue has no key on file — the sheet then says so instead of
    /// showing a code that cannot work.
    static func forVenue(_ venue: Venue, amount: Cents, comanda: String,
                         payer: Participant) -> String? {
        guard let key = venue.pixKey, !key.isEmpty, amount.raw > 0 else { return nil }
        return build(Input(
            key: key,
            receiverName: venue.legalName,
            city: venue.city,
            amount: amount,
            reference: "RACHA\(comanda)",
            message: "\(venue.name) — parte de \(payer.shortName)"
        ))
    }

    /// A friend-to-friend settlement code, built from the transfer plan. Returns
    /// nil when the receiver has no Pix key on file — the UI then asks for it
    /// rather than showing a code that cannot work.
    static func forSettlement(transfer: Transfer, receiver: Participant,
                              sender: Participant, rachaTitle: String,
                              city: String = "SAO PAULO") -> String? {
        guard let key = receiver.pixKey, !key.isEmpty else { return nil }
        return build(Input(
            key: key,
            receiverName: receiver.name,
            city: city,
            amount: transfer.amount,
            reference: "RACHA\(shortCode(rachaTitle))",
            message: "\(rachaTitle) — parte de \(sender.shortName)"
        ))
    }

    // MARK: - TLV plumbing

    /// `ID + two-digit length + value`. Length is the count of *characters* in the
    /// value as the spec counts them (the spec's charset is single-byte).
    static func tlv(_ id: String, _ value: String) -> String {
        let length = String(format: "%02d", value.count)
        return id + length + value
    }

    /// Amount as "123.45" — a period, always two decimals, no thousands
    /// separator. Built from the integer, so no float ever formats money here.
    static func decimalString(_ amount: Cents) -> String {
        let magnitude = abs(amount.raw)
        return "\(magnitude / 100).\(String(format: "%02d", magnitude % 100))"
    }

    /// The spec's charset is effectively ASCII. Accents are folded rather than
    /// dropped, so "João" becomes "Joao" and not "Jo".
    static func ascii(_ text: String, max limit: Int) -> String {
        let folded = text.folding(options: .diacriticInsensitive, locale: Locale(identifier: "pt_BR"))
        let filtered = folded.unicodeScalars.filter { $0.isASCII && $0.value >= 32 && $0.value < 127 }
        return String(String.UnicodeScalarView(filtered)).uppercased().prefix(limit).description
            .trimmingCharacters(in: .whitespaces)
    }

    /// Reference field (`62/05`). "***" is the spec's "no reference" sentinel;
    /// several bank apps reject an empty value outright.
    static func normalizeReference(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "***" }
        let allowed = CharacterSet.alphanumerics
        let cleaned = raw.folding(options: .diacriticInsensitive, locale: nil)
            .uppercased()
            .unicodeScalars.filter { allowed.contains($0) && $0.isASCII }
        let s = String(String.UnicodeScalarView(cleaned)).prefix(25)
        return s.isEmpty ? "***" : String(s)
    }

    /// CPF/CNPJ keys travel as bare digits; phone keys need the +55 prefix;
    /// e-mail and EVP keys go through untouched (lowercased for e-mail).
    static func sanitizeKey(_ key: String) -> String {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.contains("@") { return trimmed.lowercased() }
        let digits = trimmed.filter(\.isNumber)
        if digits.count == 11 && trimmed.hasPrefix("+") { return "+\(digits)" }
        if digits.count == 11 || digits.count == 14, trimmed.allSatisfy({ $0.isNumber || $0 == "." || $0 == "-" || $0 == "/" }) {
            return digits                                    // CPF or CNPJ
        }
        if digits.count == 13 && trimmed.hasPrefix("+") { return "+\(digits)" }   // +55DDNNNNNNNNN
        if digits.count == 11, trimmed.count == digits.count { return digits }
        return trimmed                                        // EVP / anything else, verbatim
    }

    /// CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no reflection,
    /// no final XOR. Uppercase hex, four digits.
    static func crc16(_ payload: String) -> String {
        var crc: UInt16 = 0xFFFF
        for byte in Array(payload.utf8) {
            crc ^= UInt16(byte) << 8
            for _ in 0..<8 {
                if crc & 0x8000 != 0 {
                    crc = (crc << 1) ^ 0x1021
                } else {
                    crc <<= 1
                }
            }
        }
        return String(format: "%04X", crc)
    }

    /// Validate a payload someone pasted in: the trailing CRC must match a CRC
    /// recomputed over everything before it.
    static func isValid(_ payload: String) -> Bool {
        guard payload.count > 8 else { return false }
        let body = String(payload.dropLast(4))
        guard body.hasSuffix("6304") else { return false }
        let given = String(payload.suffix(4)).uppercased()
        return crc16(body) == given
    }

    private static func shortCode(_ title: String) -> String {
        let folded = title.folded.filter(\.isLetter)
        return String(folded.prefix(8)).uppercased()
    }
}
