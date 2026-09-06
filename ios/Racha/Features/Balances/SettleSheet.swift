import SwiftUI

/// Pay your part.
///
/// The product's one money action. The sheet shows what you still owe the house
/// for this table, the 10% inside it with the way out (CDC — it is optional and
/// the control is here, not three taps away), a Pix BR Code payable to the
/// venue's own key, and the state of the table: what the house already has, who
/// has not paid yet, what is still unowned. Nothing here moves money between
/// friends and nothing here is held by us — the Pix goes to the restaurant, and
/// in production the PSP's webhook is what confirms it; "Já paguei" stands in
/// for that webhook in the demo.
///
/// The type keeps its old name so the call sites compile unchanged.
struct SettleSheet: View {
    let rachaID: UUID

    @Environment(RachaRepository.self) private var repository
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    private var state: RachaState? { repository.state(rachaID) }

    var body: some View {
        NavigationStack {
            ZStack {
                PaperBackground()
                if let state { content(state) }
            }
            .navigationTitle("Pagar")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fechar") { dismiss() }.font(Typo.bodyMedium)
                }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(.clear)
    }

    private func content(_ state: RachaState) -> some View {
        let me = repository.meID
        let due = state.due(of: me)
        return ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                myPart(state, due: due)
                if !due.isZero { payment(state, due: due) }
                table(state)
                Color.clear.frame(height: 34)
            }
            .padding(.horizontal, 24)
            .padding(.top, 10)
        }
        .scrollIndicators(.hidden)
    }

    // MARK: Your part

    private func myPart(_ state: RachaState, due: Cents) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text([ "Sua parte", state.venue?.name ?? state.title, state.venue?.tableLabel ]
                    .compactMap { $0 }.joined(separator: " · "))
                .metaLabel()
            if due.isZero {
                Text("Paga")
                    .font(Typo.display)
                    .foregroundStyle(Palette.ink)
                Text("\(BRL.format(state.paid(by: repository.meID), currency: state.currency)) recebidos pela casa.")
                    .font(Typo.small)
                    .foregroundStyle(Palette.ink3)
            } else {
                Text(BRL.format(due, currency: state.currency))
                    .font(Typo.display).money()
                    .foregroundStyle(Palette.ink)
                if let tip = state.extras.first(where: { $0.isGratuity && $0.isEnabled }) {
                    let mine = state.split.share(for: repository.meID)?.extras
                        .first { $0.extraID == tip.id }?.amount ?? .zero
                    HStack(spacing: 6) {
                        Text("Inclui \(BRL.format(mine, currency: state.currency)) de serviço, que vai pra equipe da casa. É opcional:")
                            .font(Typo.small)
                            .foregroundStyle(Palette.ink3)
                        Button("tirar") { toggle(tip, on: false) }
                            .accessibilityIdentifier("pay.service.remove")
                            .accessibilityLabel("Tirar o serviço")
                            .font(Typo.small.weight(.medium))
                            .foregroundStyle(Palette.ink)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                } else if let tip = state.extras.first(where: { $0.isGratuity && !$0.isEnabled }) {
                    HStack(spacing: 6) {
                        Text("Sem o serviço.").font(Typo.small).foregroundStyle(Palette.ink3)
                        Button("pôr de volta") { toggle(tip, on: true) }
                            .accessibilityIdentifier("pay.service.restore")
                            .accessibilityLabel("Pôr o serviço de volta")
                            .font(Typo.small.weight(.medium))
                            .foregroundStyle(Palette.ink)
                    }
                }
            }
        }
    }

    // MARK: The Pix, to the house

    private func payment(_ state: RachaState, due: Cents) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let venue = state.venue,
               let me = state.participant(repository.meID),
               let payload = PixPayload.forVenue(venue, amount: due, comanda: state.comanda, payer: me) {
                Text(payload)
                    .font(Typo.mono)
                    .foregroundStyle(Palette.ink3)
                    .lineLimit(3)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background {
                        RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Palette.surface)
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .strokeBorder(Palette.rule, lineWidth: 1)
                    }
                HStack(spacing: 8) {
                    RachaButton(title: copied ? "Copiado ✓" : "Copiar Pix", icon: copied ? nil : "doc.on.doc") {
                        UIPasteboard.general.string = payload
                        Haptics.shared.money()
                        withAnimation(Motion.snappy) { copied = true }
                    }
                    RachaButton(title: "Já paguei", style: .quiet) { markPaid(due) }
                }
                Text("O Pix vai direto pro \(venue.name). O Racha não segura dinheiro de ninguém.")
                    .font(Typo.small)
                    .foregroundStyle(Palette.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Esta mesa ainda não tem o Pix da casa. Escaneie o QR da mesa de novo, ou pague no caixa e registre aqui.")
                    .font(Typo.small)
                    .foregroundStyle(Palette.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                RachaButton(title: "Já paguei no caixa", style: .quiet) { markPaid(due) }
            }
        }
    }

    // MARK: The table

    private func table(_ state: RachaState) -> some View {
        let others = state.unpaidParticipants.filter { $0.id != repository.meID }
        let split = state.split
        return VStack(alignment: .leading, spacing: 0) {
            Text("A mesa").receiptLabel().padding(.bottom, 9)
            row("Já pago à casa", nil, state.confirmedPaid, state.currency)
            row("Falta na mesa",
                others.isEmpty ? nil
                    : "\(others.map(\.shortName).joinedPtBR()) ainda não \(others.count == 1 ? "pagou" : "pagaram")",
                state.remainingOnTable, state.currency)
            if split.hasUnassigned {
                row("\(split.unassigned.count) \(split.unassigned.count == 1 ? "item" : "itens") sem dono",
                    split.unassigned.compactMap { state.item($0)?.name }.joined(separator: ", ")
                        + " — entra na conta de quem assumir",
                    split.unassignedWithExtras, state.currency, tint: Palette.warn)
            }
        }
    }

    private func row(_ title: String, _ detail: String?, _ amount: Cents, _ currency: Currency,
                     tint: Color = Palette.ink) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 11) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Typo.body).foregroundStyle(tint)
                if let detail {
                    Text(detail).metaLabel().fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 12)
            Text(BRL.format(amount, currency: currency, symbol: false))
                .font(Typo.body).money()
                .foregroundStyle(tint)
        }
        .padding(.vertical, 11)
    }

    // MARK: Actions

    /// The demo's stand-in for the PSP webhook: a confirmed payment by me, to the
    /// house, for what I still owe. A ledger event like everything else, so it is
    /// undoable and reconcilable.
    private func markPaid(_ due: Cents) {
        guard let state, !due.isZero else { return }
        Task {
            let payment = Payment(payerID: repository.meID, amount: due, method: .pix,
                                  note: "Pix pra casa", confirmedAt: Date())
            try? await repository.append(rachaID, .paymentRecorded(payment),
                                         summary: "Você pagou \(BRL.format(due, currency: state.currency))")
            Haptics.shared.money()
            if let after = repository.state(rachaID), after.isSettled, after.settledAt == nil {
                try? await repository.append(rachaID, .settled(at: Date()), origin: .system,
                                             summary: "Mesa fechada")
            }
        }
    }

    private func toggle(_ extra: Extra, on: Bool) {
        Task {
            try? await repository.append(rachaID, .extraToggled(id: extra.id, enabled: on),
                                         summary: on ? "Serviço na conta" : "Serviço fora da conta")
            Haptics.shared.tick()
        }
    }
}

extension Array where Element == String {
    /// "Gui e Pedro", "você, Gui e Ju" — the list the way it is said.
    func joinedPtBR() -> String {
        guard count > 1 else { return first ?? "" }
        return dropLast().joined(separator: ", ") + " e " + (last ?? "")
    }
}
