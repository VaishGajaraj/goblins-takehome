import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams } from "react-router-dom"
import {
  getTeacherSubmission,
  getTeacherView,
  regradeFailed,
  updateRubric,
  type Rubric,
  type SubmissionSummary,
  type TeacherSubmissionAttempt,
  type TeacherSubmissionDetail,
  type TeacherView
} from "../api"

type InspectorState =
  | { kind: "loading"; id: string }
  | { kind: "ready"; id: string; detail: TeacherSubmissionDetail }
  | { kind: "error"; id: string; message: string }

function SubmissionInspector(props: { detail: TeacherSubmissionDetail; onClose: () => void }) {
  const initial =
    props.detail.attempts.find((attempt) => attempt.id === props.detail.selectedSubmissionId) ??
    props.detail.attempts.at(-1)
  const [selectedId, setSelectedId] = useState(initial?.id ?? "")
  const selected = props.detail.attempts.find((attempt) => attempt.id === selectedId) ?? initial

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [props])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) props.onClose()
      }}
    >
      <section className="submission-modal" role="dialog" aria-modal="true" aria-labelledby="submission-title">
        <div className="row modal-heading">
          <div className="grow">
            <h2 id="submission-title">
              {props.detail.student.name} · Problem {props.detail.problem.position + 1}
            </h2>
            <p className="soft">{props.detail.problem.statement}</p>
          </div>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close submission details">✕</button>
        </div>

        {props.detail.attempts.length > 1 && (
          <div className="row attempt-tabs" aria-label="Attempts">
            {props.detail.attempts.map((attempt) => (
              <button
                className={attempt.id === selected?.id ? "subtle" : "ghost"}
                key={attempt.id}
                onClick={() => setSelectedId(attempt.id)}
              >
                Attempt {attempt.attempt}
              </button>
            ))}
          </div>
        )}

        {selected ? (
          <AttemptReview attempt={selected} maxPoints={props.detail.problem.maxPoints} />
        ) : (
          <div className="empty">No attempt details are available.</div>
        )}
      </section>
    </div>
  )
}

function AttemptReview(props: { attempt: TeacherSubmissionAttempt; maxPoints: number }) {
  const { attempt } = props
  return (
    <div className="submission-review">
      <div className="work-preview">
        <h3>Student work</h3>
        {attempt.imageBase64 ? (
          <img src={`data:image/png;base64,${attempt.imageBase64}`} alt={`Submitted work, attempt ${attempt.attempt}`} />
        ) : (
          <div className="empty">The submitted image is unavailable.</div>
        )}
      </div>
      <div className="grade-detail">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Grade details</h3>
          <span className={`badge ${attempt.status}`}>{attempt.status}</span>
        </div>
        {attempt.score !== null && (
          <div className="inspector-score">{attempt.score} / {props.maxPoints}</div>
        )}
        {attempt.feedback && <p>{attempt.feedback}</p>}
        {attempt.criteriaHits && attempt.criteriaHits.length > 0 && (
          <ul className="criteria-list">
            {attempt.criteriaHits.map((criterion, index) => (
              <li className="row" key={`${criterion.criterion}:${index}`}>
                <span aria-hidden>{criterion.met ? "✓" : "–"}</span>
                <span className="grow">{criterion.criterion}</span>
                <strong>{criterion.pointsAwarded} pts</strong>
              </li>
            ))}
          </ul>
        )}
        <p className="soft inspector-time">
          Submitted {new Date(attempt.createdAt * 1000).toLocaleString()}
        </p>
      </div>
    </div>
  )
}

