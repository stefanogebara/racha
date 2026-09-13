import Foundation
import Observation

/// One racha's conversation.
///
/// Runs the tool loop: stream → collect tool calls → execute against the ledger →
/// feed results back → stream again, until the model stops asking for tools.
///
/// Two design points that matter more than the plumbing:
///
/// 1. **The ledger is never rolled back on a failed turn.** If the network dies
///    after the agent assigned three items, those three assignments stay. They
///    were real edits, they are in the log, and they are individually undoable.
///    Discarding them to keep the transcript tidy would throw away work the person
///    watched happen.
/// 2. **Tool results always carry the fresh snapshot.** The model never keeps its
///    own model of the bill; it re-reads state after every write. That is what
///    makes "quanto o Gui deve?" answerable correctly even after the person
///    edited something by hand mid-conversation.
@MainActor
@Observable
final class AgentSession {

    private(set) var messages: [ChatMessage] = []
    private(set) var isThinking = false
    /// Drives the composer's "..." and the token-stream shader's intensity.
    private(set) var streamPhase: StreamPhase = .idle

    enum StreamPhase: Equatable, Sendable {
        case idle
        case thinking
        case writing
        case working(String)   // tool label, pt-BR
    }

    let rachaID: UUID
    private let repository: RachaRepository
    private let client: AnthropicClient
    private let transcripts: TranscriptStore
    private let toolbox: AgentToolbox
    private var wire: [WireMessage] = []
    private var task: Task<Void, Never>?
    /// Chegou algum caractere do modelo nesta volta? Do acumulador CRU, não da
    /// tela — ver `cancel()`.
    private var recebeuAlgo = false

    init(rachaID: UUID, repository: RachaRepository, client: AnthropicClient,
         transcripts: TranscriptStore, history: @escaping @MainActor () -> HistoryIndex) {
        self.rachaID = rachaID
        self.repository = repository
        self.client = client
        self.transcripts = transcripts
        self.toolbox = AgentToolbox(repository: repository, rachaID: rachaID, historyProvider: history)
    }

    func load() async {
        messages = await transcripts.load(rachaID)
        wire = Self.rebuildWire(from: messages)
    }

    func cancel() {
        task?.cancel()
        task = nil
        isThinking = false
        streamPhase = .idle
        if let last = messages.indices.last, messages[last].isStreaming {
            messages[last].isStreaming = false
            // NÃO apaga a bolha por ela estar VAZIA NA TELA. `text` aqui é a
            // EXIBIÇÃO, e desde que o guarda congela o que mostra enquanto
            // julga, uma resposta longa e inteiramente legítima fica com a
            // tela vazia por segundos. Parar nesse instante removia a bolha, e
            // aí `bubbleIndex` apontava pro fim do array: a escrita seguinte
            // estourava o índice e derrubava o app, perdendo a volta. O
            // acumulador cru é quem sabe se veio alguma coisa.
            //
            // O chamador esquecido da separação acumulador/exibição — o
            // `cancel()` ficou de fora quando o resto foi convertido. Achado
            // pela revisão de segurança de 2026-09-13.
            if !recebeuAlgo && messages[last].edits.isEmpty {
                messages.removeLast()
            }
        }
    }

    // MARK: Sending

    func send(_ text: String, imageBase64: String? = nil, imageKey: String? = nil) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || imageBase64 != nil else { return }

        messages.append(ChatMessage(role: .user, text: trimmed, imageKey: imageKey))

        var blocks: [WireMessage.Block] = []
        if let imageBase64 {
            blocks.append(.image(mediaType: "image/jpeg", base64: imageBase64))
        }
        blocks.append(.text(trimmed.isEmpty ? "Segue a nota. Registra os itens." : trimmed))
        wire.append(WireMessage(role: .user, blocks: blocks))

