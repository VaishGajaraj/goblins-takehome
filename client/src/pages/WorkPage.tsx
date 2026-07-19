import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  ApiError,
  getSubmission,
  joinClass,
  storedStudent,
  submitWork,
  type CriteriaHit,
  type JoinResult,
  type ProblemForStudent,
  type SubmissionForStudent
} from "../api"
import type { WhiteboardHandle } from "./Whiteboard"

const Whiteboard = lazy(() => import("./Whiteboard"))

type Phase =
  | { kind: "loading" }
  | { kind: "drawing"; problem: ProblemForStudent; attempt: number }
  | { kind: "waiting"; problem: ProblemForStudent; submissionId: string; sinceMs: number }
  | { kind: "reveal"; problem: ProblemForStudent; score: number; feedback: string; criteriaHits: CriteriaHit[] | null; attemptsLeft: number; failed?: boolean }
  | { kind: "done" }
  | { kind: "error"; message: string }

const GOBLIN_WAIT_LINES = [
  "The goblin is squinting at your work…",
  "Checking every step twice…",
  "Consulting the rubric scroll…",
  "Counting on green fingers…"
]

export function WorkPage() {
  const { code = "" } = useParams()
  const navigate = useNavigate()
  const [joined, setJoined] = useState<Extract<JoinResult, { kind: "joined" }> | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [board, setBoard] = useState<WhiteboardHandle | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [totals, setTotals] = useState<Map<string, SubmissionForStudent>>(new Map())
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const waitLine = useMemo(() => GOBLIN_WAIT_LINES[Math.floor(Math.random() * GOBLIN_WAIT_LINES.length)], [phase.kind])

  const ATTEMPT_CAP = 3

  // latest submission per problem
  const applySubmissions = (subs: SubmissionForStudent[]) => {
    const m = new Map<string, SubmissionForStudent>()
    for (const s of subs) m.set(s.problemId, s)
    setTotals(m)
    return m
  }

  const nextProblem = useCallback(
    (problems: ProblemForStudent[], latest: Map<string, SubmissionForStudent>): Phase => {
      for (const p of [...problems].sort((a, b) => a.position - b.position)) {
        const s = latest.get(p.id)
        if (!s) return { kind: "drawing", problem: p, attempt: 1 }
        if (s.status === "queued" || s.status === "grading") {
          return { kind: "waiting", problem: p, submissionId: s.id, sinceMs: Date.now() }
        }
        if (s.status === "failed" && s.attempt < ATTEMPT_CAP) {
          return { kind: "drawing", problem: p, attempt: s.attempt + 1 }
        }
        // graded (or failed at cap) → move on
      }
      return { kind: "done" }
    },
    []
  )

  // join/resume on mount
  useEffect(() => {
    const stored = storedStudent.get(code.toUpperCase())
    if (!stored) {
      navigate(`/join/${code}`)
      return
    }
    void joinClass(code.toUpperCase(), stored.name, "resume")
      .then((res) => {
        if (res.kind !== "joined") {
          navigate(`/join/${code}`)
          return
        }
        setJoined(res)
        const latest = applySubmissions(res.submissions)
        setPhase(nextProblem(res.problems, latest))
      })
      .catch((e) => setPhase({ kind: "error", message: String(e) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  // poll while waiting, with backoff 1s→2s→4s
  useEffect(() => {
    if (phase.kind !== "waiting" || !joined) return
    let delay = 1000
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      try {
        const s = await getSubmission(phase.submissionId)
        if (s.status === "graded" && s.score !== null) {
          const latest = new Map(totals)
          latest.set(s.problemId, { ...s, problemId: s.problemId })
          setTotals(latest)
          setPhase({
            kind: "reveal",
            problem: phase.problem,
            score: s.score,
            feedback: s.feedback ?? "",
            criteriaHits: s.criteriaHits,
            attemptsLeft: Math.max(0, ATTEMPT_CAP - s.attempt)
          })
          return
        }
        if (s.status === "failed") {
          const latest = new Map(totals)
          latest.set(s.problemId, { ...s, problemId: s.problemId })
          setTotals(latest)
          setPhase({
            kind: "reveal",
            problem: phase.problem,
            score: 0,
            feedback: "The goblin needs another look at this one — it'll be flagged for your teacher. Keep going!",
            criteriaHits: null,
            attemptsLeft: Math.max(0, ATTEMPT_CAP - s.attempt),
            failed: true
          })
          return
        }
      } catch {
        // transient poll error — keep trying
      }
      delay = Math.min(delay * 2, 4000)
      pollTimer.current = setTimeout(() => void tick(), delay)
    }
    pollTimer.current = setTimeout(() => void tick(), delay)
    return () => {
      cancelled = true
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind === "waiting" ? (phase as { submissionId: string }).submissionId : ""])

  const submit = async () => {
    if (phase.kind !== "drawing" || !board || !joined) return
    setSubmitting(true)
    setNotice(null)
    const stored = storedStudent.get(code.toUpperCase())
    try {
      const blob = await board.exportPng()
      if (!blob) {
        setNotice("Show your work on the whiteboard first — the goblin wants to see your thinking!")
        setSubmitting(false)
        return
      }
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve((r.result as string).split(",", 2)[1] ?? "")
        r.onerror = () => reject(new Error("could not read image"))
        r.readAsDataURL(blob)
      })
      const res = await submitWork(stored!.studentId, phase.problem.id, base64)
      board.clear()
      setPhase({ kind: "waiting", problem: phase.problem, submissionId: res.submissionId, sinceMs: Date.now() })
    } catch (e) {
      if (e instanceof ApiError && e.tag === "QueueFullError") {
        setNotice("The goblins are swamped right now — hang on, retrying in a few seconds…")
        setTimeout(() => {
          setNotice(null)
          void submit()
        }, 8000)
        return // keep submitting=true so the button stays disabled during auto-retry
      } else if (e instanceof ApiError && e.tag === "AttemptLimitError") {
        setNotice(e.message)
        if (joined) setPhase(nextProblemAfter(phase.problem))
      } else if (e instanceof ApiError && e.tag === "PausedError") {
        setNotice(e.message)
      } else {
        setNotice(`Something went wrong: ${String(e)}. Your drawing is still here — try submitting again.`)
      }
      setSubmitting(false)
      return
    }
    setSubmitting(false)
  }

  const nextProblemAfter = (current: ProblemForStudent): Phase => {
    if (!joined) return { kind: "done" }
    const later = joined.problems
      .filter((p) => p.position > current.position)
      .sort((a, b) => a.position - b.position)
    for (const p of later) {
      const s = totals.get(p.id)
      if (!s || (s.status === "failed" && s.attempt < ATTEMPT_CAP)) {
        return { kind: "drawing", problem: p, attempt: s ? s.attempt + 1 : 1 }
      }
      if (s.status === "queued" || s.status === "grading") {
        return { kind: "waiting", problem: p, submissionId: s.id, sinceMs: Date.now() }
      }
    }
    return { kind: "done" }
  }

  if (phase.kind === "loading") return <div className="card"><p className="soft">Loading…</p></div>
  if (phase.kind === "error") {
    return (
      <div className="card">
        <h1>Hmm.</h1>
        <p className="soft">{phase.message}</p>
        <Link to={`/join/${code}`}>Rejoin the class</Link>
      </div>
    )
  }
  if (!joined) return null

  const problemCount = joined.problems.length
  const gradedScores = joined.problems.map((p) => {
    const s = totals.get(p.id)
    return s?.status === "graded" && s.score !== null ? { got: s.score, max: p.maxPoints } : null
  })

  if (phase.kind === "done") {
    const got = gradedScores.reduce((a, s) => a + (s?.got ?? 0), 0)
    const max = joined.problems.reduce((a, p) => a + p.maxPoints, 0)
    const gradedAll = gradedScores.every((s) => s !== null)
    return (
      <div className="card" style={{ textAlign: "center" }}>
        <span style={{ fontSize: "3rem" }} aria-hidden>🧌🎉</span>
        <h1>You did it, {joined.studentName}!</h1>
        <p>
          {gradedAll
            ? `${got} out of ${max} points on "${joined.assignmentTitle}".`
            : `Your work on "${joined.assignmentTitle}" is in — some grades are still cooking.`}
        </p>
        <p className="soft">
          Every step you showed helps you learn. Ask your teacher about anything that surprised you!
        </p>
      </div>
    )
  }

  const header = (
    <div className="row" style={{ justifyContent: "space-between", marginBottom: "0.5rem" }}>
      <strong>
        Problem {phase.problem.position + 1} of {problemCount}
      </strong>
      <span className="soft">
        {joined.studentName} · {joined.assignmentTitle}
      </span>
    </div>
  )

  if (phase.kind === "waiting") {
    return (
      <div className="card" style={{ textAlign: "center" }}>
        {header}
        <span style={{ fontSize: "2.6rem" }} className="wiggle" aria-hidden>🧌</span>
        <h2>{waitLine}</h2>
        <p className="soft">Your work is in — the score pops up here in a moment.</p>
      </div>
    )
  }

  if (phase.kind === "reveal") {
    return (
      <div className="card">
        {header}
        <div style={{ textAlign: "center", margin: "0.75rem 0" }}>
          <span style={{ fontSize: "2.2rem" }} aria-hidden>{phase.failed ? "🧌❓" : phase.score === phase.problem.maxPoints ? "🧌🌟" : "🧌"}</span>
          <h1 style={{ margin: "0.25rem 0" }}>
            {phase.failed ? "We'll sort this one out" : `${phase.score} / ${phase.problem.maxPoints}`}
          </h1>
          <p style={{ maxWidth: 520, margin: "0.5rem auto" }}>{phase.feedback}</p>
        </div>
        {phase.criteriaHits && (
          <ul style={{ listStyle: "none", padding: 0, maxWidth: 520, margin: "0 auto 1rem" }}>
            {phase.criteriaHits.map((c, i) => (
              <li key={i} className="row" style={{ padding: "0.2rem 0" }}>
                <span aria-hidden>{c.met ? "✅" : "▫️"}</span>
                <span className="grow">{c.criterion}</span>
                <span className="soft">{c.pointsAwarded} pts</span>
              </li>
            ))}
          </ul>
        )}
        <div className="row" style={{ justifyContent: "center" }}>
          {!phase.failed && phase.attemptsLeft > 0 && phase.score < phase.problem.maxPoints && (
            <button
              className="ghost"
              onClick={() => setPhase({ kind: "drawing", problem: phase.problem, attempt: ATTEMPT_CAP - phase.attemptsLeft + 1 })}
            >
              Try again ({phase.attemptsLeft} left)
            </button>
          )}
          <button onClick={() => setPhase(nextProblemAfter(phase.problem))}>Next →</button>
        </div>
      </div>
    )
  }

  // drawing
  return (
    <div>
      <div className="card">
        {header}
        <p style={{ fontSize: "1.05rem", margin: "0.25rem 0 0" }}>{phase.problem.statement}</p>
        <p className="soft" style={{ margin: "0.25rem 0 0" }}>
          Worth {phase.problem.maxPoints} points · attempt {phase.attempt} of {ATTEMPT_CAP} · show your steps!
        </p>
      </div>
      {notice && <div className="error-banner">{notice}</div>}
      <div className="card">
        <Suspense fallback={<div className="empty">Rolling out the whiteboard…</div>}>
          <Whiteboard onReady={setBoard} />
        </Suspense>
        <div className="row" style={{ marginTop: "0.75rem", justifyContent: "flex-end" }}>
          <button onClick={() => void submit()} disabled={!board || submitting}>
            {submitting ? "Sending to the goblin…" : "Submit my work"}
          </button>
        </div>
      </div>
    </div>
  )
}
