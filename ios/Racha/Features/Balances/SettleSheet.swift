import SwiftUI

/// "Quem paga quem", and then a way to actually pay.
///
/// The list is the minimal transfer set, so a table of six people usually
/// resolves in two or three payments rather than fifteen. Each row expands into
/// a Pix copia-e-cola the receiver's bank will accept — which is the difference
/// between an app that computes a settlement and an app that ends one.
struct SettleSheet: View {
    let rachaID: UUID

    @Environment(RachaRepository.self) private var repository
    @Environment(AppSettings.self) private var settings
    @Environment(Navigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss
    @State private var copiedTransfer: Transfer?
    @State private var askingKeyFor: Participant?

    private var state: RachaState? { repository.state(rachaID) }

    var body: some View {
        NavigationStack {
            ZStack {
                WarmGroundBackground()
                if let state { content(state) }
            }
            .navigationTitle("Acertar")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Pronto") { dismiss() }.font(Typo.bodyMedium)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(.clear)
        .sheet(item: $askingKeyFor) { person in
            PixKeyPrompt(rachaID: rachaID, person: person)
        }
    }

    private func content(_ state: RachaState) -> some View {
        let plan = state.settlement
        return ScrollView {
            VStack(spacing: 14) {
                if plan.transfers.isEmpty && plan.residual.isZero {
                    allSquare
                } else {
                    if !plan.residual.isZero {
                        // Money still owed to the restaurant is not a debt between
                        // friends and no transfer can clear it. Saying so plainly
                        // prevents the "why doesn't this add up" moment.
                        GlassCard(cornerRadius: 20, padding: 16) {
                            HStack(spacing: 10) {
                                Image(systemName: "exclamationmark.circle.fill")
                                    .foregroundStyle(Palette.amber)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Ainda falta pagar \(BRL.format(plan.residual, currency: state.currency))")
                                        .font(Typo.bodyMedium).money()
                                        .foregroundStyle(Palette.charcoal)
                                    Text("Isso é da conta, não é dívida entre vocês.")
                                        .font(Typo.caption)
                                        .foregroundStyle(Palette.stone)
                                }
                            }
                        }
                    }

                    ForEach(plan.transfers) { transfer in
                        TransferRow(transfer: transfer,
                                    state: state,
                                    meID: repository.meID,
                                    city: settings.myCity,
                                    onNeedKey: { askingKeyFor = $0 },
                                    onPaid: { markPaid(transfer) })
                    }

                    if plan.transfers.count > 1 {
                        Text("\(plan.transfers.count) transferências resolvem tudo — é o mínimo possível.")
                            .font(Typo.caption)
                            .foregroundStyle(Palette.stone)
                            .frame(maxWidth: .infinity)
                    }
                }
                Color.clear.frame(height: 20)
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
        }
        .scrollIndicators(.hidden)
    }

    private var allSquare: some View {
        GlassCard(cornerRadius: 24, padding: 30) {
            VStack(spacing: 12) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 42))
                    .foregroundStyle(Palette.emeraldBright)
                Text("Tudo quite")
                    .font(Typo.display)
                    .foregroundStyle(Palette.charcoal)
                Text("Ninguém deve nada pra ninguém.")
                    .font(Typo.body)
                    .foregroundStyle(Palette.stone)
            }
            .frame(maxWidth: .infinity)
        }
    }

    /// Recording a settlement transfer as a payment by the debtor: it moves their
    /// net toward zero exactly as a real payment would, and it is a ledger event
    /// like everything else, so it is undoable.
    private func markPaid(_ transfer: Transfer) {
        guard let state else { return }
        Task {
            let payment = Payment(payerID: transfer.from, amount: transfer.amount,
                                  method: .pix,
                                  note: "acerto com \(state.participant(transfer.to)?.shortName ?? "")",
                                  confirmedAt: Date())
            let who = state.participant(transfer.from)?.shortName ?? "alguém"
            try? await repository.append(
                rachaID, .paymentRecorded(payment),
                summary: "\(who) acertou \(BRL.format(transfer.amount, currency: state.currency))")
            Haptics.shared.money()

            if let after = repository.state(rachaID), after.isSettled, after.settledAt == nil {
                try? await repository.append(rachaID, .settled(at: Date()), origin: .system,
                                             summary: "Racha fechado")
            }
        }
    }
}

