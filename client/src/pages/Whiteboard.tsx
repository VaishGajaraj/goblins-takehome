import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw"
import "@excalidraw/excalidraw/index.css"
import { useCallback, useRef } from "react"

// Minimal structural type for the Excalidraw imperative API (avoids importing
// deep type paths from the package).
type ExAPI = {
  getSceneElements: () => readonly unknown[]
  getAppState: () => Record<string, unknown>
  getFiles: () => unknown
  resetScene: () => void
}

export type WhiteboardHandle = {
  /** PNG capped at 1024px on the long edge (cost + payload control, see PLAN.md). */
  exportPng: () => Promise<Blob | null>
  clear: () => void
}

/**
 * Default export is the Excalidraw canvas; kept in its own module so the whole
 * dependency lazy-loads (it's the biggest chunk in the app).
 */
export default function Whiteboard(props: { onReady: (handle: WhiteboardHandle) => void }) {
  const apiRef = useRef<ExAPI | null>(null)

  const onApi = useCallback(
    (api: unknown) => {
      apiRef.current = api as ExAPI
      props.onReady({
        exportPng: async () => {
          const a = apiRef.current
          if (!a) return null
          const elements = a.getSceneElements() as never[]
          if (elements.length === 0) return null
          return exportToBlob({
            elements,
            appState: { ...a.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff" } as never,
            files: a.getFiles() as never,
            maxWidthOrHeight: 1024,
            mimeType: "image/png"
          })
        },
        clear: () => apiRef.current?.resetScene()
      })
    },
    [props]
  )

  return (
    <div style={{ height: "52vh", minHeight: 340, borderRadius: 12, overflow: "hidden", border: "1.5px solid var(--line)" }}>
      <Excalidraw
        excalidrawAPI={onApi}
        theme="light"
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            saveAsImage: false
          }
        }}
      />
    </div>
  )
}
