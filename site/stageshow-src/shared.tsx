import { useEffect, useState } from 'react'
import { Check } from './kit/parts/Check'
import { Spinner } from './kit/parts/Spinner'

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')

export function useDark() {
  const [dark, setDark] = useState(() => darkQuery().matches)
  useEffect(() => {
    const q = darkQuery()
    const on = () => setDark(q.matches)
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  return dark
}

// Korean lines break only between phrases: each phrase is one unbreakable span.
export function P({ children, className }: { children: string[]; className?: string }) {
  return (
    <span className={className}>
      {children.map((p, i) => (
        <span key={i}>
          {i > 0 && ' '}
          <span className="ph">{p}</span>
        </span>
      ))}
    </span>
  )
}

export function AppMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="dz-mark" viewBox="3.5 3.5 17 17" width={size} height={size} aria-hidden>
      <circle cx="7.4" cy="7.4" r="3.1" />
      <circle cx="16.6" cy="7.4" r="1.9" />
      <circle cx="7.4" cy="16.6" r="1.9" />
      <circle className="dz-mark__dot" cx="16.6" cy="16.6" r="3.1" />
    </svg>
  )
}

export type Send = 'idle' | 'busy' | 'done'

export function DraftActions({ send, at, target = 'send' }: { send: Send; at: string; target?: string }) {
  return (
    <div className="dz-acts-cell">
      <div className="dz-acts" data-off={send === 'done' || undefined}>
        <span className="dz-btn dz-btn--send" data-target={target} data-cursor="pointer">
          <span className="dz-layer" data-on={send === 'idle' || undefined}>보내기</span>
          <span className="dz-layer" data-on={send === 'busy' || undefined}>
            <Spinner size={14} />
          </span>
        </span>
        <span className="dz-btn">고치기</span>
        <span className="dz-btn dz-btn--text">보내지 않기</span>
      </div>
      <div className="dz-sent" data-off={send !== 'done' || undefined}>
        <Check on={send === 'done'} size={16} />
        보냈어요
        <span className="dz-sent__time">{at}</span>
      </div>
    </div>
  )
}
