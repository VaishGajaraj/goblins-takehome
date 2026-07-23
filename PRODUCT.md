# Product notes: a walkthrough of the grader as it stands

_Initial audit: 2026-07-20; focused follow-up: 2026-07-22. I re-read the brief, went through the entire workflow on the
deployed app the way a teacher and a student would, and did a fresh-context
code review of every client page. Below: what works, what's broken or
missing, and what the next sprint would be if this were a real product.
Following the brief's premium on scoping, the initial findings were documented
before a focused follow-up shipped the highest-impact trust and recovery fixes._

## The workflow today (all verified live)

Teacher: lands → drafts problems with the model from a topic (or loads the
sample, or writes their own) → gets an editable AI rubric per problem, a big
join code, and a private report URL. Student: enters the code → bad codes
dead-end before a name form; real ones greet them with the assignment title →
draws on the whiteboard → 202'd submission, goblin waiting state, score
reveal with per-criterion checkmarks and warm feedback → try-again (bounded)
or next → per-problem recap and celebratory finish with the Goblins CTA.
Teacher's grid fills live with scores and class averages; clicking any result
opens the student's validated PNG, criterion-level decision, feedback, and
full attempt history. Everything server-side persists; students resume from
any device with code + name, and teachers can reopen assignments created in
the current browser from the landing page.

## Remaining issues

### Bugs and dead ends

1. **Double-draft:** hitting Enter while a draft is in flight appends a second
   batch. Guard on `drafting`.
2. Rubric editor: saved-but-untrimmed criteria leave the Save button enabled;
   poll errors after first load freeze the teacher grid silently (needs a
   "reconnecting…" chip); empty number inputs coerce to 0 with no message;
   a cleared localStorage mid-session can throw on submit instead of
   redirecting to rejoin.

### Student experience

3. Draft work still does not survive a full page refresh. Retry within the
   current session preserves the editable scene, but refresh persistence needs
   an explicit local-storage/privacy decision.
4. Mid-assignment you can't revisit past scores, although the finish screen
   now includes a per-problem recap.
5. Error states show raw exception strings to seven-year-olds; the whiteboard
   at 52vh forces scrolling on short Chromebook screens; tablet keyboards pop
   from autofocus.

### Growth & polish

6. **No QR / print view for the join code** — projecting a QR is how
    classrooms actually join things, and it's a one-day feature.
7. No teacher→teacher share ("send this grader to a colleague") — the CTA
    loop covers teacher→Goblins but not the viral edge the brief cares about.
8. Static assets ship without cache headers, so the ~1MB Excalidraw chunk
    revalidates on slow school networks; prefetching it during the join
    screen would hide the load entirely.
9. Accessibility pass: `aria-live` on the
    waiting/reveal states, `prefers-reduced-motion` for the goblin wiggle,
    table header scopes.

## Fixed in focused follow-up

- **Join limiter vs school NAT:** 30 kids joining at the bell from one shared
  IP = ~60 limiter hits/min (code check + join), exactly the old default cap —
  real classes would have hit 429s at the door. Default raised to 240/min
  (enumeration still throttled; the daily cap remains the budget backstop).
- **Teacher auditability:** every populated report cell now opens the submitted
  whiteboard beside its status, score, feedback, and criterion-level decision;
  teachers can switch across the complete attempt history. The endpoint is
  scoped by the teacher secret and validates the image path and PNG before
  returning it.
- **Assignment recovery and sharing:** the landing page safely restores and
  deduplicates assignments created in that browser. The join URL is always a
  selectable field, and clipboard failures fall back to manual copy.
- **Student revision:** retry restores the editable Excalidraw scene in the
  current session, and completion now includes a per-problem recap.
- **Latest-attempt correctness:** student and teacher queries break same-second
  timestamp ties by attempt number.

## Next sprint, in order

1. Expand the grading eval with teacher-scored, representative student work
   across handwriting styles, domains, and repeated model runs.
2. Add refresh-safe draft preservation with an explicit retention/privacy rule.
3. Add kid-friendly errors and mid-assignment score review.
4. Add QR/print join, cache headers, and Excalidraw prefetch.
5. Add colleague sharing and finish the accessibility pass.
6. Clear the remaining editor and polling edge cases.

The follow-up deliberately prioritized teacher trust and student momentum over
adding more surface area. The next release decision should be driven by the
expanded real-work accuracy evaluation, not another UI feature.
