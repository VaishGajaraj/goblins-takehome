import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { ApiError, getClassInfo, joinClass, storedStudent } from "../api"

type ClassCheck =
  | { kind: "checking" }
  | { kind: "invalid"; message: string }
  | { kind: "valid"; title: string; problemCount: number }

export function JoinPage() {
  const { code = "" } = useParams()
  const navigate = useNavigate()
  const [check, setCheck] = useState<ClassCheck>({ kind: "checking" })
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collision, setCollision] = useState<number | null>(null) // startedMinutesAgo

  // Validate the code BEFORE showing a name form — invalid codes get a clear
  // dead end instead of a form that fails on submit.
  useEffect(() => {
    let cancelled = false
    setCheck({ kind: "checking" })
    getClassInfo(code.toUpperCase())
      .then((info) => {
        if (!cancelled) setCheck({ kind: "valid", title: info.title, problemCount: info.problemCount })
      })
      .catch((e) => {
        if (cancelled) return
        const message =
          e instanceof ApiError && e.status === 404
            ? "That class code doesn't match any assignment. Double-check it with your teacher!"
            : e instanceof ApiError && e.status === 429
              ? "Too many tries from your network — wait a minute and refresh."
              : `Couldn't reach the classroom: ${String(e)}`
        setCheck({ kind: "invalid", message })
      })
    return () => {
      cancelled = true
    }
  }, [code])

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
      setError(
        e instanceof ApiError && e.status === 404
          ? "Hmm, that class code doesn't work — double-check it with your teacher."
          : String(e)
      )
    } finally {
      setBusy(false)
    }
  }

  if (check.kind === "checking") {
    return (
      <div className="card" style={{ maxWidth: 460, margin: "0 auto" }}>
        <p className="soft">Checking class code {code.toUpperCase()}…</p>
      </div>
    )
  }

  if (check.kind === "invalid") {
    return (
      <div className="card" style={{ maxWidth: 460, margin: "0 auto", textAlign: "center" }}>
        <span style={{ fontSize: "2.4rem" }} aria-hidden>🧌❓</span>
        <h1>No class here</h1>
        <p className="soft">{check.message}</p>
        <Link to="/">← Try a different code</Link>
      </div>
    )
  }

  return (
    <div className="card" style={{ maxWidth: 460, margin: "0 auto" }}>
      <h1>Join "{check.title}"</h1>
      <p className="soft">
        Class code <strong>{code.toUpperCase()}</strong> · {check.problemCount}{" "}
        {check.problemCount === 1 ? "problem" : "problems"}
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
