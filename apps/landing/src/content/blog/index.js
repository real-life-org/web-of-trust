const modules = import.meta.glob('./*.md', { eager: true, query: '?raw', import: 'default' })

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { meta: {}, content: raw }

  const meta = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value === 'true') value = true
    else if (value === 'false') value = false
    meta[key] = value
  }

  return { meta, content: match[2] }
}

const isDev = import.meta.env.DEV

const allPosts = Object.entries(modules)
  .map(([path, raw]) => {
    const slug = path.replace('./', '').replace('.md', '')
    const { meta, content } = parseFrontmatter(raw)
    return { slug, content, ...meta }
  })
  .filter((post) => isDev || !post.draft)
  .sort((a, b) => new Date(b.date) - new Date(a.date))

export const posts = allPosts

export function getPost(slug) {
  return allPosts.find((p) => p.slug === slug)
}
