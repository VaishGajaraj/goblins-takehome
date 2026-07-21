import { useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { ApiError, createAssignment, draftProblems, type ProblemInput } from "../api"

const SAMPLE: { title: string; problems: ProblemInput[] } = {
  title: "Fractions check-in",
  problems: [
    { statement: "Ella has 3/4 of a pizza. She eats 1/2 of what she has. What fraction of the whole pizza did she eat? Show your work.", maxPoints: 10 },
    { statement: "Compute 2/3 + 1/6. Show each step and simplify your answer.", maxPoints: 10 },
    { statement: "Which is bigger: 5/8 or 2/3? Explain how you know without a calculator.", maxPoints: 10 },
    { statement: "A recipe needs 1/3 cup of sugar per batch. How much sugar do you need for 4 batches? Draw or write your reasoning.", maxPoints: 10 }
  ]
}

const TOPIC_CHIPS = [
  "Adding fractions",
  "Subtraction within 20",
  "Multiplication word problems",
  "Long division",
  "Comparing decimals",
  "Area & perimeter"
]

const GRADES = ["", "grades K-2", "grades 3-5", "grades 6-8"]

/** Remember created assignments locally so a teacher can find them again from this browser. */
const rememberAssignment = (entry: { title: string; teacherSecret: string }) => {
  try {
    const key = "goblins.teacherAssignments"
    const prev = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown[]
    localStorage.setItem(key, JSON.stringify([...prev, { ...entry, at: Date.now() }]))
  } catch {
    // localStorage unavailable — persistence still works via the teacher link
  }
}

export function CreateAssignment() {
  const navigate = useNavigate()
  const [title, setTitle] = useState("")
  const [problems, setProblems] = useState<ProblemInput[]>([{ statement: "", maxPoints: 10 }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // AI drafting
  const [topic, setTopic] = useState("")
  const [grade, setGrade] = useState("")
  const [count, setCount] = useState(4)
  const [drafting, setDrafting] = useState(false)
  const textareaRefs = useRef<Map<number, HTMLTextAreaElement>>(new Map())

  const setProblem = (i: number, patch: Partial<ProblemInput>) =>
    setProblems((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  const focusProblem = (i: number) =>
    setTimeout(() => textareaRefs.current.get(i)?.focus(), 30)

  const addProblem = () => {
    setProblems((ps) => [...ps, { statement: "", maxPoints: 10 }])
    focusProblem(problems.length)
  }

  const move = (i: number, dir: -1 | 1) =>
    setProblems((ps) => {
      const j = i + dir
      if (j < 0 || j >= ps.length) return ps
      const next = [...ps]
      const tmp = next[i]!
      next[i] = next[j]!
      next[j] = tmp
      return next
    })

  const draft = async () => {
    if (!topic.trim()) return
    setDrafting(true)
    setError(null)
    try {
      const res = await draftProblems(topic.trim(), grade, count)
      setProblems((ps) => {
        const keep = ps.filter((p) => p.statement.trim().length > 0)
        return [...keep, ...res.problems]
      })
      if (!title.trim()) setTitle(topic.trim())
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 429
          ? "The goblin needs a breather — try drafting again in a minute."
          : `Drafting failed: ${String(e)}`
      )
    } finally {
      setDrafting(false)
    }
  }

  const valid =
    title.trim().length > 0 &&
    problems.length > 0 &&
    problems.every((p) => p.statement.trim().length > 0 && p.maxPoints >= 1)

  const totalPoints = problems.reduce((a, p) => a + (Number.isFinite(p.maxPoints) ? p.maxPoints : 0), 0)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await createAssignment({
        title: title.trim(),
        problems: problems.map((p) => ({ ...p, statement: p.statement.trim() }))
      })
      rememberAssignment({ title: title.trim(), teacherSecret: res.teacherSecret })
      navigate(`/t/${res.teacherSecret}`)
    } catch (e) {
      setError(`Could not create the assignment. ${String(e)}`)
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="card">
        <h1>New assignment</h1>
        <p className="soft">
          Tell the goblin a topic and it drafts the problems — or write your own below. Either
          way, you edit everything, and every problem gets a rubric you control on the next screen.
        </p>

        <div className="row" style={{ flexWrap: "wrap", marginBottom: "0.5rem" }}>
          {TOPIC_CHIPS.map((c) => (
            <button key={c} className={`chip ${topic === c ? "active" : ""}`} onClick={() => setTopic(c)}>
              {c}
            </button>
          ))}
        </div>

        <div className="row" style={{ flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="Topic — e.g. subtracting within 10"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void draft()
            }}
            style={{ flex: "2 1 220px" }}
            aria-label="Topic"
          />
          <select value={grade} onChange={(e) => setGrade(e.target.value)} aria-label="Grade level">
            {GRADES.map((g) => (
              <option key={g} value={g}>
                {g === "" ? "any grade" : g}
              </option>
            ))}
          </select>
          <select
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            aria-label="Number of problems"
          >
            {[3, 4, 5, 6, 8].map((n) => (
              <option key={n} value={n}>
                {n} problems
              </option>
            ))}
          </select>
          <button onClick={() => void draft()} disabled={!topic.trim() || drafting}>
            {drafting ? "Goblin is writing…" : "Draft problems"}
          </button>
          <button
            className="ghost"
            onClick={() => {
              setTitle(SAMPLE.title)
              setProblems(SAMPLE.problems.map((p) => ({ ...p })))
            }}
          >
            Load sample
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card stack">
        <div>
          <label htmlFor="title">Title</label>
          <input
            id="title"
            type="text"
            placeholder="e.g. Fractions check-in"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {problems.map((p, i) => (
          <div key={i} className="problem-card">
            <div className="row" style={{ marginBottom: "0.35rem" }}>
              <span className="problem-number">{i + 1}</span>
              <div className="grow" />
              <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button
                className="icon-btn"
                title="Move down"
                disabled={i === problems.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
              <button
                className="icon-btn"
                title="Duplicate"
                onClick={() =>
                  setProblems((ps) => [...ps.slice(0, i + 1), { ...ps[i]! }, ...ps.slice(i + 1)])
                }
              >
                ⧉
              </button>
              <button
                className="icon-btn danger"
                title="Remove problem"
                disabled={problems.length === 1}
                onClick={() => setProblems((ps) => ps.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
            <div className="row top">
              <div className="grow">
                <textarea
                  ref={(el) => {
                    if (el) textareaRefs.current.set(i, el)
                    else textareaRefs.current.delete(i)
                  }}
                  placeholder="Write the problem exactly as students should see it"
                  value={p.statement}
                  onChange={(e) => setProblem(i, { statement: e.target.value })}
                  onInput={(e) => {
                    const el = e.currentTarget
                    el.style.height = "auto"
                    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
                  }}
                  aria-label={`Problem ${i + 1}`}
                />
              </div>
              <div style={{ width: 86 }}>
                <label htmlFor={`pts${i}`}>Points</label>
                <input
                  id={`pts${i}`}
                  type="number"
                  min={1}
                  max={100}
                  value={p.maxPoints}
                  onChange={(e) => setProblem(i, { maxPoints: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>
        ))}

        <div className="row">
          <button className="ghost" onClick={addProblem} disabled={problems.length >= 20}>
            + Add problem
          </button>
          <span className="soft">
            {problems.length} {problems.length === 1 ? "problem" : "problems"} · {totalPoints} points
          </span>
          <div className="grow" />
          <button onClick={submit} disabled={!valid || busy}>
            {busy ? "Drafting rubrics…" : "Create assignment"}
          </button>
        </div>
      </div>
    </div>
  )
}
