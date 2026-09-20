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
                                     : "Sem chave, o app roda em modo demonstração — as contas continuam reais, só as frases são do script. Nada sai do aparelho.")
                                    .font(Typo.caption)
                                    .foregroundStyle(Palette.stone)
                                    .fixedSize(horizontal: false, vertical: true)
                                /// O QUE SAI DO APARELHO, dito onde se decide.
                                ///
                                /// O `data-map.md` já registrava a lacuna com estas
                                /// palavras: "a tela de Ajustes informa modo e custo,
                                /// e nada sobre quem recebe o quê". O art. 9º da LGPD
                                /// pede a informação ANTES da decisão, e a decisão é
                                /// esta: colar a chave. Numa página de política ela
                                /// chega tarde.
                                ///
                                /// A segunda frase é a parte desconfortável e por isso
                                /// fica. Quem cola a chave consente por si; os nomes na
                                /// conversa e os rostos e o CNPJ na foto da nota são de
                                /// OUTRAS pessoas, e o consentimento do art. 8º é
                                /// pessoal. O dono do aparelho não consente por elas —
                                /// o mínimo honesto é dizer isso a ele.
                                Text("Com chave, a conversa da mesa vai pra Anthropic, nos EUA: os nomes que você digitou e os itens da conta — e a FOTO da nota, quando você pede pra ler uma. Uma nota carrega CNPJ, endereço, data e o que mais estiver no enquadramento.")
                                    .font(Typo.caption)
                                    .foregroundStyle(Palette.stone)
                                    .fixedSize(horizontal: false, vertical: true)
                                /// `ink2`, não `stone`: esta é a frase que a pessoa
                                /// precisa ler, e `stone` É `ink3` — pôr o aviso de
                                /// consentimento no mesmo cinza do resto seria
                                /// escrevê-lo pra não ser lido. Tinta mais clara, e
                                /// não uma cor nova: o âmbar tem um significado só
                                /// neste app (pergunta em aberto) e emprestá-lo aqui
                                /// gastaria os dois.
                                Text("Os nomes são de outras pessoas, e quem consente é você. Só ligue com a mesa sabendo.")
                                    .font(Typo.caption)
                                    .foregroundStyle(Palette.ink2)
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
                                /// Aqui sai MENOS, e dizer isso importa tanto quanto
                                /// dizer o que sai: o que vai pra OpenAI/Google é o
                                /// nome do PRATO, não nome de pessoa e não a foto.
                                /// Um aviso que trata os três fornecedores como o
                                /// mesmo risco ensina a ignorar os três.
                                Text("Sem chave, o app desenha os pratos localmente. Com chave, só o NOME do prato vai pra OpenAI ou Google, nos EUA — nome de pessoa e foto da nota não vão. Usa gpt-image-1-mini (US$ 0,005 por imagem) e guarda cada prato pra sempre — a segunda picanha da sua vida é de graça.")
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
                        .fill(Palette.field)
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
                    .fill(Palette.field)
            }
    }
}
