// Hand-mirrored types from server/src/Domain.ts (single source of truth).
// Deliberate call: keeping the client dependency-free of Effect for a small
// app; the shapes are validated server-side by Schema either way.

export type RubricCriterion = { criterion: string; points: number }
export type Rubric = RubricCriterion[]

export type ProblemInput = { statement: string; maxPoints: number }

export type ProblemView = {
  id: string
  position: number
  statement: string
  maxPoints: number
  rubric: Rubric
}

export type SubmissionStatus = "queued" | "grading" | "graded" | "failed"

export type SubmissionSummary = {
  id: string
  studentId: string
  problemId: string
  status: SubmissionStatus
  score: number | null
  feedback: string | null
  createdAt: number
  gradedAt: number | null
}

export type StudentView = { id: string; name: string; createdAt: number }

export type TeacherView = {
  id: string
  title: string
  joinCode: string
  createdAt: number
  problems: ProblemView[]
  students: StudentView[]
  submissions: SubmissionSummary[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

export const createAssignment = (payload: { title: string; problems: ProblemInput[] }) =>
  request<{ id: string; joinCode: string; teacherSecret: string }>("/api/assignments", {
    method: "POST",
    body: JSON.stringify(payload)
  })

export const getTeacherView = (secret: string) =>
  request<TeacherView>(`/api/teacher/${encodeURIComponent(secret)}`)

export const updateRubric = (secret: string, problemId: string, rubric: Rubric) =>
  request<{ ok: boolean }>(
    `/api/teacher/${encodeURIComponent(secret)}/problems/${encodeURIComponent(problemId)}/rubric`,
    { method: "PUT", body: JSON.stringify({ rubric }) }
  )
