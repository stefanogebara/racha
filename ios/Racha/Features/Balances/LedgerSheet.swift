import SwiftUI

/// The bill, itemised, with every cent accounted for.
///
/// The section order answers the questions in the order people ask them:
/// what did each of us end up owing → what was on the table → what got added on
/// top → where did the rounding go. That last section is unusual and deliberate:
/// most apps hide their rounding. Showing it is what lets a person trust the rest.
struct LedgerSheet: View {
    let rachaID: UUID

    @Environment(RachaRepository.self) private var repository
    @Environment(\.dismiss) private var dismiss
    @State private var editingItem: LineItem?

    private var state: RachaState? { repository.state(rachaID) }

    var body: some View {
        NavigationStack {
            ZStack {
                PaperBackground()
                if let state {
                    content(state)
                } else {
                    Text("Racha não encontrado.").font(Typo.body).foregroundStyle(Palette.stone)
                }
            }
            .navigationTitle("A conta")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Pronto") { dismiss() }.font(Typo.bodyMedium)
                }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(.clear)
        .sheet(item: $editingItem) { item in
            ItemEditor(rachaID: rachaID, item: item)
        }
    }

    private func content(_ state: RachaState) -> some View {
        let split = state.split
        return ScrollView {
            VStack(spacing: 16) {
                sharesCard(state, split)
                itemsCard(state, split)
                if !state.extras.isEmpty { extrasCard(state) }
                if !state.payments.isEmpty { paymentsCard(state) }
                roundingCard(split, currency: state.currency)
                if !state.anomalies.isEmpty { anomaliesCard(state) }
                Color.clear.frame(height: 24)
            }
            .padding(.horizontal, 18)
            .padding(.top, 8)
        }
        .scrollIndicators(.hidden)
    }

    // MARK: Sections

