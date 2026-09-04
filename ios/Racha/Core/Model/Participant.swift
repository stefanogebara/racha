import Foundation

/// Someone at the table. Deliberately thin: a racha is about money, not contacts.
///
/// `handle` is the informal name people actually use ("o Gui", "a Ju") because
/// that is what gets typed into the chat and what the agent has to resolve. The
/// resolver lives in `ParticipantResolver` and is fuzzy on purpose — "gui",
/// "Gui", "guilherme" and "o gui" are one person.
struct Participant: Identifiable, Hashable, Codable, Sendable {
    var id: UUID
    var name: String
    /// Pix key, if they've shared one — lets the app build a payable code instead
    /// of just a number on a screen.
    var pixKey: String?
    /// Stable colour/emoji seed so a person looks the same across every racha.
    var avatarSeed: Int

    init(id: UUID = UUID(), name: String, pixKey: String? = nil, avatarSeed: Int? = nil) {
        self.id = id
        self.name = name
        self.pixKey = pixKey
        self.avatarSeed = avatarSeed ?? abs(name.lowercased().folded.hashValue % 360)
    }

    /// First name, which is what fits on a chip.
    var shortName: String {
        name.split(separator: " ").first.map(String.init) ?? name
    }

    var initials: String {
        let parts = name.split(separator: " ").prefix(2)
        return parts.compactMap { $0.first.map(String.init) }.joined().uppercased()
    }
}

extension String {
    /// Lowercased, accent-stripped, whitespace-trimmed. The normalisation used for
    /// every fuzzy match in the app — name resolution, dish-image cache keys,
    /// restaurant lookups — so "Açaí" and "acai" are never two different things.
    var folded: String {
        folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "pt_BR"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Resolves the loose way people are named in chat to actual participants.
///
/// The agent writes to the ledger by name, and a wrong match moves real money to
/// the wrong person — so this never guesses across an ambiguity. It returns
/// `.ambiguous` and the agent is instructed to ask, which is cheaper than an
/// undo.
enum ParticipantResolver {
    enum Result: Equatable {
        case matched(Participant.ID)
        case ambiguous([Participant.ID])
        case notFound
    }

    /// Portuguese articles and vocatives people type without thinking.
    private static let noise: Set<String> = ["o", "a", "os", "as", "do", "da", "de", "pro", "pra", "e"]

    static func resolve(_ query: String, in participants: [Participant]) -> Result {
        let q = query.folded
        guard !q.isEmpty else { return .notFound }

        // "eu"/"mim"/"meu" are handled by the caller, which knows who "me" is.
        let stripped = q.split(separator: " ")
            .map(String.init)
            .filter { !noise.contains($0) }
            .joined(separator: " ")
        let needle = stripped.isEmpty ? q : stripped

        let exact = participants.filter { $0.name.folded == needle || $0.shortName.folded == needle }
        if exact.count == 1 { return .matched(exact[0].id) }
        if exact.count > 1 { return .ambiguous(exact.map(\.id)) }

        let prefix = participants.filter { $0.name.folded.hasPrefix(needle) || needle.hasPrefix($0.shortName.folded) }
        if prefix.count == 1 { return .matched(prefix[0].id) }
        if prefix.count > 1 { return .ambiguous(prefix.map(\.id)) }

        let contains = participants.filter { $0.name.folded.contains(needle) }
        if contains.count == 1 { return .matched(contains[0].id) }
        if contains.count > 1 { return .ambiguous(contains.map(\.id)) }

        return .notFound
    }
}
