# Product notes: a walkthrough of the grader as it stands

_2026-07-20. I re-read the brief, then went through the entire workflow on the
deployed app the way a teacher and a student would — plus a fresh-context code
review of every client page. This is the honest result: what works, what's
broken or missing, and what the next sprint would be if this were a real
product. Per the brief's ask to scope under a time budget, these are
documented rather than built; the one exception is a config fix (join rate
limit vs school NAT) small and severe enough to ship immediately._

## The workflow today (all verified live)

Teacher: lands → drafts problems with the model from a topic (or loads the
sample, or writes their own) → gets an editable AI rubric per problem, a big
join code, and a private report URL. Student: enters the code → bad codes
dead-end before a name form; real ones greet them with the assignment title →
draws on the whiteboard → 202'd submission, goblin waiting state, score
reveal with per-criterion checkmarks and warm feedback → try-again (bounded)
or next → celebratory finish with the Goblins CTA. Teacher's grid fills live
with scores, class averages per problem, needs-review flags with one-click
regrade. Everything server-side persists; students resume from any device
with code + name.

## Issues found

### Bugs & traps (small, real, fix-first)

1. **The teacher's secret URL is a trap.** We remember created assignments in
   localStorage (`CreateAssignment.tsx`) but no screen ever reads it back —
   close the tab without bookmarking and the report is unreachable. Fix: a
   "Your assignments" list on the landing page. (Top of the one-liner batch.)
2. **Copy-link button can crash.** `navigator.clipboard` is undefined on
   non-HTTPS origins (school LANs) and the call has no catch. Fix: selectable
   input fallback.
3. **Double-draft:** hitting Enter while a draft is in flight appends a second
   batch. Guard on `drafting`.
4. Rubric editor: saved-but-untrimmed criteria leave the Save button enabled;
   poll errors after first load freeze the teacher grid silently (needs a
   "reconnecting…" chip); empty number inputs coerce to 0 with no message;
   a cleared localStorage mid-session can throw on submit instead of
   redirecting to rejoin.

### Teacher trust (the gap that matters most)

5. **Teachers can't see the student's actual work.** The PNG is stored
   server-side but no endpoint serves it, and the grid shows criteria to
   students only (teachers get a hover tooltip with feedback text — invisible
   on tablets). For a *grading* product, "click the cell, see the whiteboard
   next to the rubric breakdown" is the trust feature. This is the first
   thing I'd build next.
6. Attempt history is invisible — the grid shows the latest attempt only, no
   "attempt 2 of 3" marker.

### Student experience

7. **Try-again wipes the drawing.** The board clears on submit, so a kid who
   missed one criterion redraws everything. Snapshot the scene pre-submit and
   restore it on retry; persist scenes in localStorage so a refresh
   mid-drawing doesn't lose work either.
8. **No recap.** Mid-assignment you can't revisit past scores, and the finish
   screen shows a total but not the per-problem list it already computes —
   and "grades still cooking" never re-polls.
9. Error states show raw exception strings to seven-year-olds; the whiteboard
   at 52vh forces scrolling on short Chromebook screens; tablet keyboards pop
   from autofocus.

### Growth & polish

10. **No QR / print view for the join code** — projecting a QR is the real
    classroom join ritual, and it's a one-day feature.
11. No teacher→teacher share ("send this grader to a colleague") — the CTA
    loop covers teacher→Goblins but not the viral edge the brief cares about.
12. Static assets ship without cache headers, so the ~1MB Excalidraw chunk
    revalidates on slow school networks; prefetching it during the join
    screen would hide the load entirely.
13. Accessibility pass: aria-labels on icon buttons, `aria-live` on the
    waiting/reveal states, `prefers-reduced-motion` for the goblin wiggle,
    table header scopes.

### Fixed now (too severe to leave)

- **Join limiter vs school NAT:** 30 kids joining at the bell from one shared
  IP = ~60 limiter hits/min (code check + join), exactly the old default cap —
  real classes would have hit 429s at the door. Default raised to 240/min
  (enumeration still throttled; the daily cap remains the budget backstop).

## Next sprint, in order

1. **Teacher submission viewer** — image + per-criterion breakdown + attempt
   history in a click-open modal (issues 5, 6). The trust product is this.
2. **"Your assignments" on landing + copy-link fallback** (1, 2) — kills the
   worst dead end.
3. **Drawing preservation** — retry restore + refresh survival (7).
4. **Student recap + finish polish + kid-friendly errors** (8, 9).
5. **QR join + cache headers + Excalidraw prefetch** (10, 12).
6. One-liner batch (3, 4, 11, 13).

Everything above is scoped so 1–3 fit one focused day; none require schema
changes (the data for all of it is already stored).
