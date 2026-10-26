/**
 * dsh-github-link — host half.
 *
 * Serves one read-only JSON route (`/github-link/card`) that returns the
 * "basic information" a hover card needs for a repository URL on GitHub,
 * GitLab or Gitee: identity, description, stars/forks, language, license,
 * topics, archive/visibility state and last activity — plus, for an issue /
 * pull request / merge request URL, that item's title and state.
 *
 * Why a host route instead of a straight browser fetch:
 *   - GitHub anonymous browser calls share 60 requests/hour per IP, which a
 *     hover card burns through in a couple of replies; this process already
 *     has an authenticated `gh` login (or GITHUB_TOKEN / GH_TOKEN), which
 *     raises the ceiling to 5000/hour;
 *   - the three providers answer with three different shapes; normalising
 *     them here keeps the browser half dumb.
 *
 * The route is deliberately public-data-only: it never returns a token, never
 * proxies arbitrary URLs, and only accepts the three repository hosts.
 */
import { execFile } from 'node:child_process'

/** @type {string} */
export const name = 'dsh-github-link'

/** Route mounting requires the browser HTTP carrier. */
export const inject = ['webServer']

/**
 * 请求准入：官方 web-server 契约里 carrier 不做鉴权与 Origin 策略，每个路由要在 handler
 * 开头自己调 connection.requestRejection(req)。宿主没有 connection 服务时放行，保持旧版本兼容。
 * @returns {boolean} true 表示已经拒绝并写完响应，调用方必须立即返回
 */
function deniedByConnection(ctx, req, res) {
  let rejection
  try {
    const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : ctx?.connection
    rejection =
      connection && typeof connection.requestRejection === 'function'
        ? connection.requestRejection(req)
        : undefined
  } catch {
    rejection = undefined
  }
  if (!rejection) return false
  res.statusCode = rejection
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
  return true
}

const ROUTE_PREFIX = '/github-link'
const PLUGIN_VERSION = '0.4.0'
const CACHE_TTL_MS = 10 * 60 * 1000
const FAILURE_TTL_MS = 60 * 1000
const REQUEST_TIMEOUT_MS = 8000
const USER_AGENT = 'dsh-github-link (+https://github.com/omdsh-dev)'

/** Provider label per accepted host. */
const PROVIDERS = {
  'github.com': { label: 'GitHub' },
  'gitlab.com': { label: 'GitLab' },
  'gitee.com': { label: 'Gitee' },
}

/** Path segments that look like `/{owner}/{repo}` but are the site's own pages. */
const RESERVED_OWNERS = {
  'github.com': new Set([
    'about', 'account', 'apps', 'blog', 'codespaces', 'collections', 'contact',
    'customer-stories', 'dashboard', 'enterprise', 'events', 'explore',
    'features', 'gist', 'git-guides', 'github', 'home', 'issues', 'join',
    'login', 'logout', 'marketplace', 'mobile', 'new', 'nonprofit', 'notifications',
    'organizations', 'orgs', 'pricing', 'pulls', 'readme', 'resources', 'search',
    'security', 'sessions', 'settings', 'signup', 'site', 'sponsors', 'stars',
    'team', 'topics', 'trending', 'users', 'watching', 'wiki',
  ]),
  'gitlab.com': new Set([
    'admin', 'dashboard', 'explore', 'groups', 'help', 'projects', 'public',
    'snippets', 'users', '-',
  ]),
  'gitee.com': new Set([
    'about', 'enterprises', 'explore', 'help', 'login', 'notifications',
    'organizations', 'search', 'settings', 'signup', 'users',
  ]),
}

/**
 * Two caches, because the pieces expire differently and are shared differently:
 * a repository is one upstream read per `host/path` no matter how many issue
 * links point into it, while an issue title only applies to one `#number`.
 * Keying the assembled payload alone would let the first hover decide the shape
 * of every later hover for that repository.
 */
const repoCache = new Map()
const detailCache = new Map()
const CACHE_MAX_ENTRIES = 400

/**
 * Whether a browser half has ever announced itself, and what it did.
 *
 * This exists because the client half is loaded from the page's boot payload:
 * after editing client.js the only honest question is "did the running window
 * pick it up?", and this process cannot look into that window. The client
 * posts `/github-link/hello` once per page load and `/github-link/event` when it
 * opens a page, so `GET /github-link/status` answers it from the outside.
 */
