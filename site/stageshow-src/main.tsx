import type { ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import './look.css'
import HeroScene from './hero'
import { MailScene, PhoneScene, WatchScene } from './cards'

const SCENES: Record<string, ComponentType> = {
  hero: HeroScene,
  mail: MailScene,
  phone: PhoneScene,
  watch: WatchScene,
}

const mount = (slot: HTMLElement) => {
  const Scene = SCENES[slot.dataset.ss ?? '']
  if (!Scene) return
  createRoot(slot).render(<Scene />)
  slot.closest('.shot, .card')?.classList.add('ss-live')
}

// Each scene mounts shortly before it scrolls into view; the kit's Stage then
// plays it only while it is on screen and shows its poster under reduced motion.
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      io.unobserve(e.target)
      mount(e.target as HTMLElement)
    }
  },
  { rootMargin: '300px 0px' },
)

for (const slot of document.querySelectorAll<HTMLElement>('[data-ss]')) io.observe(slot)
