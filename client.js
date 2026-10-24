/**
 * dsh-github-link — client half.
 *
 * Adds two behaviours to github.com URLs inside the conversation transcript —
 * assistant replies and their GenUI ```dsh-ui blocks, chat markdown, tool
 * cards. The rest of the window (menus, session list, workspace tabs) keeps
 * its own link behaviour and is never decorated:
 *
 *   1. Hover  → a small card with the repository's basic information
 *               (name, description, stars/forks, language, license, topics,
 *               last activity), fetched through the plugin's own Host route.
 *   2. Click  → the URL opens in DSH's own right-side browser tab
 *               (`sidebarRight.openTab('browser', { params: { url } })`),
 *               the same surface `sidebar_open` uses.
 *
 * Nothing mutates the transcript DOM: bare URLs are resolved from the caret
 * position under the pointer, so React keeps owning every text node.
 *
 * Click routing is deliberately conservative. A plain chat markdown link is
 * left to the Host's own `linkOpening` preference — intercepting it would
 * silently override a user setting. The takeover happens only where nothing
 * else would serve the click: links drawn inside GenUI blocks (they carry
 * `target="_blank"`) and bare URLs inside prose.
 */
window.__ModuleLoader__.load({
  id: 'dsh-github-link',
  factory() {
    const CARD_ID = 'dsh-github-link-card'
    /**
     * The transcript is the only surface this plugin decorates.
     *
     * DSH owns the rest of the window: the session list, menus (portaled to
     * `document.body`) and the right-column workspace tabs all carry their own
     * link behaviour, and decorating them was never part of this plugin.
     * `data-conversation-content` is the Conversation shell's body — the one
     * surface a reply (and its GenUI blocks) actually lives in.
     */
    const CONVERSATION_ROOT = '[data-conversation-content]'
    const SHOW_DELAY_MS = 140
    const HIDE_DELAY_MS = 260
    const CARD_MAX_WIDTH = 360
    const REPO_HOSTS = ['github.com', 'gitlab.com', 'gitee.com']
    /** Cheap "does this text mention a repository host" gate (stateless regex). */
    const HOST_MENTION = /(?:github|gitlab|gitee)\.com/
    const URL_PATTERN = /https?:\/\/(?:github\.com|gitlab\.com|gitee\.com)\/[^\s<>"'`（）【】「」，。；：！？]+/g
    const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"，。；：！？）】」』]+$/

    /** url → Promise of the Host payload (failures cached for the session). */
    const payloads = new Map()

    function isZh() {
      const lang = (typeof navigator === 'object' ? navigator.language : '') || ''
      return /^zh/i.test(lang) || /^zh/i.test(document.documentElement.lang || '')
    }

    const zh = isZh()
    const text = zh
      ? {
          loading: '读取仓库信息…',
          missing: '未找到该仓库',
          unavailable: '暂时读不到该仓库信息',
          stars: '星标',
          forks: '复刻',
          issues: '议题',
          updated: '更新于',
          topics: '主题',
          archived: '已归档',
          private: '私有',
          forkOf: '复刻仓库',
          hint: '点击：右侧浏览器打开',
          hintFallback: '右侧栏浏览器未启用：点击用系统浏览器打开',
          hintMod: '⌘/Ctrl 点击：系统浏览器',
          publicRepo: '公共仓库',
          released: '最近发布',
          copyClone: '复制 clone',
          openPr: '在 DSH 打开 PR',
          openPrTitle: '在右侧栏 PR 面板中查看这个 PR（dsh-github-flow）',
          copied: '已复制',
          copyFailed: '复制失败',
          stateOpen: '开启中',
          stateClosed: '已关闭',
          stateMerged: '已合并',
          stateOther: '处理中',
          byAuthor: '由',
        }
      : {
          loading: 'Reading repository…',
          missing: 'Repository not found',
          unavailable: 'Repository details are unavailable right now',
          stars: 'stars',
          forks: 'forks',
          issues: 'issues',
          updated: 'updated',
          topics: 'topics',
          archived: 'Archived',
          private: 'Private',
          forkOf: 'fork',
          hint: 'Click: open in right sidebar',
          hintFallback: 'Sidebar browser is off: click opens the system browser',
          hintMod: '⌘/Ctrl click: system browser',
          publicRepo: 'Public repository',
          released: 'released',
          copyClone: 'Copy clone',
          openPr: 'Open PR in DSH',
          openPrTitle: 'Open this PR in the right-column PR panel (dsh-github-flow)',
          copied: 'Copied',
          copyFailed: 'Copy failed',
          stateOpen: 'Open',
          stateClosed: 'Closed',
          stateMerged: 'Merged',
          stateOther: 'In progress',
          byAuthor: 'by',
        }

    /**
     * Resolve one of this plugin's own Host routes.
     *
     * Resolved against the PAGE base on purpose: in the Desktop shell the page
     * is `dsh-app://app/` and the shell forwards every non-static path to the
     * Host, so a page-relative route reaches it same-origin. A leading slash
     * would pin the request to the origin root and drop any proxy prefix.
     */
    function endpoint(route, query) {
      const url = new URL(route.replace(/^\/+/, ''), document.baseURI)
      if (query !== undefined) url.search = query
      return url.href
    }

    /** Fire-and-forget report about this client half (never blocks the UI). */
    function report(route, body) {
      try {
        void fetch(endpoint(route), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
          keepalive: true,
        }).catch(() => {})
      } catch {
        // A reporting failure must never surface to the user.
      }
    }

    /**
     * Whether the right-sidebar browser tab type is mounted right now.
     * @param {any} context - the plugin's client context (it owns `get`).
     */
    /**
     * Whether the PR panel (`dsh-github-flow`'s `github-pr` right-column tab) is
     * mounted. Without it the card must not draw a second button: a control that
     * does nothing is worse than no control.
     * @param {any} context
     */
    function prPanelAvailable(context) {
      try {
        const sidebar = context.get?.('sidebarRight')
        const tabs = context.get?.('sidebarRightTabs')
        return sidebar?.openTab !== undefined && tabs?.get?.('github-pr') !== undefined
      } catch {
        return false
      }
    }

    /**
     * Open one PR in the right-column PR panel.
     *
     * Two steps, both required: `openTab` only adds the tab to the column's list,
     * so a collapsed column would swallow the click; `layout.openRightbar` is what
     * actually reveals it. Same pair dsh-github-flow's own overlay uses.
     * @param {any} context
     * @param {string} repo - `owner/name`.
     * @param {number} number
     */
    function openPrPanel(context, repo, number) {
      try {
        context.get('sidebarRight').openTab('github-pr', { params: { repo, number } })
        context.get?.('layout')?.openRightbar?.(true, false)
        report('github-link/event', { type: 'open-pr' })
        return true
      } catch {
        return false
      }
    }

    function browserTabAvailable(context) {
      try {
        const sidebar = context.get?.('sidebarRight')
        const tabs = context.get?.('sidebarRightTabs')
        return sidebar?.openTab !== undefined && tabs?.get?.('browser') !== undefined
      } catch {
        return false
      }
    }

    /** Trim a URL that a sentence ran into. */
    function cleanUrl(value) {
      return value.replace(TRAILING_PUNCTUATION, '')
    }

    /** Whether one absolute href points at a repository on an accepted host. */
    function isRepoUrl(value) {
      if (typeof value !== 'string') return false
      try {
        const url = new URL(value)
        const host = url.hostname.toLowerCase().replace(/^www\./, '')
        if (!REPO_HOSTS.includes(host)) return false
        const segments = url.pathname.split('/').filter((part) => part !== '')
        return segments.length >= 2
      } catch {
        return false
      }
    }

    /** The text node under a viewport point, plus its offset. */
    function caretAt(x, y) {
      if (typeof document.caretPositionFromPoint === 'function') {
        const position = document.caretPositionFromPoint(x, y)
        if (position === null || position === undefined) return null
        return { node: position.offsetNode, offset: position.offset }
      }
      if (typeof document.caretRangeFromPoint === 'function') {
        const range = document.caretRangeFromPoint(x, y)
        if (range === null || range === undefined) return null
        return { node: range.startContainer, offset: range.startOffset }
      }
      return null
    }

    /** Whether a text node is part of a control we must not decorate. */
    function inControl(node) {
      const element = node.parentElement
      if (element === null) return true
      return element.closest('input, textarea, select, [contenteditable="true"]') !== null
    }

    /**
     * Resolve a GitHub URL by measuring every URL occurrence in the nearest
     * block and testing which one's glyph box holds the point.
     *
     * This is the deterministic fallback for the caret API: Chromium's
     * `caretPositionFromPoint` degrades to offset 0 once the page has handled
     * a click (reproducible), which silently kills bare-URL detection for the
     * rest of the session. A Range hit-test has no such state.
     *
     * @returns {{ url: string, rect: DOMRect } | null}
     */
    function urlInBlockAt(element, x, y) {
      const root = element.closest('p, li, td, th, dd, dt, blockquote, figcaption, h1, h2, h3, h4, h5, h6, pre')
        ?? element.closest('[data-genui]')
        ?? element
      if (root === null || !HOST_MENTION.test(root.textContent ?? '')) return null
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const value = node.data
        if (typeof value !== 'string' || !HOST_MENTION.test(value)) continue
        URL_PATTERN.lastIndex = 0
        for (const match of value.matchAll(URL_PATTERN)) {
          const url = cleanUrl(match[0])
          if (!isRepoUrl(url)) continue
          const start = match.index ?? 0
          const range = document.createRange()
          range.setStart(node, start)
          range.setEnd(node, Math.min(start + url.length, value.length))
          for (const rect of range.getClientRects()) {
            if (x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) return { url, rect }
          }
        }
      }
      return null
    }

    /**
     * Resolve the GitHub URL under a viewport point.
     * @returns {{ url: string, rect: DOMRect, anchor: HTMLAnchorElement | null, fromText: boolean } | null}
     */
    function urlAt(x, y, target) {
      const anchor = target instanceof Element ? target.closest('a[href]') : null
      if (anchor !== null && isRepoUrl(anchor.href)) {
        return { url: anchor.href, rect: anchor.getBoundingClientRect(), anchor, fromText: false }
      }

      const caret = caretAt(x, y)
      if (caret !== null && caret.node !== null && caret.node.nodeType === 3 && !inControl(caret.node)) {
        const value = caret.node.data
        if (typeof value === 'string' && HOST_MENTION.test(value)) {
          URL_PATTERN.lastIndex = 0
          for (const match of value.matchAll(URL_PATTERN)) {
            const url = cleanUrl(match[0])
            const start = match.index ?? 0
            const end = start + url.length
            if (caret.offset < start || caret.offset > end) continue
            if (!isRepoUrl(url)) continue
            const range = document.createRange()
            range.setStart(caret.node, start)
            range.setEnd(caret.node, Math.min(end, value.length))
            const rect = range.getBoundingClientRect()
            return { url, rect: rect.width === 0 && rect.height === 0 ? caret.node.parentElement.getBoundingClientRect() : rect, anchor: null, fromText: true }
          }
        }
      }

      if (!(target instanceof Element)) return null
      const measured = urlInBlockAt(target, x, y)
      return measured === null ? null : { url: measured.url, rect: measured.rect, anchor: null, fromText: true }
    }

    /** Compact number formatting for stars/forks. */
    function compact(value) {
      const number = Number(value)
      if (!Number.isFinite(number) || number < 0) return '—'
      if (number < 1000) return String(number)
      if (number < 1_000_000) {
        const scaled = number / 1000
        return `${scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.round(scaled)}k`
      }
      const scaled = number / 1_000_000
      return `${scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.round(scaled)}M`
    }

    /** Relative "last activity" wording. */
    function ago(iso) {
      const stamp = typeof iso === 'string' ? Date.parse(iso) : Number.NaN
      if (!Number.isFinite(stamp)) return ''
      const minutes = Math.max(0, Math.round((Date.now() - stamp) / 60000))
      if (minutes < 2) return zh ? '刚刚' : 'just now'
      if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return zh ? `${hours} 小时前` : `${hours} h ago`
      const days = Math.round(hours / 24)
      if (days < 30) return zh ? `${days} 天前` : `${days} d ago`
      const months = Math.round(days / 30)
      if (months < 12) return zh ? `${months} 个月前` : `${months} mo ago`
      return zh ? `${Math.round(months / 12)} 年前` : `${Math.round(months / 12)} y ago`
    }

    const KIND_LABEL = {
      repo: { zh: '仓库', en: 'repository' },
      issue: { zh: '议题', en: 'issue' },
      pr: { zh: '拉取请求', en: 'pull request' },
      discussion: { zh: '讨论', en: 'discussion' },
      file: { zh: '文件', en: 'file' },
      releases: { zh: '发布', en: 'releases' },
      actions: { zh: '工作流', en: 'actions' },
      commit: { zh: '提交', en: 'commit' },
      path: { zh: '页面', en: 'page' },
    }

    return {
      apply(ctx) {
        let card = null
        let activeUrl = null
        let activeRect = null
        let showTimer = 0
        let hideTimer = 0
        let disposed = false

        /** Read one card payload, memoised per URL. */
        function load(url) {
          const cached = payloads.get(url)
          if (cached !== undefined) return cached
          const promise = fetch(endpoint('github-link/card', `?url=${encodeURIComponent(url)}`), {
            headers: { accept: 'application/json' },
          })
            .then((response) => (response.ok ? response.json() : { ok: false, reason: `http-${response.status}` }))
            .catch(() => ({ ok: false, reason: 'network' }))
          payloads.set(url, promise)
          return promise
        }

        /** The floating surface, created on first use and reused afterwards. */
        function ensureCard() {
          if (card !== null && card.isConnected) return card
          card = document.createElement('div')
          card.id = CARD_ID
          card.setAttribute('role', 'tooltip')
          card.setAttribute('aria-live', 'polite')
          card.style.cssText = [
            'position:fixed',
            'z-index:2147483000',
            `width:${CARD_MAX_WIDTH}px`,
            `max-width:calc(100vw - 24px)`,
            'box-sizing:border-box',
            'padding:12px 14px',
            'border-radius:var(--dsw-radius-lg,12px)',
            'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35))',
            'background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#1b1b1b))',
            'color:var(--dsw-alias-label-primary,#eee)',
            'box-shadow:0 12px 32px -8px rgba(0,0,0,.45)',
            'font:var(--dsw-font-xs-13,13px/1.5 -apple-system,system-ui,sans-serif)',
            'pointer-events:auto',
            'opacity:0',
            'transition:opacity .12s ease',
            'display:none',
          ].join(';')
          card.addEventListener('mouseenter', cancelHide)
          card.addEventListener('mouseleave', scheduleHide)
          card.addEventListener('click', (event) => {
            // Buttons inside the card own their own clicks (copy clone).
            if (event.target instanceof Element && event.target.closest('[data-ghl-action]') !== null) return
            event.preventDefault()
            event.stopPropagation()
            if (activeUrl !== null) open(activeUrl)
          })
          document.body.appendChild(card)
          return card
        }

        function clearCard() {
          if (card === null) return
          card.style.display = 'none'
          card.style.opacity = '0'
          card.textContent = ''
        }

        /** Place the card against the hovered rect, preferring below. */
        function place(rect) {
          if (card === null || rect === null) return
          const width = card.offsetWidth || CARD_MAX_WIDTH
          const height = card.offsetHeight || 120
          const gap = 8
          let top = rect.bottom + gap
          if (top + height > window.innerHeight - 8) {
            const above = rect.top - gap - height
            top = above >= 8 ? above : Math.max(8, window.innerHeight - height - 8)
          }
          const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
          card.style.top = `${Math.round(top)}px`
          card.style.left = `${Math.round(left)}px`
        }

        function line(label, value) {
          const row = document.createElement('div')
          row.style.cssText = 'display:flex;gap:6px;align-items:baseline;min-width:0'
          const key = document.createElement('span')
          key.textContent = label
          key.style.cssText = 'color:var(--dsw-alias-label-secondary,#9aa0a6);flex:none'
          const val = document.createElement('span')
          val.textContent = value
          val.style.cssText = 'color:var(--dsw-alias-label-primary,#eee);overflow-wrap:anywhere;min-width:0'
          row.append(key, val)
          return row
        }

        function chip(label) {
          const span = document.createElement('span')
          span.textContent = label
          span.style.cssText = [
            'padding:1px 6px',
            'border-radius:999px',
            'font:var(--dsw-font-xxxs-11,11px/1.6 -apple-system,system-ui,sans-serif)',
            'color:var(--dsw-alias-label-secondary,#9aa0a6)',
            'background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16))',
            'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22))',
            'white-space:nowrap',
          ].join(';')
          return span
        }

        /** The command a "copy clone" button publishes for this payload. */
        function cloneCommand(payload) {
          const host = payload?.host
          const path = payload?.repo?.fullName
          if (typeof host !== 'string' || typeof path !== 'string' || path === '') return undefined
          return `git clone https://${host}/${path}.git`
        }

        /** Clipboard write with the legacy selection fallback. */
        async function copyText(value) {
          try {
            if (navigator.clipboard?.writeText !== undefined) {
              await navigator.clipboard.writeText(value)
              return true
            }
          } catch {
            // Permission or insecure context: fall through to the selection path.
          }
          try {
            const area = document.createElement('textarea')
            area.value = value
            area.setAttribute('readonly', '')
            area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0'
            document.body.appendChild(area)
            area.select()
            const copied = document.execCommand('copy')
            area.remove()
            return copied
          } catch {
            return false
          }
        }

        /** Localised wording for one issue/PR state. */
        function stateText(state) {
          const value = (state ?? '').toLowerCase()
          if (value === 'open' || value === 'opened' || value === 'progressing') return text.stateOpen
          if (value === 'merged') return text.stateMerged
          if (value === 'closed' || value === 'rejected') return text.stateClosed
          return text.stateOther
        }

        /** Colour token for one issue/PR state. */
        function stateColor(state) {
          const value = (state ?? '').toLowerCase()
          if (value === 'open' || value === 'opened' || value === 'progressing') return 'var(--dsw-alias-state-success-primary,#3fb950)'
          if (value === 'merged') return 'var(--dsw-alias-brand-primary,#4c8dff)'
          return 'var(--dsw-alias-label-secondary,#9aa0a6)'
        }

        /** Issue / pull request / merge request title and state, when present. */
        function detailRow(detail) {
          if (detail === undefined || detail === null || typeof detail.title !== 'string') return null
          const row = document.createElement('div')
          row.style.cssText = 'display:flex;gap:6px;align-items:baseline;margin:0 0 8px;min-width:0'

          const state = document.createElement('span')
          state.textContent = stateText(detail.state)
          state.style.cssText = [
            'flex:none',
            'padding:0 6px',
            'border-radius:999px',
            `border:1px solid ${stateColor(detail.state)}`,
            `color:${stateColor(detail.state)}`,
            'font:var(--dsw-font-xxxs-11,11px/1.6 inherit)',
            'white-space:nowrap',
          ].join(';')

          const title = document.createElement('span')
          title.textContent = detail.title
          title.style.cssText = 'min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere'

          row.append(state, title)
          if (typeof detail.author === 'string' && detail.author !== '') {
            const author = document.createElement('span')
            author.textContent = `${text.byAuthor} ${detail.author}`
            author.style.cssText = 'flex:none;color:var(--dsw-alias-label-secondary,#9aa0a6);font:var(--dsw-font-xxxs-11,11px/1.6 inherit)'
            row.append(author)
          }
          return row
        }

        /** Shared look for the card's small footer buttons. */
        function footerButton(label) {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = label
          button.style.cssText = [
            'flex:none',
            'cursor:pointer',
            'padding:1px 8px',
            'border-radius:var(--dsw-radius-sm,6px)',
            'background:transparent',
            'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4))',
            'color:var(--dsw-alias-label-secondary,#9aa0a6)',
            'font:var(--dsw-font-xxxs-11,11px/1.7 inherit)',
          ].join(';')
          button.addEventListener('mouseenter', () => {
            button.style.color = 'var(--dsw-alias-label-primary,#eee)'
            button.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))'
          })
          button.addEventListener('mouseleave', () => {
            button.style.color = 'var(--dsw-alias-label-secondary,#9aa0a6)'
            button.style.background = 'transparent'
          })
          return button
        }

        /**
         * "Open the PR panel": only for a github.com pull request, and only while
         * `dsh-github-flow`'s `github-pr` tab is registered.
         */
        function prPanelButton(context, payload) {
          const repo = payload?.repo?.fullName
          const number = payload?.number
          if (payload?.host !== 'github.com') return null
          if (payload.kind !== 'pr') return null
          if (typeof repo !== 'string' || repo === '' || number === undefined) return null
          if (!prPanelAvailable(context)) return null
          const button = footerButton(text.openPr)
          button.dataset.ghlAction = 'open-pr'
          button.title = text.openPrTitle
          button.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            openPrPanel(context, repo, number)
          })
          return button
        }

        /** The "copy clone" control; null when the payload has no repository path. */
        function cloneButton(payload) {
          const command = cloneCommand(payload)
          if (command === undefined) return null
          const button = document.createElement('button')
          button.type = 'button'
          button.dataset.ghlAction = 'clone'
          button.title = command
          button.textContent = text.copyClone
          const base = 'flex:none;cursor:pointer;padding:1px 8px;border-radius:var(--dsw-radius-sm,6px);background:transparent;'
          const idle = 'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));color:var(--dsw-alias-label-secondary,#9aa0a6)'
          button.style.cssText = `${base}${idle};font:var(--dsw-font-xxxs-11,11px/1.7 inherit)`
          button.addEventListener('mouseenter', () => {
            button.style.color = 'var(--dsw-alias-label-primary,#eee)'
            button.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))'
          })
          button.addEventListener('mouseleave', () => {
            button.style.color = 'var(--dsw-alias-label-secondary,#9aa0a6)'
            button.style.background = 'transparent'
          })
          button.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            void (async () => {
              const copied = await copyText(command)
              button.textContent = copied ? text.copied : text.copyFailed
              button.style.borderColor = copied
                ? 'var(--dsw-alias-state-success-primary,#3fb950)'
                : 'var(--dsw-alias-state-error-primary,#f85149)'
              window.setTimeout(() => {
                button.textContent = text.copyClone
                button.style.borderColor = 'var(--dsw-alias-border-l2,rgba(128,128,128,.4))'
              }, 1400)
            })()
          })
          return button
        }

        function renderLoading() {
          const host = ensureCard()
          host.textContent = ''
          const row = document.createElement('div')
          row.style.cssText = 'display:flex;gap:8px;align-items:center;color:var(--dsw-alias-label-secondary,#9aa0a6)'
          const dot = document.createElement('span')
          dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4c8dff);flex:none'
          const label = document.createElement('span')
          label.textContent = text.loading
          row.append(dot, label)
          host.append(row)
          host.style.display = 'block'
          place(activeRect)
          requestAnimationFrame(() => {
            if (host === card) host.style.opacity = '1'
          })
        }

        /** Render one payload into the card. */
        function render(payload, url) {
          const host = ensureCard()
          host.textContent = ''

          if (payload?.ok !== true || payload.repo === undefined) {
            // Not a repository page (marketplace, explore, …): stay silent
            // instead of showing an error where there is no card to show.
            if (payload?.reason === 'unsupported') {
              clearCard()
              activeUrl = null
              return
            }
            const missing = document.createElement('div')
            missing.textContent = payload?.reason === 'not-found'
              ? `${text.missing}: ${url}`
              : text.unavailable
            missing.style.cssText = 'color:var(--dsw-alias-label-secondary,#9aa0a6);overflow-wrap:anywhere'
            host.append(missing)
            host.style.display = 'block'
            place(activeRect)
            requestAnimationFrame(() => { host.style.opacity = '1' })
            return
          }

          const repo = payload.repo
          const head = document.createElement('div')
          head.style.cssText = 'display:flex;gap:10px;align-items:center;margin-bottom:8px'

          if (typeof repo.avatar === 'string' && repo.avatar !== '') {
            const avatar = document.createElement('img')
            avatar.src = repo.avatar
            avatar.alt = ''
            avatar.loading = 'lazy'
            avatar.style.cssText = 'width:28px;height:28px;border-radius:8px;flex:none;background:var(--dsw-alias-bg-layer-2,#2a2a2a)'
            head.append(avatar)
          }

          const titleBox = document.createElement('div')
          titleBox.style.cssText = 'min-width:0;display:flex;flex-direction:column;gap:1px'
          const title = document.createElement('div')
          title.textContent = repo.fullName ?? `${repo.owner ?? ''}/${repo.name ?? ''}`
          title.style.cssText = 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
          const kindline = document.createElement('div')
          const kind = KIND_LABEL[payload.kind] ?? KIND_LABEL.repo
          const bits = [zh ? kind.zh : kind.en]
          const itemLabel = payload.number ?? payload.id
          if (itemLabel !== undefined) bits[0] = `${bits[0]} #${itemLabel}`
          bits.push(repo.private === true ? text.private : text.publicRepo)
          if (repo.archived === true) bits.push(text.archived)
          kindline.textContent = bits.join(' · ')
          kindline.style.cssText = 'color:var(--dsw-alias-label-secondary,#9aa0a6);font:var(--dsw-font-xxxs-11,11px/1.5 inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
          if (repo.archived === true) kindline.style.color = 'var(--dsw-alias-state-warn-primary,#d29922)'
          titleBox.append(title, kindline)
          head.append(titleBox)
          if (typeof payload.provider === 'string' && payload.provider !== '') {
            const provider = chip(payload.provider)
            provider.style.marginLeft = 'auto'
            provider.style.flex = 'none'
            head.append(provider)
          }
          host.append(head)

          if (typeof repo.description === 'string' && repo.description !== '') {
            const description = document.createElement('div')
            description.textContent = repo.description
            description.style.cssText = [
              'color:var(--dsw-alias-label-secondary,#9aa0a6)',
              'margin:0 0 8px',
              'display:-webkit-box',
              '-webkit-line-clamp:3',
              '-webkit-box-orient:vertical',
              'overflow:hidden',
              'overflow-wrap:anywhere',
            ].join(';')
            host.append(description)
          }

          const stats = document.createElement('div')
          stats.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px 10px;margin-bottom:8px;color:var(--dsw-alias-label-secondary,#9aa0a6);font:var(--dsw-font-xxxs-11,11px/1.6 inherit)'
          stats.append(
            line('★', compact(repo.stars)),
            line('⑂', compact(repo.forks)),
            line('◎', compact(repo.issues)),
          )
          if (typeof repo.language === 'string') stats.append(chip(repo.language))
          if (typeof repo.license === 'string') stats.append(chip(repo.license))
          host.append(stats)

          if (Array.isArray(repo.topics) && repo.topics.length > 0) {
            const topics = document.createElement('div')
            topics.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px'
            for (const topic of repo.topics.slice(0, 5)) topics.append(chip(`#${topic}`))
            host.append(topics)
          }

          const detail = detailRow(payload.detail)
          if (detail !== null) host.append(detail)

          const foot = document.createElement('div')
          foot.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));color:var(--dsw-alias-label-secondary,#9aa0a6);font:var(--dsw-font-xxxs-11,11px/1.6 inherit)'
          const prButton = prPanelButton(ctx, payload)
          const clone = cloneButton(payload)
          const actions = document.createElement('div')
          actions.style.cssText = 'display:flex;gap:6px;align-items:center;min-width:0'
          if (prButton !== null) actions.append(prButton)
          if (clone !== null) actions.append(clone)
          const updated = document.createElement('span')
          updated.textContent = `${text.updated} ${ago(repo.pushedAt ?? repo.updatedAt)}`
          updated.style.marginLeft = actions.childElementCount === 0 ? '0' : 'auto'
          updated.style.flex = 'none'
          if (actions.childElementCount > 0) foot.append(actions)
          foot.append(updated)
          host.append(foot)

          const hintRow = document.createElement('div')
          hintRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:5px;color:var(--dsw-alias-label-secondary,#9aa0a6);font:var(--dsw-font-xxxs-11,11px/1.6 inherit)'
          const hint = document.createElement('span')
          hint.textContent = browserTabAvailable(ctx) ? text.hint : text.hintFallback
          const hintMod = document.createElement('span')
          hintMod.textContent = text.hintMod
          hintMod.style.opacity = '.8'
          hintRow.append(hint, hintMod)
          host.append(hintRow)

          host.style.display = 'block'
          place(activeRect)
          requestAnimationFrame(() => {
            if (host === card) {
              place(activeRect)
              host.style.opacity = '1'
            }
          })
        }

        /** Ask for the payload and paint it, unless the pointer moved on. */
        async function show(url, rect) {
          activeUrl = url
          activeRect = rect
          renderLoading()
          const payload = await load(url)
          if (disposed || activeUrl !== url) return
          render(payload, url)
        }

        function cancelHide() {
          if (hideTimer !== 0) {
            clearTimeout(hideTimer)
            hideTimer = 0
          }
        }

        function scheduleHide() {
          cancelHide()
          hideTimer = window.setTimeout(() => {
            hideTimer = 0
            activeUrl = null
            activeRect = null
            clearCard()
          }, HIDE_DELAY_MS)
        }

        function cancelShow() {
          if (showTimer !== 0) {
            clearTimeout(showTimer)
            showTimer = 0
          }
        }

        /** Open one URL on the surface the click is meant to reach. */
        function open(url) {
          let opened = false
          if (browserTabAvailable(ctx)) {
            try {
              ctx.get('sidebarRight').openTab('browser', { params: { url } })
              opened = true
            } catch {
              opened = false
            }
          }
          report('github-link/event', { type: opened ? 'open' : 'fallback' })
          if (!opened) window.open(url, '_blank', 'noopener,noreferrer')
          return opened
        }

        /**
         * Whether this node belongs to a surface this plugin decorates.
         *
         * The floating card lives on `document.body`, outside the transcript,
         * so it is admitted explicitly — otherwise moving the pointer onto the
         * card would count as "left the conversation" and hide it.
         */
        function inConversation(target) {
          if (!(target instanceof Element)) return false
          if (card !== null && card.contains(target)) return true
          return target.closest(CONVERSATION_ROOT) !== null
        }

        /** Only these clicks are ours: nothing else would route them today. */
        function shouldTakeOver(hit) {
          if (hit.fromText) return true
          const anchor = hit.anchor
          if (anchor === null) return false
          return anchor.closest('[data-genui]') !== null
        }

        function onMouseOver(event) {
          if (event.pointerType === 'touch') return
          cancelShow()
          if (!inConversation(event.target)) {
            scheduleHide()
            return
          }
          const hit = urlAt(event.clientX, event.clientY, event.target)
          if (hit === null) {
            if (card !== null && event.target instanceof Node && card.contains(event.target)) return
            scheduleHide()
            return
          }
          cancelHide()
          const url = hit.url
          if (activeUrl === url && card !== null && card.style.display === 'block') {
            activeRect = hit.rect
            place(hit.rect)
            return
          }
          const rect = hit.rect
          showTimer = window.setTimeout(() => {
            showTimer = 0
            void show(url, rect)
          }, SHOW_DELAY_MS)
        }

        function onClick(event) {
          if (event.button !== 0) return
          if (!inConversation(event.target)) {
            scheduleHide()
            return
          }
          const hit = urlAt(event.clientX, event.clientY, event.target)
          if (hit === null) {
            scheduleHide()
            return
          }
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            // Explicit "not here" gesture: leave an anchor to its default, and
            // hand a bare URL to the system browser.
            if (hit.fromText) window.open(hit.url, '_blank', 'noopener,noreferrer')
            scheduleHide()
            return
          }
          if (!shouldTakeOver(hit)) {
            // A plain chat link keeps DSH's own link-opening preference.
            scheduleHide()
            return
          }
          event.preventDefault()
          event.stopPropagation()
          open(hit.url)
          scheduleHide()
        }

        function onKeyDown(event) {
          if (event.key === 'Escape') {
            activeUrl = null
            clearCard()
          }
        }

        function onScroll() {
          if (card !== null && card.style.display === 'block') {
            if (activeRect === null) return clearCard()
            place(activeRect)
          }
        }

        ctx.effect(() => {
          report('github-link/hello', { browserTab: browserTabAvailable(ctx), prPanel: prPanelAvailable(ctx), protocol: location.protocol })
          document.addEventListener('mouseover', onMouseOver, true)
          document.addEventListener('click', onClick, true)
          document.addEventListener('keydown', onKeyDown, true)
          window.addEventListener('scroll', onScroll, { capture: true, passive: true })
          window.addEventListener('resize', onScroll, { passive: true })
          return () => {
            disposed = true
            cancelShow()
            cancelHide()
            document.removeEventListener('mouseover', onMouseOver, true)
            document.removeEventListener('click', onClick, true)
            document.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('scroll', onScroll, true)
            window.removeEventListener('resize', onScroll)
            if (card !== null) card.remove()
            card = null
          }
        }, 'dsh-github-link: transcript decoration')
      },
    }
  },
})

