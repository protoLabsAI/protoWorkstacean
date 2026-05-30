import { defineConfig } from 'vitepress'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// docs/ is the VitePress root (this file lives in docs/.vitepress/).
const root = fileURLToPath(new URL('..', import.meta.url))

// GitHub Pages project path. docs-deploy.yml passes BASE_PATH=/protoWorkstacean.
const base = (process.env.BASE_PATH ?? '/protoWorkstacean').replace(/\/+$/, '') + '/'

/** Best title for a page: frontmatter `title`, else first H1, else prettified filename. */
function titleOf(file: string): string {
  const src = readFileSync(file, 'utf8')
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    const m = fm[1].match(/^title:\s*(.+)$/m)
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  }
  const h1 = src.match(/^#\s+(.+)$/m)
  if (h1) return h1[1].trim()
  return ''
}

function prettify(name: string): string {
  return name.replace(/\.md$/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Auto-build a sidebar group for a Diátaxis section — index/README first, then A–Z. */
function items(section: string) {
  const dir = join(root, section)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => {
      const rank = (n: string) => (/^(index|readme)\.md$/i.test(n) ? 0 : 1)
      return rank(a) - rank(b) || a.localeCompare(b)
    })
    .map((f) => {
      const name = f.replace(/\.md$/, '')
      const isIndex = /^(index|readme)$/i.test(name)
      return {
        text: titleOf(join(dir, f)) || prettify(f),
        link: isIndex ? `/${section}/` : `/${section}/${name}`,
      }
    })
}

// Diátaxis sections, in reading order.
const SECTIONS: [string, string][] = [
  ['tutorials', 'Tutorials'],
  ['guides', 'Guides'],
  ['how-to', 'How-to'],
  ['integrations', 'Integrations'],
  ['reference', 'Reference'],
  ['explanation', 'Explanation'],
  ['architecture', 'Architecture'],
  ['extensions', 'Extensions'],
  ['decisions', 'Decisions'],
  ['contributing', 'Contributing'],
  ['roadmap', 'Roadmap'],
]

export default defineConfig({
  base,
  title: 'protoWorkstacean',
  description:
    'The switchboard for the protoLabs agent ecosystem — trigger → router → dispatcher → executor over a typed event bus.',
  cleanUrls: true,
  ignoreDeadLinks: false,
  themeConfig: {
    search: { provider: 'local' },
    nav: [
      { text: 'Tutorials', link: '/tutorials/' },
      { text: 'Guides', link: '/guides/' },
      { text: 'Integrations', link: '/integrations/' },
      { text: 'Reference', link: '/reference/' },
      { text: 'Explanation', link: '/explanation/' },
      { text: 'Architecture', link: '/architecture/' },
      { text: 'Contributing', link: '/contributing/' },
    ],
    sidebar: SECTIONS.map(([s, label]) => ({ text: label, collapsed: true, items: items(s) })).filter(
      (g) => g.items.length > 0,
    ),
    socialLinks: [{ icon: 'github', link: 'https://github.com/protoLabsAI/protoWorkstacean' }],
    editLink: {
      pattern: 'https://github.com/protoLabsAI/protoWorkstacean/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: { message: 'protoWorkstacean — a switchboard, not an agent.' },
  },
})