const clientState = {
  helloCount: 0,
  lastHelloAt: undefined,
  lastUserAgent: undefined,
  /** Page protocol of the last hello: `dsh-app:` proves the Desktop shell. */
  lastProtocol: undefined,
  lastBrowserTab: undefined,
  /** Whether `dsh-github-flow`'s `github-pr` tab was mounted when the page loaded. */
  lastPrPanel: undefined,
  opens: 0,
  fallbacks: 0,
  prOpens: 0,
  lastEventAt: undefined,
}

/** @type {Promise<string | undefined> | undefined} */
let tokenPromise

/**
 * Resolve one GitHub token: env override first, then the authenticated `gh`
 * CLI. Memoised; absence is not an error (anonymous rate limit applies).
 * @returns {Promise<string | undefined>}
 */
function githubToken() {
  tokenPromise ??= (async () => {
    const fromEnv = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    return await new Promise((resolve) => {
      execFile('gh', ['auth', 'token'], { timeout: 4000 }, (error, stdout) => {
        if (error !== null) return resolve(undefined)
        const token = stdout.trim()
        resolve(token === '' ? undefined : token)
      })
    })
  })()
  return tokenPromise
}

/**
 * Parse a repository URL on one of the accepted hosts.
 *
 * Shapes handled:
 *   github.com/{owner}/{repo}[/…]                 (github)
 *   gitlab.com/group[/subgroup…]/{project}[/-/…]  (gitlab: the project path is
 *                                                  everything before `/-/`, so
 *                                                  nested groups work)
 *   gitee.com/{owner}/{repo}[/…]                  (gitee)
 *
 * @param {string} input - absolute URL from the hovered link.
 * @returns {{ host: string, path: string, kind: string, number?: number } | null}
 */
export function parseRepoUrl(input) {
  let url
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (!Object.hasOwn(PROVIDERS, host)) return null

  const raw = url.pathname.split('/').filter((part) => part !== '')
  if (raw.length < 2) return null
  if (RESERVED_OWNERS[host].has(raw[0].toLowerCase())) return null

  // GitLab marks the boundary between the project path and the in-project
  // route with `/-/`; the rest of the hosts use fixed leading segments.
  const segments = host === 'gitlab.com' ? raw.slice(0, raw.indexOf('-') === -1 ? raw.length : raw.indexOf('-')) : raw.slice(0, 2)
  if (segments.length < 2) return null
  const path = segments.map((part) => part.replace(/\.git$/, '')).join('/')
  if (!/^[\w./-]{3,200}$/.test(path)) return null
  if (segments.some((part) => !/^[\w.-]{1,100}$/.test(part))) return null

  const tail = raw.slice(segments.length).filter((part) => part !== '-')
  const section = (tail[0] ?? '').toLowerCase()
  // Gitee numbers issues as `IKM32Q`, GitHub/GitLab as integers: keep both.
  const rawId = tail[1]
  const numericId = Number(rawId)
  const itemId = Number.isSafeInteger(numericId) && numericId > 0
    ? { number: numericId }
    : typeof rawId === 'string' && /^[\w-]{1,40}$/.test(rawId) ? { id: rawId } : {}
  const base = { host, path }

  if (section === 'issues') return { ...base, kind: 'issue', ...itemId }
  if (section === 'merge_requests' || section === 'pull' || section === 'pulls') return { ...base, kind: 'pr', ...itemId }
  if (section === 'discussions') return { ...base, kind: 'discussion', ...itemId }
  if (section === 'blob' || section === 'tree' || section === 'raw' || section === 'src') return { ...base, kind: 'file' }
  if (section === 'releases' || section === 'tags') return { ...base, kind: 'releases' }
  if (section === 'actions' || section === 'pipelines' || section === 'ci') return { ...base, kind: 'actions' }
  if (section === 'commit' || section === 'commits') return { ...base, kind: 'commit' }
  return { ...base, kind: tail.length === 0 ? 'repo' : 'path' }
}

/**
 * One upstream read with a hard timeout. Redirects are followed (GitHub 301s
 * on renamed repositories, and the target is the same repository).
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<{ status: number, body?: any }>}
 */
async function getJson(url, headers) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, ...headers },
      signal: controller.signal,
    })
    if (response.status === 200) return { status: 200, body: await response.json() }
    return { status: response.status, body: await response.json().catch(() => undefined) }
  } catch {
    return { status: 0 }
  } finally {
    clearTimeout(timer)
  }
}

