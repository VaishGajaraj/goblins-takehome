import { useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { ApiError, joinClass, storedStudent } from "../api"

export function JoinPage() {
  const { code = "" } = useParams()
  const navigate = useNavigate()
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collision, setCollision] = useState<number | null>(null) // startedMinutesAgo

  const join = async (mode?: "resume" | "new") => {
    setBusy(true)
    setError(null)
    try {
      const res = await joinClass(code.toUpperCase(), name.trim(), mode)
      if (res.kind === "nameTaken") {
        setCollision(res.startedMinutesAgo)
      } else {
        storedStudent.set(code.toUpperCase(), { studentId: res.studentId, name: res.studentName })
        navigate(`/work/${code.toUpperCase()}`)
      }
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? "Hmm, that class code doesn't work — double-check it with your teacher." : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ maxWidth: 460, margin: "0 auto" }}>
      <h1>Join your class</h1>
      <p className="soft">
        Class code: <strong>{code.toUpperCase()}</strong>
      </p>

      {collision === null ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) void join()
          }}
        >
          <div>
            <label htmlFor="name">Your first name</label>
            <input
              id="name"
              type="text"
              placeholder="e.g. Alex"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          {error && <div className="error-banner">{error}</div>}
          <button type="submit" disabled={!name.trim() || busy}>
            {busy ? "Joining…" : "Let's go"}
          </button>
        </form>
      ) : (
        <div className="stack">
          <p>
            Someone named <strong>{name.trim()}</strong> started this assignment{" "}
            {collision === 0 ? "just now" : `${collision} min ago`}. Is that you?
          </p>
          <div className="row">
            <button onClick={() => void join("resume")} disabled={busy}>
              Yes, that's me — continue
            </button>
            <button className="ghost" onClick={() => void join("new")} disabled={busy}>
              No, I'm a different {name.trim()}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
