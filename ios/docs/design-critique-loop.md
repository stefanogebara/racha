# The critique loop

A design critic in a fresh context, given nothing but a screenshot, asked to name
the aesthetic, imagine how a top studio would execute it, and score the gap out
of ten. Same prompt every round, no memory of previous rounds, no access to the
code or to what had just been changed. Twelve rounds.

The point of the fresh context is that the critic cannot be led. It never sees
what was just fixed, so it never credits an intention — only what is on the
screen. The cost is that it also never remembers what it said last time, so the
lists shuffle and the score does not climb monotonically.

## What it actually changed

The loop was worth running. Almost everything below came out of it, and most of
it would not have occurred to me looking at my own work:

**The illustrations.** The first round called the glossy pseudo-3D renders "the
single biggest failure — the most obviously AI-generated element on the canvas".
It was right. They were rebuilt as a single engraved line system: one contour
weight, one detail weight, strict side elevation, every subject standing on the
same ground rule at the same length, hatching rationed to liquid seen through
glass, and a level-of-detail ladder so a drawing degrades to a clean pictogram
at 38px instead of a smear. Later rounds pushed further: the line now swells
along the shadowed edge, the way a gouge widens where the blade digs in, because
a perfectly uniform stroke around every object is the clearest sign no hand was
involved.

**The typeface.** Three separate rounds flagged the money typography. Measuring
settled it: Instrument Serif's figures are proportional — its "1" is 54% the
width of its "0" (13.8pt vs 7.5pt at 30pt) — so no column of amounts set in it
could ever align on the comma, and hand-tabularising it with fixed cells left
the "1"s rattling in their boxes. The whole system moved to Newsreader, one
family with an optical-size axis and figures that are uniform width by
construction. The mono was dropped entirely; a default coder mono is a signature
of machine-made work and the two remaining faces cover every job it held.

**The comanda.** Round ten's best note was not a defect at all: "nothing here is
specific — no paper grain, no thermal-receipt reference, no *comanda*
vernacular." The design was tasteful in general, which is to say it could have
been for a hotel or a wine shop. The bill in the thread became the slip a
Brazilian bar actually runs on: a four-digit number, a perforated edge, dot
leaders running from the name to the figure, a total ruled off the way a printed
tab rules it off.

**Colour.** Two rounds pulled in opposite directions — "four reds, cut to one"
and "zero semantic colour on the states that decide whether someone pays". Both
were right about the same thing. The oxblood now buys state (open, unpaid,
without an owner) and the primary action is a slab of ink: still the heaviest
object on the page by mass, without spending the only colour in the system on
the word "dividir".

Also from the loop: the stock success-green deleted; small-caps eyebrows cut
from six per screen to one spec used twice; two radii in the whole file; the
chat furniture (bubble, camera glyph, round send button) removed in favour of
two voices told apart by typeface; a real scroll fade instead of content sliced
through a price; the grid's outer margin set above its gutter; the currency
mark's advance reserved on every row so a total sits on the column its own items
make.

## The fourteenth round: changing the form instead of refining it

Five separate rounds had called the illustrations the weakest asset and the
clearest tell of a machine. The engraved line system answered that by tightening
the line — one weight, one horizon, one viewpoint — and it was better, and it
was still a line drawing. Which is the point: an even, uniform contour is what a
generator reaches for by default, so an even, uniform contour is what a machine
looks like.

So the last round changed the form. **Xilogravura** — the woodcut of Brazilian
cordel, the pamphlet literature sold at fairs in the Northeast. That inverts the
whole operation. A subject is a solid mass of ink. Detail is not added to it in
black, it is *removed* from it in white, because a gouge takes ink away. Tone is
a run of chunky parallel cuts, not fine hatching. The contour is faceted, because
a blade travels in straight pushes and the block chips where it turns. And the
ink never lays down perfectly, so a little of the paper comes through.

It is also the right form for this product and not merely a different one: a bar
tab in Brazil belongs to the same world of cheap, everyday printed paper as a
cordel cover does. The previous set could have been drawn for a hotel in
Copenhagen. This one could not.

The critic's read changed accordingly. Where earlier rounds had called the
drawings "generic monoline food icons — exactly the default output of a prompt",
the round after the woodcut called them "true linocut" and complained only that
two of the fourteen did not yet match the grammar. That is a much narrower
problem than the one it replaced.

## Where it stopped

The critic never reached 9/10. Scores ran 5.5 → 6 → 6 → 6 → 5.5 → 6 → 5.5 → 6 →
6 → 5.5 → 6 → 6 → 6 → **6.5**, across fourteen rounds — the last, after the
woodcut and the craft pass that followed it, the highest of the run.

That pattern is worth being honest about rather than grinding against. Reading
the transcripts together, three things are going on:

1. **Real, fixable defects** — most of the list above. The loop found these
   reliably and they are fixed.

2. **Contradictions between rounds.** Round 8 asked for the currency mark to
   hang outside the numeric column; round 9 called the resulting gutter ragged.
   Round 6 asked the accent to recur through the system; round 9 called that
   "four reds". Round 5 asked the presentation board to break its metronome;
   round 6 called the resulting unequal frames sloppy. Each note is defensible;
   they cannot all be satisfied at once, and chasing each new one in turn walks
   in a circle.

3. **Claims that are not true of the artifact.** Later rounds assert the figures
   are not tabular (they are, by construction, and it is measurable), that the
   ledger columns are set in a sans (they are the serif), and that the `R$` has
   four treatments (it has one rule, applied proportionally, plus one deliberate
   optical compensation at display size). A critic reading a downscaled
   screenshot of four phone screens at once will misread fine type, and it
   scores what it thinks it sees.

There is also a floor that a screenshot-only loop cannot get under. Every round
from the third onward independently identified the genre — cream ground,
editorial serif, hairline rules, one wine accent — as "the most-generated
aesthetic in existence". That judgement is about the category, not the
execution, and it caps the score no matter how well the category is executed.
Escaping it means changing the aesthetic, not refining it — and the aesthetic
was the brief.

## What I would do next, with a human in the loop

- Finish the woodcut set. Two of the fourteen blocks (the place setting and the
  fish) still read at a different level of abstraction from the rest, which the
  last round named exactly. A human cutting these would fix that in an afternoon.
- The relief form is much darker than the line form. Nobody has yet looked at it
  on a phone in a dark bar at low brightness, which is the environment this
  product was designed for, and it is the one check a screenshot cannot make.
- Decide the currency-mark question once, with someone who can look at a phone
  rather than a contact sheet. It is the single most re-litigated detail here.
- Test the ink ramp in an actual dark bar. Two rounds called the quiet greys
  below the legibility floor; two others called the same values well-judged. A
  screenshot cannot settle that and a phone at 15% brightness can.
