import Foundation
import Observation
import Security

/// User settings. Keys live in the Keychain, never in UserDefaults — an API key
/// in a plist is an API key in an unencrypted backup.
@MainActor
@Observable
final class AppSettings {
    var anthropicKey: String { didSet { Keychain.set(oldValue: oldValue, new: anthropicKey, for: .anthropic) } }
    var openAIKey: String { didSet { Keychain.set(oldValue: oldValue, new: openAIKey, for: .openAI) } }
    var googleKey: String { didSet { Keychain.set(oldValue: oldValue, new: googleKey, for: .google) } }

    /// Generated imagery costs money per image. Off by default is the wrong
    /// default (the timeline is the product), but a hard monthly ceiling is not —
    /// so it is on, with a budget the person can see and change.
    var imageryEnabled: Bool { didSet { UserDefaults.standard.set(imageryEnabled, forKey: "racha.imagery") } }
    var monthlyImageBudgetCents: Int { didSet { UserDefaults.standard.set(monthlyImageBudgetCents, forKey: "racha.imageBudget") } }

    var myName: String { didSet { UserDefaults.standard.set(myName, forKey: "racha.myName") } }
    var myPixKey: String { didSet { UserDefaults.standard.set(myPixKey, forKey: "racha.myPix") } }
    var myCity: String { didSet { UserDefaults.standard.set(myCity, forKey: "racha.myCity") } }

    var hasAgentKey: Bool { !anthropicKey.isEmpty }

    init() {
        anthropicKey = Keychain.get(.anthropic) ?? ""
        openAIKey = Keychain.get(.openAI) ?? ""
        googleKey = Keychain.get(.google) ?? ""
        let defaults = UserDefaults.standard
        imageryEnabled = defaults.object(forKey: "racha.imagery") as? Bool ?? true
        monthlyImageBudgetCents = defaults.object(forKey: "racha.imageBudget") as? Int ?? 500
        myName = defaults.string(forKey: "racha.myName") ?? "Eu"
        myPixKey = defaults.string(forKey: "racha.myPix") ?? ""
        myCity = defaults.string(forKey: "racha.myCity") ?? "SAO PAULO"
    }
}

/// Minimal Keychain wrapper for three secrets.
enum Keychain {
    enum Slot: String { case anthropic, openAI, google }

    static func get(_ slot: Slot) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.racha.keys",
            kSecAttrAccount as String: slot.rawValue,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(oldValue: String, new: String, for slot: Slot) {
        guard oldValue != new else { return }
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.racha.keys",
            kSecAttrAccount as String: slot.rawValue
        ]
        SecItemDelete(base as CFDictionary)
        guard !new.isEmpty, let data = new.data(using: .utf8) else { return }
        var add = base
        add[kSecValueData as String] = data
        // Device-only, after-first-unlock: usable by a background refresh, never
        // synced to iCloud, never present on a restored device.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}
