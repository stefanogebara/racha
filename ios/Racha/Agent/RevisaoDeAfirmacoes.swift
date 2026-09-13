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
    /// Só os negadores; a evasão preposicional pertence ao distribuidor.
    private static let negador = regex(ClaimPatterns.negadores)
    /// Negador COLADO no destinatário — "o garçom NÃO fica", "o garçom QUE NÃO
    /// recebe". Sem `sem`: `sem` evade a cláusula do distribuidor e vem na
    /// CAUDA da própria promessa ("…pro garçom SEM passar pela folha"), onde
    /// nega a frase que acabou de ser feita em vez do destino.
    private static let negadorColado = regex(ClaimPatterns.negadorColado)
    /// Preposição de destino COLADA ATRÁS do destinatário — marca que ele é
    /// OBLÍQUO: o destino do dinheiro, e destino não se retira depois dele.
    private static let regenciaDeDestino = regex(ClaimPatterns.regenciaDeDestino)
    /// Alta precisão: uma oração com esta FORMA está afirmando destino,
    /// tenha ou não os dois substantivos dentro dela.
    private static let direcional = regex(ClaimPatterns.formaDirecional)
    /// Vírgula, `mas`, `porém`, `e sim`: daqui pra frente é outra afirmação.
    private static let separadorInterno = regex(ClaimPatterns.separadorInterno)
    /// Uma frase de destino em QUALQUER lugar da oração — não só no começo.
    /// Ancorá-la no começo fazia qualquer palavra antes da preposição derrubar
    /// o casamento, e a mais provável é uma quantidade.
    /// Até dois MODIFICADORES entre o artigo e o núcleo — `to the FLOOR
    /// staff`. Sem eles esta pré-condição da regra 3 derrubava a própria
    /// frase que o corpus trilíngue usa. Ver `_porque_modificador`.
    private static let destinoEmQualquerLugar = regex(
        "(" + ClaimPatterns.preposicaoDeDestino + ")\\s+"
        + "((" + ClaimPatterns.artigoDeDestino + ")\\s+)?" + ClaimPatterns.modificadorDeDestino
        + "(" + ClaimPatterns.destinatarioRuntime + ")")
    /// Até o PRIMEIRO separador interno. A pureza se mede no que a oração
    /// afirma, não no reforço pendurado atrás da vírgula: "- 100% pra equipe,
    /// sem desconto nenhum" é a mesma afirmação, e a vírgula é justamente onde
    /// o `separadorInterno` já diz que começa outra. Sem o corte, qualquer
    /// cauda desligava a regra 3 inteira.
    private static func ateOSeparador(_ oracao: String) -> String {
        let ns = oracao as NSString
        guard let m = separadorInterno.firstMatch(
            in: oracao, range: NSRange(location: 0, length: ns.length)) else { return oracao }
        return ns.substring(to: m.range.location)
    }

    /// A oração é, do começo ao fim, uma FRASE DE DESTINO — "pro garçom",
    /// "- 100% pra equipe do salão" — e não uma oração com VERBO. Começar na
    /// preposição não bastava: "Com o atendente você confirma na saída."
    /// também começa, e é resposta certa. Três de cinco sumiam atrás da
    /// resposta segura. Exigir o substantivo da gorjeta na oração ANTERIOR não
    /// resolve — em "Gorjeta: 10% — pra equipe." o substantivo está duas
    /// orações atrás, não uma.
    ///
    /// Isto ERA uma contagem de palavras (`<= 4`), e contar palavras é um
    /// proxy do que se quer mesmo dizer: *nenhum verbo fora da frase de
    /// destino*. O proxy caía com um genitivo a mais — "- 100% pra equipe do
    /// salão" tem cinco — e o corpus que provava a cobertura trilíngue estava
    /// sentado EM CIMA do teto, porque inglês e espanhol carregam artigo
    /// obrigatório onde o português não carrega: `- 100% to the staff` são
    /// exatamente quatro palavras. Agora a oração é consumida inteira pelo
    /// padrão — marcador, quantidade, preposição, artigo, modificadores,
    /// destinatário, genitivos — e o que sobra tem que ser nada. Não há teto
    /// de aridade pra transbordar.
    /// Achado pela revisão de compliance de 2026-09-14.
    private static let fraseDeDestinoPura = regex(ClaimPatterns.fraseDeDestinoPura)

    /// A oração É, ela toda, uma frase de destino: começa na preposição.
    ///
    /// Volta a ter emprego — é ela que separa a linha de lista sem marcador
    /// ("pro garçom", logo depois de "10% de serviço") de uma oração com VERBO
    /// ("Fala com o maître na saída"), que é ação e não dinheiro indo. Só numa
    /// frase de destino inteira a quantidade da oração ANTERIOR conta.
    private static let fraseDeDestino = regex(
        "^\\s*(" + ClaimPatterns.preposicaoDeDestino + ")\\s+"
        + "((" + ClaimPatterns.artigoDeDestino + ")\\s+)?" + ClaimPatterns.modificadorDeDestino
        + "(" + ClaimPatterns.destinatarioRuntime + ")")
    /// Marcador de lista: `- `, `* `, `• `. (`\\d+[.)]` seria morto: a oração já
    /// vem cortada no ponto.)
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
        let separadores = separadorInterno.matches(in: oracao, range: todo).map { $0.range }

        var anterior = 0
        for d in dests {
            var ini = anterior
            var achou = anterior > 0
            // O substantivo da gorjeta mais próximo ANTES deste destinatário —
            // de qualquer lado dele. A versão anterior só olhava quando a
            // gorjeta vinha antes, e por isso "Sem dúvida, o garçom fica com a
            // gorjeta." (ordem invertida) ficava com a janela valendo o
            // prefixo inteiro: o preâmbulo desligava o guarda, 80 de 80.
            for g in gorjetas where g.location + g.length <= d.location {
                ini = max(ini, g.location + g.length); achou = true
            }
            for dir in direcionais where dir.location <= d.location {
                ini = max(ini, dir.location - 10); achou = true
            }
            for sep in separadores where sep.location + sep.length <= d.location {
                ini = max(ini, sep.location + sep.length); achou = true
            }
            // FALHA FECHADA: sem candidato que ancore, a janela é VAZIA — não o
            // prefixo inteiro. Com `ini = 0` como padrão, um destinatário que
            // viesse antes do substantivo, sem vírgula e sem forma direcional,
            // devolvia a janela máxima e o preâmbulo voltava a desligar tudo:
            // "Sem dúvida o garçom fica com a gorjeta" (sem a vírgula). 55 de
            // 182. O que fechou o caso reportado foi o separador, por acidente
            // de pontuação — deletar o laço da gorjeta inteiro deixava o
            // fixture VERDE, e o comentário aqui dizia que ele olhava dos dois
            // lados. Achado pela revisão de segurança de 2026-09-13.
            ini = achou ? max(0, min(ini, d.location)) : d.location
            // Se ALGUM destinatário chega sem negação na sua janela, a oração
            // AFIRMA. Olhar só o primeiro deixava negar um destinatário e
            // afirmar outro na mesma oração — "não fica com o salão, fica com
            // o garçom" —, e o teste passava só porque a palavra escolhida
            // (`casa`) não está na lista de runtime: provava a regra com o
            // único substantivo incapaz de exercitá-la.
            let antes = ini < d.location
                ? casa(negador, ns.substring(with: NSRange(location: ini, length: d.location - ini)))
                : false
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
            // SÓ DESTINATÁRIO SUJEITO é resgatável por negador que venha
            // atrás. Regido por preposição ele é OBLÍQUO — é o destino do
            // dinheiro — e a negação CONTRASTIVA do termo seguinte afirma a
            // promessa em vez de negá-la: "A gorjeta fica com a equipe NÃO COM
            // A CASA" diz que fica com a equipe. Numa grade de 625 caudas
            // contrastivas passavam 625; as mesmas 125 frases sem cauda eram
            // recusadas. E é a resposta mais provável à pergunta mais provável
            // da mesa. Achado pela revisão de segurança de 2026-09-14.
            //
            // REGÊNCIA NÃO É ADJACÊNCIA: a pergunta é feita sobre O MESMO VÃO
            // que o `antes` usa, e não sobre os 14 caracteres colados no
            // destinatário. O olho mágico admitia UM token entre a preposição
            // e o núcleo, e artigo nu — e o português põe possessivo ali o
            // tempo todo. Com um modificador inserido, 1250 de 3125 caudas
            // contrastivas voltavam a passar: "A gorjeta vai pra NOSSA equipe
            // não pra casa." Ver `_porque_regencia`.
            //
            // De quebra some o falso positivo do "Com o garçom não tem gorjeta
            // nenhuma.": ali não há nada ancorando a janela, o vão é VAZIO, o
            // destinatário não é oblíquo e a negação de verdade resgata a
            // frase. Achado pela revisão de segurança de 2026-09-14.
            let obliquo = ini < d.location
                && casa(regenciaDeDestino, ns.substring(with: NSRange(
                    location: ini, length: d.location - ini)))
            let depois = !obliquo && fimDoTrecho > d.location + d.length && casa(negadorColado, ns.substring(with: NSRange(
                location: d.location + d.length, length: fimDoTrecho - d.location - d.length)))
            if !antes && !depois { return false }
            anterior = d.location + d.length
        }
        return true
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
        for m in distribuidor.matches(in: oracao, range: NSRange(location: 0, length: ns.length)) {
            let ini = max(0, m.range.location - 30)
            let fim = min(ns.length, m.range.location + m.range.length + 30)
            if !casa(revoga, ns.substring(with: NSRange(location: ini, length: fim - ini))) { return true }
        }
        return false
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
            // A oração anterior tem que trazer a QUANTIDADE *e* o substantivo
            // da gorjeta. Só a quantidade não basta: `tudo`/`todo` aparecem o
            // tempo todo fora de contexto de dinheiro, e "Já tirei o serviço
            // todo.\nCom o atendente você confirma na saída." virava recusa —
            // três de cinco respostas certas sumiam atrás da resposta segura.
            // Piora com a moeda na lista: "Sua parte é R$ 61,00.\nCom o garçom
            // você acerta." passaria a ter quantidade também.
            // Achado pela revisão de segurança de 2026-09-14.
            // A CLASSE NÃO TEM VERBO — "pro garçom", "100% pra equipe",
            // "- 100% pra equipe do salão". Uma oração com verbo é outra
            // coisa: "Com o garçom tá tudo certo" é confirmação operacional, e
            // virava recusa. A regra 1b é quem cuida dessas, porque elas têm
            // verbo.
            guard casa(fraseDeDestinoPura, ateOSeparador(o)) else { continue }
            let anteriorTemQuantidade = i > 0 && casa(quantidade, partes[i - 1])
                && casa(fraseDeDestino, o)
            guard casa(marcadorDeLista, o) || casa(quantidade, o) || anteriorTemQuantidade else { continue }
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
