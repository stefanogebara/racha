import SwiftUI

/// Racha's colours, ported from `apps/web/src/styles.css` so the phone and the
/// web app are recognisably the same product.
///
/// The system is "Warm Glass": a warm-white ground with four soft orbs bleeding
/// through it, and surfaces that are translucent rather than opaque. Burgundy is
/// the only action colour; emerald, amber and red are semantic only — a green
/// button that doesn't mean "paid" would break the one thing the colour says.
enum Palette {
    // The ground is paper, not a gradient. Three cuts of the same warm stock:
    // the tile sheet is lit (paperHigh → paperLow), the app ground sits between
    // them. Colour in this app comes from the food, never from the chrome.
    static let paper       = Color(hex: 0xF7F2E9)
    static let paperHigh   = Color(hex: 0xFCF9F3)
    static let paperMid    = Color(hex: 0xF1EADD)
    static let paperLow    = Color(hex: 0xE7DECB)

    // Four values of ink, and no more. The two quiet ones were originally set
    // light enough to read as texture rather than as text, which is a defect in
    // an app whose job is telling someone what they owe, in a bar, at night.
    static let ink         = Color(hex: 0x211C16)
    static let ink2        = Color(hex: 0x4A4134)
    static let ink3        = Color(hex: 0x6E6454)
    static let ink4        = Color(hex: 0x968B76)

    /// The one action colour. It means "the thing that closes this out", and it
    /// appears once per screen.
    ///
    /// There is deliberately no success green. A stock emerald belongs to a
    /// component library, not to a palette of bone and oxblood — it was the
    /// clearest sign in the interface that something had been dropped in rather
    /// than drawn. Settled state is carried by the word and by ink weight,
    /// which is how the rest of this design carries everything.
    static let action      = Color(hex: 0x8E1231)
    static let actionDark  = Color(hex: 0x6E0C25)
    static let positive    = Color(hex: 0x4A4136)

    static let warmWhite   = Color(hex: 0xFAFAF9)
    static let burgundy    = Color(hex: 0x9F1239)
    static let burgundyDark = Color(hex: 0x881337)
    static let charcoal    = Color(hex: 0x1C1917)
    static let stone       = Color(hex: 0x706A65)
    static let emerald     = Color(hex: 0x059669)
    static let emeraldBright = Color(hex: 0x10B981)
    static let amber       = Color(hex: 0xD97706)
    static let amberSoft   = Color(hex: 0xF59E0B)
    static let sienna      = Color(hex: 0x78350F)

    // Glass tiers, same alphas as the web app's --glass-* tokens.
    static let glassCard    = Color.white.opacity(0.62)
    static let glassPanel   = Color.white.opacity(0.55)
    static let glassSubtle  = Color.white.opacity(0.40)
    static let glassBorder  = Color.white.opacity(0.70)
    static let hairline     = Color(hex: 0x211C16).opacity(0.07)
    static let inputBorder  = Color(hex: 0x1C1917).opacity(0.12)

    /// The four orbs from the web `body` background, as normalised positions,
    /// radii and colours. Fed to the mesh-gradient shader rather than drawn as
    /// four blurred circles — see `Racha.metal`.
    static let orbs: [(center: SIMD2<Float>, radius: SIMD2<Float>, color: SIMD4<Float>)] = [
        (SIMD2(0.12, 0.18), SIMD2(0.65, 0.45), SIMD4(0.851, 0.467, 0.024, 0.18)),  // amber 600
        (SIMD2(0.88, 0.22), SIMD2(0.55, 0.40), SIMD4(0.961, 0.620, 0.043, 0.15)),  // amber 500
        (SIMD2(0.50, 0.95), SIMD2(0.75, 0.50), SIMD4(0.624, 0.071, 0.224, 0.12)),  // burgundy
        (SIMD2(0.90, 0.80), SIMD2(0.45, 0.35), SIMD4(0.471, 0.208, 0.059, 0.10))   // sienna
    ]

    /// A stable colour per person.
    ///
    /// Kept for the few places a person still needs a mark of their own, but the
    /// ledger no longer uses it: four discs in four shades of the same wine are
    /// four indistinguishable discs, read by their letter and nothing else, and
    /// in a list that already prints everybody's name they were saying the same
    /// thing twice. Ink, not hue.
    static func avatar(seed: Int) -> Color {
        let hue = Double((seed * 47) % 360) / 360.0
        let warm = 0.02 + hue * 0.20            // 7°–79°: rust through gold
        let alternate = 0.92 + hue * 0.08       // 331°–360°: wine
        let useAlternate = (seed / 7) % 3 == 0
        return Color(hue: useAlternate ? alternate.truncatingRemainder(dividingBy: 1.0) : warm,
                     saturation: 0.55, brightness: 0.72)
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: 1)
    }
}
