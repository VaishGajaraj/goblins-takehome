import { useEffect, useState } from "react"

export function App() {
  const [health, setHealth] = useState<string>("checking…")

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setHealth(JSON.stringify(d)))
      .catch((e) => setHealth(`unreachable: ${e}`))
  }, [])

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>Goblins Grader</h1>
      <p>Scaffold shell. Server health: <code>{health}</code></p>
    </main>
  )
}
