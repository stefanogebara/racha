import SwiftUI

/// Start a racha.
///
/// Two fields and a row of types, then straight into the thread. Everything else
/// — who's there, what was eaten, the serviço — is a conversation, which is the
/// whole premise. A setup wizard here would contradict the product.
///
/// Recurring groups from history appear as one-tap starters, because the same
/// four people eat together most weeks and re-typing their names is friction the
/// app already has the data to remove.
struct NewRachaSheet: View {
    @Environment(RachaRepository.self) private var repository
    @Environment(Navigator.self) private var navigator
    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var kind: RachaKind = .jantar

    private var history: HistoryIndex {
        HistoryIndex.build(from: repository.allStates, meID: repository.meID)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                PaperBackground()
                ScrollView {
                    VStack(spacing: 18) {
                        GlassCard(cornerRadius: 22) {
                            VStack(alignment: .leading, spacing: 14) {
                                Text("O que foi?").rachaLabel()
                                TextField("Bar do Zé, viagem pra Paraty…", text: $title)
                                    .font(Typo.serifBody)
                                    .padding(.vertical, 6)
                                Divider().overlay(Palette.hairline)
                                FlowLayout(spacing: 8) {
                                    ForEach(RachaKind.allCases, id: \.self) { option in
                                        RachaChip(title: option.label, isOn: kind == option) {
                                            kind = option
                                        }
                                    }
                                }
                            }
                        }

                        if !history.recurringGroups.isEmpty {
                            GlassCard(cornerRadius: 22) {
                                VStack(alignment: .leading, spacing: 12) {
                                    Text("Os de sempre").rachaLabel()
                                    ForEach(history.recurringGroups.prefix(3)) { group in
                                        Button {
                                            Haptics.shared.tick()
                                            create(with: group)
                                        } label: {
                                            HStack(spacing: 10) {
                                                Text(group.memberNames.joined(separator: ", "))
                                                    .font(Typo.body)
                                                    .foregroundStyle(Palette.charcoal)
                                                    .lineLimit(1)
                                                Spacer()
                                                Text("\(group.occurrences)×")
                                                    .font(Typo.caption).money()
                                                    .foregroundStyle(Palette.stone)
                                                Image(systemName: "arrow.right")
                                                    .font(.system(size: 11, weight: .semibold))
                                                    .foregroundStyle(Palette.stone)
                                            }
                                            .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }

                        RachaButton(title: "Criar", icon: "sparkles") { create(with: nil) }
                        Color.clear.frame(height: 20)
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 8)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("Novo racha")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(.clear)
    }

    private func create(with group: HistoryIndex.RecurringGroup?) {
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolved = name.isEmpty ? (group?.suggestedTitle ?? kind.label) : name
        Task {
            let id = try? await repository.createRacha(title: resolved, kind: kind,
                                                       meName: settings.myName)
            guard let id else { return }
            if !settings.myPixKey.isEmpty {
                try? await repository.append(id, .pixKeySet(id: repository.meID, key: settings.myPixKey),
                                             origin: .system, summary: "Sua chave Pix")
            }
            if let group {
                for (personID, personName) in zip(group.members, group.memberNames) {
                    let participant = Participant(id: personID, name: personName)
                    try? await repository.append(id, .participantAdded(participant),
                                                 origin: .system,
                                                 summary: "\(personName) entrou no racha")
                }
            }
            Haptics.shared.press()
            dismiss()
            navigator.open(id)
        }
    }
}
