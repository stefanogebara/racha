import Foundation

/// Turn a scanned check into a racha.
///
/// The one rule that shapes this file: **the ledger is the truth, so a scan is
/// events, not a state overwrite**. Importing appends `venueSet`, `itemsAdded`
/// and the venue's serviço exactly the way a person or the agent would, which is
/// what keeps every imported row as undoable and as auditable as a typed one.
///
/// Re-scanning is the interesting case. A waiter adds a round; someone scans
/// again; the check now has rows the racha does not. Importing the whole check
/// again would duplicate everything and double the bill, so the import is a
/// **diff**: rows already on the racha are left alone, with their claims intact,
/// and only what is new gets appended.
enum CheckImport {

    /// Create a racha from a freshly scanned table.
    @MainActor
    static func createRacha(from check: OpenCheck, in repository: RachaRepository,
                            meName: String) async throws -> UUID {
        let id = try await repository.createRacha(title: check.venue.name, kind: .jantar,
                                                  meName: meName)
        var events: [(RachaEvent.Body, String)] = [
            (.venueSet(check.venue), [check.venue.tableLabel, check.venue.name]
                .compactMap { $0 }.joined(separator: " · "))
        ]
        if !check.items.isEmpty {
            events.append((.itemsAdded(check.items),
                           "\(check.items.count) \(check.items.count == 1 ? "item" : "itens") da comanda"))
        }
        // The serviço the venue publishes, switched on but — as always —
        // switchable off (CDC, non-negotiable #3). A venue that publishes no
        // rate gets no extra invented for it.
        if let bp = check.servicoBP, bp > 0 {
            events.append((.extraAdded(Extra.servico(bp: bp)),
                           "Serviço \(bp / 100)% da casa"))
        }
        _ = try await repository.appendBatch(id, events, origin: .system)
        return id
    }

    /// Bring a re-scanned check up to date without disturbing what is already
    /// split. Returns the rows that were added, so the UI can say what changed
    /// rather than silently mutating the bill under someone's thumb.
    @MainActor
    @discardableResult
    static func merge(_ check: OpenCheck, into rachaID: UUID,
                      in repository: RachaRepository) async throws -> [LineItem] {
        guard let state = repository.state(rachaID) else { return [] }
        let newRows = newItems(in: check, existing: state.items)
        var events: [(RachaEvent.Body, String)] = []

        // The table can move (a group changes tables mid-dinner) and the venue
        // can gain a Pix key between reads; take the newer one.
        if let venue = state.venue, venue != check.venue {
            events.append((.venueSet(check.venue), "Mesa atualizada"))
        }
        if !newRows.isEmpty {
            events.append((.itemsAdded(newRows),
                           "\(newRows.count) \(newRows.count == 1 ? "item novo" : "itens novos") na comanda"))
        }
        guard !events.isEmpty else { return [] }
        _ = try await repository.appendBatch(rachaID, events, origin: .system)
        return newRows
    }

    /// Which rows of the check the racha does not have yet.
    ///
    /// Matched on name, quantity and total — not on the POS's row id, which
    /// Saipos regenerates between reads, and not on name alone, because a table
    /// really does order a second identical round. Multiplicity counts: two
    /// chopps on the check and one on the racha means one is new.
    static func newItems(in check: OpenCheck, existing: [LineItem]) -> [LineItem] {
        var have: [Key: Int] = [:]
        for item in existing { have[Key(item), default: 0] += 1 }
        var out: [LineItem] = []
        for item in check.items {
            let key = Key(item)
            if let count = have[key], count > 0 {
                have[key] = count - 1
            } else {
                out.append(item)
            }
        }
        return out
    }

    private struct Key: Hashable {
        let name: String, quantity: Int, total: Cents
        init(_ item: LineItem) {
            name = item.name.folded
            quantity = item.quantity
            total = item.total
        }
    }
}
