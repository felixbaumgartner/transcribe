import type { TranscriptListItem } from '../../../preload/index'

interface Props {
  items: TranscriptListItem[]
  onRefresh: () => void
  onOpen: (item: TranscriptListItem) => void
  onOpenFolder: () => void
  viewing: { name: string; body: string } | null
  onClose: () => void
}

export function History({ items, onRefresh, onOpen, onOpenFolder, viewing, onClose }: Props): JSX.Element {
  if (viewing) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
          <div className="text-sm font-medium">{viewing.name}</div>
          <button onClick={onClose} className="text-xs text-zinc-400 hover:text-zinc-200">
            ← Back
          </button>
        </div>
        <div className="transcript-text flex-1 overflow-y-auto px-6 py-5">
          <pre className="mx-auto max-w-3xl whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
            {viewing.body}
          </pre>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-3 text-xs">
        <span className="text-zinc-500">{items.length} transcripts</span>
        <div className="flex gap-3">
          <button onClick={onRefresh} className="text-zinc-400 hover:text-zinc-200">
            Refresh
          </button>
          <button onClick={onOpenFolder} className="text-zinc-400 hover:text-zinc-200">
            Open folder
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">
          No transcripts yet.
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {items.map((item) => (
            <li
              key={item.file}
              onClick={() => onOpen(item)}
              className="cursor-pointer border-b border-zinc-900 px-6 py-3 hover:bg-zinc-900/50"
            >
              <div className="text-sm">{item.name.replace(/\.md$/, '')}</div>
              <div className="text-xs text-zinc-500">
                {new Date(item.mtime).toLocaleString()} · {(item.size / 1024).toFixed(1)} KB
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
