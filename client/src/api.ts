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

// ---------- student ----------

export type ProblemForStudent = {
  id: string
  position: number
  statement: string
  maxPoints: number
}

export type SubmissionForStudent = {
  id: string
  problemId: string
  attempt: number
  status: SubmissionStatus
  score: number | null
  feedback: string | null
}

export type JoinResult =
  | {
      kind: "joined"
      studentId: string
      studentName: string
      assignmentTitle: string
      problems: ProblemForStudent[]
      submissions: SubmissionForStudent[]
    }
  | { kind: "nameTaken"; startedMinutesAgo: number }

export type CriteriaHit = { criterion: string; met: boolean; pointsAwarded: number }

export type SubmissionDetail = {
  id: string
  problemId: string
  attempt: number
  status: SubmissionStatus
  score: number | null
  feedback: string | null
  criteriaHits: CriteriaHit[] | null
}

/** Error with HTTP status + parsed server error tag, for 429/404 handling. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly tag: string,
    message: string
  ) {
    super(message)
  }
}

async function requestWithTag<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init })
  if (!res.ok) {
    let tag = "Unknown"
    let msg = `${res.status}`
    try {
      const body = (await res.json()) as { _tag?: string; message?: string }
      tag = body._tag ?? tag
      msg = body.message ?? msg
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, tag, msg)
  }
  return res.json() as Promise<T>
}

export const joinClass = (code: string, name: string, mode?: "resume" | "new") =>
  requestWithTag<JoinResult>("/api/join", {
    method: "POST",
    body: JSON.stringify({ code, name, ...(mode ? { mode } : {}) })
  })

export const submitWork = (studentId: string, problemId: string, imageBase64: string) =>
  requestWithTag<{ submissionId: string; attempt: number }>("/api/submissions", {
    method: "POST",
    body: JSON.stringify({ studentId, problemId, imageBase64 })
  })

export const getSubmission = (id: string) =>
  requestWithTag<SubmissionDetail>(`/api/submissions/${encodeURIComponent(id)}`)

// localStorage identity per class code (cross-device resume works via code + name)
export type StoredStudent = { studentId: string; name: string }

export const storedStudent = {
  get: (code: string): StoredStudent | null => {
    try {
      return JSON.parse(localStorage.getItem(`goblins.student.${code}`) ?? "null") as StoredStudent | null
    } catch {
      return null
    }
  },
  set: (code: string, s: StoredStudent) => {
    try {
      localStorage.setItem(`goblins.student.${code}`, JSON.stringify(s))
    } catch {
      // private mode — resume still possible by re-entering name
    }
  }
}
