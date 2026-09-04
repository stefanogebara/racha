import Foundation

/// The contract between the model and the ledger.
///
/// Every tool that writes money returns a `preview` describing the change in
/// pt-BR **and** the ids of the events it appended, so the thread can render an
/// undo affordance next to the agent's message. That is the mechanical guarantee
/// behind the product rule: the agent never silently mutates an amount.
struct AgentTool: Sendable {
    var name: String
    var description: String
    /// JSON Schema for the input. Written by hand rather than generated: the
    /// wording of a tool description is prompt engineering, and money tools need
    /// their invariants spelled out where the model will actually read them.
    var schema: JSONValue
    var writesMoney: Bool
}

/// What a tool hands back to the loop.
struct ToolOutcome: Sendable {
    /// JSON the model sees.
    var payload: JSONValue
    /// Human-readable pt-BR summary shown in the thread. `nil` for read-only tools.
    var preview: String?
    /// Events appended by this call — the undo handle.
    var eventIDs: [UUID]
    var isError: Bool

    init(_ payload: JSONValue, preview: String? = nil, eventIDs: [UUID] = [], isError: Bool = false) {
        self.payload = payload
        self.preview = preview
        self.eventIDs = eventIDs
        self.isError = isError
    }

    static func failure(_ message: String) -> ToolOutcome {
        ToolOutcome(["ok": false, "error": .string(message)], isError: true)
    }
}

enum AgentTools {

    static var all: [AgentTool] { [
        parseReceipt, addItems, editItem, removeItem,
        assignItems, listSplit, addPerson, setExtra, toggleExtra,
        recordPayment, settleUp, pixCode,
        history, venueProfile, setCurrency, setTitle
    ] }

    // MARK: Receipt

    static let parseReceipt = AgentTool(
        name: "registrar_itens_da_nota",
        description: """
        Registra os itens lidos numa foto de nota/comanda. Chame DEPOIS de ler a imagem \
        que o usuário mandou. Valores SEMPRE em centavos inteiros (R$ 47,50 → 4750). \
        Se o total impresso da linha não bater com quantidade × preço unitário, mande o \
        total impresso mesmo assim em `total_cents` — a nota é a autoridade, e o app \
        marca a divergência em vez de recalcular escondido. Não invente itens que você \
        não consegue ler; itens ilegíveis vão em `ilegiveis`.
        """,
        schema: ["type": "object", "properties": [
            "itens": ["type": "array", "items": ["type": "object", "properties": [
                "nome": ["type": "string", "description": "Nome do item como está na nota"],
                "quantidade": ["type": "integer", "minimum": 1],
                "preco_unitario_cents": ["type": "integer", "minimum": 0],
                "total_cents": ["type": "integer", "minimum": 0],
                "categoria": ["type": "string", "enum": .array(ItemCategory.allCases.map { .string($0.rawValue) })]
            ], "required": ["nome", "quantidade", "total_cents"]]],
            "servico_bp": ["type": "integer", "description": "Serviço em pontos-base (10% = 1000), se estiver impresso"],
            "couvert_cents": ["type": "integer", "description": "Couvert por pessoa, se houver"],
            "ilegiveis": ["type": "array", "items": ["type": "string"]]
        ], "required": ["itens"]],
        writesMoney: true
    )

    // MARK: Items

    static let addItems = AgentTool(
        name: "adicionar_itens",
        description: """
        Adiciona itens à conta manualmente (sem nota). Valores em centavos inteiros. \
        Use quando o usuário fala um gasto direto: "a Uber deu 38 reais" → um item de 3800.
        """,
        schema: ["type": "object", "properties": [
            "itens": ["type": "array", "items": ["type": "object", "properties": [
                "nome": ["type": "string"],
                "quantidade": ["type": "integer", "minimum": 1],
                "total_cents": ["type": "integer", "minimum": 0],
                "categoria": ["type": "string", "enum": .array(ItemCategory.allCases.map { .string($0.rawValue) })]
            ], "required": ["nome", "total_cents"]]]
        ], "required": ["itens"]],
        writesMoney: true
    )

