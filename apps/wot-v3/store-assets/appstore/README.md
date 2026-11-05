# App Store screenshots

Six iPhone screenshots of Web of Trust 3, German, light theme, 1320×2868 PNG (iPhone 6.9", the size App Store Connect scales down for the smaller iPhones).

| File | Screen |
|---|---|
| `01-begegnung-code.png` | Noah shows his code (Verify in person) |
| `02-kontakte.png` | Jonas's contacts, mutually verified and trusted |
| `03-gemeinsame-kontakte.png` | Lea's details: verification, trust both ways, shared contacts |
| `04-gespraech.png` | The conversation with Noah, every message delivered |
| `05-graph.png` | The graph: Jonas's contacts and what they share |
| `06-vertrauen.png` | The trust question for Sam, with what it discloses |

## How they are taken

`e2e/appstore-screenshots.spec.ts` runs the workbench page (the real app on the real library, the VTI mediator double in the page, offline): five fictional people (Jonas, Noah, Lea, Mara, Sam) who met before the page opened, everyone trusts everyone they met except Jonas → Sam, then the clock runs until the shared contacts have arrived. Each screen is a phone of its own, 440×956 CSS pixels at device scale factor 3, laid over the workbench. Language `lang=de`, time zone `tz=Europe/Berlin`.

From `apps/wot-v3`:

```bash
WOT_APPSTORE_DIR=store-assets/appstore pnpm exec playwright test -c playwright.screenshots.config.ts appstore
```

The config builds the harness and serves it on port 5291 (`WOT_SHOTS_PORT` to change it). Without `WOT_APPSTORE_DIR` the spec is skipped. The QR code, the dates and the times differ on every run.
