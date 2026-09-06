import Foundation

/// A text-to-image backend.
///
/// **Pricing as of September 2026**, per 1024×1024 image, which is why the
/// default is what it is:
///
/// | model                       | vendor | per image |
/// |-----------------------------|--------|-----------|
/// | gpt-image-1-mini (low)      | OpenAI | $0.005    |  ← default
/// | gpt-image-1-mini (medium)   | OpenAI | ~$0.011   |
/// | imagen-4-fast               | Google | $0.020    |
/// | gemini-3.1-flash-lite-image | Google | $0.0336   |
/// | gemini-3.1-flash-image      | Google | ~$0.045   |
///
/// `gpt-image-1-mini` at low quality is roughly 4× cheaper than the nearest
/// alternative and is more than good enough for a 160pt card, which is the size
/// these are actually seen at. Imagen 4 Fast is the quality tier for the cover
/// image, which gets shown large in the timeline.
///
/// The real cost lever is not the model, though — it is the cache. A dish is
/// generated once, ever, per style version. See `ImageCache`.
protocol ImageProvider: Sendable {
    var identifier: String { get }
    /// Approximate USD cost per image, for the budget meter in Settings.
    var costPerImageMicros: Int { get }
    func generate(prompt: String, size: Int) async throws -> Data
}

enum ImageProviderError: LocalizedError {
    case notConfigured
    case rejected(String)
    case malformedResponse
    case rateLimited

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Sem chave de imagem configurada."
        case .rejected(let why): return "O gerador recusou: \(why)"
        case .malformedResponse: return "Resposta inesperada do gerador de imagem."
        case .rateLimited: return "Muitas imagens de uma vez. Tentando de novo em instantes."
        }
    }
}

/// OpenAI Images API. The default.
///
/// **Transparency is the reason this is the default**, not the price.
/// `gpt-image-1` and `gpt-image-1-mini` are the only current models that return
/// a real alpha channel (`background: "transparent"` with a PNG or WebP output),
/// and a cut-out subject is what makes the gallery work: a dish sitting on the
/// app's paper with its own contact shadow reads as an object that was
/// photographed on a surface. A dish delivered on its own baked-in background
/// reads as a stock photo pasted into a box, and no amount of styling recovers
/// from that — it is the single biggest difference between the gallery looking
/// designed and looking generated.
///
/// Imagen and the Gemini image line return opaque frames, so they are the
/// quality tier for the *cover* (which is full-bleed and wants a background)
/// and never for a line item.
struct OpenAIImageProvider: ImageProvider {
    var apiKey: String
    var model: String = "gpt-image-1-mini"
    var quality: String = "low"
    /// Cut-out (alpha) or full-frame. Line items are cut out; covers are not.
    var transparent: Bool = true

    var identifier: String { "\(model)/\(quality)\(transparent ? "/alpha" : "")" }
    var costPerImageMicros: Int { quality == "low" ? 5_000 : 11_000 }

    func generate(prompt: String, size: Int) async throws -> Data {
        guard !apiKey.isEmpty else { throw ImageProviderError.notConfigured }
        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/images/generations")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 90
        // `background: transparent` requires a format that carries alpha. WebP
        // keeps a 1024px cut-out at a few tens of KB, which matters because the
        // cache holds hundreds of them.
        var fields: [String: JSONValue] = [
            "model": .string(model),
            "prompt": .string(prompt),
            "n": 1,
            "size": .string("\(size)x\(size)"),
            "quality": .string(quality),
            "output_format": .string(transparent ? "png" : "webp")
        ]
        if transparent { fields["background"] = "transparent" }
        let body = JSONValue.object(fields)
        request.httpBody = body.jsonText.data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            if http.statusCode == 429 { throw ImageProviderError.rateLimited }
            let detail = JSONValue.parse(String(data: data, encoding: .utf8) ?? "")?["error"]?.string("message")
            throw ImageProviderError.rejected(detail ?? "HTTP \(http.statusCode)")
        }
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: data),
              let first = json["data"]?.arrayValue?.first,
              let b64 = first.string("b64_json"),
              let decoded = Data(base64Encoded: b64) else {
            throw ImageProviderError.malformedResponse
        }
        return decoded
    }
}

/// Google's Imagen / Gemini image models. The quality tier.
struct GoogleImageProvider: ImageProvider {
    var apiKey: String
    /// `imagen-4.0-fast-generate-001` is flat-rate and the cheapest good Google
    /// option; `gemini-3.1-flash-image` is the Nano Banana line.
    var model: String = "imagen-4.0-fast-generate-001"

    var identifier: String { model }
    var costPerImageMicros: Int { model.hasPrefix("imagen-4.0-fast") ? 20_000 : 45_000 }

    func generate(prompt: String, size: Int) async throws -> Data {
        guard !apiKey.isEmpty else { throw ImageProviderError.notConfigured }
        let url = URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(model):predict")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 90
        let body: JSONValue = [
            "instances": .array([["prompt": .string(prompt)]]),
            "parameters": [
                "sampleCount": 1,
                "aspectRatio": "1:1",
                "personGeneration": "dont_allow"
            ]
        ]
        request.httpBody = body.jsonText.data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            if http.statusCode == 429 { throw ImageProviderError.rateLimited }
            throw ImageProviderError.rejected("HTTP \(http.statusCode)")
        }
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: data),
              let prediction = json["predictions"]?.arrayValue?.first,
              let b64 = prediction.string("bytesBase64Encoded"),
              let decoded = Data(base64Encoded: b64) else {
            throw ImageProviderError.malformedResponse
        }
        return decoded
    }
}

/// Draws a deterministic cut-out dish locally, with alpha. Used with no key configured, and
/// as the permanent fallback when generation fails — so a card is never empty and
/// the timeline never has a hole in it.
struct ProceduralImageProvider: ImageProvider {
    var identifier: String { "procedural" }
    var costPerImageMicros: Int { 0 }

    func generate(prompt: String, size: Int) async throws -> Data {
        // The renderer lives in ProceduralPlate.swift so this file stays free of
        // UIKit and can be unit-tested on its own.
        try await ProceduralPlate.render(seed: prompt.folded.stableHash, size: size)
    }
}
