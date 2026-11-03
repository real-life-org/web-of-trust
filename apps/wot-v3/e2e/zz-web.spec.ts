import { test, expect } from '@playwright/test'
test('web build under /app/', async ({ page }) => {
  const errors: string[] = []; const sockets: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('websocket', (ws) => sockets.push(ws.url()))
  page.on('requestfailed', (r) => errors.push('failed ' + r.url()))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('http://localhost:5297/app/')
  await page.waitForTimeout(5000)
  await page.screenshot({ path: '/tmp/claude-1000/-home-fritz-workspace-workspace/dddd0c40-67f1-49d2-ab65-1e85debaa9b2/scratchpad/web-1.png' })
  console.log('TEXT', (await page.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | '))
  console.log('ERRORS', JSON.stringify(errors)); console.log('SOCKETS', JSON.stringify(sockets))
})
