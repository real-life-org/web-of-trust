import demoContent from './demo-ausprobieren.md?raw'
import techContent from './technisches-design.md?raw'
import gemeinschaftContent from './gemeinschaftsoekonomie-drei-fragen.md?raw'

export const posts = [
  {
    slug: 'gemeinschaftsoekonomie-drei-fragen',
    title: 'Von der Tragik der Allmende zur Gemeinschaftsökonomie',
    description: 'Von KI-Disruption zu Gemeinschaftsökonomie: Eigentumsfrage, Anreizfrage, Machtfrage — und was Elinor Ostrom, Charles Eisenstein und Web of Trust damit zu tun haben.',
    date: '2026-03-01',
    author: 'Anton Tranelis und Eli',
    content: gemeinschaftContent,
  },
  {
    slug: 'demo-ausprobieren',
    title: 'Die Web-of-Trust Demo ausprobieren',
    description: 'Erstelle deine dezentrale Identität, verifiziere Kontakte und tausche Attestierungen aus — alles direkt im Browser.',
    date: '2026-02-09',
    author: 'Anton Tranelis',
    content: demoContent,
  },
  {
    slug: 'technisches-design',
    title: 'Technisches Design: Wie die Demo funktioniert',
    description: 'Ein Blick unter die Haube: 6-Adapter Architektur, Ed25519-Kryptographie, Evolu als CRDT-Storage und ein blinder WebSocket Relay.',
    date: '2026-02-09',
    author: 'Anton Tranelis',
    content: techContent,
  },
]

export function getPost(slug) {
  return posts.find(p => p.slug === slug)
}
