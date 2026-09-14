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
    /// O que o NEGADOR pode negar. Ver `_porque_nucleo_negavel`.
    private static let negavel = regex(ClaimPatterns.nucleoNegavel)
    // A lista de RUNTIME, mais curta: `a gente`, `você` e `pessoal` são as
    // pessoas da MESA quando quem fala é o assistente. Ver claims.json.
    private static let destinatario = regex(ClaimPatterns.destinatarioRuntime)
    private static let distribuidor = regex(ClaimPatterns.distribuidorComSujeito)
    private static let revoga = regex(ClaimPatterns.revogaDispensa)
    /// Só os negadores; a evasão preposicional pertence ao distribuidor.
    private static let negador = regex(ClaimPatterns.negadores)
    /// Negador COLADO no destinatário — "o garçom NÃO fica", "o garçom QUE NÃO
    /// recebe". Sem `sem`: `sem` evade a cláusula do distribuidor e vem na
    /// CAUDA da própria promessa ("…pro garçom SEM passar pela folha"), onde
    /// nega a frase que acabou de ser feita em vez do destino.
    private static let negadorColado = regex(ClaimPatterns.negadorColado)
    /// Negador CONTRASTIVO: o negador colado no destinatário é seguido de
    /// OUTRO destino. "não PRA casa" retira o outro e afirma este; "não TEM
    /// gorjeta nenhuma" nega de verdade. Ver `_porque_contrastiva`.
    private static let contrasteColado = regex(ClaimPatterns.contrasteColado)
    private static let regenciaDoNucleo = regex(ClaimPatterns.regenciaDoNucleo)
    private static let sujeitoNominal = regex(ClaimPatterns.sujeitoNominal)
    /// Sujeito próprio em QUALQUER lugar do segmento — o `sujeitoNominal` é
    /// ancorado no fim porque julga PREFIXO. Ver `_porque_sintagma_nominal`.
    private static let sintagmaNominal = regex(ClaimPatterns.sintagmaNominal)
    private static let anaforaDeDinheiro = regex(ClaimPatterns.anaforaDeDinheiro)
    private static let destinatarioAmbiguo = regex(ClaimPatterns.destinatarioAmbiguo)
    /// O sujeito que o veto da regra 1b existe pra proteger. Ver o gêmeo.
    private static let naoDinheiro = regex(ClaimPatterns.substantivoNaoDinheiro)
    /// O cômodo POSSUÍDO — a relação, não a palavra. Ver `_porque_ambiguo`.
    private static let ambiguoPossuido = regex(ClaimPatterns.ambiguoPossuido)
    private static let palavraFuncional = regex(ClaimPatterns.palavraFuncional)

    /// Entre o negador e o núcleo só há material FUNCIONAL?
    ///
    /// Um negador que rege o destino é seguido de verbo, preposição e artigo
    /// até chegar nele. Um negador que nega OUTRA coisa traz conteúdo próprio
    /// no caminho — `sem DÚVIDA o garçom`, `não PRECISA DEIXAR MAIS NADA o
    /// garçom`. Ver `_porque_alcance_antes`: bastava uma interjeição com
    /// vírgula na frente pra CRIAR a âncora que abre a janela, e eram 144 de
    /// 144. Polaridade: palavra desconhecida = não alcança = recusa.
    /// SUBTRAÇÃO, não contagem. A versão anterior somava os CARACTERES
    /// cobertos e comparava com as LETRAS presentes: `a gente` cobre 7 e traz
    /// 6, `R$ 12,00` cobre 8 e traz 4. Toda alternativa com espaço dentro
    /// vendia folga, e a polaridade aqui é fail-open. Ver `_porque_alcance_antes`.
    private static func soFuncionalAteONucleo(_ vao: String) -> Bool {
        let restante = NSMutableString(string: vao)
        for m in palavraFuncional.matches(
            in: vao, range: NSRange(location: 0, length: (vao as NSString).length)) {
            let r = m.range(at: 1)
            restante.replaceCharacters(in: r, with: String(repeating: " ", count: r.length))
        }
        return !(restante as String).contains { $0.isLetter || $0.isNumber }
    }
    private static let evasaoQueLicencia = regex(ClaimPatterns.evasaoQueLicencia)
    private static let cabecaDirecional = regex(ClaimPatterns.cabecaDirecional)
    /// A cabeça do caminho fraco com preposição GENITIVA, ANCORADA no começo
    /// da oração. Ver `_porque_cabeca_genitiva`.
    private static let cabecaGenitiva = regex(ClaimPatterns.cabecaGenitiva)

    /// O negador atrás resgata? Duas perguntas, as duas já doutrina aqui.
    ///
    /// ORDEM: se antes dele já houve forma direcional, a promessa vinculou
    /// (CDC art. 30) e o que vem atrás qualifica, não desdiz — a mesma regra
    /// da 1b e a do distribuidor. ESCOPO: se logo depois dele vem OUTRO
    /// destino, é contraste, e contraste afirma.
    ///
    /// O que sobra é negação de verdade. Ver `_porque_alcance`: a versão
    /// anterior perguntava só pelo contraste e deixava passar 90 de 90 caudas
    /// que negam outra coisa ("não precisa deixar mais nada").
    private static func negadorResgata(_ antesDoNucleo: String, _ cauda: String) -> Bool {
        guard let m = acha(negadorColado, cauda) else { return false }
        let resto = (cauda as NSString).substring(from: m.location + m.length)
        // O NEGADOR ATRÁS RESGATA SE ALCANÇA A GORJETA, ou se não diz mais
        // nada além do verbo que ele nega. `não TEM GORJETA nenhuma`, `não
        // FICA COM A GORJETA` falam do dinheiro; `não recebe`, `não leva` são
        // a negação nua do predicado cujo sujeito é o próprio destinatário.
        // `não precisa DEIXAR MAIS NADA`, `não tem TAXA nenhuma` trazem
        // conteúdo próprio: negam outra coisa, e nada resgata uma afirmação já
        // feita (CDC art. 30).
        //
        // Substituiu um teste de REGÊNCIA por adjacência — a única peça do
        // arquivo que tinha ficado sem slot de modificador, declarada como tal
        // — e o fabricador a derrubou com uma palavra na primeira rodada:
        // `fica com ASSIM a equipe não precisa deixar mais nada`. Agora não há
        // adjacência nenhuma aqui. Achado pelo fabricador, 2026-09-14.
        // ORDEM, DE VOLTA. Eu tirei a pergunta junto com o instrumento errado
        // que a respondia (a lista de verbos), e nada mais passou a perguntar
        // se a promessa já tinha sido feita: `A gorjeta fica com o garçom, não
        // é mesmo.` — uma tag de confirmação — virava negação e resgatava,
        // 90 de 120, todas recusadas pelo commit anterior. E a mutação que
        // mediria isso saiu no MESMO commit, então os dois portões ficaram
        // verdes sobre uma regra que não existia mais.
        //
        // O instrumento certo é o que o `_porque_alcance` já nomeava: REGÊNCIA
        // do núcleo. Complemento oblíquo (`ao garçom`, `com a equipe`) é
        // dinheiro já mandado; núcleo nu é sujeito, e sujeito se nega. O slot
        // de modificador fica entre o ARTIGO e o núcleo — entre a preposição e
        // o artigo ele deixava `de HOJE o garçom` passar por oblíquo.
        // Achado pela revisão de segurança de 2026-09-14.
        // O QUE O NEGADOR PODE ESTAR NEGANDO É OUTRA LISTA, com a polaridade
        // ao contrário: mais palavras, mais resgate, menos recusa. Ver
        // `_porque_nucleo_negavel`.
        if casa(regenciaDoNucleo, antesDoNucleo) && !casa(negavel, resto) { return false }
        if !casa(negavel, resto) && !soFuncionalAteONucleo(resto) { return false }
        return !casa(contrasteColado, resto)
    }


    /// Alta precisão: uma oração com esta FORMA está afirmando destino,
    /// tenha ou não os dois substantivos dentro dela.
    private static let direcional = regex(ClaimPatterns.formaDirecional)
    /// Vírgula, `mas`, `porém`, `e sim`: daqui pra frente é outra afirmação.
    private static let separadorInterno = regex(ClaimPatterns.separadorInterno)
    /// Ponto entre DÍGITOS não fecha oração — ver o gêmeo no censo.
    private static let separadorDeOracao = regex(ClaimPatterns.separadorDeOracao)
    /// Abertura de cláusula ADVERSATIVA — ela qualifica a oração anterior.
    private static let adversativaInicial = regex(ClaimPatterns.adversativaInicial)
    private static let separadorDeClausula = regex(ClaimPatterns.separadorDeClausula)
    /// Uma frase de destino em QUALQUER lugar da oração — não só no começo.
    /// Ancorá-la no começo fazia qualquer palavra antes da preposição derrubar
    /// o casamento, e a mais provável é uma quantidade.
    /// Até dois MODIFICADORES entre o artigo e o núcleo — `to the FLOOR
    /// staff`. Sem eles esta pré-condição da regra 3 derrubava a própria
    /// frase que o corpus trilíngue usa. Ver `_porque_modificador`.
    private static let destinoEmQualquerLugar = regex(
        "(" + ClaimPatterns.preposicaoDeDestino + ")\\s+" + ClaimPatterns.modificadorDeDestino
        + "((" + ClaimPatterns.artigoDeDestino + ")\\s+)?" + ClaimPatterns.modificadorDeDestino
        + "(" + ClaimPatterns.destinatarioRuntime + ")")
    private static let cabecaDeDestino = regex(ClaimPatterns.cabecaDeDestino)
    private static let cabecaForte = regex(ClaimPatterns.cabecaForte)
    private static let pronomeSujeito = regex(ClaimPatterns.pronomeSujeito)
    private static let preposicaoRegendoPronome = regex(ClaimPatterns.preposicaoRegendoPronome)
    private static let verboFinito = regex(ClaimPatterns.verboFinito)
    private static let relativaQualquer = regex(ClaimPatterns.relativaQualquer)
    private static let genitivoDescritivo = regex(ClaimPatterns.genitivoDescritivo)

    /// A oração nomeia um destinatário que NÃO seja genitivo descritivo?
    ///
    /// "remuneração da equipe", "serviço da equipe", "gorjeta dos garçons" —
    /// o genitivo do próprio dinheiro diz DE QUEM ele é, não pra onde vai, e é
    /// a moldura legalmente certa. O censo de build já dispensa essa família;
    /// o runtime não tinha dispensa nenhuma e recusava o turno toda vez que o
    /// modelo repetia o texto que o `AgentTool` lhe ensina.
    /// Ver `_porque_genitivo_descritivo`.
    private static func destinatarioNaoAtributivo(_ oracao: String, _ clausula: String? = nil) -> Bool {
        // A DISPENSA É REVOGADA PELA MESMA CLÁUSULA QUE REVOGA O DISTRIBUIDOR.
        // Ela é a única regra deste arquivo que AFROUXA, e sem revogação virava
        // porta: "A renda dos garçons vem da sua gorjeta, SEM FOLHA." e "A verba
        // da equipe é a gorjeta que você deixa NA MÃO dela." passavam a escapar
        // — duas regressões medidas contra o commit anterior. Evasão cancela a
        // leitura benigna, que é exatamente o que o `revoga_dispensa` já faz do
        // outro lado.
        // A REVOGAÇÃO É LIDA NA ORAÇÃO INTEIRA, não no segmento: em `A renda
        // dos garçons vem da sua gorjeta, SEM FOLHA.` a evasão mora depois da
        // vírgula, e o genitivo que ela revoga mora antes.
        if casa(revoga, clausula ?? oracao) { return casa(destinatario, oracao) }
        let semGenitivo = genitivoDescritivo.stringByReplacingMatches(
            in: oracao, range: NSRange(location: 0, length: (oracao as NSString).length),
            withTemplate: " ")
        return casa(destinatario, semGenitivo)
    }

    /// O que sobra da oração depois da CABEÇA de destino — ou `nil` se ela não
    /// começa por uma. Ver `_porque_cabeca`: a pureza era uma whitelist
    /// ancorada nos dois lados e falhava ABERTO em tudo que não modelava.
    private static func restoDepoisDaCabeca(_ oracao: String) -> String? {
        cabecaValida(cabecaDeDestino, oracao)
    }

    /// A cabeça casa E o que vem antes dela não é outra oração. Devolve o resto.
    private static func cabecaValida(_ re: NSRegularExpression, _ oracao: String) -> String? {
        guard let m = acha(re, oracao) else { return nil }
        let ns = oracao as NSString
        // O QUE VEM ANTES DA CABEÇA TAMBÉM É JULGADO, pela mesma pergunta. A
        // cabeça era ancorada em `^`, e uma palavra de preâmbulo desligava a
        // regra 3 inteira: "Hoje 100% pro garçom", "No fim, 100% pra equipe",
        // "Então tudo pro garçom" — 60 de 65 numa grade de preâmbulos. O lado
        // direito deixou de ser whitelist nesta rodada; o esquerdo continuava
        // sendo, e falhava aberto do mesmo jeito.
        //
        // Adjunto antes não desmancha nada; oração inteira antes desmancha, e
        // é o que separa "Hoje 100% pro garçom" de "Você acerta com o garçom".
        // O prefixo é julgado só por SUJEITO SOLTO, não por verbo. Verbo
        // antes da cabeça costuma ser a cópula da própria afirmação de destino
        // ("É todo do garçom", "Vai tudo pro garçom"); sujeito novo é que faz
        // dela outra oração ("VOCÊ acerta com o garçom").
        // O prefixo é julgado por VERBO FINITO, não por sujeito. Verbo é o
        // que faz do prefixo outra oração — "O Gui PAGA tudo pro garçom",
        // "Mostra tudo pro garçom", "Você CONFIRMA tudo com o garçom" são
        // frases de conta, não promessas de destino. Pronome sozinho não é
        // oração: "ELA, 100% pro garçom." é a mesma promessa com anáfora na
        // frente, e julgar por sujeito a deixava escapar — a mesma anáfora que
        // derrubou a pré-condição uma rodada antes, um nível abaixo.
        // Achado pelas revisões de 2026-09-14.
        if casa(verboFinito, ultimoSegmento(ns.substring(to: m.location))) { return nil }
        return ns.substring(from: m.location + m.length)
    }

    /// O resto traz PREDICAÇÃO NOVA — sujeito solto ou verbo finito?
    ///
    /// Adjunto não desmancha uma frase de destino: "hoje", "do salão
    /// principal", "em dinheiro", "que cuidou de você". Oração nova desmancha:
    /// "você acerta na maquininha", "eles já sabem", "tá tudo certo".
    /// Ver `_porque_predicacao` — inclusive pela polaridade, que é o que
    /// permite ao `verboFinito` ser uma enumeração.
    /// Sujeito NOMINAL solto — determinante + substantivo não regido por
    /// preposição. `A COMANDA vai pro garçom` tem um; `Com A CONTA fechada,
    /// vai tudo pro garçom` não tem — ali o nominal é complemento do `com`.
    /// Ver `_porque_sujeito_nominal`.
    /// Só o ÚLTIMO segmento do prefixo. Uma vírgula não abre oração, então
    /// `Pode ficar tranquilo, 100% pro garçom.` punha um verbo no prefixo e
    /// desligava a regra inteira — 847 de 2400 variantes do corpo com doze
    /// preâmbulos comuns na frente. A regra 1b já fazia a pergunta ancorada no
    /// FIM do prefixo; a 3 era a chamadora esquecida. Ver
    /// `_porque_prefixo_por_segmento`.
    private static func ultimoSegmento(_ prefixo: String) -> String {
        let ns = prefixo as NSString
        var ini = 0
        for m in separadorDeClausula.matches(
            in: prefixo, range: NSRange(location: 0, length: ns.length)) {
            ini = max(ini, m.range.location + m.range.length)
        }
        return ns.substring(from: ini)
    }

    private static func temSujeitoNominal(_ trecho: String) -> Bool {
        let ns = trecho as NSString
        for m in sujeitoNominal.matches(in: trecho, range: NSRange(location: 0, length: ns.length)) {
            let p = m.range(at: 1).location
            if !casa(preposicaoRegendoPronome, ns.substring(to: p)) { return true }
        }
        return false
    }

    /// Sujeito SOLTO — pronome que não vem regido por preposição.
    private static func temSujeitoSolto(_ trecho: String) -> Bool {
        let ns = trecho as NSString
        for m in pronomeSujeito.matches(in: trecho, range: NSRange(location: 0, length: ns.length)) {
            let p = m.range(at: 1).location
            if !casa(preposicaoRegendoPronome, ns.substring(to: p)) { return true }
        }
        return false
    }

    private static func temPredicacao(_ resto: String) -> Bool {
        // A relativa sai antes: o verbo dela é da relativa, não da oração.
        let semRelativa = relativaQualquer.stringByReplacingMatches(
            in: resto, range: NSRange(location: 0, length: (resto as NSString).length), withTemplate: " ")
        if casa(verboFinito, semRelativa) { return true }
        // Pronome SUJEITO: o que não vem regido por preposição. Aqui a
        // adjacência é regência de fato — pronome não admite modificador.
        return temSujeitoSolto(semRelativa)
    }


    /// Marcador de lista: `- `, `* `, `• `, `+ `, `> `. (`\\d+[.)]` seria morto: a
    /// oração já vem cortada no ponto.) Ver `_porque_marcador`.
    private static let marcadorDeLista = regex(ClaimPatterns.marcadorDeLista)
    /// QUANTIDADE: o que distingue dinheiro DIRIGIDO de uma ação dirigida.
    /// Sem isto, exigir só a frase de destino recusava "Se quiser, mostra pro
    /// garçom." e "Fala com o maître na saída." — respostas certas, a primeira
    /// com o valor logo antes. `mostra pro garçom` é objeto indireto de uma
    /// ação; `100% pro garçom` é o dinheiro indo.
    private static let quantidade = regex(ClaimPatterns.quantidade)

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
    /// Ênfase de markdown NÃO é conteúdo, e forma composta NÃO é outra letra.
    ///
    /// `- **100%** pro garçom` era 6 de 6 escapes: a classe de ênfase morava
    /// num lugar só do padrão (antes do marcador) e todos os casos do corpo
    /// embrulhavam a frase INTEIRA, que é a única posição em que ela estava.
    /// Interleavá-la em cada junção seria outra enumeração; tirá-la é o que um
    /// renderizador de markdown faz.
    ///
    /// E `precomposedStringWithCanonicalMapping` porque `gar[çc]o[nm]s?` não
    /// casa `c` + U+0327: em NFD o guarda inteiro era inerte, e o cliente cola
    /// texto de onde quiser. Achado pela revisão de segurança de 2026-09-14.
    private static func normalizado(_ texto: String) -> String {
        texto.precomposedStringWithCanonicalMapping
            .replacingOccurrences(of: "[*_`~]+", with: "", options: .regularExpression)
    }

    private static func oracoes(_ texto: String) -> [String] {
        // PONTO ENTRE DÍGITOS NÃO FECHA ORAÇÃO: `R$ 1.250,00` é um número, e
        // cortar nele punha o rabo de uma frase dentro da oração da outra. A
        // vírgula decimal já estava protegida havia rodadas; o ponto do
        // MILHAR, não. Ver `_porque_separador_de_oracao`.
        let ns = texto as NSString
        var fora: [String] = [], ini = 0
        for m in separadorDeOracao.matches(
            in: texto, range: NSRange(location: 0, length: ns.length)) {
            fora.append(ns.substring(with: NSRange(location: ini, length: m.range.location - ini)))
            ini = m.range.location + m.range.length
        }
        fora.append(ns.substring(from: ini))
        return fora.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }


    /// A oração NEGA o destino, em vez de afirmá-lo?
    ///
    /// O negador tem que ATACAR A AFIRMAÇÃO, não apenas vir antes dela. A
    /// versão anterior olhava TODO o prefixo até o destinatário, e com isso
    /// qualquer preâmbulo tranquilizador desligava o guarda — "Sem dúvida, a
    /// gorjeta vai pro garçom", "Não precisa deixar mais nada, o serviço fica
    /// com a equipe", "A gorjeta não fica com a casa, fica com o garçom". A
    /// última é a negação de UM destino seguida da afirmação do proibido, e
    /// era lida como negação inteira. O registro que o `SystemPrompt` pede
    /// ("frases curtas", "um amigo que faz a conta") produz esses preâmbulos o
    /// tempo todo: 112 de 160 afirmações proibidas chegavam à tela. Achado
    /// pela revisão de segurança de 2026-09-13.
    ///
    /// A janela começa no FIM do substantivo da gorjeta, ou dez caracteres
    /// antes da forma direcional — o que vier depois — e termina no
    /// destinatário. É o espaço onde um "não" nega ESTA afirmação.
    private static func nega(_ oracao: String) -> Bool {
        let ns = oracao as NSString
        let todo = NSRange(location: 0, length: ns.length)
        let dests = destinatario.matches(in: oracao, range: todo).map { $0.range }
        guard !dests.isEmpty else { return false }
        let gorjetas = gorjeta.matches(in: oracao, range: todo).map { $0.range }
        let direcionais = direcional.matches(in: oracao, range: todo).map { $0.range }
        // Separador interno: depois de uma vírgula ou de um "mas", começa outra
        // afirmação — e a negação da primeira não alcança a segunda.
        // E ` e ` TAMBÉM ABRE OUTRA AFIRMAÇÃO. `Não, vai pra equipe.` recusa;
        // trocada a vírgula pela conjunção — que é a mesma coisa dita com
        // outro ritmo —, o `Não` passava a alcançar o destino e a promessa
        // escapava. Cinco casos do corpo, todos por um sinal.
        // Achado pelo eixo de RE-SEGMENTAÇÃO, 2026-09-14.
        let separadores = separadorDeClausula.matches(in: oracao, range: todo).map { $0.range }

        var anterior = 0
        for d in dests {
            // A JANELA VIROU O PREFIXO DESDE O DESTINATÁRIO ANTERIOR, e três
            // das quatro âncoras saíram.
            //
            // Elas existiam porque o `antes` contava qualquer negador que
            // caísse na janela, então a janela precisava ser pequena — e
            // acertar o tamanho dela custou três rodadas (preâmbulo que
            // desligava o guarda, falha aberta quando nada ancorava, a
            // interjeição que CRIAVA âncora). Desde que o negador precisa
            // ALCANÇAR o destino, o tamanho da janela deixou de importar: um
            // negador longe traz conteúdo próprio no caminho e não conta.
            //
            // Medido, não suposto: com o escopo no lugar, apagar cada uma das
            // quatro âncoras deixava o corpo inteiro verde. Peça que não pode
            // ficar vermelha é peça sem teste, e peça sem teste que também não
            // decide nada é só peça. Achado pelo portão de mutação ao ser
            // reapontado pro código novo, 2026-09-14.
            //
            // A do DESTINATÁRIO ANTERIOR ficou, e agora ela tem caso: em
            // "A caixinha não é do barman NEM do sommelier." o `nem` que nega o
            // segundo mora depois do primeiro, e sem o corte o escopo do `não`
            // esbarra em `barman` — conteúdo — e a negação some.
            // O SEPARADOR INTERNO VOLTOU, e a lição é sobre a medição, não
            // sobre a peça. Eu apaguei as quatro âncoras porque apagar cada uma
            // deixava o corpo verde — e isso mediu o CORPO, não a âncora. Com
            // ela de volta o corpo continua verde e 165 de 165 voltam a ser
            // recusadas: `Não, vai pra equipe.` — o `Não` responde à PERGUNTA
            // do cliente, e sem o corte na vírgula ele alcançava o destino da
            // resposta. É a resposta mais provável à pergunta mais provável.
            //
            // As outras três âncoras eram mesmo mortas: restauradas uma a uma,
            // zero vereditos mudam numa grade de 1080. Achado pela revisão de
            // segurança de 2026-09-14, que restaurou cada uma e mediu.
            var ini = anterior
            for sep in separadorDeClausula.matches(
                in: oracao, range: NSRange(location: anterior, length: d.location - anterior)) {
                ini = max(ini, sep.range.location + sep.range.length)
            }
            let vao = ns.substring(with: NSRange(location: ini, length: d.location - ini))
            var antes = false
            if let n = acha(negador, vao) {
                // E O NEGADOR TEM QUE ALCANÇAR O DESTINO. Ver
                // `_porque_alcance_antes`.
                antes = soFuncionalAteONucleo(
                    (vao as NSString).substring(from: n.location + n.length))
            }
            // E O NEGADOR PODE VIR DEPOIS DO DESTINATÁRIO — mas COLADO nele,
            // e sem `sem`.
            //
            // A primeira versão aceitava qualquer negador entre o
            // destinatário e o próximo separador, e `sem` está na lista: a
            // CAUDA da própria frase virava negação da promessa que ela
            // acabara de fazer. "A gorjeta vai direto pro garçom sem passar
            // pela folha." passava — o arranjo que o inegociável #2 existe pra
            // impedir, sem qualificação nenhuma, na tela do cliente. E "Os 10%
            // vão pro garçom e você não paga nada a mais" é frase que o
            // inegociável #1 (nenhuma taxa pro cliente) faz o modelo produzir
            // o tempo todo.
            //
            // Medido pela revisão: das 31 frases aposentadas que a lista de
            // runtime cobre, o commit anterior recusava 31 e este recusava 7.
            // Numa grade de 900, zero escapavam antes e 540 escapavam depois —
            // o conserto do preâmbulo abriu um buraco uma ordem de grandeza
            // maior que o que fechou. Achado pela revisão de segurança de
            // 2026-09-13.
            //
            // E o corpo não viu porque o ÚNICO caso de evasão pós-destinatário
            // que ele tinha usava `fora`, a única palavra de evasão que NÃO
            // está em `negadores`. Trocada por `sem`, o veredito inverte.
            let fimDoTrecho = separadores.first(where: { $0.location >= d.location + d.length })?.location
                ?? ns.length
            // O NEGADOR ATRÁS SÓ RESGATA SE FOR NEGAÇÃO DE VERDADE. "A gorjeta
            // fica com a equipe NÃO COM A CASA" retira o outro destino e
            // AFIRMA este; "o garçom NÃO TEM gorjeta nenhuma" nega. A pergunta
            // é sobre a regência do NEGADOR, não sobre a do destinatário —
            // duas versões erraram esse alvo, uma por adjacência (perdia o
            // oblíquo com um possessivo no meio) e outra por presença no vão,
            // que falhava ABERTO em toda linha de lista sem verbo (nada ancora
            // a janela, o vão fica vazio: 3125 de 3125 escapavam) e FECHADO
            // quando a preposição regia a GORJETA e não o destinatário
            // ("A gorjeta DE HOJE o garçom não recebe." virava recusa, 6 de 6).
            // Ver `_porque_contrastiva`. Achado pelas revisões de 2026-09-14.
            let cauda = fimDoTrecho > d.location + d.length
                ? ns.substring(with: NSRange(
                    location: d.location + d.length, length: fimDoTrecho - d.location - d.length))
                : ""
            let depois = negadorResgata(ns.substring(to: d.location), cauda)
            if !antes && !depois { return false }
            anterior = d.location + d.length
        }
        return true
    }

    /// O distribuidor resgata SÓ se vier antes da afirmação de destino.
    ///
    /// NADA RESGATA UMA AFIRMAÇÃO JÁ FEITA — é a doutrina da regra 1b (CDC
    /// art. 30), e a regra 1 não a aplicava. Bastava colar a frase sancionada
    /// depois: "A gorjeta PERTENCE À EQUIPE e o restaurante distribui pela
    /// folha." passava, e a segunda metade é literalmente o texto que a regra
    /// 9 do `SystemPrompt` manda o modelo escrever — a cláusula mais provável
    /// de aparecer colada na promessa era a que desligava a promessa.
    ///
    /// Ordem, e não lista de verbos: a versão que a revisão atacou dependia de
    /// `gatilho_forma_direcional` conhecer o verbo (`é` sim, `pertence` não,
    /// `destina-se` não, `beneficia` não), e enumerar conectivo é o jogo que a
    /// língua sempre ganha. Achado pela revisão de segurança de 2026-09-14.
    /// Os SEGMENTOS de uma oração, separados pelo `separadorInterno`.
    private static func segmentos(_ oracao: String) -> [String] {
        let ns = oracao as NSString
        var fora: [String] = [], ini = 0
        for m in separadorDeClausula.matches(in: oracao, range: NSRange(location: 0, length: ns.length)) {
            fora.append(ns.substring(with: NSRange(location: ini, length: m.range.location - ini)))
            ini = m.range.location + m.range.length
        }
        fora.append(ns.substring(from: ini))
        return fora.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    private static func distribuidorAntesDoDestino(_ oracao: String) -> Bool {
        guard temDistribuidor(oracao) else { return false }
        let todo = NSRange(location: 0, length: (oracao as NSString).length)
        // A posição do DESTINATÁRIO, não da frase de destino: `beneficia A
        // EQUIPE` é objeto direto, sem preposição nenhuma, e a frase de
        // destino não casa. Enumerar a regência é o mesmo jogo perdido.
        guard let dest = destinatario.firstMatch(in: oracao, range: todo)
        else { return true }
        guard let dist = distribuidor.firstMatch(in: oracao, range: todo) else { return true }
        return dist.range.location < dest.range.location
    }

    /// A oração carrega, ELA MESMA, a cláusula do distribuidor?
    private static func temDistribuidor(_ oracao: String) -> Bool {
        let ns = oracao as NSString
        // TODAS as ocorrências, e a janela olha PRA FRENTE também. Olhava só a
        // primeira e só pra trás, enquanto o censo de build olhava todas e
        // ±30: "A gorjeta pertence à equipe e o restaurante distribui, mas não
        // pela folha." era RECUSADA no build e PASSAVA aqui — o runtime mais
        // frouxo que o censo, na única direção que chega ao cliente, e
        // justamente na classe de evasão que o `revoga_dispensa` existe pra
        // pegar. `pertence` não é forma direcional, então a regra 1b não
        // salvava. Achado pela revisão de compliance de 2026-09-13.
        // A JANELA É A ORAÇÃO, não ±30 caracteres. O orçamento fixo era a
        // mesma forma do olho mágico: `O restaurante distribui ASSIM a gorjeta
        // à equipe, mas não pela folha.` empurrava o `mas não pela folha` pra
        // fora da janela e a evasão deixava de revogar. A oração já é a
        // unidade do julgamento em todo o resto do arquivo.
        // Achado pelo fabricador, 2026-09-14.
        if casa(revoga, oracao) { return false }
        return casa(distribuidor, oracao)
    }

    /// O segmento é uma FRASE DE DESTINO — cabeça de destino, sem verbo no
    /// prefixo e sem predicação nem na cabeça nem no resto? É a mesma pergunta
    /// do caminho fraco da regra 3, reusada onde a regra 1 atravessa segmento.
    private static func fraseDeDestino(_ seg: String) -> Bool {
        guard let m = acha(cabecaDeDestino, seg) else { return false }
        let ns = seg as NSString
        if casa(verboFinito, ultimoSegmento(ns.substring(to: m.location))) { return false }
        // O QUE VEM DEPOIS DA CABEÇA NÃO DESFAZ A PROMESSA — doutrina do CDC
        // art. 30 que a regra 1b já aplica. `a caixinha, dos atendentes do
        // salão São R$ 1.250,00 no total.` tem a promessa inteira no segmento
        // e uma frase NOVA colada atrás, sem pontuação no meio.
        return !temPredicacao(ns.substring(with: NSRange(location: m.location, length: m.length)))
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
    static func afirmaDestinoSemDistribuidor(_ textoCru: String) -> Bool {
        // A PRÉ-CONDIÇÃO NÃO PEDE MAIS O SUBSTANTIVO DA GORJETA, e essa era a
        // porta por onde tudo passava. O texto julgado é só o do MODELO — a
        // pergunta do cliente não entra nele —, e um prompt que manda escrever
        // "frases curtas, uma ideia por frase" produz a resposta com anáfora:
        // "Vai sim, 100% pro garçom." não repete `gorjeta` porque quem
        // perguntou acabou de dizer. Quinze respostas curtas naturais à
        // pergunta mais provável da mesa, quinze escapes — e todas as peças
        // desta rodada ficavam atrás desta linha, inalcançáveis. As mesmas
        // quinze com `A gorjeta? ` na frente: doze recusas. O substantivo
        // fazia 100% do trabalho.
        //
        // Agora quem decide são as REGRAS: a 1 continua exigindo os dois
        // substantivos NA MESMA ORAÇÃO, a 1b exige forma direcional e a 3
        // exige quantidade ou marcador com cabeça de destino. O que sai daqui
        // é só o turno que não nomeia destinatário nenhum.
        // Achado pela revisão de segurança de 2026-09-14.
        let texto = normalizado(textoCru)
        guard casa(destinatario, texto) else { return false }
        let partes = oracoes(texto)
        // 1. Uma oração que junta os dois substantivos tem que trazer o
        //    distribuidor ELA MESMA — ou estar negando.
        // A DISPENSA DO DISTRIBUIDOR VALE NO SEGMENTO DELE. Era um teste de
        // ORDEM, e ordem errava dos dois lados: com a frase sancionada na
        // FRENTE ela virava um interruptor de absolvição — "O restaurante
        // distribui à equipe, como manda a lei, e a gorjeta pertence ao
        // garçom." passava —, e a moldura mais natural do português põe o
        // destinatário como SUJEITO e o distribuidor depois dele, então "A
        // equipe recebe a gorjeta pela folha de pagamento da casa." virava
        // recusa. Posição não sabe dizer que cláusula qualifica qual
        // afirmação; escopo sabe. Achado pela revisão de segurança de
        // 2026-09-14.
        // UMA ORAÇÃO ABERTA POR ADVERSATIVA CONTINUA A ANTERIOR. `O
        // restaurante distribui a gorjeta à equipe, mas não pela folha.` é
        // uma oração só, e a evasão revoga a dispensa do distribuidor.
        // Trocada a vírgula por travessão, dois-pontos, ponto-e-vírgula ou
        // quebra de linha, o `mas não pela folha` virava oração separada, a
        // revogação deixava de ser lida, e a promessa proibida passava com a
        // qualificação colada. Uma cláusula aberta por `mas` não é afirmação
        // nova: ela QUALIFICA a anterior.
        // Achado pelo eixo de RE-SEGMENTAÇÃO, 2026-09-14.
        func comAdversativa(_ i: Int) -> String {
            let prox = i + 1 < partes.count ? partes[i + 1] : ""
            return casa(adversativaInicial, prox) ? partes[i] + " " + prox : partes[i]
        }
        for (iO, o) in partes.enumerated() where casa(gorjeta, o) {
            // COORDENAÇÃO HERDA O DISTRIBUIDOR. `O restaurante distribui a
            // gorjeta à equipe E À COZINHA` põe o segundo destinatário num
            // segmento sem verbo próprio, e a frase SANCIONADA na forma que o
            // dono mais quer — dividir com a cozinha — virava recusa. Segmento
            // sem verbo é continuação, não afirmação nova.
            // Achado pela revisão de segurança de 2026-09-14.
            var distribuidorAnterior = false
            for seg in segmentos(o) {
                // O distribuidor tem que estar na predicação MATRIZ: numa
                // relativa ele modifica a GORJETA e não diz pra onde ela vai.
                let matriz = relativaQualquer.stringByReplacingMatches(
                    in: seg, range: NSRange(location: 0, length: (seg as NSString).length),
                    withTemplate: " ")
                let temDist = casa(distribuidor, matriz)
                let temVerbo = casa(verboFinito, seg) || casa(direcional, seg)
                // A HERANÇA DA COORDENAÇÃO FALHA FECHADO. Ela dizia
                // `segmento sem verbo CONHECIDO é continuação`, e verbo
                // desconhecido virava continuação: `O restaurante distribui à
                // equipe e a gorjeta PERTENCE ao garçom.` passava — e
                // `pertence`, `beneficia`, `destina-se` e `cabe` são os verbos
                // que o `distribuidorAntesDoDestino` cita como o motivo de este
                // arquivo ter parado de enumerar conectivo. A regra 9 do
                // `SystemPrompt` MANDA o modelo escrever a metade esquerda, e
                // isso dava carimbo a qualquer coisa coordenada depois dela.
                // Continuação agora exige evidência POSITIVA: segmento com
                // sujeito próprio é afirmação nova.
                let dispensa = temDist
                    || (!temVerbo && !casa(sintagmaNominal, seg) && distribuidorAnterior)
                if temVerbo || temDist { distribuidorAnterior = temDist }
                guard destinatarioNaoAtributivo(seg, o) else { continue }
                // A REGRA 1 SÓ ATRAVESSA SEGMENTO SE O SEGMENTO FOR FRASE DE
                // DESTINO. Ela perguntava se o TOKEN do destinatário está no
                // segmento, e nunca se ele está numa RELAÇÃO de destino — e é
                // por isso que juntar duas frases numa oração virava recusa.
                // `Já tirei o serviço, chama o atendente que ele confere.`
                // confirma que o serviço SAIU, e o guarda pisava nessa
                // confirmação (CDC, inegociável #3). No MESMO segmento nada
                // muda, então `A gorjeta, pro garçom.` segue recusada.
                // Ver `_porque_travessia_de_segmento`.
                guard casa(gorjeta, seg) || fraseDeDestino(seg) else { continue }
                if !nega(o) && (casa(revoga, comAdversativa(iO)) || !dispensa) { return true }
            }
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
            // O GENITIVO DESCRITIVO DISPENSA AQUI TAMBÉM. `A gorjeta
            // arrecadada é remuneração da equipe` diz DE QUEM o dinheiro é,
            // não pra onde ele vai, e é a frase que o produto tem que poder
            // dizer. A regra 1 já perguntava isso; a 1b nunca perguntou — o
            // veto de sujeito respondia por ela por acidente, e o acidente
            // apareceu quando o veto foi restringido ao que ele de fato
            // protege.
            guard destinatarioNaoAtributivo(o, nil) else { continue }
            // CONTEXTO DE DINHEIRO. Até a pré-condição cair, o substantivo da
            // gorjeta garantia isto de graça; sem ela, `A comanda vai pro
            // garçom conferir.` e `O pedido vai pra copa.` viravam recusa —
            // 34 de 47 turnos inocentes, e um deles apagava o valor da conta
            // da tela, que é a falha que este arquivo existe pra não repetir.
            //
            // A forma direcional NO COMEÇO da oração conta como contexto: o
            // sujeito elidido é o assunto, e é assim que a resposta curta se
            // escreve — "Fica com a equipe, sim.", "Vai tudo pro garçom." Com
            // sujeito na frente, o assunto é OUTRA COISA.
            // Achado pela revisão de segurança de 2026-09-14.
            // O PREFIXO É JULGADO, NÃO CONTADO. Isto era "nenhum caractere
            // alfanumérico antes do verbo" — um teste de posição no lugar do
            // teste de predicação que o resto do arquivo usa. Uma palavra de
            // discurso na frente desligava tudo: `Sim, vai pro garçom.`,
            // `Claro, fica com a equipe.`, `Ela fica com o garçom.` — 150 de
            // 150, e é a resposta de uma volta à pergunta mais provável da
            // mesa, sem substantivo de gorjeta nenhum porque quem perguntou
            // acabou de dizer. `Sim,` e `Ela` são adjunto e anáfora; `O Gui
            // paga` é oração nova. Achado pelas duas revisões de 2026-09-14.
            // SUJEITO NOMINAL QUE NÃO SEJA A GORJETA VETA a regra 1b: a frase
            // é sobre OUTRA coisa. `A COMANDA vai pro garçom conferir.`, `O
            // PEDIDO vai pra copa.` — 34 de 47 turnos inocentes viravam recusa,
            // e um deles apagava o valor da conta da tela. `A GORJETA vai pro
            // garçom.` tem sujeito nominal e é justamente a promessa, então o
            // substantivo da gorjeta sai antes do teste.
            // O PREFIXO DA 1B TAMBÉM É O ÚLTIMO SEGMENTO. `A conta fechou,
            // vai tudo pro garçom.` recusa; trocada a vírgula por ` e `, o
            // sujeito `A conta` passava a caber no teste ancorado, `conta`
            // está no `substantivo_nao_dinheiro`, e o veto desligava a regra.
            // O sujeito que interessa é o DESTA cláusula.
            let prefixo = ultimoSegmento(
                acha(direcional, o).map { (o as NSString).substring(to: $0.location) } ?? "")
            // O SUJEITO PODE SER O DINHEIRO CHAMADO POR OUTRO NOME. `O VALOR
            // vai todo pro garçom.`, `A PARTE vai pro garçom.`, `Esse DINHEIRO
            // fica com o garçom.` — 96 de 96 escapavam porque o veto lia `o
            // valor` como `outra coisa`. Mesma anáfora que derrubou a
            // pré-condição duas rodadas antes, agora do lado do sujeito.
            var prefixoSemGorjeta = gorjeta.stringByReplacingMatches(
                in: prefixo, range: NSRange(location: 0, length: (prefixo as NSString).length),
                withTemplate: " ")
            prefixoSemGorjeta = anaforaDeDinheiro.stringByReplacingMatches(
                in: prefixoSemGorjeta,
                range: NSRange(location: 0, length: (prefixoSemGorjeta as NSString).length),
                withTemplate: " ")
            // O VETO SÓ VALE ONDE NÃO PODE ESCONDER UMA PROMESSA. A
            // enumeração do dinheiro estava com a polaridade virada pro
            // escape: `comissão`, `acréscimo`, `agrado` — palavra de dinheiro
            // que a lista não conhece ficava no prefixo, virava `outro
            // assunto` e VETAVA a regra 1b. Numa janela que fala de dinheiro o
            // veto agora exige um sujeito NOMEADO como não-dinheiro;
            // desconhecido significa recusa. Fora dela o veto vale inteiro, e
            // é lá que mora `A comanda vai pro garçom conferir.`
            // Ver `_porque_veto_por_contexto`.
            let contextoDeDinheiro = casa(gorjeta, texto) || casa(quantidade, texto)
            if temSujeitoNominal(prefixoSemGorjeta)
                && (!contextoDeDinheiro || casa(naoDinheiro, prefixo)) { continue }
            // Na evidência mais fraca, destinatário que também é LUGAR não
            // basta: `Vai pra cozinha, já avisei.` é sobre o pedido.
            // Ver `_porque_ambiguo`.
            // UM CÔMODO PODE SER DESTINO DE MOVIMENTO E NÃO PODE SER DONO DE
            // DINHEIRO. A ambiguidade está na RELAÇÃO, não na palavra: `Vai
            // pra cozinha` é sobre o pedido, `Fica com o salão` e `É da copa`
            // são a promessa. Apagar `salão` da lista não fecharia isso —
            // `cozinha` e `copa` carregavam o mesmo escape.
            let soAmbiguo = casa(destinatarioAmbiguo, o)
                && !casa(destinatario, destinatarioAmbiguo.stringByReplacingMatches(
                    in: o, range: NSRange(location: 0, length: (o as NSString).length),
                    withTemplate: " "))
                && !casa(ambiguoPossuido, o)
            let comecaNaForma = !temSujeitoNominal(prefixoSemGorjeta) && !soAmbiguo
            // O contexto de dinheiro é medido na JANELA, não na oração: em
            // `vai pra equipe · ${e.tip}` o substantivo da gorjeta está na
            // mesma linha e noutra oração, e a janela é o que o
            // `_porque_janela` define como unidade de leitura.
            guard contextoDeDinheiro || comecaNaForma else { continue }
            if !nega(o) { return true }
        }
        // 3. Afirmação repartida entre orações. Duas correções, da mesma
        //    revisão e pelo mesmo motivo — o caminho 3 era o que sobrava do
        //    julgamento antigo, text-wide, escondido atrás dos dois primeiros.
        //
        //    ORDEM. Bastava que ALGUMA oração, em qualquer posição, nomeasse o
        //    distribuidor — então a frase sancionada colada no FIM voltava a
        //    lavar por aqui o que as regras 1 e 1b já não deixavam lavar. Um
        //    separador de oração depois do substantivo ("Sobre a gorjeta: vai
        //    todinha pro garçom.") e um advérbio fora da lista da forma
        //    direcional bastavam pra cair neste ramo. Pelo CDC art. 30 vale a
        //    primeira metade: o distribuidor tem que ser nomeado ATÉ a oração
        //    que nomeia o destinatário, nunca depois dela.
        //
        //    E O QUE SOBRA TEM QUE SER FRASE DE DESTINO. O `return true` solto
        //    recusava qualquer texto com gorjeta numa oração e equipe noutra —
        //    "Já tirei o serviço. Chama o atendente pra fechar a conta." e
        //    "Sua parte com serviço é R$ 61,00. Se quiser, mostra pro garçom."
        //    sumiam da tela, a segunda levando o valor junto e sem a pessoa
        //    saber. Num app de dividir conta em restaurante esses dois
        //    substantivos se encontram o tempo todo sem prometer nada: sete de
        //    sete frases comuns recusadas. E o ramo não ganhava nada — ZERO
        //    frases do corpo que só ele pegasse. O que ele tem que cobrir é a
        //    divisão SEM VERBO ("- 10% de serviço\n- pro garçom"), e é só isso.
        // NÃO HÁ MAIS RETORNO PRECOCE AQUI, e a razão dele estava errada.
        // Ele dizia "a regra 1 já julgou essa oração" — mas a regra 1 ABSOLVE
        // a oração que traz o distribuidor, e essa absolvição voltava `false`
        // pro TEXTO INTEIRO, cancelando a regra 3 pra todas as outras. Bastava
        // pôr um substantivo de gorjeta na cauda sancionada:
        //
        //   "…\n- 100% pro garçom\nA gorjeta pertence à equipe e o
        //    restaurante distribui pela folha."
        //
        // `pertence` não é forma direcional (1b cala), a cauda é absolvida
        // pela regra 1, e o `- 100% pro garçom` nunca era olhado. A promessa
        // do CAMINHO e a da QUANTIDADE, as duas, na tela.
        //
        // Tirar a linha não quebra nada: os quatro falsos positivos que a
        // motivaram já são segurados pela exigência de marcador-ou-quantidade
        // logo abaixo. Achado pela revisão de compliance de 2026-09-13.
        // SEM RETORNO PRECOCE PELA NEGAÇÃO. Uma oração negando em qualquer
        // lugar desligava a regra 3 pro texto inteiro — e o assunto faz do
        // prefixo negativo a abertura mais provável: "A gorjeta não fica com o
        // maître. Sobre a gorjeta\n100% pro garçom" passava. É a classe do
        // prefixo inocente, reaberta com um prefixo NEGATIVO: o conserto do
        // `firstIndex` entrou no laço e os retornos de texto inteiro acima
        // dele ficaram. A negação é julgada POR ORAÇÃO dentro do laço.
        // TODAS as orações com destinatário, não a primeira. `firstIndex` era
        // a mesma forma "só o primeiro" que a revisão anterior tinha achado no
        // `nega` — deixada intacta no laço irmão, trinta linhas abaixo. Bastava
        // uma frase inocente com um substantivo de equipe na frente ("A equipe
        // da mesa 7 já fechou.") pra capturar o índice, falhar o teste de
        // destino e desarmar a classe inteira. Quatro de quatro casos do
        // próprio fixture escapavam assim.
        //
        // E NÃO SE EXIGE MAIS MARCADOR DE LISTA. `(marcado || fraseDeDestino)`
        // deixava passar "Sobre a gorjeta\n100% pro garçom" e a versão em
        // negrito do Markdown; e a alternativa `\d+[.)]` do marcador era morta
        // por construção, porque a oração já vinha cortada no ponto. O teste
        // usava `- 100% pro garçom`, a única forma COM marcador — o mesmo
        // formato do erro anterior, um passo adiante.
        for (i, o) in partes.enumerated() where casa(destinatario, o) {
            guard casa(destinoEmQualquerLugar, o), !nega(o) else { continue }
            // Marcador de lista OU quantidade — e a quantidade pode estar na
            // oração ANTERIOR, que é onde o valor costuma morar. Exigi-la na
            // mesma oração do destinatário fazia a classe sobreviver só na
            // renderização com marcador de Markdown: tirando os dois traços de
            // "- 10% de serviço\n- pro garçom" — o exemplo canônico do próprio
            // comentário — ela escapava, e "Gorjeta: 10% — pra equipe." também.
            // A quantidade da oração anterior só vale se ESTA for uma frase de
            // destino inteira — senão "Tirei os 10%. Fala com o maître na saída."
            // vira achado, e é resposta certa com o valor na oração de trás.
            // A oração anterior tem que trazer a QUANTIDADE. O comentário que
            // estava aqui dizia, em maiúsculas e duas vezes, que ela precisava
            // trazer TAMBÉM o substantivo da gorjeta — e o código nunca fez
            // essa checagem, nem aqui nem no gêmeo. Quem segura a classe que o
            // comentário citava é a FORMA exigida no caminho fraco (resto
            // vazio), não uma conjunção que não existe. Comentário que promete
            // um cinto que não está lá é como o próximo leitor decide afrouxar
            // a forma. Achado pela revisão de segurança de 2026-09-14.
            // A CABEÇA é um PREFIXO, e o que decide é o RESTO: adjunto não
            // desmancha uma frase de destino, predicação nova desmancha. A
            // whitelist ancorada nos dois lados que estava aqui falhava ABERTO
            // em tudo que não modelava — `- 100% pro garçom hoje`, `…em
            // dinheiro`, `…do salão principal`, `…🙂`: 165 de 180 numa grade
            // de adjuntos, contra 120 do teto de palavras que ela substituiu.
            // Ver `_porque_cabeca` e `_porque_predicacao`.
            // O CORTE NO SEPARADOR VALE SÓ NO CAMINHO FORTE, e essa é a
            // granularidade que a versão anterior errava: ela cortava pra
            // medir a FORMA e não cortava pra medir a QUANTIDADE, então o
            // `tudo` de "Com o garçom, TUDO CERTO." contava como dinheiro
            // dirigido e a resposta certa virava recusa. Ver `_porque_corte`.
            // CAMINHO FORTE: quantidade consumida pela cabeça. Pelo CDC
            // art. 30 a oferta obriga no momento em que é feita, e o que vier
            // pendurado atrás qualifica, não desdiz.
            if cabecaValida(cabecaForte, o) != nil { return true }
            // Aqui NÃO se pergunta por predicação: o caminho fraco exige resto
            // VAZIO, e vazio já não tem predicação. Perguntar as duas coisas é
            // uma guarda que não pode disparar — guarda ausente.
            // CAMINHO FRACO: a quantidade está só na oração anterior, então
            // a FORMA tem que compensar — cabeça ancorada e direcional.
            // PISTA DE EVASÃO VALE COMO DIRECIONALIDADE. `com`/`no`/`em` são
            // excluídos porque `Com o garçom, ok.` é resposta certa — mas
            // `- no bolso do garçom` e `- em espécie, com o garçom` são a
            // promessa proibida na mesma forma sem verbo que a regra 3 existe
            // pra cobrir, e a evasão é a evidência que separa as duas.
            // Achado pela revisão de compliance de 2026-09-14.
            // O DISTRIBUIDOR DISPENSA NO CAMINHO FRACO, e só nele. Aqui a
            // evidência é fraca por definição — a quantidade está noutra
            // oração —, então nomear quem distribui basta pra não ser promessa
            // avulsa. No caminho FORTE não dispensa: ali a quantidade foi
            // consumida pela cabeça e a oferta já vinculou (CDC art. 30).
            //
            // Sem isto, a FRASE SANCIONADA em inglês era recusada: o teste de
            // prefixo não conhece `distributes`, e crescer a lista de verbos
            // com cada tradução é a enumeração que sempre perde.
            if temDistribuidor(o) && !casa(revoga, o) { continue }
            // A PISTA DE EVASÃO VALE PELA JANELA, não pela oração: ela
            // qualifica o CAMINHO do dinheiro, e uma qualificação mora onde o
            // ritmo da frase a puser. `Com a equipe, sem passar pela casa.`
            // vira `Com a equipe — sem passar pela casa.` e a pista muda de
            // oração, com o mesmo sentido e outro veredito. A licença segue a
            // ESTRITA. Achado pelo eixo de RE-SEGMENTAÇÃO, 2026-09-14.
            let comEvasao = casa(evasaoQueLicencia, texto)
            // CABEÇA GENITIVA. `PREPDIR` não tem `d[oa]s?` — de propósito, pra
            // `Com o garçom, ok.` não entrar por outra porta —, então a
            // promessa sem verbo e sem direção não tinha quem a visse:
            // `A caixinha — dos atendentes do salão`, `A caixinha? Da equipe.`,
            // `Serviço: 10%⏎- da equipe`. A licença é a ESTRITA (substantivo da
            // gorjeta antes, não só quantidade) e a cabeça é ANCORADA no começo
            // da oração. Ver `_porque_cabeca_genitiva`.
            var mOpt = acha(comEvasao ? cabecaDeDestino : cabecaDirecional, o)
            var soGorjetaAntes = comEvasao
            if mOpt == nil {
                mOpt = acha(cabecaGenitiva, o)
                soGorjetaAntes = true
            }
            guard let m = mOpt else { continue }
            let ns = o as NSString
            // O prefixo do caminho FRACO é julgado pela predicação INTEIRA, e
            // não só por sujeito: aqui a evidência é fraca, então qualquer
            // oração na frente desqualifica. É o que separa `assim pra equipe`
            // (adjunto) de `mostra pro garçom` e de `O restaurante distribui à
            // equipe` (orações). Ver `_porque_dois_niveis`.
            // O prefixo é julgado por VERBO nos DOIS caminhos: pronome
            // sozinho é anáfora, não oração nova — `Ela, pra equipe.` é a
            // mesma promessa. Ver `_porque_cabeca`.
            guard !casa(verboFinito, ultimoSegmento(ns.substring(to: m.location)))
            else { continue }
            // E A CABEÇA NÃO PODE CONTER PREDICAÇÃO. Os slots de modificador
            // somam até cinco palavras entre a preposição e o núcleo, e um
            // verbo finito cabe lá com folga — ancorada no `^`, a cabeça deixa
            // o prefixo VAZIO e o teste de prefixo não vê nada. `Serviço: 10%
            // no fim da conta você chama o garçom.` virava recusa: o `^` que
            // fechou a frase por um lado abriu-a pelo outro.
            guard !temPredicacao(ns.substring(with: NSRange(location: m.location, length: m.length)))
            else { continue }
            let resto = ns.substring(from: m.location + m.length)
            // A FORÇA DA EVIDÊNCIA DECIDE O QUANTO A FORMA PRECISA SER
            // ESTRITA. Quantidade CONSUMIDA pela cabeça é dinheiro dirigido, e
            // aí um adjunto atrás do núcleo não desmancha nada. Quantidade só
            // na oração anterior é evidência fraca, e aí a oração tem que ser
            // uma frase de destino e MAIS NADA — senão "Sua parte com serviço
            // é R$ 61,00.\nCom o garçom, ok." vira recusa, e é a resposta
            // certa com o dinheiro dela dentro. Ver `_porque_dois_niveis`.
            // `pro garçom` é dinheiro indo; `com o garçom` é com quem se
            // acerta, e é resposta certa. A primeira versão exigia RESTO VAZIO
            // em vez disso, e um advérbio derrubava a regra.
            guard !temPredicacao(resto) else { continue }
            // QUALQUER oração anterior da janela, não só a de trás. O
            // `partes[i - 1]` era adjacência posicional: um bullet a mais
            // entre a linha do valor e a do destino — `- 10% de serviço\n-
            // sem desconto\n- pro garçom` — e a regra desligava. A janela já
            // é o limite; `_porque_janela` é quem o define.
            // Quantidade OU o substantivo da gorjeta numa oração anterior: em
            // "Sobre a gorjeta\nSim, pra equipe." não há quantidade em lugar
            // nenhum, e a promessa é a mesma.
            // A licença da cabeça não-direcional exige o SUBSTANTIVO da
            // gorjeta antes, não só quantidade — ver `_porque_licenca`.
            guard partes[..<i].contains(where: {
                soGorjetaAntes ? casa(gorjeta, $0) : (casa(quantidade, $0) || casa(gorjeta, $0))
            }) else { continue }
            // NADA RESGATA UMA AFIRMAÇÃO JÁ FEITA — a mesma lógica da regra
            // 1b, que a regra 3 não aplicava. A dispensa por ORDEM valia só
            // aqui, e por isso bastava ABRIR com a frase sancionada pra
            // liberar o `- 100% pro garçom` depois dela. A regra 9 do
            // `SystemPrompt` MANDA o modelo dizer essa frase, então abrir com
            // ela é o caso provável, não o exótico. As mesmas duas frases,
            // trocadas de ordem, davam vereditos opostos. Achado pela revisão
            // de segurança de 2026-09-13.
            return true
        }
        return false
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
    static func chegouPertoDoAssunto(_ textoCru: String) -> Bool {
        // NORMALIZA AQUI TAMBÉM. A trava do streaming é o SEGUNDO ponto de
        // entrada, e o conserto de NFD tinha ido só no primeiro: em forma
        // decomposta `gar[çc]o[nm]s?` não casa, a trava não arma, e a promessa
        // aparece quadro a quadro na tela antes de o veredito final a trocar.
        // O veredito ficava certo e a garantia do `streamNaoVaza` não.
        let texto = normalizado(textoCru)
        return casa(gorjeta, texto) || casa(destinatario, texto)
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
