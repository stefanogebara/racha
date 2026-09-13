import Foundation

/// O ÚNICO LUGAR ONDE A AFIRMAÇÃO NASCE DEPOIS DO BUILD.
///
/// Todo guarda deste repositório é de tempo de build: o censo do
/// `claims.test.js` varre Swift, TSX, o protótipo publicado e as fontes dele.
/// Nenhum deles pode ver o que o assistente da mesa ESCREVE — esse texto não
/// existe em artefato nenhum até o cliente perguntar. E é a superfície que
/// mais provavelmente será perguntada: "pra onde vai o serviço?" é uma
/// pergunta de mesa, feita a quem está ali pra responder perguntas.
///
/// A regra 9 do `SystemPrompt.swift` instrui o modelo a usar a frase
/// sancionada. Instrução não é guarda: um prompt inclina, não impede. Achado
/// pela revisão de compliance de 2026-09-13, que chamou isto de "a maior
/// superfície não censada" e tinha razão.
///
/// A forma da regra é a mesma do `docs/compliance/claims.json`, e os
/// `RevisaoDeAfirmacoesTests` exigem que continue sendo: substantivo de
/// gorjeta + substantivo de destinatário, sem cláusula de distribuidor com
/// sujeito. O conectivo não é modelado — enumerá-lo foi o erro que custou
/// duas rodadas de revisão.
enum RevisaoDeAfirmacoes {

    /// A frase que o produto diz, nas quatro superfícies. Não é uma variação.
    static let sancionada = "o restaurante distribui à equipe, como manda a lei"

    private static let gorjeta = regex("gorjeta|gorjetas|servi(ç|c|ci)o|servi(ç|c|ci)os|service charge|\\btips?\\b|propina")
    private static let destinatario = regex(
        "equipe|equipo|\\bstaff\\b|\\bteam\\b|\\btime\\b|gar[çc]o[nm]s?|gar[çc]onete|atendente|pessoal\\b"
        + "|sal[ãa]o|funcion[áa]ri|colaborador|mozo|barman|cozinha|camarero|waiter|server\\b"
        + "|pra gente|pro pessoal|para n[óo]s|\\bto us\\b|para nosotros")
    private static let distribuidor = regex(
        "(restaurante|restaurant|\\bcasa\\b|house|venue|estabelecimento)[^.;]{0,50}(distribu|reparte|repassa|liquida)"
        + "|(distribu|reparte|repassa|liquida)[^.;]{0,60}(restaurante|restaurant|\\bcasa\\b|house|venue|estabelecimento|CNPJ)"
        + "|folha de pagamento|passa pela folha|payroll|n[óo]mina")

    private static func regex(_ p: String) -> NSRegularExpression {
        // `try!` é deliberado: o padrão é constante e literal. Se ele não
        // compilar, o app não tem guarda nenhum e falhar alto no primeiro
        // lançamento é melhor que um `if let` que degrada em silêncio — que é
        // exatamente a falha de 2026-07-14 registrada no CLAUDE.md.
        try! NSRegularExpression(pattern: p, options: [.caseInsensitive])
    }

    private static func casa(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// Esta frase afirma um destino sem dizer quem distribui?
    static func afirmaDestinoSemDistribuidor(_ frase: String) -> Bool {
        casa(gorjeta, frase) && casa(destinatario, frase) && !casa(distribuidor, frase)
    }

    /// Troca a frase ofensora pela sancionada, preservando o resto do texto.
    ///
    /// Troca por FRASE, não o texto inteiro: uma resposta que explica a conta
    /// e erra numa oração continua útil nas outras. E é o que permite rodar
    /// isto durante o streaming — a cada oração FECHADA — em vez de só no
    /// fim, o que deixaria a afirmação errada visível por um segundo.
    static func corrigir(_ texto: String) -> String {
        guard casa(gorjeta, texto), casa(destinatario, texto) else { return texto }
        var saida = ""
        var frase = ""
        for ch in texto {
            frase.append(ch)
            if ch == "." || ch == "!" || ch == "?" || ch == "\n" {
                saida += troca(frase)
                frase = ""
            }
        }
        saida += troca(frase)
        return saida
    }

    private static func troca(_ frase: String) -> String {
        guard afirmaDestinoSemDistribuidor(frase) else { return frase }
        // Preserva a pontuação final e o espaço que vem depois, pro texto não
        // se emendar na oração seguinte.
        let cauda = frase.suffix(while: { $0 == " " || $0 == "\n" })
        let corpo = frase.dropLast(cauda.count)
        let fim = corpo.last.map { ".!?\n".contains($0) ? String($0) : "." } ?? "."
        return "O " + sancionada + fim + cauda
    }
}

private extension String {
    /// Sufixo enquanto o predicado valer — usado pra não comer o espaço entre orações.
    func suffix(while predicado: (Character) -> Bool) -> String {
        String(reversed().prefix(while: predicado).reversed())
    }
}
