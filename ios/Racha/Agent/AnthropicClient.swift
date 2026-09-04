import Foundation

/// Streaming client for the Anthropic Messages API.
///
/// Deliberately hand-rolled over `URLSession.bytes(for:)` rather than pulled from
/// a package: the app needs *token-level* deltas to drive the streaming shader,
/// and it needs them with the timing preserved. A convenience wrapper that
/// buffers and hands back a finished string would make the nicest part of the
/// chat impossible.
///
/// Ships with a `MockTransport` so the whole thread works with no key and no
/// network — which is also how the UI is exercised in a simulator.
struct AnthropicClient: Sendable {

    struct Config: Sendable {
        var apiKey: String
        var model: String
        var maxTokens: Int
        var baseURL: URL
        var version: String

        /// Opus 5 for the conversation. The agent does arithmetic-adjacent
        /// reasoning about money and resolves ambiguous Portuguese references to
        /// people — both are places where a cheaper model's mistake costs a real
        /// person real money, and the volume here (a few turns per meal) makes the
        /// cost difference irrelevant.
        static func opus(key: String) -> Config {
            Config(apiKey: key, model: "claude-opus-5", maxTokens: 4096,
                   baseURL: URL(string: "https://api.anthropic.com/v1/messages")!,
                   version: "2023-06-01")
        }

        /// Haiku for the receipt pass, where the job is transcription rather than
        /// judgement and latency at the table is what matters.
        static func haiku(key: String) -> Config {
            Config(apiKey: key, model: "claude-haiku-4-5-20251001", maxTokens: 8192,
                   baseURL: URL(string: "https://api.anthropic.com/v1/messages")!,
                   version: "2023-06-01")
        }
    }

    /// What the caller sees while the model talks.
    enum Event: Sendable {
        case textDelta(String)
        case thinkingDelta(String)
        /// A tool call has started; arguments are still streaming.
        case toolStarted(id: String, name: String)
        case toolInputDelta(id: String, partialJSON: String)
        case toolReady(id: String, name: String, input: JSONValue)
        case stopped(reason: String?)
        case failed(String)
    }

    var config: Config
    var transport: AgentTransport

    init(config: Config, transport: AgentTransport? = nil) {
        self.config = config
        self.transport = transport ?? LiveTransport()
    }

    func stream(messages: [WireMessage], system: String, tools: [AgentTool]) -> AsyncStream<Event> {
        let body = requestBody(messages: messages, system: system, tools: tools)
        return transport.stream(config: config, body: body)
    }

    private func requestBody(messages: [WireMessage], system: String, tools: [AgentTool]) -> JSONValue {
        [
            "model": .string(config.model),
            "max_tokens": .int(config.maxTokens),
            "stream": .bool(true),
            // A single cacheable system block. The tool list and the house rules are
            // identical on every turn of every racha, so caching them is most of the
            // per-turn cost gone.
            "system": .array([[
                "type": "text",
                "text": .string(system),
                "cache_control": ["type": "ephemeral"]
            ]]),
            "tools": .array(tools.map { tool in
                ["name": .string(tool.name),
                 "description": .string(tool.description),
                 "input_schema": tool.schema]
            }),
            "messages": .array(messages.map(\.wire))
        ]
    }
}

/// One message on the wire. Kept separate from the UI's `ChatMessage` because the
/// two diverge: the wire needs tool_result blocks the user never sees, and the UI
/// needs edit ribbons the model never sees.
struct WireMessage: Sendable {
    enum Role: String, Sendable { case user, assistant }
    var role: Role
    var blocks: [Block]

    enum Block: Sendable {
        case text(String)
        case image(mediaType: String, base64: String)
        case toolUse(id: String, name: String, input: JSONValue)
        case toolResult(id: String, content: String, isError: Bool)
    }

    var wire: JSONValue {
        [
            "role": .string(role.rawValue),
            "content": .array(blocks.map { block in
                switch block {
                case .text(let t):
                    return ["type": "text", "text": .string(t)]
                case .image(let mediaType, let base64):
                    return ["type": "image",
                            "source": ["type": "base64",
                                       "media_type": .string(mediaType),
                                       "data": .string(base64)]]
                case .toolUse(let id, let name, let input):
                    return ["type": "tool_use", "id": .string(id),
                            "name": .string(name), "input": input]
                case .toolResult(let id, let content, let isError):
                    return ["type": "tool_result", "tool_use_id": .string(id),
                            "content": .string(content), "is_error": .bool(isError)]
                }
            })
        ]
    }
}

// MARK: - Transport

