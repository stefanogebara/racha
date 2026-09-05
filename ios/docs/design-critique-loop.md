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

## Rounds 15–18: a stronger critic, and the reference that changed the sky

The user switched the critic to Fable 5.1 and pointed at air.inc as the
reference. The analysis of that site is in `reference-air-inc.md`; decision #27
records what was taken from it — the *system* (one continuous atmosphere, one
family in several cuts at a 16:1 size ratio, glass layering, a cursive accent for
one phrase, 24px as the unit) and not the sky. Racha's equivalent of Air's sky
is the bar at night: a warm near-black table, and the comanda as the one cream
object because it is the one object that is paper.

The new critic is better in exactly the way that matters: it zooms. It saved
thirteen crops of the board, sampled colours, and did the arithmetic on every
figure before scoring. Its findings were correspondingly harder to argue with.

**Round 15 (6/10).** Its loudest tells were all mine: the identical warm
vignette on all four frames ("the loudest AI tell on the board"), the white
sticker-halo around every woodcut, a half-skeuomorph receipt with CSS sawtooth
edges, three type voices without stated roles, and dot leaders on every row of
every screen. It also found that the home figure (46,15) was summing euros into
reais. The halo turned out to be the paper-coloured separation channel `block()`
strokes around each form — invisible on cream stock, a black outline on dark.
Every mark that takes ink away now erases the canvas (`destination-out`), so the
paper is wherever the ink is not, on any ground. The vignette went; the receipt
went flat; Newsreader went; the leaders stayed only on the comanda; the hub
figure became the friend balance in reais, with one row per racha in that
racha's own currency.

**Round 16 (6/10).** The finding that mattered: the comanda's total was R$ 1,80
short of what the restaurant would print, because the unowned pudim carried no
10% service. That was a money bug, not a design note, and it existed in the Swift
engine too. `SplitResult` now carries `unassignedExtras` — the house's
percentages on what nobody has claimed — and the total on the slip is the total
on the table (`fbac45e`). The rest of the round was finish: two reds of
different hue, five corner radii, currency marks under 8px, the poster buried at
82% of the screen, the chat's polarity inverted (the loud voice was the person,
the quiet one carried the money).

**Round 17 (6/10).** The critic described "arch-top cards" as a decorative
motif overused on three screens. They were a bug: my new radius token `--r:12px`
collided with the device shell's own `--r:56px`, so every card, button and sheet
inside the phone had a 56px radius. Renamed, and the two radii became two radii.
The rest: the same 59,90 as the poster on two consecutive screens (fixed in the
seed — Gui paid the whole beach, so the hub is now a portfolio figure, 98,50,
that visibly equals 158,40 − 59,90); no money action on three of four screens
(each screen now has one: Pagar, Cobrar, Enviar); four button styles (now two:
filled, and text with a hairline); the fish's scales as a second carving
grammar; a Beetle standing in for Lisboa (now the eléctrico).

**Rounds 19–22 (6, 6, 6, 6).** Four more rounds, each a real list, each scored
the same. Round 19 verified two regressions of mine at the pixel (a ghost
button whose label sat at the top because the racha screen overflowed the frame
and the flex column shrank it to 30px; a numeric column broken by a chevron slot
I had reserved 3px too narrow) — both fixed at the root. It also asked for the
one thing this product must never bury: the 10% is optional by law, and the
control had drifted into a sub-row. It is a visible button now, and the
suggestion chips answer the question the agent actually asked. Rounds 20–22 kept
finding things — a hero and a CTA that disagreed on the hub, "sem dono" typeset
as neutral one round after the previous round had asked me to take the red off
it, a sheet without elevation, content under the home indicator — and each fix
held. The score did not move.

