import Foundation

/// O ÚNICO LUGAR ONDE A AFIRMAÇÃO NASCE DEPOIS DO BUILD.
///
/// Todo censo deste repositório é de tempo de build. O que o assistente da mesa
/// ESCREVE não existe em artefato nenhum até o cliente perguntar — e "pra onde
/// vai o serviço?" é uma pergunta de mesa, feita a quem está ali pra responder.
/// A regra 9 do `SystemPrompt` inclina o modelo; não impede.
///
/// ── ESTE GUARDA NÃO EDITA TEXTO, E É A TERCEIRA VERSÃO ────────────────────
///
/// As duas primeiras tentaram consertar a frase do modelo cirurgicamente, e as
/// duas foram barradas por defeitos diferentes. A conta final de três rodadas
/// de revisão sobre a ideia de reescrever:
///
///  · APAGAVA DINHEIRO. A oração ia até o próximo `.`, então uma oração unida
///    por vírgula morria inteira: "O serviço de R$ 24,00 é do pessoal, e o Gui
///    te deve R$ 51,20." virava a frase sancionada, sem os dois valores e sem
///    a resposta à pergunta feita.
///  · APAGAVA A VERDADE. "Já tirei o serviço. A sobremesa de R$ 32,00 fica com
///    a gente" — `fica com a gente` é a ATRIBUIÇÃO DA DIVISÃO, num app cujo
///    propósito inteiro é dizer de quem é cada item. Falso positivo que apaga
///    um valor e o troca por uma frase sobre um serviço que acabou de sair.
///  · CARIMBAVA O PROIBIDO. Acrescentar a frase sancionada a um texto cuja
///    oração ofensora não pôde ser suprimida produz a promessa proibida COM
///    selo legal nosso embaixo — pior que não ter guarda nenhum.
///  · E O TESTE NÃO PODIA FALHAR: como o texto de saída sempre terminava com
///    "o restaurante distribui...", o oráculo `!afirmaDestinoSemDistribuidor`
///    era satisfeito pela própria cauda acrescentada. Apagar a metade
///    destrutiva inteira deixava 28 das 31 frases do corpo verdes. Isso é o
///    inegociável #7 mudado de lugar: guarda que não dispara não é guarda.
///
/// Então a edição saiu. O que resta tem modo de falha FINITO: a volta inteira
/// passa, ou a volta inteira não passa. Nada é recortado, nada é acrescentado,
/// nenhum número é reescrito e nenhuma frase nossa é pendurada na frase do
/// modelo. Uma recusa custa uma volta de conversa — e os valores vivem na
/// conta, não só no balão.
enum RevisaoDeAfirmacoes {

    /// O que se mostra no lugar da volta recusada. Não corrige o modelo: diz o
    /// que o produto tem a dizer e devolve a palavra pra pessoa.
    ///
    /// EM PORTUGUÊS, e só. O detector é trilíngue — o modelo pode responder em
    /// inglês ou espanhol e ser recusado — mas o app nativo é monolíngue: não
    /// há `.lproj`, e cada `Text(` dele é uma frase em português. Uma recusa
    /// em português numa volta em inglês é consistente com o resto da tela, e
    /// inventar aqui uma camada de idioma que o app não tem seria a única
    /// string localizada de um produto que não localiza. Quando o app ganhar
    /// idioma — se ganhar — esta frase entra junto, e não antes.
    /// Apontado pela revisão de segurança de 2026-09-13.
    static var respostaSegura: String {
        "Sobre o serviço: \(ClaimPatterns.sancionada). Pode perguntar de novo que eu respondo."
    }

    private static let gorjeta = regex(ClaimPatterns.substantivoGorjeta)
    // A lista de RUNTIME, mais curta: `a gente`, `você` e `pessoal` são as
    // pessoas da MESA quando quem fala é o assistente. Ver claims.json.
    private static let destinatario = regex(ClaimPatterns.destinatarioRuntime)
    private static let distribuidor = regex(ClaimPatterns.distribuidorComSujeito)
    private static let revoga = regex(ClaimPatterns.revogaDispensa)
    /// Alta precisão: uma oração com esta FORMA está afirmando destino,
    /// tenha ou não os dois substantivos dentro dela.
    private static let direcional = regex(ClaimPatterns.formaDirecional)

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

    /// Orações, separadas por `. ; ! ? \n`. A unidade do julgamento.
    private static func oracoes(_ texto: String) -> [String] {
        var fora: [String] = [], atual = ""
        for ch in texto {
            //  e travessão também separam oração: "o restaurante distribui, mas
            // não é bem assim: a gorjeta vai pro garçom" é uma promessa com uma
            // cláusula inocente na frente.
            if ".;!?:\n—".contains(ch) { if !atual.isEmpty { fora.append(atual) }; atual = "" }
            else { atual.append(ch) }
        }
        if !atual.isEmpty { fora.append(atual) }
        return fora
    }

    /// A oração NEGA o destino, em vez de afirmá-lo?
    ///
    /// O negador tem que vir ANTES do destinatário: "a gorjeta NÃO fica com o
    /// garçom" é a resposta certa; "vai pro garçom, SEM passar pela folha" é a
    /// promessa proibida com uma ressalva depois. A versão anterior olhava
    /// qualquer negador numa janela de 30 caracteres em volta do distribuidor,
    /// e por isso RECUSAVA a negação correta — a resposta mais direta que
    /// existe pra "a gorjeta vai pro garçom?" — enquanto deixava passar a
    /// afirmação proibida. Polaridade invertida nos dois sentidos.
    private static func nega(_ oracao: String) -> Bool {
        guard let d = acha(destinatario, oracao) else { return false }
        let ns = oracao as NSString
        return casa(revoga, ns.substring(to: d.location))
    }

