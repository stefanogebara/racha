import UIKit

/// The subject, cut in relief.
///
/// This exists so the app is never ugly while it waits, and never broken when
/// there is no key or no signal. It is not a placeholder pretending to be a
/// photograph — it is the drawing system itself, and a generated image is the
/// upgrade rather than the point.
///
/// The form is xilogravura: the woodcut of Brazilian cordel, the pamphlet
/// literature sold at fairs in the Northeast. That choice is not decoration.
/// Twelve rounds of blind critique kept naming the previous line drawings as
/// the clearest sign of a machine, and the reason is structural: a generator
/// reaches for an even, uniform contour by default, so an even, uniform
/// contour is what a machine looks like. A relief print inverts the whole
/// operation. The subject is a solid mass of ink; detail is not added to it in
/// black but *removed* from it in white, because a gouge takes ink away. Tone
/// is a run of chunky parallel cuts. The contour is faceted, because a blade
/// travels in straight pushes and the block chips where it turns. And the ink
/// never lays down perfectly, so a little of the paper comes through.
///
/// It is also the right form for this product specifically. A bar tab in
/// Brazil belongs to the same world of cheap everyday printed paper as a
/// cordel cover does. The line-drawing version could have been made for a
/// hotel in Copenhagen; this could not.
///
/// Mirrors `ios/lab/food.js`, which is where the drawing was worked out and
/// where it can be audited on a contact sheet at three sizes.
///
/// Same seed, same block, forever. That stability matters: a placeholder that
/// reshuffles on every launch makes the whole timeline feel unreliable.
enum ProceduralPlate {

    /// Bone stock and the ink that sits in it.
    private static let paper = UIColor(red: 0.976, green: 0.961, blue: 0.925, alpha: 1)
    private static let ink   = UIColor(red: 0.141, green: 0.118, blue: 0.090, alpha: 1)

    /// Every subject stands on this line and reaches no higher than the cap, so
    /// a row of them shares a horizon.
    private static let cap: CGFloat = 0.20, base: CGFloat = 0.850

    static func render(seed: Int, size: Int) async throws -> Data {
        await MainActor.run {
            let rng = SplitMix64(seed: UInt64(bitPattern: Int64(seed)))
            let side = CGFloat(size)
            let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
            let image = renderer.image { ctx in
                let cg = ctx.cgContext
                cg.setFillColor(paper.cgColor)
                cg.fill(CGRect(x: 0, y: 0, width: side, height: side))

                var b = Block(cg: cg, side: side, rng: rng, lod: Lod(side))
                b.subject()
                b.ground()
            }
            return image.pngData() ?? Data()
        }
    }

    /// Below ~64pt a gouge narrower than a point closes up and the block turns
    /// to a blot, so the small cut is the silhouette and the two or three
    /// gouges that carry the subject's identity — which is what a printer
    /// cutting a small block actually does.
    private enum Lod: Int {
        case small = 0, medium = 1, full = 2
        init(_ side: CGFloat) { self = side < 64 ? .small : side < 132 ? .medium : .full }
    }

    /// The block, and the four marks a relief print affords: ink left standing,
    /// ink taken away by a gouge, ink taken away in parallel runs, and ink that
    /// failed to transfer.
    private struct Block {
        let cg: CGContext
        let side: CGFloat
        var rng: SplitMix64
        let lod: Lod
        var chipCounter: Int = 0

