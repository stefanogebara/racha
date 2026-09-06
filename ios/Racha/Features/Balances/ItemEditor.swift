import SwiftUI

/// Correct an item by hand.
///
/// Exists because the agent is not always right and the person is always the
/// authority. Tapping people toggles their claim; the per-person number updates
/// live so you can see the effect before committing, and the whole edit is one
/// ledger event that undoes like any other.
struct ItemEditor: View {
    let rachaID: UUID
    let item: LineItem

    @Environment(RachaRepository.self) private var repository
    @Environment(\.dismiss) private var dismiss

    @State private var name: String = ""
    @State private var amountText: String = ""
    @State private var claimed: Set<Participant.ID> = []
    @State private var loaded = false

    private var state: RachaState? { repository.state(rachaID) }

    var body: some View {
        NavigationStack {
            ZStack {
                PaperBackground()
                ScrollView {
                    VStack(spacing: 16) {
                        GlassCard(cornerRadius: 20) {
                            VStack(spacing: 12) {
                                DishImageView(cacheKey: ImageStyle.cacheKey(for: item),
                                              prompt: ImageStyle.prompt(for: item),
                                              category: item.category,
                                              cornerRadius: 16, size: 512)
                                    .frame(height: 150)

                                TextField("Nome", text: $name)
                                    .font(Typo.body)
                                    .padding(12)
                                    .background {
                                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                                            .fill(Color.white.opacity(0.6))
                                    }

                                HStack {
                                    Text(state?.currency.symbol ?? "R$")
                                        .font(Typo.body)
                                        .foregroundStyle(Palette.stone)
                                    TextField("0,00", text: $amountText)
                                        .font(Typo.serifBody)
                                        .money()
                                        .keyboardType(.decimalPad)
                                }
                                .padding(12)
                                .background {
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .fill(Color.white.opacity(0.6))
                                }
                            }
                        }

                        if let state {
                            GlassCard(cornerRadius: 20) {
                                VStack(alignment: .leading, spacing: 12) {
                                    Text("De quem foi").rachaLabel()
                                    ForEach(state.participants) { person in
                                        claimRow(person, in: state)
                                    }
                                    if !claimed.isEmpty {
                                        Text(perPersonHint)
                                            .font(Typo.caption)
                                            .foregroundStyle(Palette.stone)
                                    }
                                }
                            }
                        }

                        RachaButton(title: "Salvar", action: save)
                        RachaButton(title: "Tirar da conta", style: .ghost, action: remove)
                        Color.clear.frame(height: 20)
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 8)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("Item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
            }
        }
        .onAppear(perform: prime)
    }

    private func claimRow(_ person: Participant, in state: RachaState) -> some View {
        let isOn = claimed.contains(person.id)
        return Button {
            Haptics.shared.claim()
            withAnimation(Motion.snappy) {
                if isOn { claimed.remove(person.id) } else { claimed.insert(person.id) }
            }
        } label: {
            HStack(spacing: 10) {
                AvatarBubble(participant: person, size: 28, isMe: person.id == repository.meID)
                Text(person.id == repository.meID ? "Você" : person.shortName)
                    .font(Typo.body)
                    .foregroundStyle(Palette.charcoal)
                Spacer()
                Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 19))
                    .foregroundStyle(isOn ? Palette.emerald : Palette.stone.opacity(0.4))
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Live preview of what each claimant will pay, remainder included.
    private var perPersonHint: String {
        let amount = BRL.parse(amountText, currency: state?.currency ?? .brl) ?? item.total
        let alloc = Allocator.equal(amount, into: claimed.count)
        guard let first = alloc.parts.first else { return "" }
        let currency = state?.currency ?? .brl
        if alloc.remainderRecipients.isEmpty {
            return "\(BRL.format(first, currency: currency)) pra cada um"
        }
        let low = alloc.parts.min() ?? first
        return "\(BRL.format(low, currency: currency)) pra cada, e \(alloc.remainderRecipients.count) pessoa(s) pagam um centavo a mais"
    }

    private func prime() {
        guard !loaded else { return }
        loaded = true
        name = item.name
        amountText = BRL.format(item.total, currency: state?.currency ?? .brl, symbol: false)
        claimed = Set(state?.claims(for: item.id).map(\.personID) ?? [])
    }

    private func save() {
        guard let state else { return }
        let amount = BRL.parse(amountText, currency: state.currency)
        Task {
            if name != item.name || (amount != nil && amount != item.total) {
                try? await repository.append(
                    rachaID,
                    .itemEdited(id: item.id, name: name, quantity: nil,
                                unitPrice: nil, total: amount, category: nil),
                    summary: "\(item.name) → \(BRL.format(amount ?? item.total, currency: state.currency))")
            }
            let claims = claimed.map { Claim(itemID: item.id, personID: $0) }
            let names = claimed.compactMap { state.participant($0)?.shortName }.sorted()
            try? await repository.append(
                rachaID, .claimsSet(itemID: item.id, claims: claims),
                summary: names.isEmpty ? "\(item.name) ficou sem dono"
                                       : "\(item.name) → \(names.joined(separator: ", "))")
            Haptics.shared.money()
            dismiss()
        }
    }

    private func remove() {
        Task {
            try? await repository.append(rachaID, .itemRemoved(item.id),
                                         summary: "\(item.name) removido")
            Haptics.shared.undone()
            dismiss()
        }
    }
}
