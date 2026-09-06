import Foundation

/// A fast, offline first guess at what a receipt line *is*.
///
/// The agent can and does override this — it has the full receipt and far more
/// context. But the categoriser runs the instant a row appears, before any
/// network call, and the category is what picks the image prompt and the row's
/// icon. Getting "chopp" onto a glass and "picanha" onto a plate in the first
/// frame is the difference between a list and a menu.
///
/// Matching is on folded text (accent- and case-insensitive), longest keyword
/// first so "água de coco" doesn't get caught by "água".
enum ItemCategorizer {

    private static let keywords: [(ItemCategory, [String])] = [
        (.carne, ["picanha", "fraldinha", "alcatra", "contra file", "contrafile", "maminha", "cupim",
                  "costela", "linguica", "linguiça", "bife", "file mignon", "filé mignon", "churrasco",
                  "hamburguer", "hambúrguer", "burger", "frango", "bacon", "carne", "parmegiana",
                  "espetinho", "porco", "pernil", "cordeiro", "steak", "rib eye", "ancho"]),
        (.peixe, ["salmao", "salmão", "tilapia", "tilápia", "bacalhau", "camarao", "camarão", "polvo",
                  "lula", "sushi", "sashimi", "temaki", "peixe", "moqueca", "casquinha de siri",
                  "ostra", "atum", "ceviche", "robalo"]),
        (.massa, ["pizza", "massa", "macarrao", "macarrão", "espaguete", "spaghetti", "nhoque", "gnocchi",
                  "lasanha", "ravioli", "penne", "fettuccine", "risoto", "risotto", "talharim"]),
        (.petisco, ["pastel", "coxinha", "bolinho", "porcao", "porção", "isca", "batata frita",
                    "onion rings", "petisco", "tabua", "tábua", "antepasto", "bruschetta", "croquete",
                    "dadinho", "torresmo", "calabresa acebolada", "aperitivo"]),
        (.salada, ["salada", "caesar", "rucula", "rúcula", "caprese", "folhas", "tabule"]),
        (.acompanhamento, ["arroz", "feijao", "feijão", "farofa", "vinagrete", "pure", "purê", "mandioca",
                           "aipim", "polenta", "pao de alho", "pão de alho", "acompanhamento", "guarnicao",
                           "guarnição", "molho", "queijo coalho"]),
        (.sobremesa, ["sobremesa", "pudim", "petit gateau", "brownie", "sorvete", "acai", "açaí",
                      "mousse", "cheesecake", "torta", "bolo", "doce", "brigadeiro", "romeu e julieta",
                      "creme brulee", "banoffee"]),
        (.cerveja, ["chopp", "chope", "cerveja", "brahma", "heineken", "original", "budweiser", "spaten",
                    "ipa", "pilsen", "lager", "long neck", "longneck", "stella", "corona", "eisenbahn",
                    "beer", "growler"]),
        (.drink, ["caipirinha", "caipiroska", "gin", "tonica", "tônica", "drink", "coquetel", "cocktail",
                  "whisky", "whiskey", "vodka", "aperol", "spritz", "negroni", "moscow mule", "margarita",
                  "cachaca", "cachaça", "dose", "shot", "mojito", "batida", "rum", "tequila"]),
        (.vinho, ["vinho", "malbec", "cabernet", "merlot", "chardonnay", "sauvignon", "espumante",
                  "prosecco", "champagne", "tannat", "rose", "rosé", "taca de vinho", "taça de vinho"]),
        (.refrigerante, ["coca", "guarana", "guaraná", "refrigerante", "sprite", "fanta", "tonica lata",
                         "agua com gas", "água com gás", "agua", "água", "h2oh", "soda"]),
        (.cafe, ["cafe", "café", "espresso", "expresso", "cappuccino", "capuccino", "latte", "macchiato",
                 "cortado", "coado", "cha", "chá"]),
        (.suco, ["suco", "vitamina", "smoothie", "limonada", "agua de coco", "água de coco", "laranja"]),
        (.couvert, ["couvert", "couvert artistico", "couvert artístico", "musica ao vivo"]),
        (.servico, ["servico", "serviço", "taxa de servico", "gorjeta", "10%"]),
        (.taxa, ["taxa", "entrega", "delivery", "frete", "convenience", "tarifa"]),
        (.transporte, ["uber", "99", "taxi", "táxi", "onibus", "ônibus", "metro", "metrô", "aviao",
                       "avião", "passagem", "voo", "aluguel de carro", "pedagio", "pedágio",
                       "estacionamento", "trem", "van", "cabify", "blablacar"]),
        (.hospedagem, ["airbnb", "hotel", "pousada", "hostel", "diaria", "diária", "chale", "chalé",
                       "resort", "camping", "booking"]),
        (.ingresso, ["ingresso", "ticket", "entrada", "show", "cinema", "festival", "balada", "museu",
                     "parque", "pista", "camarote", "excursao", "excursão"]),
        (.mercado, ["mercado", "supermercado", "hortifruti", "acougue", "açougue", "padaria",
                    "carrefour", "pao de acucar", "pão de açúcar", "atacadao", "atacadão", "compras",
                    "feira", "sacolao", "sacolão"]),
        (.combustivel, ["gasolina", "etanol", "alcool", "álcool", "diesel", "combustivel", "combustível",
                        "posto", "abastecer", "carga eletrica", "carga elétrica"]),
        (.assinatura, ["netflix", "spotify", "assinatura", "mensalidade", "internet", "luz", "agua conta",
                       "condominio", "condomínio", "aluguel", "gas", "gás", "faxina", "diarista"])
    ]

    /// Keywords sorted longest-first once, at first use. A short keyword that is a
    /// substring of a longer one must never win the race.
    private static let ranked: [(phrase: String, category: ItemCategory)] = {
        keywords
            .flatMap { category, phrases in phrases.map { (phrase: $0.folded, category: category) } }
            .sorted { $0.phrase.count > $1.phrase.count }
    }()

    static func guess(_ name: String) -> ItemCategory {
        let n = name.folded
        guard !n.isEmpty else { return .other }
        for entry in ranked where n.contains(entry.phrase) { return entry.category }
        return .other
    }
}