/** Strip a trailing `/` and expose the value only when it is a non-empty string. */
function str(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Coerce a provider count to a number (three APIs disagree on nullability). */
function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/**
 * GitHub expresses an absent licence as `NOASSERTION`; fall back to its name.
 * @param {{ spdx_id?: unknown, name?: unknown } | undefined} license
 */
function githubLicense(license) {
  const spdx = str(license?.spdx_id)
  if (spdx !== undefined && spdx !== 'NOASSERTION') return spdx
  return str(license?.name)
}

/**
 * GitHub repository read. `path` is `owner/repo`.
 * @param {string} path
 */
async function githubRepo(path) {
  const token = await githubToken()
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  }
  const response = await getJson(`https://api.github.com/repos/${path}`, headers)
  if (response.status !== 200) return { status: response.status }
  const repo = response.body
  return {
    status: 200,
    headers,
    repo: {
      fullName: str(repo.full_name),
      owner: str(repo.owner?.login),
      name: str(repo.name),
      avatar: str(repo.owner?.avatar_url),
      description: str(repo.description),
      homepage: str(repo.homepage),
      stars: count(repo.stargazers_count),
      forks: count(repo.forks_count),
      issues: count(repo.open_issues_count),
      language: str(repo.language),
      license: githubLicense(repo.license),
      pushedAt: str(repo.pushed_at),
      updatedAt: str(repo.updated_at),
      createdAt: str(repo.created_at),
      archived: repo.archived === true,
      private: repo.private === true,
      fork: repo.fork === true,
      topics: Array.isArray(repo.topics) ? repo.topics.filter((t) => typeof t === 'string').slice(0, 6) : [],
      url: str(repo.html_url),
    },
  }
}

/**
 * GitLab project read. GitLab answers counts by default and leaves language /
 * license out of the project payload, so those stay undefined.
 * @param {string} path - project path with namespace.
 */
async function gitlabRepo(path) {
  const response = await getJson(`https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}`, {
    accept: 'application/json',
  })
  if (response.status !== 200) return { status: response.status }
  const repo = response.body
  return {
    status: 200,
    repo: {
      fullName: str(repo.path_with_namespace),
      owner: str(repo.namespace?.full_path) ?? str(repo.namespace?.name),
      name: str(repo.path),
      avatar: str(repo.avatar_url) ?? str(repo.namespace?.avatar_url),
      description: str(repo.description),
      homepage: undefined,
      stars: count(repo.star_count),
      forks: count(repo.forks_count),
      issues: count(repo.open_issues_count),
      language: str(repo.language),
      license: undefined,
      pushedAt: str(repo.last_activity_at),
      updatedAt: str(repo.last_activity_at),
      createdAt: str(repo.created_at),
      archived: repo.archived === true,
      private: repo.visibility !== undefined && repo.visibility !== 'public',
      fork: repo.forked_from_project !== undefined && repo.forked_from_project !== null,
      topics: Array.isArray(repo.topics) ? repo.topics.filter((t) => typeof t === 'string').slice(0, 6) : Array.isArray(repo.tag_list) ? repo.tag_list.filter((t) => typeof t === 'string').slice(0, 6) : [],
      url: str(repo.web_url),
    },
  }
}

/**
 * Gitee repository read. The v5 API is public for public repositories and
 * carries no topics, so those stay empty.
 * @param {string} path
 */
async function giteeRepo(path) {
  const response = await getJson(`https://gitee.com/api/v5/repos/${path}`, { accept: 'application/json' })
  if (response.status !== 200) return { status: response.status }
  const repo = response.body
  return {
    status: 200,
    repo: {
      fullName: str(repo.full_name),
      owner: str(repo.namespace?.path) ?? str(repo.owner?.login),
      name: str(repo.path) ?? str(repo.name),
      avatar: str(repo.owner?.avatar_url),
      description: str(repo.description),
      homepage: str(repo.homepage),
      stars: count(repo.stargazers_count),
      forks: count(repo.forks_count),
      issues: count(repo.open_issues_count),
      language: str(repo.language),
      license: str(repo.license),
      pushedAt: str(repo.updated_at),
      updatedAt: str(repo.updated_at),
      createdAt: str(repo.created_at),
      archived: repo.archived === true,
      private: repo.private === true,
      fork: repo.fork === true,
      topics: [],
      url: str(repo.html_url),
    },
  }
}

const READERS = {
  'github.com': githubRepo,
  'gitlab.com': gitlabRepo,
  'gitee.com': giteeRepo,
}

/**
 * Issue / pull request / merge request title and state, when the URL names one.
 * Best effort: a failure here never fails the card.
 * @param {{ host: string, path: string, kind: string, number?: number }} target
 * @returns {Promise<{ kind: string, number: number, title?: string, state?: string, comments?: number, author?: string } | undefined>}
 */