/// One "X paga Y", expanding into a payable Pix code.
struct TransferRow: View {
    var transfer: Transfer
    var state: RachaState
    var meID: Participant.ID
    var city: String
    var onNeedKey: (Participant) -> Void
    var onPaid: () -> Void

    @State private var expanded = false
    @State private var copied = false

    private var from: Participant? { state.participant(transfer.from) }
    private var to: Participant? { state.participant(transfer.to) }
    private var isMine: Bool { transfer.from == meID }

    var body: some View {
        GlassCard(cornerRadius: 20, padding: 16, refract: false) {
            VStack(spacing: 12) {
                HStack(spacing: 12) {
                    if let from { AvatarBubble(participant: from, size: 34, isMe: isMine) }
                    Image(systemName: "arrow.right")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Palette.stone.opacity(0.6))
                    if let to { AvatarBubble(participant: to, size: 34, isMe: transfer.to == meID) }

                    VStack(alignment: .leading, spacing: 1) {
                        Text(headline)
                            .font(Typo.bodyMedium)
                            .foregroundStyle(Palette.charcoal)
                            .lineLimit(1)
                        Text(BRL.format(transfer.amount, currency: state.currency))
                            .font(Typo.serifBody).money()
                            .foregroundStyle(isMine ? Palette.burgundy : Palette.charcoal)
                    }
                    Spacer()
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    Haptics.shared.tick()
                    withAnimation(Motion.fluid) { expanded.toggle() }
                }

                if expanded {
                    VStack(spacing: 10) {
                        if let payload {
                            Text(payload)
                                .font(Typo.mono)
                                .foregroundStyle(Palette.stone)
                                .lineLimit(3)
                                .truncationMode(.middle)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10)
                                .background {
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .fill(Color.white.opacity(0.5))
                                }
                                .overlay {
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .strokeBorder(Palette.hairline, lineWidth: 1)
                                }

                            HStack(spacing: 8) {
                                RachaButton(title: copied ? "Copiado ✓" : "Copiar Pix",
                                            icon: copied ? nil : "doc.on.doc") {
                                    UIPasteboard.general.string = payload
                                    Haptics.shared.money()
                                    withAnimation(Motion.snappy) { copied = true }
                                }
                                RachaButton(title: "Já pagou", style: .quiet) {
                                    withAnimation(Motion.fluid) { onPaid() }
                                }
                            }
                        } else if let to {
                            VStack(spacing: 8) {
                                Text("\(to.shortName) não tem chave Pix salva.")
                                    .font(Typo.small)
                                    .foregroundStyle(Palette.stone)
                                RachaButton(title: "Adicionar chave", icon: "key") { onNeedKey(to) }
                                RachaButton(title: "Já pagou", style: .quiet) { onPaid() }
                            }
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    private var headline: String {
        let payer = isMine ? "Você" : (from?.shortName ?? "?")
        let receiver = transfer.to == meID ? "você" : (to?.shortName ?? "?")
        return "\(payer) → \(receiver)"
    }

    private var payload: String? {
        guard let from, let to else { return nil }
        return PixPayload.forSettlement(transfer: transfer, receiver: to, sender: from,
                                        rachaTitle: state.title, city: city)
    }
}

/// Ask for a Pix key. The app never guesses one — see the note in `PixPayload`.
struct PixKeyPrompt: View {
    let rachaID: UUID
    let person: Participant

    @Environment(RachaRepository.self) private var repository
    @Environment(\.dismiss) private var dismiss
    @State private var key = ""

    var body: some View {
        NavigationStack {
            ZStack {
                WarmGroundBackground()
                VStack(spacing: 16) {
                    Text("Chave Pix de \(person.shortName)")
                        .font(Typo.serifBody)
                        .foregroundStyle(Palette.charcoal)
                    TextField("CPF, telefone, e-mail ou chave aleatória", text: $key)
                        .font(Typo.body)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(14)
                        .background {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(Color.white.opacity(0.6))
                        }
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(Palette.inputBorder, lineWidth: 1)
                        }
                    RachaButton(title: "Salvar") {
                        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !trimmed.isEmpty else { return }
                        Task {
                            try? await repository.append(
                                rachaID, .pixKeySet(id: person.id, key: trimmed),
                                summary: "Chave Pix de \(person.shortName) salva")
                            dismiss()
                        }
                    }
                    Spacer()
                }
                .padding(20)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
            }
        }
        .presentationDetents([.height(280)])
    }
}