        run()
    }

    private func run() {
        task?.cancel()
        isThinking = true
        streamPhase = .thinking

        task = Task { [weak self] in
            guard let self else { return }
            var rounds = 0
            var hitLimit = true
            // A hard ceiling on the loop. A model that keeps calling tools forever
            // would burn the user's battery and their money; six rounds is far more
            // than any real request needs.
            let maxRounds = 6

            while rounds < maxRounds, !Task.isCancelled {
                rounds += 1
                let outcome = await self.streamOneTurn()
                switch outcome {
                case .finished:
                    break
                case .needsTools(let calls):
                    await self.execute(calls)
                    continue
                case .failed(let message):
                    self.finishWithFailure(message)
                }
                hitLimit = false
                break
            }

            if hitLimit && !Task.isCancelled {
                self.finishWithFailure("A conversa ficou em loop e eu parei. O que já foi alterado está salvo e dá pra desfazer.")
            }
            self.isThinking = false
            self.streamPhase = .idle
            await self.persist()
        }
    }

    private enum TurnOutcome {
        case finished
        case needsTools([(id: String, name: String, input: JSONValue)])
        case failed(String)
    }

    private func streamOneTurn() async -> TurnOutcome {
        let bubbleIndex = messages.count
        messages.append(ChatMessage(role: .agent, text: "", isStreaming: true))

        var assistantBlocks: [WireMessage.Block] = []
        /// Quantas voltas foram recusadas nesta sessão. CONTADO, não só
        /// tratado: um modelo que insiste na afirmação proibida é sinal — de
        /// prompt que regrediu, de modelo trocado, de alguém empurrando. O
        /// inegociável #8 vale aqui: sucesso silencioso é o inimigo.
        var recusas = 0
        /// Texto já mostrado, e os últimos caracteres do pedaço anterior — o
        /// substantivo pode ficar a cavalo de dois deltas.
        var exibido = ""
        var fimAnterior = ""
        /// Ver o uso lá embaixo: uma vez perto do assunto, sempre perto.
        var guardaArmado = false
        var pendingTools: [(id: String, name: String, input: JSONValue)] = []
        var text = ""
        var failure: String?

        let system = SystemPrompt.build(state: repository.state(rachaID),
                                        meName: repository.state(rachaID)?.participant(repository.meID)?.name)

        for await event in client.stream(messages: wire, system: system, tools: AgentTools.all) {
            guard !Task.isCancelled else { break }
            switch event {
            case .textDelta(let chunk):
                if streamPhase != .writing { streamPhase = .writing }
                text += chunk
                // O ACUMULADOR FICA CRU; a exibição é DERIVADA dele, e
                // CONGELA assim que o texto chega perto do assunto.
                //
                // Nada é recortado nem acrescentado: a volta inteira passa ou
                // a volta inteira não passa, julgada quando fecha. Era um
                // conserto cirúrgico e apagava valores da tela — ver o
                // cabeçalho de `RevisaoDeAfirmacoes`.
                recebeuAlgo = true
                if !guardaArmado { guardaArmado = RevisaoDeAfirmacoes.chegouPertoDoAssunto(chunk + fimAnterior) }
                if !guardaArmado {
                    exibido = RevisaoDeAfirmacoes.parcialExibivel(text)
                    // Idem: `cancel()` pode ter removido a bolha entre um
                    // pedaço e o próximo.
                    if messages.indices.contains(bubbleIndex) { messages[bubbleIndex].text = exibido }
                }
                // Só os últimos caracteres entram na próxima checagem: o
                // substantivo pode ficar a cavalo de dois pedaços, e reler o
                // acumulado a cada delta era o O(n²) na thread principal.
                fimAnterior = String(text.suffix(40))

            case .thinkingDelta:
                streamPhase = .thinking

            case .toolStarted(_, let name):
                streamPhase = .working(ToolLabels.pt(name))

            case .toolInputDelta:
                break

            case .toolReady(let id, let name, let input):
                pendingTools.append((id, name, input))

            case .stopped:
                break

            case .failed(let message):
                failure = message
            }
        }

        // Fechada a volta, dá pra julgar. Recusa é da VOLTA INTEIRA: o texto
        // do modelo não é editado nem carimbado — some, e entra no lugar dele
        // uma frase que é nossa e diz isso. E é o texto RECUSADO que vai pro
        // histórico, não o cru: devolver o cru ensinaria o modelo que aquilo
        // passou, e ele repetiria com mais convicção na volta seguinte.
        if RevisaoDeAfirmacoes.afirmaDestinoSemDistribuidor(text) {
            recusas += 1
            text = RevisaoDeAfirmacoes.respostaSegura
        }
        // A bolha pode ter sido removida por um `cancel()` no meio do stream.
        if messages.indices.contains(bubbleIndex) { messages[bubbleIndex].text = text }
        if !text.isEmpty { assistantBlocks.append(.text(text)) }
        for call in pendingTools {
            assistantBlocks.append(.toolUse(id: call.id, name: call.name, input: call.input))
        }
        if messages.indices.contains(bubbleIndex) { messages[bubbleIndex].isStreaming = false }

        if let failure {
            // Keep an empty bubble out of the thread; the failure is attached to the
            // last real message so the person sees it in context.
            if text.isEmpty && pendingTools.isEmpty { messages.remove(at: bubbleIndex) }
            return .failed(failure)
        }

        if text.isEmpty && pendingTools.isEmpty {
            messages.remove(at: bubbleIndex)
            return .finished
        }

        wire.append(WireMessage(role: .assistant, blocks: assistantBlocks))
        return pendingTools.isEmpty ? .finished : .needsTools(pendingTools)
    }

    private func execute(_ calls: [(id: String, name: String, input: JSONValue)]) async {
        var results: [WireMessage.Block] = []
        let before = repository.state(rachaID)?.split.total

        for call in calls {
            streamPhase = .working(ToolLabels.pt(call.name))
            let outcome = await toolbox.run(call.name, call.input)
            results.append(.toolResult(id: call.id, content: outcome.payload.jsonText, isError: outcome.isError))

            guard let preview = outcome.preview, !outcome.eventIDs.isEmpty else { continue }
            let after = repository.state(rachaID)?.split.total
            let delta: Cents? = (before != nil && after != nil && before != after) ? (after! - before!) : nil
            let edit = LedgerEdit(toolName: call.name, summary: preview,
                                  eventIDs: outcome.eventIDs, deltaCents: delta)
            // Attach to the bubble the agent just wrote, so the ribbon sits under
            // the sentence that explains it.
            if let idx = messages.lastIndex(where: { $0.role == .agent }) {
                messages[idx].edits.append(edit)
            } else {
                messages.append(ChatMessage(role: .agent, text: "", edits: [edit]))
            }
        }

        wire.append(WireMessage(role: .user, blocks: results))
    }

    private func finishWithFailure(_ message: String) {
        if let idx = messages.lastIndex(where: { $0.role == .agent }) {
            messages[idx].failure = message
            messages[idx].isStreaming = false
        } else {
            messages.append(ChatMessage(role: .system, text: message))
        }
    }

    // MARK: Undo

    /// One gesture, whole edit. Reverting is itself a ledger event, so the undo is
    /// visible in the log too.
    func undo(_ edit: LedgerEdit) async {
        guard !edit.isUndone else { return }
        let log = repository.log(rachaID)
        let events = log.filter { edit.eventIDs.contains($0.id) }
        guard !events.isEmpty else { return }
        try? await repository.undo(group: events, reason: "desfeito pelo usuário")

        for m in messages.indices {
            for e in messages[m].edits.indices where messages[m].edits[e].id == edit.id {
                messages[m].edits[e].isUndone = true
            }
        }
        // The model must know, or its next answer will be computed from a bill that
        // no longer exists.
        wire.append(WireMessage(role: .user, blocks: [
            .text("[sistema] O usuário desfez: \(edit.summary). Considere revertido; releia com ver_racha antes de responder valores.")
        ]))
        await persist()
    }

    func clear() async {
        messages = []
        wire = []
        await transcripts.delete(rachaID)
    }

    private func persist() async {
        await transcripts.save(rachaID, messages: messages)
    }

    /// Rebuild the wire history from a loaded transcript. Tool traffic is not
    /// replayed — only the visible turns — because the tool results referenced a
    /// state that has since moved on. The model re-reads with `ver_racha`, which is
    /// cheaper and always correct.
    private static func rebuildWire(from messages: [ChatMessage]) -> [WireMessage] {
        messages.compactMap { m in
            switch m.role {
            case .user: return WireMessage(role: .user, blocks: [.text(m.text)])
            case .agent:
                guard !m.text.isEmpty else { return nil }
                return WireMessage(role: .assistant, blocks: [.text(m.text)])
            case .system: return nil
            }
        }
    }
}

/// pt-BR labels for the "working" indicator. Short verbs, present tense — this
/// string sits under a spinner while someone waits.
enum ToolLabels {
    static func pt(_ toolName: String) -> String {
        switch toolName {
        case AgentTools.parseReceipt.name: return "lendo a nota"
        case AgentTools.addItems.name: return "anotando"
        case AgentTools.editItem.name: return "corrigindo"
        case AgentTools.removeItem.name: return "tirando da conta"
        case AgentTools.assignItems.name: return "dividindo"
        case AgentTools.listSplit.name: return "conferindo a conta"
        case AgentTools.addPerson.name: return "chamando pra mesa"
        case AgentTools.setExtra.name, AgentTools.toggleExtra.name: return "ajustando o serviço"
        case AgentTools.recordPayment.name: return "registrando o pagamento"
        case AgentTools.settleUp.name: return "fechando as contas"
        case AgentTools.pixCode.name: return "gerando o Pix"
        case AgentTools.history.name, AgentTools.venueProfile.name: return "lembrando"
        default: return "trabalhando"
        }
    }
}