    static let editItem = AgentTool(
        name: "editar_item",
        description: """
        Corrige um item existente. Passe SÓ os campos que mudam. \
        Se mandar `total_cents`, ele vence — o total é o que o restaurante cobra.
        """,
        schema: ["type": "object", "properties": [
            "item": ["type": "string", "description": "Nome ou id do item"],
            "nome": ["type": "string"],
            "quantidade": ["type": "integer", "minimum": 1],
            "preco_unitario_cents": ["type": "integer", "minimum": 0],
            "total_cents": ["type": "integer", "minimum": 0],
            "categoria": ["type": "string"]
        ], "required": ["item"]],
        writesMoney: true
    )

    static let removeItem = AgentTool(
        name: "remover_item",
        description: "Tira um item da conta (cobrado errado, veio o prato errado).",
        schema: ["type": "object", "properties": [
            "item": ["type": "string"]
        ], "required": ["item"]],
        writesMoney: true
    )

    // MARK: Split

    static let assignItems = AgentTool(
        name: "atribuir_itens",
        description: """
        Diz de quem é cada item. É o coração do racha.

        - `pessoas: []` (lista vazia) tira todos os donos do item.
        - `pesos` opcional, na mesma ordem de `pessoas`: "o Pedro tomou dois dos quatro \
          chopps" → pessoas ["Pedro","Gui","Ju"], pesos [2,1,1].
        - Sem `pesos`, o item é dividido igualmente entre as pessoas listadas; o centavo \
          que sobra é distribuído e o app mostra em quem caiu.
        - Se o nome de alguém for ambíguo (dois "Ju"), o app devolve erro — PERGUNTE, \
          não escolha.
        """,
        schema: ["type": "object", "properties": [
            "atribuicoes": ["type": "array", "items": ["type": "object", "properties": [
                "item": ["type": "string", "description": "Nome ou id do item"],
                "pessoas": ["type": "array", "items": ["type": "string"]],
                "pesos": ["type": "array", "items": ["type": "integer", "minimum": 1]]
            ], "required": ["item", "pessoas"]]]
        ], "required": ["atribuicoes"]],
        writesMoney: true
    )

    static let listSplit = AgentTool(
        name: "ver_racha",
        description: """
        Estado atual completo: itens, quem pegou o quê, extras, quanto cada um deve, \
        quem já pagou, o que falta, e onde caiu cada centavo de arredondamento. \
        Chame ANTES de responder qualquer pergunta sobre valores — nunca calcule de cabeça.
        """,
        schema: ["type": "object", "properties": [:]],
        writesMoney: false
    )

    static let addPerson = AgentTool(
        name: "adicionar_pessoa",
        description: "Coloca alguém no racha. `chave_pix` opcional, pra gerar código de pagamento depois.",
        schema: ["type": "object", "properties": [
            "nome": ["type": "string"],
            "chave_pix": ["type": "string"]
        ], "required": ["nome"]],
        writesMoney: false
    )

    // MARK: Extras

    static let setExtra = AgentTool(
        name: "definir_extra",
        description: """
        Cria ou atualiza um extra: serviço, couvert, taxa de entrega, gorjeta, desconto.

        Tipos:
        - `percentual` + `bp` (10% = 1000) — cobrado sobre o que CADA UM consumiu, \
          proporcional. Quem comeu mais paga mais serviço.
        - `por_cabeca` + `valor_cents` — couvert: valor fixo por pessoa presente.
        - `fixo` + `valor_cents` — rateado proporcionalmente ao consumo de cada um.
        - `desconto` + `valor_cents` — igual ao fixo, com sinal negativo.

        O serviço é SEMPRE removível pelo usuário (CDC). Nunca trate como obrigatório.
        """,
        schema: ["type": "object", "properties": [
            "nome": ["type": "string"],
            "tipo": ["type": "string", "enum": ["percentual", "por_cabeca", "fixo", "desconto"]],
            "bp": ["type": "integer", "description": "Pontos-base, para tipo=percentual"],
            "valor_cents": ["type": "integer"],
            "gorjeta": ["type": "boolean", "description": "true se for remuneração da equipe (serviço/gorjeta)"]
        ], "required": ["nome", "tipo"]],
        writesMoney: true
    )

