import { BrowserRouter, Link, Route, Routes } from "react-router-dom"
import { CreateAssignment } from "./pages/CreateAssignment"
import { JoinPage } from "./pages/JoinPage"
import { Landing } from "./pages/Landing"
import { TeacherPage } from "./pages/TeacherPage"
import { WorkPage } from "./pages/WorkPage"

export function App() {
  return (
    <BrowserRouter>
      <div className="shell">
        <nav className="topbar">
          <span className="mascot" aria-hidden>🧌</span>
          <Link to="/">Goblins Grader</Link>
        </nav>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/new" element={<CreateAssignment />} />
          <Route path="/t/:secret" element={<TeacherPage />} />
          <Route path="/join/:code" element={<JoinPage />} />
          <Route path="/work/:code" element={<WorkPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