    private func sharesCard(_ state: RachaState, _ split: SplitResult) -> some View {
        GlassCard(cornerRadius: 20) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Quem deve o quê").rachaLabel()
                ForEach(split.shares) { share in
                    if let person = state.participant(share.personID) {
                        ShareRow(person: person, share: share,
                                 balance: state.balances.first { $0.personID == share.personID },
                                 currency: state.currency,
                                 isMe: person.id == repository.meID)
                    }
                }
                /// A PARTE DE NINGUÉM, para a coluna fechar no Total.
                ///
                /// As partes somavam R$ 352,70 debaixo de um "Total R$ 372,50",
                /// e os R$ 19,80 que faltavam — o pudim sem dono mais o serviço
                /// que a casa cobra nele — estavam explicados dois cartões
                /// abaixo. Uma coluna de números que não fecha com o total
                /// impresso embaixo dela faz o leitor procurar o erro nosso, e
                /// o erro não existe: é uma linha que ninguém desenhou.
                ///
                /// `unassignedWithExtras` é do modelo desde sempre — a conta
                /// estava certa e a tela é que não contava. Aparece só quando
                /// existe, porque um "R$ 0,00 sem dono" em toda mesa é ruído.
                if !split.unassignedWithExtras.isZero {
                    HStack(spacing: 10) {
                        UnownedBubble(size: 30)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Sem dono")
                                .font(Typo.bodyMedium)
                                .foregroundStyle(Palette.charcoal)
                            Text("entra na conta de quem assumir")
                                .font(Typo.caption)
                                .foregroundStyle(Palette.amber)
                        }
                        Spacer()
                        Text(BRL.format(split.unassignedWithExtras, currency: state.currency))
                            .font(Typo.serifBody).money()
                            .foregroundStyle(Palette.charcoal)
                    }
                    .accessibilityElement(children: .combine)
                }
                Divider().overlay(Palette.charcoal.opacity(0.5))
                HStack {
                    Text("Total").font(Typo.bodyMedium)
                    Spacer()
                    Text(BRL.format(split.total, currency: state.currency))
                        .font(Typo.bodyMedium).money()
                }
                .foregroundStyle(Palette.charcoal)
            }
        }
    }

    private func itemsCard(_ state: RachaState, _ split: SplitResult) -> some View {
        GlassCard(cornerRadius: 20) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Itens").rachaLabel()
                    Spacer()
                    if split.hasUnassigned {
                        Text("\(split.unassigned.count) sem dono")
                            .font(Typo.caption)
                            .foregroundStyle(Palette.amber)
                    }
                }
                ForEach(state.items) { item in
                    // A Button, not an onTapGesture. Claiming an item is the
                    // core move of the product ("fala o que foi de quem") and a
                    // tap gesture is invisible to VoiceOver and Switch Control:
                    // the row read as text with no way to activate it.
                    Button {
                        Haptics.shared.tick(); editingItem = item
                    } label: {
                        ItemRow(item: item,
                                owners: state.claims(for: item.id).compactMap { state.participant($0.personID) },
                                currency: state.currency)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Toque pra dizer de quem foi")
                }
            }
        }
    }

    private func extrasCard(_ state: RachaState) -> some View {
        GlassCard(cornerRadius: 20) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Extras").rachaLabel()
                ForEach(state.extras) { extra in
                    ExtraRow(extra: extra) { enabled in
                        Task {
                            Haptics.shared.tick()
                            try? await repository.append(
                                rachaID, .extraToggled(id: extra.id, enabled: enabled),
                                summary: enabled ? "\(extra.label) ligado" : "\(extra.label) tirado")
                        }
                    }
                }
                if state.extras.contains(where: { $0.isGratuity && $0.isEnabled }) {
                    // CLAUDE.md non-negotiable #3: the 10% is optional under the CDC.
                    // Saying so in the UI is not legal boilerplate — it is the thing
                    // that makes the toggle above feel usable rather than risky.
                    Text("O serviço é opcional. Pode tirar sem constrangimento.")
                        .font(Typo.caption)
                        .foregroundStyle(Palette.stone)
                }
            }
        }
    }

    private func paymentsCard(_ state: RachaState) -> some View {
        GlassCard(cornerRadius: 20) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Pagamentos").rachaLabel()
                ForEach(state.payments) { payment in
                    HStack(spacing: 10) {
                        Image(systemName: payment.method.symbol)
                            .font(.system(size: 13))
                            .foregroundStyle(payment.isConfirmed ? Palette.emerald : Palette.stone)
                            .frame(width: 20)
                        Text(state.participant(payment.payerID)?.shortName ?? "—")
                            .font(Typo.body)
                        if !payment.isConfirmed {
                            Text("pendente")
                                .font(Typo.caption)
                                .foregroundStyle(Palette.amber)
                        }
                        Spacer()
                        Text(BRL.format(payment.amount, currency: state.currency))
                            .font(Typo.body).money()
                    }
                    .foregroundStyle(Palette.charcoal)
                }
            }
        }
    }

    /// Where the leftover centavos landed.
    ///
    /// This card is the reason the split engine tracks `remainderRecipients` at
    /// all. It costs one small section and it removes the single most common
    /// argument about a shared bill.
    private func roundingCard(_ split: SplitResult, currency: Currency) -> some View {
        let touched = split.shares.filter { !$0.roundingAdjustment.isZero }
        return Group {
            if touched.isEmpty {
                EmptyView()
            } else {
                GlassCard(cornerRadius: 20, padding: 16) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Arredondamento").rachaLabel()
                        ForEach(touched) { share in
                            HStack {
                                Text(state?.participant(share.personID)?.shortName ?? "—")
                                    .font(Typo.small)
                                Spacer()
                                Text("+\(share.roundingAdjustment.raw) centavo\(share.roundingAdjustment.raw == 1 ? "" : "s")")
                                    .font(Typo.small).money()
                                    .foregroundStyle(Palette.stone)
                            }
                            .foregroundStyle(Palette.charcoal)
                        }
                        Text("Divisões que não fecham redondo sobram um centavo. Ele vai pra alguém — aqui está pra quem.")
                            .font(Typo.caption)
                            .foregroundStyle(Palette.stone)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private func anomaliesCard(_ state: RachaState) -> some View {
        GlassCard(cornerRadius: 20, padding: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Label("Avisos no histórico", systemImage: "exclamationmark.triangle")
                    .font(Typo.small)
                    .foregroundStyle(Palette.amber)
                ForEach(state.anomalies, id: \.self) { note in
                    Text(note).font(Typo.caption).foregroundStyle(Palette.stone)
                }
            }
        }
    }
}

// MARK: - Rows

struct ShareRow: View {
    var person: Participant
    var share: PersonShare
    var balance: NetBalance?
    var currency: Currency
    var isMe: Bool

    @State private var expanded = false

    /// "não pagou" quando o devido é a parte inteira (a coluna já diz quanto),
    /// e o valor só quando ele é NOVO — pagou parte e falta o resto.
    private func statusLine(balance: NetBalance, share: Cents) -> String {
        if !balance.net.isNegative {
            return "a receber \(BRL.format(balance.net, currency: currency))"
        }
        let devido = balance.net.magnitude
        return devido == share ? "não pagou"
                               : "falta \(BRL.format(devido, currency: currency))"
    }

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 10) {
                AvatarBubble(participant: person, size: 30, isMe: isMe)
                VStack(alignment: .leading, spacing: 1) {
                    Text(isMe ? "Você" : person.shortName)
                        .font(Typo.bodyMedium)
                        .foregroundStyle(Palette.charcoal)
                    /// O subtítulo diz o ESTADO; a coluna diz a PARTE.
                    ///
                    /// Antes ele repetia o número: quem não pagou nada aparecia
                    /// como "deve R$ 107,70" ao lado de uma coluna que já dizia
                    /// R$ 107,70. Duas vezes o mesmo dado, e o olho perde a
                    /// informação nova — que é quanto FALTA de quem pagou parte.
                    if let balance, !balance.net.isZero {
                        Text(statusLine(balance: balance, share: share.total))
                            .font(Typo.caption).money()
                            .foregroundStyle(balance.net.isNegative ? Palette.burgundy : Palette.emerald)
                    } else if balance != nil {
                        Text("quite").font(Typo.caption).foregroundStyle(Palette.emerald)
                    }
                }
                Spacer()
                Text(BRL.format(share.total, currency: currency))
                    .font(Typo.serifBody).money()
                    .foregroundStyle(Palette.charcoal)
            }
            .contentShape(Rectangle())
            // Same reason as the item rows: this opens the derivation of a
            // number someone is about to pay, so it has to be reachable.
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint(expanded ? "Toque pra fechar a conta dessa parte"
                                        : "Toque pra ver como essa parte foi calculada")
            .accessibilityAction {
                Haptics.shared.tick()
                withAnimation(Motion.fluid) { expanded.toggle() }
            }
            .onTapGesture {
                Haptics.shared.tick()
                withAnimation(Motion.fluid) { expanded.toggle() }
            }

            if expanded {
                // The derivation. Nobody argues with a total they can decompose.
                VStack(spacing: 4) {
                    breakdown("Consumo", share.consumption)
                    ForEach(share.extras.indices, id: \.self) { i in
                        breakdown(share.extras[i].label, share.extras[i].amount)
                    }
                }
                .padding(.leading, 40)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private func breakdown(_ label: String, _ amount: Cents) -> some View {
        HStack {
            Text(label).font(Typo.caption).foregroundStyle(Palette.stone)
            Spacer()
            Text(BRL.format(amount, currency: currency))
                .font(Typo.caption).money()
                .foregroundStyle(Palette.stone)
        }
    }
}

struct ItemRow: View {
    var item: LineItem
    var owners: [Participant]
    var currency: Currency

    @Environment(\.imageEngine) private var engine

    var body: some View {
        HStack(spacing: 12) {
            DishImageView(cacheKey: ImageStyle.cacheKey(for: item),
                          prompt: ImageStyle.prompt(for: item),
                          category: item.category,
                          cornerRadius: 10, size: 256)
                .frame(width: 44, height: 44)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    if item.quantity > 1 {
                        Text("\(item.quantity)×")
                            .font(Typo.caption).money()
                            .foregroundStyle(Palette.stone)
                    }
                    Text(item.name)
                        .font(Typo.body)
                        .foregroundStyle(Palette.charcoal)
                        .lineLimit(1)
                }
                if owners.isEmpty {
                    Text("sem dono")
                        .font(Typo.caption)
                        .foregroundStyle(Palette.amber)
                } else {
                    AvatarStack(participants: owners, size: 18)
                }
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 1) {
                Text(BRL.format(item.total, currency: currency))
                    .font(Typo.body).money()
                    .foregroundStyle(Palette.charcoal)
                if item.isInconsistent {
                    // The receipt disagrees with itself. Flagged, never corrected.
                    Text("confere?")
                        .font(Typo.caption)
                        .foregroundStyle(Palette.amber)
                }
            }
        }
        .padding(.vertical, 3)
    }
}

struct ExtraRow: View {
    var extra: Extra
    var onToggle: (Bool) -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button {
                onToggle(!extra.isEnabled)
            } label: {
                Image(systemName: extra.isEnabled ? "checkmark.square.fill" : "square")
                    .font(.system(size: 19))
                    .foregroundStyle(extra.isEnabled ? Palette.emerald : Palette.stone.opacity(0.5))
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 1) {
                Text(extra.label)
                    .font(Typo.body)
                    .foregroundStyle(extra.isEnabled ? Palette.charcoal : Palette.stone)
                if extra.isGratuity {
                    Text("vai pra equipe")
                        .font(Typo.caption)
                        .foregroundStyle(Palette.stone)
                }
            }
            Spacer()
            Text(extra.kind.display)
                .font(Typo.body).money()
                .foregroundStyle(extra.isEnabled ? Palette.charcoal : Palette.stone)
        }
    }
}