    static let toggleExtra = AgentTool(
        name: "ligar_desligar_extra",
        description: "Liga ou desliga um extra sem apagar. Usado pra tirar o serviço.",
        schema: ["type": "object", "properties": [
            "nome": ["type": "string"],
            "ligado": ["type": "boolean"]
        ], "required": ["nome", "ligado"]],
        writesMoney: true
    )

    // MARK: Money movement

    static let recordPayment = AgentTool(
        name: "registrar_pagamento",
        description: """
        Registra que alguém pagou. "Eu paguei a conta toda" → pagador "eu", valor = total. \
        `confirmado` false quando é só uma intenção ("vou pagar depois").
        """,
        schema: ["type": "object", "properties": [
            "pagador": ["type": "string"],
            "valor_cents": ["type": "integer", "minimum": 0],
            "metodo": ["type": "string", "enum": ["pix", "cartao", "dinheiro", "transferencia", "outro"]],
            "confirmado": ["type": "boolean"],
            "observacao": ["type": "string"]
        ], "required": ["pagador", "valor_cents"]],
        writesMoney: true
    )

    static let settleUp = AgentTool(
        name: "acertar_contas",
        description: """
        Calcula o menor número de transferências que zera todo mundo. Não move dinheiro — \
        só devolve o plano ("Gui paga R$ 43,20 pra você"). Se ainda falta dinheiro pro \
        restaurante, isso vem separado em `falta_pagar`, nunca embutido na dívida de alguém.
        """,
        schema: ["type": "object", "properties": [:]],
        writesMoney: false
    )

    static let pixCode = AgentTool(
        name: "gerar_codigo_pix",
        description: """
        Gera o Pix copia-e-cola de uma transferência do plano de acerto. Precisa da chave \
        Pix de quem RECEBE — se não tiver, devolve erro e você deve pedir a chave. \
        Nunca invente chave.
        """,
        schema: ["type": "object", "properties": [
            "de": ["type": "string", "description": "Quem paga"],
            "para": ["type": "string", "description": "Quem recebe"],
            "valor_cents": ["type": "integer", "minimum": 1]
        ], "required": ["de", "para", "valor_cents"]],
        writesMoney: false
    )

    // MARK: History

    static let history = AgentTool(
        name: "consultar_historico",
        description: """
        Histórico entre rachas: com quem o usuário divide conta, grupos recorrentes, e \
        quanto cada pessoa ainda deve somando TODOS os rachas abertos. \
        É como você responde "quanto o pessoal ainda me deve?".
        """,
        schema: ["type": "object", "properties": [
            "escopo": ["type": "string", "enum": ["pendencias", "pessoas", "grupos", "tudo"]],
            "pessoa": ["type": "string", "description": "Filtra por uma pessoa"]
        ]],
        writesMoney: false
    )

    static let venueProfile = AgentTool(
        name: "consultar_lugar",
        description: """
        Como a conta de um lugar costuma ser: quantas visitas, gasto mediano, itens que \
        sempre aparecem, se cobra couvert, e qual o percentual de serviço.
        """,
        schema: ["type": "object", "properties": [
            "lugar": ["type": "string"]
        ], "required": ["lugar"]],
        writesMoney: false
    )

    // MARK: Meta

    static let setCurrency = AgentTool(
        name: "definir_moeda",
        description: """
        Define a moeda do racha e, se for viagem, a cotação travada pro real. \
        `micros_por_unidade`: 1 EUR = R$ 6,2135 → 6213500. A cotação fica CONGELADA no \
        racha — o histórico não se re-precifica sozinho quando o câmbio mexe.
        """,
        schema: ["type": "object", "properties": [
            "moeda": ["type": "string", "description": "Código ISO, ex. EUR"],
            "micros_por_unidade": ["type": "integer"]
        ], "required": ["moeda"]],
        writesMoney: true
    )

    static let setTitle = AgentTool(
        name: "renomear_racha",
        description: "Dá nome ao racha. Use o nome do lugar quando souber — o histórico usa isso.",
        schema: ["type": "object", "properties": [
            "titulo": ["type": "string"],
            "tipo": ["type": "string", "enum": .array(RachaKind.allCases.map { .string($0.rawValue) })]
        ], "required": ["titulo"]],
        writesMoney: false
    )
}
