import Foundation

/// Where this build talks to.
///
/// O comentário que estava aqui dizia que "o QR carrega a própria origem, então
/// uma casa white-label funciona sem release" — e ele continuou dizendo isso
/// depois que o `TableQR` passou a exigir lista de permissão. Dois arquivos
/// afirmando modelos de segurança opostos, e o desatualizado era o que
/// PRODUZIA a origem. Reescrito junto com o guarda.
///
/// Hoje: a origem é sempre uma da `TableQR.allowedHosts`. É o padrão do "digitar
/// o código" e o jeito de saber se o build tem backend.
enum RachaEnvironment {
    /// Overridable at launch (`-RachaOrigin https://staging…`) so QA can point a
    /// debug build at staging without a rebuild.
    ///
    /// SÓ EM DEBUG, e só pra um host da lista. Aceitava qualquer host, e o teste
    /// de esquema era `hasPrefix("http")` — que é verdade pra `http://` também.
    /// Como isto alimenta o `defaultOrigin` do `TableQR.parse`, era o caminho de
    /// volta pro primitivo de desvio de pagamento que a lista de permissão
    /// tinha acabado de fechar: qualquer host, em texto claro, num build de
    /// release. Achado pelas duas revisões de 2026-09-10, separadamente.
    static var origin: URL {
        #if DEBUG
        if let raw = UserDefaults.standard.string(forKey: "RachaOrigin"),
           let url = URL(string: raw), TableQR.isAllowedOrigin(url) {
            return url
        }
        #endif
        // O host que de fato responde. `racha.app` é o nome que a gente quer e
        // ele NÃO RESOLVE — não está registrado — enquanto `Qrs.tsx` imprime
        // `racha-gray.vercel.app` no QR e o `CLIENT_URL` cai nele. O padrão de
        // um cliente nativo não pode ser um domínio morto; vira `racha.app` no
        // dia em que `racha.app` servir o produto, junto com o `PROD_ORIGIN`.
        return URL(string: "https://racha-gray.vercel.app")!
    }

    /// Demo mode: no backend, everything through `DemoTableSource`. On by
    /// default in the simulator and in a debug build, so the app keeps its
    /// promise of running with no key and no network.
    static var isDemo: Bool {
        if UserDefaults.standard.object(forKey: "RachaDemo") != nil {
            return UserDefaults.standard.bool(forKey: "RachaDemo")
        }
        #if targetEnvironment(simulator)
        return true
        #elseif DEBUG
        return true
        #else
        return false
        #endif
    }

    /// The source this build reads tables from.
    static var tableSource: any TableSource {
        isDemo ? DemoTableSource() : BackendTableSource()
    }
}
