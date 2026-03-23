# WoT Demo App

## Design Context

### Users
People building and experiencing a decentralized Web of Trust. Early adopters who care about digital sovereignty, self-owned identity, and genuine human connection. They use the app to create their identity, verify contacts face-to-face via QR codes, exchange attestations, and share data in encrypted spaces. Context of use: often in-person encounters (verification flow), but also solo (profile management, reviewing attestations). Not necessarily technical — the app should feel approachable, not intimidating.

### Brand Personality
**Organisch, lebendig, vernetzt** — like a living network that grows through real encounters. Not a cold tech product, but a warm ecosystem. Think of mycelium networks: invisible infrastructure that connects living things.

### Emotional Goals
- **Vertrauen & Sicherheit**: Users handle cryptographic identity — the UI must radiate reliability without being sterile
- **Wärme & Verbundenheit**: This is about human connection, not technology. The interface should feel like a trusted community space
- **Klarheit & Ruhe**: No visual stress. Every element earns its place. Calm confidence.

### Aesthetic Direction
**Klar, vertrauenswürdig, konsistent mit der Landing-Page.**

- **Color palette**: Blue (#2563eb / oklch 264°) as primary, Green (#059669 / oklch 142°) for success/verified states, Orange (#f59e0b / oklch 55°) as accent/warning. Consistent with the landing page and favicon.
- **Neutrals**: Subtle cool-tinted stone neutrals (265° hue, low chroma). Not pure gray, not warm sand.
- **Surfaces**: Soft backgrounds (stone-50 body, white cards/inputs). No harsh contrasts.
- **Shapes**: Softer corners, organic forms where appropriate. Not everything needs to be a card.
- **Typography**: System defaults are fine for now. The landing page also uses Inter/system.
- **Icons**: Lucide is fine, used consistently. Consider reducing icon density where text alone is clearer.
- **Motion**: Subtle and purposeful. Current animations (confetti, toast, fade) are good starting points. No bounce, no elastic.

### Functional Reference
**Signal** — as a reference for clarity, trustworthiness, and functional minimalism. Signal proves you can handle serious topics (encryption, privacy) with a clean, approachable UI. Adopt this principle: serious technology doesn't need to look intimidating.

### Anti-References (what this should NOT look like)
- Generic crypto/Web3 dashboards (dark mode, neon accents, gradients)
- Typical AI-generated UIs (purple gradients, glassmorphism, Inter font, cards-in-cards)
- Enterprise SaaS (gray everything, tiny text, dense information)
- Overly playful/gamified (this handles real identity — maintain gravitas)

### Design Principles

1. **Vertrauen durch Klarheit** — Trust comes from clarity, not decoration. Every element should be immediately understandable. If something feels confusing, simplify it.

2. **Konsistenz vor Individualität** — The demo app should feel like a natural continuation of the landing page. Same colors, same tone, same brand. Consistency builds trust.

3. **Begegnung im Zentrum** — The core experience is human encounter (face-to-face verification). The UI should celebrate and support these moments, not bury them in technical details.

4. **Ruhige Souveränität** — Self-sovereign identity deserves a UI that feels sovereign: composed, confident, unhurried. No anxiety-inducing patterns, no dark patterns, no unnecessary urgency.

5. **Weniger, aber bewusst** — Every color, every element, every interaction should be intentional. Restraint is a feature. White space is content.

### Current State Assessment
The existing UI is functional and well-structured (React 19, Tailwind 4, responsive layout with sidebar/bottom nav). Color palette aligned with landing page (Blue primary, Green success, Orange accent). Accessibility hardened (aria-labels, dialog roles, touch targets, prefers-reduced-motion). All form inputs have explicit bg-white for contrast against stone-100 body.

## iOS Deployment (Capacitor)

### Prerequisites
- Xcode installed with command line tools (`xcode-select -s /Applications/Xcode.app/Contents/Developer`)
- iPhone connected via USB with Developer Mode enabled
- Device target ID: `00008110-000874901A09801E` (iPhone 13 mini "🦋")

### Build & Deploy
```bash
# 1. Build web assets (VITE_BASE_PATH must be / for Capacitor, not /demo/)
cd /Users/tillmann.heigel/code/web-of-trust
VITE_BASE_PATH=/ pnpm build --filter=demo

# 2. Sync web assets to iOS project
cd apps/demo
npx cap sync ios

# 3. Deploy to device
npx cap run ios --target 00008110-000874901A09801E
```

### Key Notes
- `VITE_BASE_PATH=/demo/` is for GitHub Pages deployment — using it for Capacitor causes a white screen
- `cap run` does both `sync` and `build+deploy`, but running `sync` separately first is useful for debugging
- To list available devices: `npx cap run ios --list`
- iOS safe area insets are handled in `src/index.css` (`env(safe-area-inset-top)` on `#root`, `body::before` covers status bar)
- `viewport-fit=cover` in `index.html` is required for `env()` safe area variables to work
