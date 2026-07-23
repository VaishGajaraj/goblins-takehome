import { useState } from "react"
import { useNavigate } from "react-router-dom"

type RememberedAssignment = {
  title: string
  teacherSecret: string
  at: number
}

const loadRememberedAssignments = (): RememberedAssignment[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("goblins.teacherAssignments") ?? "[]")
    if (!Array.isArray(stored)) return []

    const valid = stored
      .filter((entry): entry is RememberedAssignment => {
        if (typeof entry !== "object" || entry === null) return false
        const candidate = entry as Partial<RememberedAssignment>
        return (
          typeof candidate.title === "string" &&
          candidate.title.trim().length > 0 &&
          typeof candidate.teacherSecret === "string" &&
          candidate.teacherSecret.trim().length > 0 &&
          typeof candidate.at === "number" &&
          Number.isFinite(candidate.at) &&
          candidate.at > 0 &&
          !Number.isNaN(new Date(candidate.at).getTime())
        )
      })
      .map((entry) => ({
        ...entry,
        title: entry.title.trim(),
        teacherSecret: entry.teacherSecret.trim()
      }))

    valid.sort((a, b) => b.at - a.at)
    return valid.filter(
      (assignment, index) =>
        valid.findIndex((candidate) => candidate.teacherSecret === assignment.teacherSecret) === index
    )
  } catch {
    return []
  }
}

export function Landing() {
  const navigate = useNavigate()
  const [code, setCode] = useState("")
  const [assignments] = useState(loadRememberedAssignments)

  return (
    <div>
      <div className="card">
        <h1>Grade less. Teach more.</h1>
        <p className="soft">
          Create a math assignment, share a code with your class, and let the goblins grade
          the work — with a rubric you control.
        </p>
        <button onClick={() => navigate("/new")}>Create an assignment</button>
      </div>

      {assignments.length > 0 && (
        <div className="card">
          <h2>Your assignments</h2>
          <p className="soft">Reopen an assignment created in this browser.</p>
          <div className="stack">
            {assignments.map((assignment) => (
              <div className="problem-card row" key={assignment.teacherSecret}>
                <div className="grow">
                  <strong>{assignment.title}</strong>
                  <div className="soft" style={{ fontSize: "0.85rem" }}>
                    Created {new Date(assignment.at).toLocaleString()}
                  </div>
                </div>
                <button
                  className="ghost"
                  onClick={() => navigate(`/t/${encodeURIComponent(assignment.teacherSecret)}`)}
                  aria-label={`Open ${assignment.title}`}
                >
                  Open report
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h2>Joining your class?</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            if (code.trim()) navigate(`/join/${code.trim().toUpperCase()}`)
          }}
        >
          <input
            type="text"
            placeholder="Enter your class code, e.g. QK7MPT"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-label="Class code"
            style={{ maxWidth: 280, textTransform: "uppercase" }}
          />
          <button type="submit" className="ghost" disabled={code.trim().length < 4}>
            Join
          </button>
        </form>
      </div>
    </div>
  )
}