        /// The gouge widens as the block shrinks, so it never closes up in the
        /// print.
        var weight: CGFloat {
            max(0.0185, 1.35 / side) * (lod == .small ? 1.5 : lod == .medium ? 1.15 : 1) * side
        }
        /// The block chips less on a small cut: there is no room for it to.
        var chip: CGFloat {
            (lod == .small ? 0 : lod == .medium ? 0.0030 : 0.0042) * side
        }

        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * side, y: y * side) }

        /// Walk a dense point list with straight segments, displacing each point
        /// along its normal. A blade cuts in straight pushes and the block chips
        /// where it turns, so a woodcut contour is a chain of short segments
        /// that do not quite line up — never a smooth curve.
        mutating func path(_ pts: [CGPoint], close: Bool = true) -> CGPath {
            let p = CGMutablePath()
            chipCounter += 1
            let k = CGFloat(chipCounter) * 2.399
            for (i, raw) in pts.enumerated() {
                var q = raw
                if chip > 0 && pts.count > 2 {
                    let prev = pts[(i - 1 + pts.count) % pts.count], next = pts[(i + 1) % pts.count]
                    let dx = next.x - prev.x, dy = next.y - prev.y
                    let len = max(0.0001, (dx * dx + dy * dy).squareRoot())
                    // two octaves, so the wobble reads as grain and not as a sine wave
                    let w = sin(CGFloat(i) * 1.77 + k) * 0.62 + sin(CGFloat(i) * 0.53 + k * 1.9) * 0.38
                    q.x += (-dy / len) * w * chip
                    q.y += (dx / len) * w * chip
                }
                i == 0 ? p.move(to: q) : p.addLine(to: q)
            }
            if close { p.closeSubpath() }
            return p
        }

        /// Ink left standing. The paper halo is the uncut channel a printer
        /// leaves between two forms so they do not run together on the sheet.
        func fill(_ path: CGPath) {
            cg.addPath(path)
            cg.setStrokeColor(paper.cgColor); cg.setLineWidth(weight * 4.2)
            cg.setLineJoin(.round); cg.strokePath()
            cg.addPath(path)
            cg.setFillColor(ink.cgColor); cg.fillPath()
        }

        /// A gouge: ink taken away. Detail lives here now — a white line through
        /// the black, not a black line on the white.
        func gouge(_ path: CGPath, _ k: CGFloat = 1) {
            guard lod != .small else { return }
            cg.addPath(path)
            cg.setStrokeColor(paper.cgColor); cg.setLineWidth(weight * 1.15 * k)
            cg.setLineCap(.round); cg.strokePath()
        }

        /// Ink that did not take. A few specks of paper coming through a black
        /// mass — the thing that says a block was pressed onto a sheet by hand.
        mutating func speck(in clip: CGPath, count: Int) {
            guard lod == .full else { return }
            cg.saveGState(); cg.addPath(clip); cg.clip()
            cg.setFillColor(paper.cgColor)
            for _ in 0..<count {
                let c = pt(CGFloat(rng.nextUnit()), CGFloat(rng.nextUnit()))
                let r = (0.004 + CGFloat(rng.nextUnit()) * 0.008) * side
                let p = CGMutablePath()
                for j in 0..<5 {                                  // angular, not round
                    let a = CGFloat(j) / 5 * .pi * 2
                    let rr = r * (0.6 + CGFloat(rng.nextUnit()) * 0.8)
                    let q = CGPoint(x: c.x + cos(a) * rr, y: c.y + sin(a) * rr)
                    j == 0 ? p.move(to: q) : p.addLine(to: q)
                }
                p.closeSubpath(); cg.addPath(p); cg.fillPath()
            }
            cg.restoreGState()
        }

        /// The ground: a bar, not a hairline. That shared horizon is most of
        /// what makes unrelated objects read as one set.
        func ground() {
            cg.setFillColor(ink.cgColor)
            let h = weight * 1.5
            cg.fill(CGRect(x: 0.10 * side, y: base * side - h / 2, width: 0.80 * side, height: h))
        }

        /// The generic subject — a plate, front elevation, cut as one silhouette
        /// and articulated from the inside. A dish drawn from above would be a
        /// second camera, and one different camera in a set is enough to break
        /// it back into a pile of stickers.
        mutating func subject() {
            let ry = base - 0.100, w: CGFloat = 0.238
            var pts: [CGPoint] = []
            let crown: [(CGFloat, CGFloat)] = [
                (0.5 - w - 0.082, ry - 0.006), (0.5 - w * 0.62, ry - 0.020),
                (0.5 - w * 0.38, ry - 0.122), (0.5 + 0.010, ry - 0.160),
                (0.5 + w * 0.44, ry - 0.116), (0.5 + w * 0.64, ry - 0.020),
                (0.5 + w + 0.082, ry - 0.006)]
            for (x, y) in crown { pts.append(pt(x, y)) }
            for i in 1...22 {
                let t = CGFloat(i) / 22
                pts.append(pt(0.5 + w + 0.082 - (2 * w + 0.164) * t,
                              ry + sin(.pi * t) * 0.104))
            }
            let dish = path(pts)
            fill(dish)
            // the rim: one gouge separating the food from the plate
            gouge(path([pt(0.5 - w - 0.040, ry + 0.010), pt(0.5 + w + 0.040, ry + 0.010)],
                       close: false), 1.0)
            speck(in: dish, count: 20)
            fill(path([pt(0.5 - 0.086, ry + 0.086), pt(0.5 + 0.086, ry + 0.086),
                       pt(0.5 + 0.068, base), pt(0.5 - 0.068, base)]))
        }
    }
}

/// Deterministic randomness. Same seed, same block, forever — across launches
/// and across devices, which `Swift.hashValue` cannot promise because its seed
/// is per-process.
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

    /// A value in [0,1). Used for the speck pattern, where the only requirement
    /// is that the same block prints the same imperfections every time.
    mutating func nextUnit() -> Double { Double(next() >> 11) * 0x1p-53 }
}