protocol AgentTransport: Sendable {
    func stream(config: AnthropicClient.Config, body: JSONValue) -> AsyncStream<AnthropicClient.Event>
}

/// Real SSE over HTTPS.
struct LiveTransport: AgentTransport {

    func stream(config: AnthropicClient.Config, body: JSONValue) -> AsyncStream<AnthropicClient.Event> {
        AsyncStream { continuation in
            let task = Task {
                do {
                    var request = URLRequest(url: config.baseURL)
                    request.httpMethod = "POST"
                    request.setValue(config.apiKey, forHTTPHeaderField: "x-api-key")
                    request.setValue(config.version, forHTTPHeaderField: "anthropic-version")
                    request.setValue("application/json", forHTTPHeaderField: "content-type")
                    request.httpBody = body.jsonText.data(using: .utf8)
                    request.timeoutInterval = 120

                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                        var detail = ""
                        for try await line in bytes.lines { detail += line }
                        continuation.yield(.failed(Self.humanError(status: http.statusCode, body: detail)))
                        continuation.finish()
                        return
                    }

                    var parser = SSEParser()
                    for try await line in bytes.lines {
                        guard !Task.isCancelled else { break }
                        for event in parser.consume(line) { continuation.yield(event) }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.yield(.failed("Sem conexão com o agente. \(error.localizedDescription)"))
                    continuation.finish()
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// The person holding the phone is at a table, not in a terminal. Status codes
    /// get translated into what they can actually do about it.
    static func humanError(status: Int, body: String) -> String {
        switch status {
        case 401, 403: return "A chave da API não foi aceita. Confira em Ajustes."
        case 429: return "Muitas mensagens seguidas. Espera uns segundos e manda de novo."
        case 500...599: return "O serviço está fora do ar. Você pode continuar editando na mão — nada se perde."
        default: return "Deu erro (\(status)). Você pode continuar editando na mão."
        }
    }
}

/// Incremental SSE → `Event`.
///
/// Tool arguments arrive as `input_json_delta` fragments that are only valid JSON
/// once concatenated, so partial JSON is accumulated per block index and parsed
/// exactly once at `content_block_stop`. Parsing early would either fail or, far
/// worse, succeed on a truncated object and call a money tool with half its
/// arguments.
struct SSEParser {
    private var currentEvent: String?
    private var toolBlocks: [Int: (id: String, name: String, json: String)] = [:]
    private var currentIndex: Int = 0

    mutating func consume(_ line: String) -> [AnthropicClient.Event] {
        if line.hasPrefix("event: ") {
            currentEvent = String(line.dropFirst(7)).trimmingCharacters(in: .whitespaces)
            return []
        }
        guard line.hasPrefix("data: ") else { return [] }
        let payload = String(line.dropFirst(6))
        guard let json = JSONValue.parse(payload) else { return [] }
        let type = json.string("type") ?? currentEvent ?? ""
        let index = json.int("index") ?? currentIndex
        currentIndex = index

        switch type {
        case "content_block_start":
            guard let block = json["content_block"] else { return [] }
            if block.string("type") == "tool_use",
               let id = block.string("id"), let name = block.string("name") {
                toolBlocks[index] = (id, name, "")
                return [.toolStarted(id: id, name: name)]
            }
            return []

        case "content_block_delta":
            guard let delta = json["delta"] else { return [] }
            switch delta.string("type") {
            case "text_delta":
                return delta.string("text").map { [.textDelta($0)] } ?? []
            case "thinking_delta":
                return delta.string("thinking").map { [.thinkingDelta($0)] } ?? []
            case "input_json_delta":
                guard let partial = delta.string("partial_json"), var block = toolBlocks[index] else { return [] }
                block.json += partial
                toolBlocks[index] = block
                return [.toolInputDelta(id: block.id, partialJSON: partial)]
            default:
                return []
            }

        case "content_block_stop":
            guard let block = toolBlocks.removeValue(forKey: index) else { return [] }
            // An empty argument object is legitimate (ver_racha takes none).
            let input = JSONValue.parse(block.json.isEmpty ? "{}" : block.json)
            guard let input else {
                return [.failed("A chamada de ferramenta \(block.name) veio incompleta. Nada foi alterado.")]
            }
            return [.toolReady(id: block.id, name: block.name, input: input)]

        case "message_delta":
            return [.stopped(reason: json["delta"]?.string("stop_reason"))]

        case "error":
            return [.failed(json["error"]?.string("message") ?? "Erro do serviço.")]

        default:
            return []
        }
    }
}
