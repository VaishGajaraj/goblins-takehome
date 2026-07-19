import { useParams } from "react-router-dom"

/** Placeholder — the full student flow (whiteboard + grading) lands in M3. */
export function JoinPlaceholder() {
  const { code = "" } = useParams()
  return (
    <div className="card">
      <h1>Almost there!</h1>
      <p className="soft">
        Class code <strong>{code}</strong> recognized. The student whiteboard is being wired up
        next — check back shortly.
      </p>
    </div>
  )
}
