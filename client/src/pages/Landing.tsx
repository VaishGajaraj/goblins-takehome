import { useState } from "react"
import { useNavigate } from "react-router-dom"

export function Landing() {
  const navigate = useNavigate()
  const [code, setCode] = useState("")

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