async function detailFor(target) {
  const entryId = target.number ?? target.id
  if (entryId === undefined) return undefined
  if (target.kind !== 'issue' && target.kind !== 'pr') return undefined
  const base = {
    kind: target.kind,
    ...(target.number === undefined ? {} : { number: target.number }),
    ...(target.id === undefined ? {} : { id: target.id }),
  }

  if (target.host === 'github.com') {
    const token = await githubToken()
    const response = await getJson(`https://api.github.com/repos/${target.path}/issues/${entryId}`, {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    })
    if (response.status !== 200) return base
    const record = response.body
    return {
      ...base,
      // A pull request is served from the issues endpoint with a `pull_request` marker.
      kind: record.pull_request === undefined ? 'issue' : 'pr',
      title: str(record.title),
      state: str(record.state),
      comments: count(record.comments),
      author: str(record.user?.login),
    }
  }

  if (target.host === 'gitlab.com') {
    const project = encodeURIComponent(target.path)
    const section = target.kind === 'pr' ? 'merge_requests' : 'issues'
    const response = await getJson(`https://gitlab.com/api/v4/projects/${project}/${section}/${entryId}`, {
      accept: 'application/json',
    })
    if (response.status !== 200) return base
    const record = response.body
    return {
      ...base,
      title: str(record.title),
      state: str(record.state),
      comments: count(record.user_notes_count),
      author: str(record.author?.username),
    }
  }

  if (target.host === 'gitee.com') {
    const section = target.kind === 'pr' ? 'pulls' : 'issues'
    const response = await getJson(`https://gitee.com/api/v5/repos/${target.path}/${section}/${entryId}`, {
      accept: 'application/json',
    })
    if (response.status !== 200) return base
    const record = response.body
    return {
      ...base,
      title: str(record.title),
      state: str(record.state),
      comments: count(record.comments),
      author: str(record.user?.login),
    }
  }

  return base
}

/**
 * Read one TTL cache entry.
 * @param {Map<string, { expiresAt: number, value: unknown }>} map
 * @param {string} key
 */
function cacheGet(map, key) {
  const hit = map.get(key)
  return hit !== undefined && hit.expiresAt > Date.now() ? hit.value : undefined
}

/**
 * Store one TTL cache entry and bound the map.
 * @param {Map<string, { expiresAt: number, value: unknown }>} map
 * @param {string} key
 * @param {unknown} value
 * @param {number} ttlMs
 */
function cacheSet(map, key, value, ttlMs) {
  map.set(key, { expiresAt: Date.now() + ttlMs, value })
  if (map.size > CACHE_MAX_ENTRIES) {
    const oldest = map.keys().next()
    if (oldest.done !== true) map.delete(oldest.value)
  }
}

/**
 * Resolve one card payload from the repository cache plus the detail cache.
 * @param {{ host: string, path: string, kind: string, number?: number }} target
 */