function RubricEditor(props: {
  secret: string
  problemId: string
  maxPoints: number
  rubric: Rubric
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<Rubric>(props.rubric.map((c) => ({ ...c })))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = JSON.stringify(draft) !== JSON.stringify(props.rubric)
  const sum = draft.reduce((a, c) => a + (Number.isFinite(c.points) ? c.points : 0), 0)
  const sumOk = sum === props.maxPoints
  const allValid = draft.length > 0 && draft.every((c) => c.criterion.trim().length > 0 && c.points > 0)

  const setRow = (i: number, patch: Partial<Rubric[number]>) =>
    setDraft((r) => r.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await updateRubric(props.secret, props.problemId, draft.map((c) => ({ ...c, criterion: c.criterion.trim() })))
      props.onSaved()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="stack" style={{ marginTop: "0.5rem" }}>
      {draft.map((c, i) => (
        <div className="rubric-row" key={i}>
          <input
            type="text"
            value={c.criterion}
            aria-label={`Criterion ${i + 1}`}
            onChange={(e) => setRow(i, { criterion: e.target.value })}
          />
          <input
            type="number"
            min={1}
            max={100}
            value={c.points}
            aria-label={`Points for criterion ${i + 1}`}
            onChange={(e) => setRow(i, { points: Number(e.target.value) })}
          />
          <button
            className="danger-ghost"
            title="Remove criterion"
            disabled={draft.length === 1}
            onClick={() => setDraft((r) => r.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="row">
        <button
          className="ghost"
          onClick={() => setDraft((r) => [...r, { criterion: "", points: 1 }])}
          disabled={draft.length >= 10}
        >
          + Criterion
        </button>
        <span className={`points-sum ${sumOk ? "" : "bad"}`}>
          {sum} / {props.maxPoints} pts{sumOk ? "" : " — should add up to max points"}
        </span>
        <div className="grow" />
        {error && <span className="points-sum bad">{error}</span>}
        <button onClick={save} disabled={!dirty || !allValid || saving}>
          {saving ? "Saving…" : "Save rubric"}
        </button>
      </div>
    </div>
  )
}

export function TeacherPage() {
  const { secret = "" } = useParams()
  const [view, setView] = useState<TeacherView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [inspector, setInspector] = useState<InspectorState | null>(null)

  const refresh = useCallback(async () => {
    try {
      setView(await getTeacherView(secret))
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [secret])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 5000)
    return () => clearInterval(t)
  }, [refresh])

  const byStudentProblem = useMemo(() => {
    const m = new Map<string, SubmissionSummary>()
    // submissions are ordered by created_at; the latest attempt wins the cell
    for (const s of view?.submissions ?? []) m.set(`${s.studentId}:${s.problemId}`, s)
    return m
  }, [view])

  const problemAverages = useMemo(() => {
    if (!view) return new Map<string, { avg: number; n: number }>()
    const m = new Map<string, { avg: number; n: number }>()
    for (const p of view.problems) {
      const graded = view.students
        .map((st) => byStudentProblem.get(`${st.id}:${p.id}`))
        .filter((s): s is SubmissionSummary => s?.status === "graded" && s.score !== null)
      if (graded.length > 0) {
        m.set(p.id, {
          avg: graded.reduce((a, s) => a + (s.score ?? 0), 0) / graded.length,
          n: graded.length
        })
      }
    }
    return m
  }, [view, byStudentProblem])

  const inspectSubmission = async (id: string) => {
    setInspector({ kind: "loading", id })
    try {
      const detail = await getTeacherSubmission(secret, id)
      setInspector((current) => current?.id === id ? { kind: "ready", id, detail } : current)
    } catch (e) {
      setInspector((current) => current?.id === id ? { kind: "error", id, message: String(e) } : current)
    }
  }

  if (error && !view) {
    return <div className="card"><h1>Hmm.</h1><p className="soft">{error}</p></div>
  }
  if (!view) return <div className="card"><p className="soft">Loading…</p></div>

  const joinUrl = `${window.location.origin}/join/${view.joinCode}`

  return (
    <div>
      <div className="card">
        <h1>{view.title}</h1>
        <p className="soft">
          Students join at <strong>{window.location.host}</strong> with this code — or share the
          direct link. Keep this page's URL private: it's your teacher key, and how you get back
          to this report from any device.
        </p>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <span className="join-code">{view.joinCode}</span>
          <input
            className="share-link"
            value={joinUrl}
            readOnly
            aria-label="Student join link"
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            className="ghost"
            onClick={() => {
              setCopyFailed(false)
              if (!navigator.clipboard) {
                setCopyFailed(true)
                return
              }
              void navigator.clipboard.writeText(joinUrl).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }).catch(() => setCopyFailed(true))
            }}
          >
            {copied ? "Copied!" : "Copy student link"}
          </button>
        </div>
        {copyFailed && <p className="soft">Copy is unavailable here. Select the link above and copy it manually.</p>}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Class report</h2>
          {view.submissions.some((s) => s.status === "failed") && (
            <button
              className="subtle"
              onClick={() => void regradeFailed(secret).then(() => refresh())}
              title="Failed grades get re-queued (each regrade is a model call)"
            >
              Regrade {view.submissions.filter((s) => s.status === "failed").length} failed
            </button>
          )}
        </div>
        {view.students.length === 0 ? (
          <div className="empty">
            <span className="mascot">🧌</span>
            Waiting for your first student… share the code above to get going.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="report">
              <thead>
                <tr>
                  <th>Student</th>
                  {view.problems.map((p) => (
                    <th key={p.id}>P{p.position + 1}</th>
                  ))}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {view.students.map((st) => {
                  let total = 0
                  let anyGraded = false
                  const cells = view.problems.map((p) => {
                    const s = byStudentProblem.get(`${st.id}:${p.id}`)
                    if (s?.status === "graded" && s.score !== null) {
                      total += s.score
                      anyGraded = true
                      return (
                        <td key={p.id} className="num">
                          <button
                            className="report-cell"
                            onClick={() => void inspectSubmission(s.id)}
                            aria-label={`Review ${st.name}'s work for problem ${p.position + 1}`}
                          >
                            {s.score}/{p.maxPoints}
                          </button>
                        </td>
                      )
                    }
                    return (
                      <td key={p.id}>
                        {s ? (
                          <button
                            className="report-cell"
                            onClick={() => void inspectSubmission(s.id)}
                            aria-label={`Review ${st.name}'s work for problem ${p.position + 1}`}
                          >
                            <span className={`badge ${s.status}`}>{s.status}</span>
                          </button>
                        ) : <span className="soft">—</span>}
                      </td>
                    )
                  })
                  return (
                    <tr key={st.id}>
                      <td>{st.name}</td>
                      {cells}
                      <td className="num">{anyGraded ? total : "—"}</td>
                    </tr>
                  )
                })}
                <tr>
                  <td><strong>Class average</strong></td>
                  {view.problems.map((p) => {
                    const a = problemAverages.get(p.id)
                    return (
                      <td key={p.id} className="num soft">
                        {a ? `${a.avg.toFixed(1)}/${p.maxPoints}` : "—"}
                      </td>
                    )
                  })}
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Problems & rubrics</h2>
        <p className="soft">
          The rubric is what the grader follows — tune it until it matches how you'd grade.
        </p>
        <div className="stack">
          {view.problems.map((p) => (
            <div key={p.id} style={{ borderTop: "1px solid var(--line)", paddingTop: "0.75rem" }}>
              <strong>Problem {p.position + 1}</strong> <span className="soft">({p.maxPoints} pts)</span>
              <p style={{ margin: "0.25rem 0 0" }}>{p.statement}</p>
              <RubricEditor
                secret={secret}
                problemId={p.id}
                maxPoints={p.maxPoints}
                rubric={p.rubric}
                onSaved={refresh}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="cta-footer">
        Like this? The full <a href="https://goblinsapp.com" target="_blank" rel="noreferrer">Goblins experience</a>{" "}
        gives your students real-time feedback while they work — this grader is just the beginning.
      </div>

      {inspector?.kind === "loading" && (
        <div className="modal-backdrop">
          <div className="submission-modal empty" role="status">Opening student work…</div>
        </div>
      )}
      {inspector?.kind === "error" && (
        <div className="modal-backdrop" onMouseDown={() => setInspector(null)}>
          <div className="submission-modal" role="alert" onMouseDown={(event) => event.stopPropagation()}>
            <div className="row">
              <p className="grow">Could not open this submission. {inspector.message}</p>
              <button className="ghost" onClick={() => setInspector(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {inspector?.kind === "ready" && (
        <SubmissionInspector
          key={inspector.detail.selectedSubmissionId}
          detail={inspector.detail}
          onClose={() => setInspector(null)}
        />
      )}
    </div>
  )
}
