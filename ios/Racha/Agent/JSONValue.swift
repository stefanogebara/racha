import Foundation

/// A tiny dynamic JSON value.
///
/// Tool arguments arrive as arbitrary JSON and the money-touching code needs to
/// read them without `Any` casts scattered everywhere. The accessors below are
/// the only place that conversion happens, and `cents(_:)` in particular refuses
/// to read a money field from a JSON number — see the note there.
indirect enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Int.self) { self = .int(v) }
        else if let v = try? c.decode(Double.self) { self = .double(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .double(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }

    // MARK: Accessors

    subscript(key: String) -> JSONValue? {
        if case .object(let dict) = self { return dict[key] }
        return nil
    }

    var stringValue: String? {
        switch self {
        case .string(let v): return v
        case .int(let v): return String(v)
        case .double(let v): return String(v)
        case .bool(let v): return String(v)
        default: return nil
        }
    }

    var intValue: Int? {
        switch self {
        case .int(let v): return v
        case .double(let v): return Int(v.rounded())
        case .string(let v): return Int(v)
        default: return nil
        }
    }

    var boolValue: Bool? {
        switch self {
        case .bool(let v): return v
        case .int(let v): return v != 0
        case .string(let v): return ["true", "sim", "yes", "1"].contains(v.lowercased())
        default: return nil
        }
    }

    var arrayValue: [JSONValue]? {
        if case .array(let v) = self { return v }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let v) = self { return v }
        return nil
    }

    /// Read a money field.
    ///
    /// The tool schemas ask the model for **integer minor units** (`amount_cents`),
    /// never reais, so the normal path is `.int`. A `.double` is accepted only when
    /// it is exactly integral — a model that emits `4750.0` is fine, one that emits
    /// `47.50` has answered in the wrong unit and must fail loudly rather than
    /// silently charging someone R$ 0,47. A `.string` goes through the same pt-BR
    /// parser the keyboard uses, which is the one forgiving case worth having.
    func cents(_ key: String) -> Cents? {
        guard let raw = self[key] else { return nil }
        switch raw {
        case .int(let v): return Cents(v)
        case .double(let v):
            guard v == v.rounded() else { return nil }
            return Cents(Int(v))
        case .string(let s):
            if let plain = Int(s) { return Cents(plain) }
            return BRL.parse(s)
        default: return nil
        }
    }

    func string(_ key: String) -> String? { self[key]?.stringValue }
    func int(_ key: String) -> Int? { self[key]?.intValue }
    func bool(_ key: String) -> Bool? { self[key]?.boolValue }
    func strings(_ key: String) -> [String]? { self[key]?.arrayValue?.compactMap(\.stringValue) }
    func objects(_ key: String) -> [JSONValue]? { self[key]?.arrayValue }

    /// Compact JSON text — what goes back to the model as a tool result.
    var jsonText: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
        guard let data = try? encoder.encode(self), let s = String(data: data, encoding: .utf8) else { return "null" }
        return s
    }

    static func parse(_ text: String) -> JSONValue? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral {
    init(stringLiteral value: String) { self = .string(value) }
    init(integerLiteral value: Int) { self = .int(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
}

extension JSONValue: ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral {
    init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(uniqueKeysWithValues: elements))
    }
    init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}
