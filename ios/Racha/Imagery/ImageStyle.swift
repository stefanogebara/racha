import Foundation

/// Which visual world an item belongs to.
///
/// The brief: a table of "picanha, farofa, chopp" must read as a plated spread,
/// and a racha of "Uber, Airbnb, ingresso" needs its own consistent language.
/// Four worlds, each with a fixed lighting and staging recipe, is what makes
/// twenty images generated weeks apart look like one photographer shot them.
enum VisualWorld: String, Codable, Sendable {
    case plate      // food, top-down on ceramic
    case glass      // drinks, three-quarter on a bar
    case object     // non-food: a ticket, a key, a car — still life
    case abstract   // couvert, taxes: no object exists, so a material study
}

/// The prompt recipe.
///
/// `version` is part of every cache key. Changing a word in a recipe therefore
/// invalidates only the images made under the old wording, which is what lets the
/// style be tuned without either serving a mixed-looking gallery or throwing away
/// a paid-for cache.
enum ImageStyle {
    static let version = 4

    /// The constant that makes a set look like a set. Every prompt ends with it.
    /// The constant that makes a set look like a set. Every item prompt ends
    /// with it. Note what it asks for: a subject **isolated on transparency**,
    /// with its own contact shadow retained. The app composites that cut-out
    /// onto its paper, so the object appears to sit on the page rather than
    /// inside a photo pasted into a box.
    private static let house = """
    Isolated on a fully transparent background — no backdrop, no surface, no \
    scene, alpha channel only around the subject. Keep the subject's own soft \
    contact shadow directly beneath it. Shot on a Hasselblad with a 100mm macro, \
    f/5.6. Single large softbox from the upper left with a subtle warm bounce \
    from the right. Muted, natural, slightly desaturated colour with warm amber \
    undertones. Editorial food-magazine styling. No text, no logos, no \
    watermarks, no hands, no people, no cutlery unless specified, no props \
    competing with the subject. Subject centred and filling most of the frame, \
    square crop.
    """

    /// The cover is different: it is shown full-bleed behind type, so it keeps a
    /// real background rather than being cut out.
    private static let coverHouse = """
    Shot on a Hasselblad with a 100mm macro, f/5.6. Single large softbox from the \
    upper left. Background is a seamless warm off-white (#F7F2E9) paper surface \
    with a faint falloff. Muted, natural, slightly desaturated colour with warm \
    amber undertones. Editorial food-magazine styling. No text, no logos, no \
    watermarks, no hands, no people. Generous negative space, square crop.
    """

    static func prompt(for item: LineItem) -> String {
        let subject = subject(for: item)
        switch item.category.world {
        case .plate:
            return """
            A single serving of \(subject), Brazilian restaurant plating, on a plain \
            matte ceramic plate. Shot from directly overhead, subject filling about \
            60% of the frame. \(house)
            """
        case .glass:
            return """
            \(subject), served in the appropriate Brazilian bar glassware, \
            condensation on the glass, shot at a three-quarter angle just above the \
            rim line on a bare wooden bar top. \(house)
            """
        case .object:
            return """
            A minimal still life representing \(subject): the single most \
            characteristic physical object, isolated, resting on the surface. Product \
            photography, not an illustration or an icon. \(house)
            """
        case .abstract:
            return """
            An abstract material study representing \(subject): folded warm off-white \
            paper and soft raking light, no recognisable object. Quiet, textural, \
            almost monochrome with a faint amber cast. \(house)
            """
        }
    }

    /// The cover for a whole racha. Composed from the three most expensive items,
    /// so the picture is of the meal rather than of a category.
    static func coverPrompt(kind: RachaKind, title: String, headline: [String]) -> String {
        let subjects = headline.isEmpty ? [title] : headline
        switch kind {
        case .jantar, .rolê, .churrasco:
            return """
            An overhead editorial spread of a shared Brazilian table: \
            \(subjects.joined(separator: ", ")). Several dishes arranged on a warm \
            off-white surface, as if photographed the moment before people start \
            eating. \(coverHouse)
            """
        case .viagem:
            return """
            A travel still life representing a trip: \(subjects.joined(separator: ", ")). \
            A few characteristic objects arranged as an overhead flat lay. \(coverHouse)
            """
        case .casa:
            return """
            A quiet domestic still life representing a shared household: \
            \(subjects.joined(separator: ", ")). Overhead, calm, ordered. \(coverHouse)
            """
        case .mercado:
            return """
            An overhead flat lay of grocery items: \(subjects.joined(separator: ", ")), \
            arranged in a loose grid. \(coverHouse)
            """
        case .outro:
            return """
            An abstract overhead still life representing \(title), built from folded \
            warm paper and simple geometric forms. \(coverHouse)
            """
        }
    }

    /// Strip the receipt's noise so the prompt describes food rather than a POS
    /// entry: "2X PICANHA C/ FRITAS *PROMO" → "picanha com fritas".
    static func subject(for item: LineItem) -> String {
        var name = item.name
            .replacingOccurrences(of: #"^\s*\d+\s*[xX]\s*"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[*#]+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        if name == name.uppercased() { name = name.lowercased() }
        for (abbrev, full) in abbreviations {
            name = name.replacingOccurrences(of: abbrev, with: full, options: [.caseInsensitive])
        }
        return name.isEmpty ? item.category.label.lowercased() : name
    }

    private static let abbreviations: [(String, String)] = [
        (" c/ ", " com "), (" s/ ", " sem "), (" p/ ", " para "),
        ("refri", "refrigerante"), ("acomp", "acompanhamento"),
        ("porc ", "porção "), ("md ", "média "), ("gd ", "grande ")
    ]

    /// The cache key.
    ///
    /// Folded name + world + style version. Deliberately *not* the item id: two
    /// people ordering picanha at two restaurants on two nights must hit the same
    /// cached image. That is the whole economics of the feature — the marginal
    /// cost of the hundredth picanha is zero.
    static func cacheKey(for item: LineItem) -> String {
        let subject = subject(for: item).folded
            .replacingOccurrences(of: " ", with: "-")
            .filter { $0.isLetter || $0.isNumber || $0 == "-" }
        return "v\(version).\(item.category.world.rawValue).\(subject.prefix(60))"
    }

    static func coverCacheKey(kind: RachaKind, headline: [String]) -> String {
        let joined = headline.map(\.folded).sorted().joined(separator: "+")
            .replacingOccurrences(of: " ", with: "-")
            .filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "+" }
        return "v\(version).cover.\(kind.rawValue).\(joined.prefix(72))"
    }
}
