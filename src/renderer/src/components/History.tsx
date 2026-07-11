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
        <div className="flex items-center gap-3 border-b border-zinc-800/70 px-6 py-3">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
          >
            <ChevronLeft />
            Back
          </button>
          <div className="text-sm font-medium text-zinc-200">{prettyName(viewing.name)}</div>
        </div>
        <div className="transcript-text flex-1 overflow-y-auto px-6 py-6">
          <pre className="mx-auto max-w-3xl whitespace-pre-wrap rounded-2xl border border-zinc-800/70 bg-zinc-900/40 px-6 py-5 font-sans text-sm leading-relaxed text-zinc-200 shadow-sm">
            {viewing.body}
          </pre>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800/70 px-6 py-3 text-xs">
        <span className="text-zinc-500">
          {items.length === 0 ? 'No transcripts' : `${items.length} transcript${items.length === 1 ? '' : 's'}`}
        </span>
        <div className="flex gap-2">
          <ToolbarButton onClick={onRefresh}>Refresh</ToolbarButton>
          <ToolbarButton onClick={onOpenFolder}>Open folder</ToolbarButton>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900/50">
            <DocIcon className="text-zinc-600" />
          </div>
          <div className="text-sm text-zinc-500">Recordings you finish will show up here.</div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <ul className="mx-auto flex max-w-3xl flex-col gap-2.5">
            {items.map((item) => (
              <li key={item.file}>
                <button
                  onClick={() => onOpen(item)}
                  className="group flex w-full items-center gap-4 rounded-xl border border-zinc-800/70 bg-zinc-900/40 px-4 py-3.5 text-left shadow-sm transition-all hover:-translate-y-px hover:border-zinc-700 hover:bg-zinc-900/70 hover:shadow-md"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950/60 transition-colors group-hover:border-emerald-800/60">
                    <DocIcon className="text-zinc-500 transition-colors group-hover:text-emerald-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-zinc-200">{prettyName(item.name)}</div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {formatDate(item.mtime)} · {(item.size / 1024).toFixed(1)} KB
                    </div>
                  </div>
                  <ChevronRight />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ToolbarButton({ onClick, children }: { onClick: () => void; children: string }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
    >
      {children}
    </button>
  )
}

/** "2026-07-11-091432.md" → "2026-07-11 09:14" (falls back to the raw name). */
function prettyName(name: string): string {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})\d{2}(-recovered(?:-\d+)?)?\.md$/)
  if (!m) return name.replace(/\.md$/, '')
  const recovered = m[6] ? ' · recovered' : ''
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}${recovered}`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function DocIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  )
}

function ChevronLeft(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

function ChevronRight(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-zinc-600 transition-colors group-hover:text-zinc-400" aria-hidden>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}
