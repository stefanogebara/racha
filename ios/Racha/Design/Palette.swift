import SwiftUI

/// Racha's colours — the bar at night.
///
/// The ground is a warm near-black table, not paper: on an OLED at 15% battery
/// in a dark bar, dark ground is the honest choice, and it leaves the one cream
/// object — the comanda — to be the only light on the screen, the way the slip
/// is the only paper on a real table. Ink is cream, in four strengths. Two
/// colours carry meaning and nothing else does: vermilion for money leaving your
/// pocket, amber for a question still open (an item nobody has claimed). There is
/// no green: settled is a word and a weight, not a colour.
///
/// Ported from `ios/lab/app.html` after twenty-one rounds of blind critique; the
/// reasoning is in `docs/design-critique-loop.md` and `docs/decisions.md` #27–28.
enum Palette {
    // The ground and its one step up. Depth is a hairline and a shade, not a light.
    static let night       = Color(hex: 0x141008)
    static let surface     = Color(hex: 0x1E1812)
    static let surfaceHigh = Color(hex: 0x282016)
    static let sheet       = Color(hex: 0x221B13)

    // Ink: cream, four strengths. The quiet ones by alpha so they sit on any surface.
    static let cream       = Color(hex: 0xF7F2E9)
    static let ink         = cream
    static let ink2        = cream.opacity(0.88)
    static let ink3        = cream.opacity(0.62)
    static let ink4        = cream.opacity(0.40)

    /// Money leaving your pocket. The vermilion of a cordel cover — warm, not coral.
    static let action      = Color(hex: 0xE85C40)
    static let actionDark  = Color(hex: 0xC4482E)
    /// A question still open: an item nobody has claimed. The lamp's colour.
    static let warn        = Color(hex: 0xE2A54A)
    /// Settled. Carried by the word and by ink weight; this is the quiet ink.
    static let positive    = ink3

    // Hairlines you can see. On an OLED an 8-level border disappears.
    static let rule        = cream.opacity(0.17)
    static let rule2       = cream.opacity(0.09)

    // The one paper object: the comanda. Duller and warmer than the action cream,
    // so a slip and a button never wear the same colour. Its own ink ramp and its
    // own two semantic tones, because they sit on light.
    static let slip        = Color(hex: 0xEEE5D3)
    static let slipInk     = Color(hex: 0x211C16)
    static let slipInk2    = Color(hex: 0x4A4134)
    static let slipInk3    = Color(hex: 0x6E6454)
    static let slipInk4    = Color(hex: 0x968B76)
    static let slipRule    = Color(hex: 0x211C16).opacity(0.14)
    static let slipAction  = Color(hex: 0xB23A1F)
    static let slipWarn    = Color(hex: 0x8A5A10)

    // ── Legacy names, mapped onto the system above ─────────────────────────
    // The views were written against the web app's warm-glass names. Rather than
    // touch sixty files blind, the old names resolve to the new values; a view
    // that asked for "paper" as a ground gets the table, one that asked for
    // "charcoal" as text gets cream. Migrate call sites to the names above as
    // each view is next opened.
    static let paper        = night
    static let paperHigh    = surface
    static let paperMid     = surface
    static let paperLow     = surfaceHigh
    static let warmWhite    = surface
    static let charcoal     = ink
    static let stone        = ink3
    static let burgundy     = action
    static let burgundyDark = actionDark
    static let amber        = warn
    static let amberSoft    = warn
    static let sienna       = warn
    /// No green in the system. "Paid" is the word, set in ink.
    static let emerald      = ink
    static let emeraldBright = ink

    // Surfaces: a flat step, not translucency. Kept as names for the glass card.
    static let glassCard    = cream.opacity(0.045)
    static let glassPanel   = cream.opacity(0.04)
    static let glassSubtle  = cream.opacity(0.03)
    static let glassBorder  = rule
    static let hairline     = rule
    static let inputBorder  = rule

    /// Kept for the mesh shader's signature; the ground no longer draws them.
    static let orbs: [(center: SIMD2<Float>, radius: SIMD2<Float>, color: SIMD4<Float>)] = []

    /// A stable colour per person. Warm, low-saturation, readable on the table.
    static func avatar(seed: Int) -> Color {
        let hue = Double((seed * 47) % 360) / 360.0
        let warm = 0.05 + hue * 0.10            // 18°–54°: amber through gold
        return Color(hue: warm, saturation: 0.45, brightness: 0.80)
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