    /// A oração carrega, ELA MESMA, a cláusula do distribuidor?
    private static func temDistribuidor(_ oracao: String) -> Bool {
        guard let d = acha(distribuidor, oracao) else { return false }
        let ns = oracao as NSString
        let ini = max(0, d.location - 30)
        // Negação DENTRO da cláusula do distribuidor derruba a dispensa: "sem
        // passar pela folha" não é a cláusula legal, é o contrário dela.
        return !casa(revoga, ns.substring(with: NSRange(location: ini, length: d.location - ini + d.length)))
    }

    /// Este texto afirma um destino sem dizer quem distribui?
    ///
    /// POR ORAÇÃO, e não pelo texto todo — e essa é a diferença que importa.
    /// Com o julgamento text-wide, a frase sancionada COLADA NO FIM desarmava
    /// o guarda inteiro: "A gorjeta fica com a equipe do salão. O restaurante
    /// distribui à equipe, como manda a lei." passava. E a regra 9 do
    /// `SystemPrompt` MANDA o modelo dizer exatamente essa frase — então a
    /// coisa com maior probabilidade de aparecer ao lado de qualquer resposta
    /// sobre gorjeta era a string que desligava a checagem. É a tautologia do
    /// oráculo de teste, mudada de lugar: antes o GUARDA acrescentava a frase
    /// e o teste se dava por satisfeito; depois o MODELO acrescenta a frase e
    /// o guarda se dá por satisfeito. Nomear quem distribui não desdiz o
    /// caminho já prometido, e pelo CDC art. 30 a primeira metade é que
    /// vincula. Achado pela revisão de segurança de 2026-09-13.
    ///
    /// Mas a detecção NÃO pode ser só por oração: a afirmação atravessa
    /// oração com toda naturalidade ("- 10% de serviço\n- vai pro garçom"),
    /// e foi por isso que ela virou text-wide na rodada anterior. Então as
    /// duas coisas, cada uma no seu lugar — a DETECÇÃO alcança o texto todo,
    /// a DISPENSA vale só na oração que a carrega.
    static func afirmaDestinoSemDistribuidor(_ texto: String) -> Bool {
        guard casa(gorjeta, texto), casa(destinatario, texto) else { return false }
        let partes = oracoes(texto)
        // 1. Uma oração que junta os dois substantivos tem que trazer o
        //    distribuidor ELA MESMA — ou estar negando.
        for o in partes where casa(gorjeta, o) && casa(destinatario, o) {
            if !nega(o) && !temDistribuidor(o) { return true }
        }
        // 1b. E a FORMA DIRECIONAL numa oração não é resgatável por cláusula
        //     de distribuidor nenhuma, nem na mesma oração: "a gorjeta vai pro
        //     garçom, o restaurante distribui à equipe" é a promessa proibida
        //     seguida de uma qualificação, e pelo CDC art. 30 é a primeira
        //     metade que vincula. Nomear quem distribui não desdiz o caminho
        //     já prometido — e a frase sancionada, que a regra 9 manda o modelo
        //     dizer, é justamente o que apareceria colado ali.
        // 2. Uma oração com FORMA DIRECIONAL afirma destino mesmo sem carregar
        //    os dois substantivos — e nenhuma cláusula de distribuidor NOUTRA
        //    oração a desfaz. Sem isto, a frase sancionada colada no fim
        //    lavava toda afirmação repartida entre orações, que é a mesma
        //    lavagem da regra 1 entrando pela porta da regra 3.
        for o in partes where casa(direcional, o) {
            if !nega(o) { return true }
        }
        // 3. Afirmação repartida entre orações: nenhuma junta os dois, mas o
        //    texto junta. Aí basta que ALGUMA oração nomeie o distribuidor.
        if partes.contains(where: { casa(gorjeta, $0) && casa(destinatario, $0) }) { return false }
        if partes.contains(where: nega) { return false }
        return !partes.contains(where: temDistribuidor)
    }

    /// Chegou perto do assunto? Então PARA DE MOSTRAR até dar pra julgar.
    ///
    /// Dispara com UM dos dois substantivos, não com os dois. Com os dois, a
    /// promessa "nunca fica legível" era falsa de dois jeitos: se a afirmação
    /// vinha numa oração ANTERIOR à do substantivo da gorjeta, ela ficava
    /// congelada na tela o resto da volta ("Fica com a equipe, sim." é a
    /// resposta mais provável a "a gorjeta fica com a equipe?"); e o segundo
    /// substantivo costuma ser a última palavra da frase, então a tela sempre
    /// chegava a um caractere do fim.
    static func chegouPertoDoAssunto(_ texto: String) -> Bool {
        casa(gorjeta, texto) || casa(destinatario, texto)
    }

    /// O que mostrar ENQUANTO chega, dado o acumulado cru.
    ///
    /// Antes de chegar perto do assunto, o texto inteiro — menos a última
    /// palavra incompleta, pra não exibir meia palavra que o julgamento ainda
    /// não alcançou. Depois, nada de novo: congela onde estava.
    static func parcialExibivel(_ texto: String) -> String {
        guard let corte = texto.lastIndex(where: { $0 == " " || $0 == "\n" }) else { return "" }
        return String(texto[..<texto.index(after: corte)])
    }
}
