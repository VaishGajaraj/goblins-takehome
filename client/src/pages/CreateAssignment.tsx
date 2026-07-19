import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { createAssignment, type ProblemInput } from "../api"

const SAMPLE: { title: string; problems: ProblemInput[] } = {
  title: "Fractions check-in",
  problems: [
    { statement: "Ella has 3/4 of a pizza. She eats 1/2 of what she has. What fraction of the whole pizza did she eat? Show your work.", maxPoints: 10 },
    { statement: "Compute 2/3 + 1/6. Show each step and simplify your answer.", maxPoints: 10 },
    { statement: "Which is bigger: 5/8 or 2/3? Explain how you know without a calculator.", maxPoints: 10 },
    { statement: "A recipe needs 1/3 cup of sugar per batch. How much sugar do you need for 4 batches? Draw or write your reasoning.", maxPoints: 10 }
  ]
}

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

  const setProblem = (i: number, patch: Partial<ProblemInput>) =>
    setProblems((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  const valid =
    title.trim().length > 0 &&
    problems.length > 0 &&
    problems.every((p) => p.statement.trim().length > 0 && p.maxPoints >= 1)

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
          Write your problems (or load the sample to see how it works). A grading rubric is
          drafted for each problem — you can edit every point of it on the next screen.
        </p>
        <button
          className="subtle"
          onClick={() => {
            setTitle(SAMPLE.title)
            setProblems(SAMPLE.problems.map((p) => ({ ...p })))
          }}
        >
          Load sample assignment
        </button>
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
          <div key={i} className="row top">
            <div className="grow">
              <label htmlFor={`p${i}`}>Problem {i + 1}</label>
              <textarea
                id={`p${i}`}
                placeholder="Write the problem exactly as students should see it"
                value={p.statement}
                onChange={(e) => setProblem(i, { statement: e.target.value })}
              />
            </div>
            <div style={{ width: 90 }}>
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
            <button
              className="danger-ghost"
              title="Remove problem"
              disabled={problems.length === 1}
              onClick={() => setProblems((ps) => ps.filter((_, j) => j !== i))}
              style={{ marginTop: "1.55rem" }}
            >
              ✕
            </button>
          </div>
        ))}

        <div className="row">
          <button
            className="ghost"
            onClick={() => setProblems((ps) => [...ps, { statement: "", maxPoints: 10 }])}
            disabled={problems.length >= 20}
          >
            + Add problem
          </button>
          <div className="grow" />
          <button onClick={submit} disabled={!valid || busy}>
            {busy ? "Drafting rubrics…" : "Create assignment"}
          </button>
        </div>
      </div>
    </div>
  )
}
