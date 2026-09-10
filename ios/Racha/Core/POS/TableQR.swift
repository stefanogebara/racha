import Foundation

/// What the QR sticker on the table actually carries.
///
/// The web app prints `<origin>/?t=<qr_token>` (`apps/web/src/Qrs.tsx`), so the
/// scanner has to accept that URL — and, because a camera in a bar reads
/// whatever is in frame, reject everything else clearly rather than guessing.
///
/// The token is a **rotating** secret: `POST /api/tables/rotate` replaces it and
/// the old one goes dead. That is the whole security model of pay-at-table —
/// possession of the sticker is what proves you are sitting there — so the token
/// is treated as a credential: never logged, never persisted in the event log,
/// never shown in the UI.
struct TableQR: Equatable, Sendable {
    /// The opaque table token. Credential: keep it out of logs and events.
    let token: String
    // O inicializador memberwise sintetizado é `internal`, então qualquer
    // arquivo do módulo montava um `TableQR` com origem arbitrária sem passar
    // pelo `parse`. Ninguém fazia — e "ninguém faz" é convenção, não estrutura.
    // Privado, a lista de permissão passa a ser inevitável.
    /// Where the check lives. Taken from the QR's own origin — but only from an
    /// origin we already know. See `allowedHosts`.
    let origin: URL

    /// The hosts a scanned sticker is allowed to name.
    ///
    /// This used to be "any https or http origin", so a venue on a white-label
    /// domain would work without a client release. That convenience is a
    /// payment-redirection primitive: a sticker pasted over a real table's QR,
    /// encoding `https://attacker.example/?t=anything`, points the app at
    /// someone else's server and the app renders the response as a Racha bill —
    /// their amounts, their Pix key, our chrome. It is the ordinary Brazilian
    /// QR-sticker fraud, with the native client removing the one defence a
    /// browser gives: a visible address bar. `http` was accepted too.
    ///
    /// White-label stays possible; it just stops being self-service for whoever
    /// holds a printer. The next step is fetching onboarded domains from our own
    /// API and merging them here — until then the list is what ships.
    /// Found by the security review of 2026-09-10.
    ///
    /// `racha-gray.vercel.app` ESTÁ NA LISTA DE RELEASE, e tem que estar.
    ///
    /// Ele saiu daqui por uma rodada, pra DEBUG: um nome `*.vercel.app` mora no
    /// registrador de outra pessoa e volta a ser reivindicável se o projeto for
    /// renomeado ou apagado, e numa lista que decide se o app desenha o JSON de
    /// alguém como CONTA isso é caro. O raciocínio está certo e o remédio
    /// estava errado, pelo motivo mais simples possível: é o host que o
    /// `Qrs.tsx` IMPRIME no QR (`PROD_ORIGIN`), é o padrão do `CLIENT_URL`, e
    /// `racha.app` não resolve — não está registrado. Um build de release com a
    /// lista curta recusaria TODA mesa de verdade, e adesivo colado em mesa não
    /// se chama de volta.
    ///
    /// A mitigação do risco de registrador não é tirar da lista: é CONTINUAR
    /// DONO do projeto na Vercel. A saída é migrar `PROD_ORIGIN` pra um domínio
    /// nosso, servir o antigo com redirect enquanto houver folha impressa
    /// apontando pra ele, girar as folhas (`POST /api/tables/rotate`) e só
    /// então encurtar esta lista. Nessa ordem.
    ///
    /// Falha fechada, então não era buraco — era o produto quebrado. Achado da
    /// revisão de segurança de 2026-09-10, contra uma correção que eu tinha
    /// acabado de fazer por causa da revisão de compliance. Quando os dois
    /// portões discordam, quem decide é o que o produto FAZ.
    static let allowedHosts: Set<String> = ["racha.app", "www.racha.app", "racha-gray.vercel.app"]

    /// A origem é aceitável? `https` e um host que a gente já conhece.
    ///
    /// Uma FUNÇÃO, e não uma linha repetida em dois lugares, porque foi
    /// justamente isso que deu errado: o guarda entrou no ramo da URL e não no
    /// ramo do código digitado, e a frase que eu escrevi no mapa de dados
    /// ("agora há lista de permissão e https obrigatório") ficou mais estreita
    /// que o código. As duas revisões acharam o mesmo buraco separadamente.
    static func isAllowedOrigin(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else { return false }
        return allowedHosts.contains(host)
    }

    private init(token: String, origin: URL) {
        self.token = token
        self.origin = origin
    }

    /// Parse a scanned string. Accepts the printed URL form; a bare token is
    /// accepted only with an explicit fallback origin, which is what the
    /// "type the code" path passes.
    static func parse(_ scanned: String, defaultOrigin: URL? = nil) -> TableQR? {
        let trimmed = scanned.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // `https` only: plaintext would let anyone on the café wifi rewrite the
        // bill on the way to the phone.
        if let url = URL(string: trimmed), url.scheme?.lowercased() == "https" {
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let token = components.queryItems?.first(where: { $0.name == "t" })?.value,
                  isPlausibleToken(token) else { return nil }
            var originComponents = URLComponents()
            originComponents.scheme = components.scheme
            originComponents.host = components.host
            originComponents.port = components.port
            guard let origin = originComponents.url, isAllowedOrigin(origin) else { return nil }
            return TableQR(token: token, origin: origin)
        }

        // Not a URL: the manual-entry path, where the origin is the app's own.
        //
        // O MESMO guarda. Este ramo ficou de fora na primeira versão e o
        // `defaultOrigin` entrava direto na struct — e quem o fornece é o
        // `RachaEnvironment.origin`, que aceitava qualquer host de um
        // `UserDefaults` e `http` junto. O primitivo que o ramo de cima fechou
        // continuava alcançável pelo "digitar o código".
        guard let defaultOrigin, isAllowedOrigin(defaultOrigin), isPlausibleToken(trimmed) else { return nil }
        return TableQR(token: trimmed, origin: defaultOrigin)
    }

    /// A cheap shape check so an unrelated QR (a wifi code, a Pix code, a
    /// business card) fails here instead of costing a network round trip.
    static func isPlausibleToken(_ token: String) -> Bool {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        return (4...128).contains(token.count)
            && token.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}
