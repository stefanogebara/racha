import Foundation

/// Executes tool calls against the repository.
///
/// Every write goes through `RachaRepository.append`, so every agent edit lands
/// in the log with a pt-BR summary and an event id. Nothing here mutates state
/// directly, and nothing here computes money — the split engine does that, and
/// the toolbox reports what the engine said.
@MainActor
struct AgentToolbox {
    let repository: RachaRepository
    let rachaID: UUID
    var historyProvider: @MainActor () -> HistoryIndex

    private var state: RachaState { get throws {
        guard let s = repository.state(rachaID) else { throw RachaError.unknownRacha }
        return s
    } }

    // MARK: Dispatch

    func run(_ name: String, _ args: JSONValue) async -> ToolOutcome {
        do {
            switch name {
            case AgentTools.parseReceipt.name:   return try await registrarItens(args, fromReceipt: true)
            case AgentTools.addItems.name:       return try await registrarItens(args, fromReceipt: false)
            case AgentTools.editItem.name:       return try await editarItem(args)
            case AgentTools.removeItem.name:     return try await removerItem(args)
            case AgentTools.assignItems.name:    return try await atribuir(args)
            case AgentTools.listSplit.name:      return try verRacha()
            case AgentTools.addPerson.name:      return try await adicionarPessoa(args)
            case AgentTools.setExtra.name:       return try await definirExtra(args)
            case AgentTools.toggleExtra.name:    return try await ligarExtra(args)
            case AgentTools.recordPayment.name:  return try await registrarPagamento(args)
            case AgentTools.settleUp.name:       return try acertarContas()
            case AgentTools.pixCode.name:        return try gerarPix(args)
            case AgentTools.history.name:        return consultarHistorico(args)
            case AgentTools.venueProfile.name:   return consultarLugar(args)
            case AgentTools.setCurrency.name:    return try await definirMoeda(args)
            case AgentTools.setTitle.name:       return try await renomear(args)
            default: return .failure("Ferramenta desconhecida: \(name)")
            }
        } catch let error as RachaError {
            return .failure(error.errorDescription ?? "Erro")
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    // MARK: Items

    private func registrarItens(_ args: JSONValue, fromReceipt: Bool) async throws -> ToolOutcome {
        guard let raw = args.objects("itens"), !raw.isEmpty else {
            return .failure("Nenhum item na chamada.")
        }
        var items: [LineItem] = []
        for entry in raw {
            guard let name = entry.string("nome") else { continue }
            let qty = entry.int("quantidade") ?? 1
            let total = entry.cents("total_cents")
            let unit = entry.cents("preco_unitario_cents")
            // A row must carry at least one real amount. Inventing one is exactly
            // the "silently mutates an amount" failure the product forbids.
            guard let resolvedTotal = total ?? unit.map({ $0 * qty }) else {
                return .failure("O item “\(name)” veio sem valor. Mande total_cents em centavos inteiros.")
            }
            guard resolvedTotal.raw >= 0 else {
                return .failure("Valor negativo em “\(name)”. Desconto é um extra do tipo `desconto`.")
            }
            let unitResolved = unit ?? Cents(resolvedTotal.raw / max(1, qty))
            let category = entry.string("categoria").flatMap(ItemCategory.init(rawValue:))
                ?? ItemCategorizer.guess(name)
            items.append(LineItem(name: name, quantity: qty, unitPrice: unitResolved,
                                  total: resolvedTotal, category: category,
                                  rawText: fromReceipt ? entry.string("nome") : nil))
        }
        guard !items.isEmpty else { return .failure("Não consegui montar nenhum item válido.") }

        let sum = items.map(\.total).total
        var events: [UUID] = []
        let e = try await repository.append(rachaID, .itemsAdded(items), origin: fromReceipt ? .scan : .agent,
                                            summary: "\(items.count) \(items.count == 1 ? "item adicionado" : "itens adicionados") · \(BRL.format(sum))")
        events.append(e.id)

        // Extras that came off the same receipt, appended as their own facts so
        // each can be toggled or undone on its own.
        if let bp = args.int("servico_bp"), bp > 0 {
            let extra = Extra.servico(bp: bp)
            let ev = try await repository.append(rachaID, .extraAdded(extra), origin: .scan,
                                                 summary: "Serviço \(extra.kind.display) da nota")
            events.append(ev.id)
        }
        if let couvert = args.cents("couvert_cents"), couvert.raw > 0 {
            let extra = Extra.couvert(couvert)
            let ev = try await repository.append(rachaID, .extraAdded(extra), origin: .scan,
                                                 summary: "Couvert \(BRL.format(couvert)) por pessoa")
            events.append(ev.id)
        }

        let unreadable = args.strings("ilegiveis") ?? []
        return ToolOutcome(
            ["ok": true,
             "itens_adicionados": .int(items.count),
             "soma_cents": .int(sum.raw),
             "ilegiveis": .array(unreadable.map { .string($0) }),
             "estado": try snapshot()],
            preview: "\(items.count) \(items.count == 1 ? "item" : "itens") · \(BRL.format(sum))",
            eventIDs: events
        )
    }

    private func editarItem(_ args: JSONValue) async throws -> ToolOutcome {
        let s = try state
        guard let query = args.string("item"), let item = findItem(query, in: s) else {
            throw RachaError.unknownItem(args.string("item") ?? "?")
        }
        let newTotal = args.cents("total_cents")
        let newUnit = args.cents("preco_unitario_cents")
        let body = RachaEvent.Body.itemEdited(
            id: item.id,
            name: args.string("nome"),
            quantity: args.int("quantidade"),
            unitPrice: newUnit,
            total: newTotal,
            category: args.string("categoria").flatMap(ItemCategory.init(rawValue:))
        )
        let describedChange = newTotal.map { "\(item.name): \(BRL.format(item.total)) → \(BRL.format($0))" }
            ?? "\(item.name) atualizado"
        let e = try await repository.append(rachaID, body, origin: .agent, summary: describedChange)
        return ToolOutcome(["ok": true, "estado": try snapshot()],
                           preview: describedChange, eventIDs: [e.id])
    }

    private func removerItem(_ args: JSONValue) async throws -> ToolOutcome {
        let s = try state
        guard let query = args.string("item"), let item = findItem(query, in: s) else {
            throw RachaError.unknownItem(args.string("item") ?? "?")
        }
        let e = try await repository.append(rachaID, .itemRemoved(item.id), origin: .agent,
                                            summary: "\(item.name) removido · −\(BRL.format(item.total))")
        return ToolOutcome(["ok": true, "estado": try snapshot()],
                           preview: "\(item.name) removido", eventIDs: [e.id])
    }

    // MARK: Assignment

    private func atribuir(_ args: JSONValue) async throws -> ToolOutcome {
        guard let entries = args.objects("atribuicoes"), !entries.isEmpty else {
            return .failure("Nenhuma atribuição na chamada.")
        }
        var events: [UUID] = []
        var lines: [String] = []

        for entry in entries {
            let s = try state          // re-read: participants may have been created mid-loop
            guard let query = entry.string("item"), let item = findItem(query, in: s) else {
                throw RachaError.unknownItem(entry.string("item") ?? "?")
            }
            let names = entry.strings("pessoas") ?? []
            if names.isEmpty {
                let e = try await repository.append(rachaID, .claimsCleared(itemID: item.id), origin: .agent,
                                                    summary: "\(item.name) ficou sem dono")
                events.append(e.id)
                lines.append("\(item.name): sem dono")
                continue
            }
            let weights = entry.arrayValue(forKey: "pesos")
            var claims: [Claim] = []
            var resolved: [String] = []
            for (i, name) in names.enumerated() {
                let (personID, created) = try await resolvePerson(name)
                if let created { events.append(created.id) }
                let weight = weights?[safe: i]?.intValue ?? 1
                claims.append(Claim(itemID: item.id, personID: personID, weight: weight))
                let short = repository.state(rachaID)?.participant(personID)?.shortName ?? name
                resolved.append(weight > 1 ? "\(short)×\(weight)" : short)
            }
            let e = try await repository.append(rachaID, .claimsSet(itemID: item.id, claims: claims), origin: .agent,
                                                summary: "\(item.name) → \(resolved.joined(separator: ", "))")
            events.append(e.id)
            lines.append("\(item.name) → \(resolved.joined(separator: ", "))")
        }

        return ToolOutcome(["ok": true, "estado": try snapshot()],
                           preview: lines.joined(separator: "\n"), eventIDs: events)
    }

    // MARK: People

    private func adicionarPessoa(_ args: JSONValue) async throws -> ToolOutcome {
        guard let name = args.string("nome"), !name.trimmingCharacters(in: .whitespaces).isEmpty else {
            return .failure("Nome vazio.")
        }
        var events: [UUID] = []
        let (personID, created) = try await resolvePerson(name)
        if let created { events.append(created.id) }
        if let key = args.string("chave_pix"), !key.isEmpty {
            let e = try await repository.append(rachaID, .pixKeySet(id: personID, key: key), origin: .agent,
                                                summary: "Chave Pix de \(name) salva")
            events.append(e.id)
        }
        let display = repository.state(rachaID)?.participant(personID)?.name ?? name
        return ToolOutcome(["ok": true, "pessoa": .string(display), "estado": try snapshot()],
                           preview: created == nil ? nil : "\(display) entrou no racha",
                           eventIDs: events)
    }

    // MARK: Extras

    private func definirExtra(_ args: JSONValue) async throws -> ToolOutcome {
        let s = try state
        guard let label = args.string("nome"), let tipo = args.string("tipo") else {
            return .failure("Extra precisa de nome e tipo.")
        }
        let kind: Extra.Kind
        switch tipo {
        case "percentual":
            guard let bp = args.int("bp"), bp > 0, bp <= 30_000 else {
                return .failure("`bp` fora de faixa. 10% = 1000.")
            }
            kind = .percentage(bp: bp)
        case "por_cabeca":
            guard let v = args.cents("valor_cents"), v.raw > 0 else { return .failure("`valor_cents` obrigatório.") }
            kind = .perHead(v)
        case "fixo":
            guard let v = args.cents("valor_cents"), v.raw > 0 else { return .failure("`valor_cents` obrigatório.") }
            kind = .fixed(v)
        case "desconto":
            guard let v = args.cents("valor_cents"), v.raw > 0 else { return .failure("`valor_cents` obrigatório.") }
            kind = .discount(v)
        default:
            return .failure("Tipo desconhecido: \(tipo)")
        }

        let isGratuity = args.bool("gorjeta") ?? (label.folded.contains("servic") || label.folded.contains("gorjeta"))
        let base: Extra.Base = (tipo == "por_cabeca") ? .equalHeads : .consumption

        if let existing = s.extras.first(where: { $0.label.folded == label.folded }) {
            var updated = existing
            updated.kind = kind
            updated.base = base
            updated.isGratuity = isGratuity
            updated.isEnabled = true
            let e = try await repository.append(rachaID, .extraUpdated(updated), origin: .agent,
                                                summary: "\(label): \(existing.kind.display) → \(kind.display)")
            return ToolOutcome(["ok": true, "estado": try snapshot()],
                               preview: "\(label) agora é \(kind.display)", eventIDs: [e.id])
        }

        let extra = Extra(label: label, kind: kind, base: base, isEnabled: true, isGratuity: isGratuity)
        let e = try await repository.append(rachaID, .extraAdded(extra), origin: .agent,
                                            summary: "\(label) \(kind.display)")
        return ToolOutcome(["ok": true, "estado": try snapshot()],
                           preview: "\(label) \(kind.display)", eventIDs: [e.id])
    }

    private func ligarExtra(_ args: JSONValue) async throws -> ToolOutcome {
        let s = try state
        guard let label = args.string("nome"),
              let extra = s.extras.first(where: { $0.label.folded.contains(label.folded) }) else {
            return .failure("Não achei o extra “\(args.string("nome") ?? "?")”.")
        }
        let on = args.bool("ligado") ?? true
        let e = try await repository.append(rachaID, .extraToggled(id: extra.id, enabled: on), origin: .agent,
                                            summary: on ? "\(extra.label) ligado" : "\(extra.label) tirado da conta")
        return ToolOutcome(["ok": true, "estado": try snapshot()],
                           preview: on ? "\(extra.label) de volta" : "\(extra.label) fora", eventIDs: [e.id])
    }

    // MARK: Payments

    private func registrarPagamento(_ args: JSONValue) async throws -> ToolOutcome {
        guard let payerName = args.string("pagador") else { return .failure("Falta o pagador.") }
        guard let amount = args.cents("valor_cents"), amount.raw > 0 else {
            return .failure("`valor_cents` precisa ser inteiro positivo em centavos.")
        }
        var events: [UUID] = []
        let (payerID, created) = try await resolvePerson(payerName)
        if let created { events.append(created.id) }

        let method = args.string("metodo").flatMap(Payment.Method.init(rawValue:)) ?? .pix
        let confirmed = args.bool("confirmado") ?? true
        let payment = Payment(payerID: payerID, amount: amount, method: method,
                              note: args.string("observacao"),
                              confirmedAt: confirmed ? Date() : nil)
        let who = repository.state(rachaID)?.participant(payerID)?.shortName ?? payerName
        let e = try await repository.append(rachaID, .paymentRecorded(payment), origin: .agent,
                                            summary: "\(who) pagou \(BRL.format(amount)) (\(method.label))")
        events.append(e.id)

        // Reaching zero is a moment, not a side effect — the UI listens for this
        // event to run the settled transition.
        if let after = repository.state(rachaID), after.isSettled, after.settledAt == nil {
            let settledEvent = try await repository.append(rachaID, .settled(at: Date()), origin: .system,
                                                           summary: "Racha fechado")
            events.append(settledEvent.id)
        }

        return ToolOutcome(["ok": true, "estado": try snapshot()],
                           preview: "\(who) pagou \(BRL.format(amount))", eventIDs: events)
    }

    // MARK: Read-only

    private func verRacha() throws -> ToolOutcome { ToolOutcome(try snapshot()) }

    private func acertarContas() throws -> ToolOutcome {
        let s = try state
        let plan = s.settlement
        let transfers = plan.transfers.map { t -> JSONValue in
            [
                "de": .string(s.participant(t.from)?.name ?? "?"),
                "para": .string(s.participant(t.to)?.name ?? "?"),
                "valor_cents": .int(t.amount.raw),
                "valor": .string(BRL.format(t.amount, currency: s.currency)),
                "tem_chave_pix": .bool(s.participant(t.to)?.pixKey?.isEmpty == false)
            ]
        }
        return ToolOutcome([
            "transferencias": .array(transfers),
            "quantidade": .int(plan.transfers.count),
            "falta_pagar_cents": .int(plan.residual.raw),
            "falta_pagar": .string(BRL.format(plan.residual, currency: s.currency)),
            "tudo_certo": .bool(plan.isComplete)
        ])
    }

    private func gerarPix(_ args: JSONValue) throws -> ToolOutcome {
        let s = try state
        guard let fromName = args.string("de"), let toName = args.string("para"),
              let amount = args.cents("valor_cents"), amount.raw > 0 else {
            return .failure("Preciso de `de`, `para` e `valor_cents`.")
        }
        guard case .matched(let fromID) = ParticipantResolver.resolve(fromName, in: s.participants),
              case .matched(let toID) = ParticipantResolver.resolve(toName, in: s.participants),
              let from = s.participant(fromID), let to = s.participant(toID) else {
            return .failure("Não consegui identificar as pessoas com certeza. Pergunte ao usuário.")
        }
        guard let key = to.pixKey, !key.isEmpty else {
            return .failure("\(to.shortName) não tem chave Pix salva. Peça a chave antes — não invente uma.")
        }
        let transfer = Transfer(from: fromID, to: toID, amount: amount)
        guard let payload = PixPayload.forSettlement(transfer: transfer, receiver: to, sender: from,
                                                     rachaTitle: s.title) else {
            return .failure("Não consegui montar o código Pix.")
        }
        return ToolOutcome([
            "copia_e_cola": .string(payload),
            "valor": .string(BRL.format(amount)),
            "recebedor": .string(to.name),
            "valido": .bool(PixPayload.isValid(payload))
        ], preview: "Pix de \(BRL.format(amount)) pra \(to.shortName)")
    }

    private func consultarHistorico(_ args: JSONValue) -> ToolOutcome {
        let index = historyProvider()
        let scope = args.string("escopo") ?? "tudo"
        var out: [String: JSONValue] = [:]

        if scope == "pendencias" || scope == "tudo" {
            var rows = index.outstanding
            if let filter = args.string("pessoa") {
                rows = rows.filter { $0.name.folded.contains(filter.folded) }
            }
            out["pendencias"] = .array(rows.map { row in
                [
                    "pessoa": .string(row.name),
                    "saldo_cents": .int(row.net.raw),
                    "saldo": .string(BRL.format(row.net)),
                    "sentido": .string(row.net.isNegative ? "voce_deve" : "te_deve"),
                    "rachas_abertos": .int(row.rachaIDs.count)
                ]
            })
            out["total_a_receber"] = .string(BRL.format(index.totalOwedToMe))
            out["total_a_pagar"] = .string(BRL.format(index.totalIOwe))
        }
        if scope == "pessoas" || scope == "tudo" {
            out["pessoas_frequentes"] = .array(index.companions.prefix(10).map {
                ["nome": .string($0.name), "rachas": .int($0.rachaCount)]
            })
        }
        if scope == "grupos" || scope == "tudo" {
            out["grupos_recorrentes"] = .array(index.recurringGroups.prefix(5).map {
                ["pessoas": .array($0.memberNames.map { .string($0) }),
                 "vezes": .int($0.occurrences),
                 "nome_sugerido": .string($0.suggestedTitle)]
            })
        }
        return ToolOutcome(.object(out))
    }

    private func consultarLugar(_ args: JSONValue) -> ToolOutcome {
        guard let query = args.string("lugar") else { return .failure("Falta `lugar`.") }
        guard let venue = historyProvider().venue(matching: query) else {
            return ToolOutcome(["encontrado": false,
                                "dica": "Primeira vez nesse lugar — não tenho histórico."])
        }
        return ToolOutcome([
            "encontrado": true,
            "lugar": .string(venue.displayName),
            "visitas": .int(venue.visits),
            "gasto_mediano": .string(BRL.format(venue.medianTotal)),
            "sempre_pedem": .array(venue.staples.map { .string($0) }),
            "servico_bp": venue.servicoBP.map { .int($0) } ?? .null,
            "cobra_couvert": .bool(venue.chargesCouvert)
        ])
    }

    // MARK: Meta

    private func definirMoeda(_ args: JSONValue) async throws -> ToolOutcome {
        guard let code = args.string("moeda") else { return .failure("Falta `moeda`.") }
        var events: [UUID] = []
        if let micros = args.int("micros_por_unidade"), micros > 0 {
            let rate = FXRate(from: code, to: "BRL", microsPerUnit: micros, capturedAt: Date())
            let e = try await repository.append(rachaID, .fxRateSet(rate), origin: .agent,
                                                summary: "1 \(code.uppercased()) travado em \(BRL.format(Cents(roundHalfUpDiv(micros, 10_000))))")
            events.append(e.id)
        }
        return ToolOutcome(["ok": true, "estado": try snapshot()],
                           preview: "Moeda: \(code.uppercased())", eventIDs: events)
    }

    private func renomear(_ args: JSONValue) async throws -> ToolOutcome {
        guard let title = args.string("titulo") else { return .failure("Falta `titulo`.") }
        var events: [UUID] = []
        let e = try await repository.append(rachaID, .renamed(title: title), origin: .agent,
                                            summary: "Racha virou “\(title)”")
        events.append(e.id)
        if let kindRaw = args.string("tipo"), let kind = RachaKind(rawValue: kindRaw) {
            let k = try await repository.append(rachaID, .kindChanged(kind), origin: .agent,
                                                summary: "Tipo: \(kind.label)")
            events.append(k.id)
        }
        return ToolOutcome(["ok": true], preview: "“\(title)”", eventIDs: events)
    }

    // MARK: Snapshot — the model's single source of truth about the ledger

    private func snapshot() throws -> JSONValue {
        let s = try state
        let split = s.split
        let cur = s.currency

        let items: [JSONValue] = s.items.map { item in
            let owners = s.claims(for: item.id).compactMap { c -> JSONValue? in
                guard let p = s.participant(c.personID) else { return nil }
                return c.weight > 1
                    ? .string("\(p.shortName)×\(c.weight)")
                    : .string(p.shortName)
            }
            return [
                "id": .string(item.id.uuidString),
                "nome": .string(item.name),
                "qtd": .int(item.quantity),
                "total_cents": .int(item.total.raw),
                "total": .string(BRL.format(item.total, currency: cur)),
                "categoria": .string(item.category.rawValue),
                "donos": .array(owners),
                "divergente": .bool(item.isInconsistent)
            ]
        }

        let people: [JSONValue] = split.shares.compactMap { share in
            guard let p = s.participant(share.personID) else { return nil }
            let balance = s.balances.first { $0.personID == share.personID }
            return [
                "nome": .string(p.name),
                "eu": .bool(p.id == repository.meID),
                "consumo_cents": .int(share.consumption.raw),
                "extras_cents": .int(share.extrasTotal.raw),
                "deve_cents": .int(share.total.raw),
                "deve": .string(BRL.format(share.total, currency: cur)),
                "pagou_cents": .int(balance?.paid.raw ?? 0),
                "saldo_cents": .int(balance?.net.raw ?? 0),
                "centavos_de_arredondamento": .int(share.roundingAdjustment.raw),
                "tem_chave_pix": .bool(p.pixKey?.isEmpty == false)
            ]
        }

        let extras: [JSONValue] = s.extras.map { extra in
            ["nome": .string(extra.label), "tipo": .string(extra.kind.display),
             "ligado": .bool(extra.isEnabled), "gorjeta": .bool(extra.isGratuity)]
        }

        let unassigned: [JSONValue] = split.unassigned.compactMap { id in
            s.item(id).map { .string($0.name) }
        }

        return [
            "titulo": .string(s.title),
            "tipo": .string(s.kind.rawValue),
            "moeda": .string(cur.code),
            "itens": .array(items),
            "extras": .array(extras),
            "pessoas": .array(people),
            "total_cents": .int(split.total.raw),
            "total": .string(BRL.format(split.total, currency: cur)),
            "pago_cents": .int(s.confirmedPaid.raw),
            "falta_cents": .int((split.total - s.confirmedPaid).clampedNonNegative.raw),
            "itens_sem_dono": .array(unassigned),
            "sem_dono_cents": .int(split.unassignedTotal.raw),
            "servico_sem_dono_cents": .int(split.unassignedExtras.raw),
            "falta_na_mesa_cents": .int(s.remainingOnTable.raw),
            "quem_falta_pagar": .array(s.unpaidParticipants.map { .string($0.name) }),
            "mesa": s.venue?.table.map { .int($0) } ?? .null,
            "fechado": .bool(s.isSettled),
            "conferido": .bool(split.isBalanced)
        ]
    }

    // MARK: Helpers

    private func resolvePerson(_ name: String) async throws -> (Participant.ID, RachaEvent?) {
        let normalized = name.folded
        // "eu", "mim", "meu" always mean the device owner, never a fuzzy match.
        if ["eu", "mim", "meu", "minha", "eu mesmo"].contains(normalized) {
            return (repository.meID, nil)
        }
        return try await repository.participant(named: name, in: rachaID)
    }

    /// Item lookup by id, then exact name, then fuzzy — and it refuses on
    /// ambiguity rather than picking the first match, because "coloca a picanha
    /// pro Gui" with two picanhas on the bill is a real thing that happens.
    private func findItem(_ query: String, in s: RachaState) -> LineItem? {
        if let uuid = UUID(uuidString: query), let hit = s.item(uuid) { return hit }
        let q = query.folded
        let exact = s.items.filter { $0.name.folded == q }
        if exact.count == 1 { return exact[0] }
        let fuzzy = s.items.filter { $0.name.folded.contains(q) || q.contains($0.name.folded) }
        return fuzzy.count == 1 ? fuzzy[0] : nil
    }
}

private extension JSONValue {
    func arrayValue(forKey key: String) -> [JSONValue]? { self[key]?.arrayValue }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
