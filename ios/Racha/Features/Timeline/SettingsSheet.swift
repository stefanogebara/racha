import SwiftUI

/// Keys, identity, and what the imagery has cost.
///
/// The cost meter is not a gimmick: generated images are the one part of the app
/// that spends the user's money on every new dish, and an app that spends money
/// silently is the kind of app people delete. It is shown, with the cache hit
/// count next to it, so the number keeps going up more slowly and that is visible.
struct SettingsSheet: View {
    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss
    @State private var spent = ""
    @State private var diskMB = ""

    var body: some View {
        @Bindable var settings = settings

        NavigationStack {
            ZStack {
                PaperBackground()
                ScrollView {
                    VStack(spacing: 16) {
                        GlassCard(cornerRadius: 20) {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Você").rachaLabel()
                                field("Nome", text: $settings.myName)
                                field("Sua chave Pix", text: $settings.myPixKey,
                                      hint: "usada pra gerar o código quando te devem")
                                field("Cidade", text: $settings.myCity,
                                      hint: "vai no código Pix, como o padrão do Bacen pede")
                            }
                        }

                        GlassCard(cornerRadius: 20) {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Agente").rachaLabel()
                                secureField("Chave Anthropic", text: $settings.anthropicKey)
                                Text(settings.hasAgentKey
                                     ? "O agente responde de verdade."
                                     : "Sem chave, o app roda em modo demonstração — as contas continuam reais, só as frases são do script.")
                                    .font(Typo.caption)
                                    .foregroundStyle(Palette.stone)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }

                        GlassCard(cornerRadius: 20) {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Imagens").rachaLabel()
                                Toggle(isOn: $settings.imageryEnabled) {
                                    Text("Gerar imagens dos itens").font(Typo.body)
                                }
                                .tint(Palette.emerald)
                                secureField("Chave OpenAI", text: $settings.openAIKey)
                                secureField("Chave Google", text: $settings.googleKey)
                                Text("Sem chave, o app desenha os pratos localmente. Com chave, usa gpt-image-1-mini (US$ 0,005 por imagem) e guarda cada prato pra sempre — a segunda picanha da sua vida é de graça.")
                                    .font(Typo.caption)
                                    .foregroundStyle(Palette.stone)
                                    .fixedSize(horizontal: false, vertical: true)
                                if !spent.isEmpty {
                                    HStack {
                                        Text(spent).font(Typo.small).money()
                                        Spacer()
                                        Text(diskMB).font(Typo.caption).foregroundStyle(Palette.stone)
                                    }
                                    .foregroundStyle(Palette.charcoal)
                                }
                                RachaButton(title: "Limpar cache de imagens", style: .ghost) {
                                    Task {
                                        await ImageCache.shared.clear()
                                        await refreshUsage()
                                    }
                                }
                            }
                        }
                        Color.clear.frame(height: 20)
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 8)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("Ajustes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Pronto") { dismiss() } }
            }
            .task { await refreshUsage() }
        }
        .presentationBackground(.clear)
    }

    private func refreshUsage() async {
        spent = await ImageCache.shared.spentDisplay
        let bytes = await ImageCache.shared.diskBytes()
        diskMB = String(format: "%.1f MB em cache", Double(bytes) / 1_048_576)
    }

    private func field(_ label: String, text: Binding<String>, hint: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField(label, text: text)
                .font(Typo.body)
                .textInputAutocapitalization(label == "Nome" ? .words : .never)
                .autocorrectionDisabled()
                .padding(12)
                .background {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.white.opacity(0.6))
                }
            if let hint {
                Text(hint).font(Typo.caption).foregroundStyle(Palette.stone)
            }
        }
    }

    private func secureField(_ label: String, text: Binding<String>) -> some View {
        SecureField(label, text: text)
            .font(Typo.mono)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(12)
            .background {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.white.opacity(0.6))
            }
    }
}
