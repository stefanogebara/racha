import UIKit

/// A deterministic, locally-drawn stand-in.
///
/// This exists so the app is never ugly while it waits, and never broken when
/// there is no key or no signal. It draws a plated abstraction: a warm ground, a
/// soft plate disc, and two or three organic blobs in colours derived from the
/// seed — recognisably "food on a plate" at card size, without pretending to be
/// a photograph.
///
/// Same seed, same picture, forever. That stability matters: a placeholder that
/// reshuffles on every launch makes the whole timeline feel unreliable.
enum ProceduralPlate {

    static func render(seed: Int, size: Int) async throws -> Data {
        await MainActor.run {
            var rng = SplitMix64(seed: UInt64(bitPattern: Int64(seed)))
            let side = CGFloat(size)
            let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
            let image = renderer.image { ctx in
                let cg = ctx.cgContext

                // Ground: the app's warm white with a faint corner falloff.
                cg.setFillColor(UIColor(red: 0.980, green: 0.980, blue: 0.976, alpha: 1).cgColor)
                cg.fill(CGRect(x: 0, y: 0, width: side, height: side))

                let warm = UIColor(hue: 0.09, saturation: 0.30, brightness: 0.97, alpha: 1)
                drawRadial(cg, center: CGPoint(x: side * 0.28, y: side * 0.22),
                           radius: side * 0.7, color: warm.withAlphaComponent(0.35))

                // Plate.
                let plateRect = CGRect(x: side * 0.12, y: side * 0.12, width: side * 0.76, height: side * 0.76)
                cg.setShadow(offset: CGSize(width: 0, height: side * 0.014),
                             blur: side * 0.05, color: UIColor.black.withAlphaComponent(0.10).cgColor)
                cg.setFillColor(UIColor(white: 0.995, alpha: 1).cgColor)
                cg.fillEllipse(in: plateRect)
                cg.setShadow(offset: .zero, blur: 0, color: nil)

                cg.setStrokeColor(UIColor(white: 0.86, alpha: 1).cgColor)
                cg.setLineWidth(side * 0.004)
                cg.strokeEllipse(in: plateRect.insetBy(dx: side * 0.055, dy: side * 0.055))

                // Two or three blobs of "food". Hues stay in the warm/earth half of
                // the wheel so every plate belongs to the same palette.
                let blobCount = 2 + Int(rng.next() % 2)
                for i in 0..<blobCount {
                    let hue = 0.02 + Double(rng.next() % 130) / 1000.0        // 7°–54°
                    let colour = UIColor(hue: hue,
                                         saturation: 0.42 + Double(rng.next() % 25) / 100.0,
                                         brightness: 0.55 + Double(rng.next() % 30) / 100.0,
                                         alpha: 1)
                    let angle = Double(i) * (2 * .pi / Double(blobCount)) + Double(rng.next() % 100) / 100.0
                    let offset = side * 0.12
                    let center = CGPoint(x: side * 0.5 + CGFloat(cos(angle)) * offset,
                                         y: side * 0.5 + CGFloat(sin(angle)) * offset)
                    let radius = side * (0.11 + CGFloat(rng.next() % 6) / 100.0)
                    blob(cg, center: center, radius: radius, colour: colour, rng: &rng)
                }

                // Grain, to match the app's paperGrain shader.
                cg.setBlendMode(.overlay)
                for _ in 0..<Int(side * 2) {
                    let x = CGFloat(rng.next() % UInt64(size))
                    let y = CGFloat(rng.next() % UInt64(size))
                    let a = CGFloat(rng.next() % 40) / 400.0
                    cg.setFillColor(UIColor(white: 0.5, alpha: a).cgColor)
                    cg.fill(CGRect(x: x, y: y, width: 1.5, height: 1.5))
                }
            }
            // JPEG rather than PNG: a flat gradient plate compresses to a few KB,
            // and the cache holds hundreds of these.
            return image.jpegData(compressionQuality: 0.86) ?? Data()
        }
    }

    /// An organic lump: a circle whose radius wobbles on a few harmonics.
    private static func blob(_ cg: CGContext, center: CGPoint, radius: CGFloat,
                             colour: UIColor, rng: inout SplitMix64) {
        let path = CGMutablePath()
        let harmonics = (0..<3).map { _ in
            (amp: CGFloat(rng.next() % 18) / 100.0, phase: CGFloat(rng.next() % 628) / 100.0)
        }
        let steps = 64
        for step in 0...steps {
            let t = CGFloat(step) / CGFloat(steps) * 2 * .pi
            var r = radius
            for (i, h) in harmonics.enumerated() {
                r += radius * h.amp * cos(t * CGFloat(i + 2) + h.phase)
            }
            let point = CGPoint(x: center.x + cos(t) * r, y: center.y + sin(t) * r)
            step == 0 ? path.move(to: point) : path.addLine(to: point)
        }
        path.closeSubpath()

        cg.saveGState()
        cg.setShadow(offset: CGSize(width: 0, height: radius * 0.10),
                     blur: radius * 0.30, color: UIColor.black.withAlphaComponent(0.18).cgColor)
        cg.addPath(path)
        cg.setFillColor(colour.cgColor)
        cg.fillPath()
        cg.restoreGState()

        // A specular kiss on the upper left, so it reads as three-dimensional.
        cg.saveGState()
        cg.addPath(path)
        cg.clip()
        drawRadial(cg, center: CGPoint(x: center.x - radius * 0.3, y: center.y - radius * 0.3),
                   radius: radius * 0.9, color: UIColor.white.withAlphaComponent(0.30))
        cg.restoreGState()
    }

    private static func drawRadial(_ cg: CGContext, center: CGPoint, radius: CGFloat, color: UIColor) {
        guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                                        colors: [color.cgColor, color.withAlphaComponent(0).cgColor] as CFArray,
                                        locations: [0, 1]) else { return }
        cg.drawRadialGradient(gradient, startCenter: center, startRadius: 0,
                              endCenter: center, endRadius: radius, options: [])
    }
}

/// A small deterministic PRNG. `SystemRandomNumberGenerator` would make the
/// placeholder different on every launch, which is exactly what must not happen.
struct SplitMix64: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E3779B97F4A7C15 }

    mutating func next() -> UInt64 {
        state = state &+ 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}
