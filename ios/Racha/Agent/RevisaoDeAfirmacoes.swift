import Foundation

/// O ÚNICO LUGAR ONDE A AFIRMAÇÃO NASCE DEPOIS DO BUILD.
///
/// Todo censo deste repositório é de tempo de build. Nenhum deles pode ver o
/// que o assistente da mesa ESCREVE — esse texto não existe em artefato nenhum
/// até o cliente perguntar, e "pra onde vai o serviço?" é uma pergunta de mesa,
/// feita a quem está ali pra responder. A regra 9 do `SystemPrompt` inclina o
/// modelo; não impede.
///
/// Os padrões vêm do `ClaimPatterns.swift`, GERADO do `docs/compliance/claims.json`.
/// Eles já foram escritos duas vezes à mão e já divergiram em quatro tokens.
///
/// ── TRÊS ERROS DA PRIMEIRA VERSÃO, todos achados pelas revisões ────────────
///
/// 1. DETECÇÃO POR ORAÇÃO. A relevância era medida no texto inteiro mas a
///    decisão era tomada por fragmento entre `.`/`\n` — então toda afirmação
///    cujos dois substantivos caíam em fragmentos diferentes passava intacta.
///    Uma lista em Markdown ("- 10% de serviço\n- vai direto pro garçom"),
///    um valor com separador de milhar (`R$ 1.250,00`) ou um `etc.` bastavam.
///    Modelo responde "pra onde vai o serviço?" em lista o tempo todo. Agora a
///    DECISÃO é do texto todo; a oração só escolhe o que suprimir.
///
/// 2. SUBSTITUIÇÃO. Trocar a oração inteira pela frase sancionada fabrica uma
///    afirmação que o modelo não fez (num falso positivo) e apaga o que a
///    oração dizia de verdade (num verdadeiro). Medido: "Pronto, removi os 10%
///    de serviço — pode avisar a equipe." virava a frase da distribuição. O
///    cliente pede pra tirar o serviço (inegociável #3), o app tira, e o
///    guarda apagava a confirmação. Valores sumiam junto. Agora SUPRIME a
///    oração e ACRESCENTA a frase sancionada no fim: nada é fabricado no lugar
///    de nada, e nenhum número é reescrito.
///
/// 3. ORAÇÃO INCOMPLETA. Corrigir o fragmento que ainda está chegando destrói
///    frase correta cuja cláusula do distribuidor ainda não chegou — "A
///    gorjeta fica com a equipe — o restaurante distribui em folha" dispara em
///    "fica com a equipe". E o `AgentSession` realimentava o resultado no
///    acumulador, tornando a mutilação irreversível. Agora o acumulador fica
///    CRU, a exibição é derivada dele, e a oração em curso é SEGURADA enquanto
///    estiver afirmando destino: some por um instante em vez de aparecer
///    errada.
enum RevisaoDeAfirmacoes {

    static let sancionada = ClaimPatterns.sancionada

    private static let gorjeta = regex(ClaimPatterns.substantivoGorjeta)
    private static let destinatario = regex(ClaimPatterns.substantivoDestinatario)
    private static let distribuidor = regex(ClaimPatterns.distribuidorComSujeito)
    private static let revoga = regex(ClaimPatterns.revogaDispensa)
    private static let direcional = regex(ClaimPatterns.direcionalParaSuprimir)

    private static func regex(_ p: String) -> NSRegularExpression {
        // `try!` é deliberado: o padrão é constante e gerado. Se não compilar,
        // o app não tem guarda nenhum, e falhar alto no primeiro lançamento é
        // melhor que um `if let` que degrada em silêncio — a falha de
        // 2026-07-14 registrada no CLAUDE.md.
        try! NSRegularExpression(pattern: p, options: [.caseInsensitive])
    }

    private static func acha(_ re: NSRegularExpression, _ s: String) -> NSRange? {
        let r = re.rangeOfFirstMatch(in: s, range: NSRange(s.startIndex..., in: s))
        return r.location == NSNotFound ? nil : r
    }

    private static func casa(_ re: NSRegularExpression, _ s: String) -> Bool { acha(re, s) != nil }