async function cardFor(target) {
  const repoKey = `${target.host}/${target.path}`.toLowerCase()

  let read = cacheGet(repoCache, repoKey)
  if (read === undefined) {
    const fresh = await READERS[target.host](target.path)
    cacheSet(repoCache, repoKey, fresh, fresh.status === 200 ? CACHE_TTL_MS : FAILURE_TTL_MS)
    read = fresh
  }

  let detail
  if ((target.number !== undefined || target.id !== undefined) && (target.kind === 'issue' || target.kind === 'pr')) {
    const detailKey = `${repoKey}/${target.kind === 'pr' ? 'pr' : 'issue'}#${target.number ?? target.id}`
    detail = cacheGet(detailCache, detailKey)
    if (detail === undefined) {
      const fresh = await detailFor(target).catch(() => undefined)
      if (fresh !== undefined) cacheSet(detailCache, detailKey, fresh, CACHE_TTL_MS)
      detail = fresh
    }
  }

  if (read === undefined) return { ok: false, reason: 'unavailable', host: target.host }
  if (read.status === 200 && read.repo !== undefined) {
    return {
      ok: true,
      host: target.host,
      provider: PROVIDERS[target.host].label,
      kind: target.kind,
      ...(target.number === undefined ? {} : { number: target.number }),
      ...(target.id === undefined ? {} : { id: target.id }),
      repo: read.repo,
      ...(detail === undefined ? {} : { detail }),
    }
  }
  if (read.status === 404) return { ok: false, reason: 'not-found', host: target.host, owner: target.path }
  if (read.status === 403 || read.status === 429) return { ok: false, reason: 'rate-limited', host: target.host }
  return { ok: false, reason: 'unavailable', host: target.host, status: read.status }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/**
 * Reject requests a browser made on another site's behalf: the card is public
 * data, but a stray cross-site GET should not be able to use this Host as an
 * oracle. Same-origin page fetches pass (they carry `same-origin`).
 * @param {import('node:http').IncomingMessage} req
 */
function trustedRequest(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  return true
}

/**
 * Read one small JSON body (the client's event reports).
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
async function readJsonBody(req, limit = 4096) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** One short report the client half sends: a page-load hello or an open event. */
async function handleClientReport(req, res, route) {
  if (req.method !== 'POST') return writeJson(res, 405, { ok: false, reason: 'method-error' })
  const body = await readJsonBody(req)
  const now = new Date().toISOString()
  if (route === 'hello') {
    clientState.helloCount += 1
    clientState.lastHelloAt = now
    clientState.lastUserAgent = str(req.headers['user-agent'])
    clientState.lastProtocol = str(body?.protocol)
    clientState.lastBrowserTab = body?.browserTab === true
    clientState.lastPrPanel = body?.prPanel === true
    return writeJson(res, 200, { ok: true, version: PLUGIN_VERSION, browserTab: body?.browserTab === true })
  }
  const type = str(body?.type)
  if (type === 'open') clientState.opens += 1
  else if (type === 'fallback') clientState.fallbacks += 1
  else if (type === 'open-pr') clientState.prOpens += 1
  else return writeJson(res, 200, { ok: false, reason: 'unknown-event' })
  clientState.lastEventAt = now
  return writeJson(res, 200, { ok: true })
}

/**
 * What the Host can honestly claim about the browser half.
 *
 * A hello only counts as "loaded" when it came from a real page: the client
 * sends `location.protocol`, so `dsh-app:` (Desktop shell) or `http(s):`
 * qualifiers prove the running window picked the module up, while a probe
 * (curl, a test) without one is reported as unverified instead of green.
 */
function describeClient() {
  const protocol = clientState.lastProtocol ?? ''
  const fromPage = /^(dsh-app:|https?:)$/.test(protocol)
  if (clientState.helloCount === 0) {
    return { loaded: false, hint: 'no browser hello yet: refresh the GUI page once' }
  }
  return {
    loaded: fromPage,
    hellos: clientState.helloCount,
    lastHelloAt: clientState.lastHelloAt,
    protocol: protocol === '' ? undefined : protocol,
    userAgent: clientState.lastUserAgent,
    sidebarBrowserTab: clientState.lastBrowserTab,
    prPanelTab: clientState.lastPrPanel,
    opens: clientState.opens,
    fallbacks: clientState.fallbacks,
    prPanelOpens: clientState.prOpens,
    lastEventAt: clientState.lastEventAt,
    ...(fromPage ? {} : { hint: 'last hello carried no page protocol: re-check after a real page load' }),
  }
}

/** What the Host can say about its own halves. */
function handleStatus(res) {
  writeJson(res, 200, {
    ok: true,
    version: PLUGIN_VERSION,
    route: `${ROUTE_PREFIX}/card`,
    upstreams: Object.keys(PROVIDERS),
    client: describeClient(),
    cache: { repos: repoCache.size, details: detailCache.size },
  })
}

/**
 * Route table under `/github-link`:
 *   GET  /card?url=…   hover-card payload
 *   GET  /status       whether the browser half loaded, plus counters
 *   POST /hello        client half announces a page load
 *   POST /event        client half reports `open` / `fallback` / `open-pr`
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handler(req, res) {
  if (!trustedRequest(req)) return writeJson(res, 403, { ok: false, reason: 'forbidden' })

  const requestUrl = new URL(req.url ?? '/', 'http://dsh.internal')
  const route = requestUrl.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')

  if (route === 'status') return handleStatus(res)
  if (route === 'hello' || route === 'event') return handleClientReport(req, res, route)
  if (route !== 'card') return writeJson(res, 404, { ok: false, reason: 'not-found' })

  if (req.method !== 'GET') return writeJson(res, 405, { ok: false, reason: 'method-error' })
  const target = requestUrl.searchParams.get('url')
  if (target === null || target === '') return writeJson(res, 400, { ok: false, reason: 'missing-url' })
  if (target.length > 2048) return writeJson(res, 400, { ok: false, reason: 'url-too-long' })

  const parsed = parseRepoUrl(target)
  if (parsed === null) return writeJson(res, 200, { ok: false, reason: 'unsupported' })

  try {
    writeJson(res, 200, await cardFor(parsed))
  } catch {
    writeJson(res, 500, { ok: false, reason: 'unavailable' })
  }
}

/**
 * Mount the route; cordis disposes it with the plugin.
 * @param {any} ctx
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => (deniedByConnection(ctx, req, res) ? undefined : handler(req, res)),
      }),
    'dsh-github-link: /github-link/card route',
  )
}