By round 20 this critic had also begun to contradict itself across rounds, the
way the first one had: round 16 asked for a status bar so the frame would be
honest; round 21 called the status bar "presentation cosplay". Round 17 called
the text-link suggestions "indistinguishable from body copy" and asked for
pills; round 21 called the pills the chat template. Round 18 wanted "quite" in
the amount slot; round 21 wanted it left; round 22 wanted it centred. Round 18
asked for the red to come off "sem dono"; round 19 said the most actionable
state was typeset as neutral. Round 20 praised the hero illustration as one of
the two ownable assets; round 22 asked to shrink it to a 40px mark. None of
these notes is wrong on its own. Together they are a critic with no memory
re-deciding taste questions each round, and a score that measures the distance
to a bar — a Koto or Porto Rocha deliverable — that a code-drawn prototype in a
headless browser does not reach by iterating.

## Where it stopped

Neither critic reached 9/10.

| critic | rounds | scores |
|---|---|---|
| Opus 4.6 | 1–14 | 5.5 → 6 → 6 → 6 → 5.5 → 6 → 5.5 → 6 → 6 → 5.5 → 6 → 6 → 6 → 6.5 |
| Fable 5.1 | 15–22 | 6 → 6 → 6 → 6 → 6 → 6 → 6 → 6 |

That pattern is worth being honest about rather than grinding against. Reading
all twenty-two transcripts together, four things are going on:

1. **Real, fixable defects.** Most of both lists. The loop found these reliably
   — including three money bugs a design review had no business catching (euros
   summed into reais; a "settled" racha with no settling payment; the unowned
   pudim carrying no service, so the slip's total was R$ 1,80 short of the
   restaurant's) — and they are fixed, in the prototype and in the Swift engine.

2. **Contradictions between rounds.** Listed above for both critics. Each note
   is defensible; they cannot all be satisfied at once, and chasing each new one
   in turn walks in a circle. This is structural: a critic with no memory
   re-litigates every taste decision from scratch.

3. **Claims that are not true of the artifact.** The first critic misread fine
   type on a downscaled board. The second zoomed and measured, and was almost
   never wrong about what was on the screen — but it was sometimes wrong about
   intent, and a reader cannot tell the difference, so those were fixed too.

4. **Two blockers that no round of pixel work moves.** Every Fable round named
   the pictogram set as "a collection, not a family" — and it is right that
   fourteen recipes drawn in code do not have one hand the way a set an
   illustrator cut in an afternoon would. And several rounds named the
   conversation itself — a person's line, an agent's answer, suggestions, a
   prompt — as "the chat template"; the conversation is the brief. The first is
   a commission. The second is a decision the brief already made.

The score is not the useful output of this loop. The lists are. Twenty-two
rounds of them produced most of what is good about the current design and
caught three money bugs; that is a good return on a critic that costs five
minutes a round. It is also the argument for stopping at a plateau instead of
running it forever: from round 19 on, the marginal round found a 4px edge and a
three-period ellipsis, and re-decided the chips.

## What I would do next, with a human in the loop

- **Commission the pictogram set.** Fourteen blocks, one hand, one grid, the
  ground line as the motif. The woodcut grammar in `food.js` (solid mass, gouges
  that erase, one hatch, faceted contour) is the brief for the illustrator, and
  the recipes are the reference — but the set needs a person. This is the
  single item every round of the second critic put first.
- **Look at it on a phone in a bar.** The night palette was chosen for an OLED
  at 15% brightness in a dark room. Nobody has looked at cream at 62% on umbra
  there. It is the one check a screenshot cannot make, and two rounds guessed
  opposite answers to it.
- **Decide what the hub is.** The second critic said twice, correctly and
  outside its brief, that this board is a friends' ledger — Lisboa, Praia,
  euros, "Pagar pro Gui" — and that peer-to-peer settlement is exactly the
  fund flow the pay-at-table product avoids. The iOS brief asked for the
  friends' app; the repo's strategy is the table. The two can share a
  conversation, a comanda and a woodcut. They cannot share a first screen.
- **Compile it.** The Swift side now carries the night palette, Archivo in three
  widths and the flat ground as tokens (`Palette.swift`, `Typography.swift`,
  `Racha.metal`), with the old names mapped so the views still build. Nothing
  here has seen a compiler; `verification.md` says what to run.