    /// O texto é SEQUER relevante? Duas varreduras, sem alocar nada.
    ///
    /// Existe pro `AgentSession` poder perguntar barato a cada pedaço: o
    /// `corrigir` roda sobre o acumulado inteiro, e chamado a cada delta isso é
    /// O(n²) na thread principal — 1,9 s de CPU pra uma resposta de 8 KB, num
    /// Mac, medido pela revisão de segurança. Como o texto só CRESCE, uma vez
    /// que os dois substantivos apareceram eles não desaparecem: o chamador
    /// memoriza e para de perguntar. Antes disso, a pergunta custa duas
    /// varreduras lineares sem construir string nenhuma — e a resposta é
    /// quase sempre "não", que é o caso comum de uma conversa sobre a conta.
    static func podeSerRelevante(_ texto: String) -> Bool {
        casa(gorjeta, texto) && casa(destinatario, texto)
    }

    /// Este TEXTO afirma um destino sem dizer quem distribui?
    ///
    /// Do texto todo, não de uma oração: o substantivo da gorjeta e o do
    /// destinatário se separam em linhas diferentes com toda naturalidade.
    static func afirmaDestinoSemDistribuidor(_ texto: String) -> Bool {
        guard casa(gorjeta, texto), casa(destinatario, texto) else { return false }
        guard let d = acha(distribuidor, texto) else { return true }
        // A dispensa cai se houver negação na cláusula ou logo antes: "sem
        // passar pela folha de pagamento" não é a cláusula legal, é o contrário.
        let ns = texto as NSString
        let ini = max(0, d.location - 30)
        return casa(revoga, ns.substring(with: NSRange(location: ini, length: d.location - ini + d.length)))
    }

    /// A oração afirma destino COM FORMA DIRECIONAL? Só isto autoriza suprimir.
    ///
    /// Alta precisão, baixa cobertura — é o gatilho que falhou como DETECTOR
    /// na v2, e que aqui está no lugar certo: a ação destrutiva só age onde há
    /// certeza de forma. Ver `_porque_dois_limiares` no claims.json.
    /// Usada SÓ depois de `corrigir` ter julgado o texto inteiro — por isso
    /// aqui basta a forma. Exigir também os dois substantivos NESTA oração
    /// deixava passar exatamente o caso que motivou o conserto: numa lista
    /// ("- 10% de serviço" / "- vai direto pro garçom"), a oração que carrega
    /// a promessa não carrega o substantivo, que ficou na linha de cima.
    static func podeSuprimir(_ oracao: String) -> Bool { casa(direcional, oracao) }

    /// O que se mostra ao cliente.
    ///
    /// `parcial` = o texto ainda está chegando.
    static func corrigir(_ texto: String, parcial: Bool = false) -> String {
        guard afirmaDestinoSemDistribuidor(texto) else { return texto }

        var oracoes: [String] = []
        var atual = ""
        for ch in texto {
            atual.append(ch)
            if ch == "." || ch == "!" || ch == "?" || ch == "\n" { oracoes.append(atual); atual = "" }
        }
        if !atual.isEmpty { oracoes.append(atual) }

        // ENQUANTO CHEGA: segura tudo a partir da oração onde a afirmação se
        // completa. Uma afirmação que atravessa orações ("- 10% de serviço\n-
        // vai pro garçom") não é pega por nenhuma oração isolada, então
        // suprimir por oração deixaria o texto inteiro legível até o fim do
        // stream. Segurar some com o trecho por um instante; é o único jeito
        // de a promessa "nunca fica legível" ser verdade em vez de aproximada.
        if parcial {
            var prefixo: [String] = []
            for o in oracoes {
                let tentativa = (prefixo + [o]).joined()
                if afirmaDestinoSemDistribuidor(tentativa) { break }
                prefixo.append(o)
            }
            return prefixo.joined()
        }

        // FECHADO: suprime só o que tem FORMA DIRECIONAL — nunca uma oração
        // que apenas menciona a equipe — e ACRESCENTA a frase sancionada.
        // Acrescentar em vez de substituir é o que impede fabricar uma
        // afirmação no lugar de outra e apagar valores junto.
        let mantidas = oracoes.filter { !podeSuprimir($0) }
        var saida = mantidas.joined().trimmingCharacters(in: .whitespacesAndNewlines)
        let separador = saida.isEmpty ? "" : " "
        saida += separador + sancionada.prefix(1).uppercased() + sancionada.dropFirst() + "."
        return saida
    }
}
