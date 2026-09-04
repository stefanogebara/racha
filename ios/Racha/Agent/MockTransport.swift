import Foundation

/// A scripted agent that runs with no API key and no network.
///
/// This is not a stub for tests — it is a shipping mode. Someone who opens the
/// app before adding a key gets a thread that works: it reads the sample racha,
/// splits items, answers about balances. The whole UI (streaming shader, edit
/// ribbons, undo, the settled transition) is exercised by it, which is also how
/// the interactions get verified in the simulator.
///
/// It streams character by character with realistic jitter, because a mock that
/// returns instantly would make the streaming visuals impossible to tune.
struct MockTransport: AgentTransport {

    /// Roughly a fast reader's pace. Slow enough to see, fast enough not to annoy.
    var charactersPerSecond: Double = 90

    func stream(config: AnthropicClient.Config, body: JSONValue) -> AsyncStream<AnthropicClient.Event> {
        let script = Self.respond(to: body)
        let cps = charactersPerSecond
        return AsyncStream { continuation in
            let task = Task {
                for step in script {
                    guard !Task.isCancelled else { break }
                    switch step {
                    case .say(let text):
                        // Chunk on word boundaries: the real API emits multi-character
                        // deltas, and per-character would make the shader behave
                        // differently here than in production.
                        for chunk in text.chunkedForStreaming() {
                            guard !Task.isCancelled else { break }
                            continuation.yield(.textDelta(chunk))
                            let seconds = Double(chunk.count) / cps
                            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                        }
                    case .tool(let name, let input):
                        let id = "mock_\(UUID().uuidString.prefix(8))"
                        continuation.yield(.toolStarted(id: id, name: name))
                        try? await Task.sleep(nanoseconds: 320_000_000)
                        continuation.yield(.toolReady(id: id, name: name, input: input))
                    case .pause(let ms):
                        try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
                    }
                }
                continuation.yield(.stopped(reason: "end_turn"))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    enum Step {
        case say(String)
        case tool(String, JSONValue)
        case pause(Int)
    }

    /// Pattern-matches the last user message. Crude on purpose — it only has to be
    /// convincing enough to drive the UI, and every real answer comes from the
    /// ledger via a real tool call, so the numbers it shows are always true.
    static func respond(to body: JSONValue) -> [Step] {
        let messages = body["messages"]?.arrayValue ?? []
        let lastUserText = messages.last { $0.string("role") == "user" }
            .flatMap { m -> String? in
                m["content"]?.arrayValue?.compactMap { $0.string("text") }.joined(separator: " ")
            }?.folded ?? ""

        // A tool result just came back — narrate it and stop.
        if messages.last?["content"]?.arrayValue?.contains(where: { $0.string("type") == "tool_result" }) == true {
            return [.pause(200), .say("Pronto. Dá uma conferida aí em cima — se algo ficou errado, é só desfazer.")]
        }

        if lastUserText.contains("deve") || lastUserText.contains("pendenc") {
            return [.tool(AgentTools.history.name, ["escopo": "pendencias"]),
                    .say("Deixa eu ver o que está aberto.")]
        }
        if lastUserText.contains("acert") || lastUserText.contains("fechar") || lastUserText.contains("quita") {
            return [.tool(AgentTools.settleUp.name, [:]),
                    .say("Fechando as contas.")]
        }
        if lastUserText.contains("servic") || lastUserText.contains("serviç") || lastUserText.contains("10%") {
            let off = lastUserText.contains("tira") || lastUserText.contains("sem ") || lastUserText.contains("remove")
            return [.tool(AgentTools.toggleExtra.name, ["nome": "Serviço", "ligado": .bool(!off)]),
                    .say(off ? "Tirei o serviço." : "Serviço de volta na conta.")]
        }
        if lastUserText.contains("nota") || lastUserText.contains("foto") || lastUserText.contains("comanda") {
            return [.say("Lendo a nota."), .pause(400),
                    .tool(AgentTools.parseReceipt.name, [
                        "itens": .array([
                            ["nome": "Picanha na chapa", "quantidade": 1, "total_cents": 12900, "categoria": "carne"],
                            ["nome": "Farofa da casa", "quantidade": 1, "total_cents": 2200, "categoria": "acompanhamento"],
                            ["nome": "Chopp 500ml", "quantidade": 4, "preco_unitario_cents": 1600, "total_cents": 6400, "categoria": "cerveja"],
                            ["nome": "Caipirinha de limão", "quantidade": 2, "preco_unitario_cents": 2400, "total_cents": 4800, "categoria": "drink"]
                        ]),
                        "servico_bp": 1000
                    ])]
        }
        if lastUserText.contains("divid") || lastUserText.contains("coloca") || lastUserText.contains("racha") {
            return [.tool(AgentTools.listSplit.name, [:]),
                    .say("Vou olhar a conta primeiro.")]
        }

        return [.say("""
        Modo demonstração — sem chave da API configurada. \
        A conta e as divisões são reais: tudo que eu mexer aqui passa pelo mesmo motor \
        de centavos do app. Só as minhas frases é que estão no script.

        Experimenta: "quanto o pessoal ainda me deve?", "tira o serviço", ou manda uma foto da nota.
        """)]
    }
}

extension String {
    /// Split into streaming-sized chunks at word boundaries, 2–5 words each.
    func chunkedForStreaming() -> [String] {
        var out: [String] = []
        var current = ""
        var wordsInChunk = 0
        let target = 3
        for word in split(separator: " ", omittingEmptySubsequences: false) {
            current += (current.isEmpty ? "" : " ") + word
            wordsInChunk += 1
            if wordsInChunk >= target {
                out.append(current)
                current = ""
                wordsInChunk = 0
            }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }
}
