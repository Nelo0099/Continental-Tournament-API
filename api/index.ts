import type { VercelRequest, VercelResponse } from '@vercel/node'

const DATABASE_URL = process.env.DATABASE_URL!
const APP_ID = 'ac90e984-9dff-4368-d8f5-08dee052f0fb'
const REFRESH_KEY = 'NjgyZDJhNjcyYThjNGQ1ZTI5ODkwOGRlZGZmMTVhMzBoblNvcU1oSHJQUk5wZ1VMWUdaRXliUWpVY05qaWRRZA=='
const TOURNAMENT_ID = 'f36f9c9d-6674-4be9-d107-08deddcfab7c'

// Neon connection (lazy)
let neonSql: any = null
async function sql() {
  if (!neonSql) {
    const { neon } = await import('@neondatabase/serverless')
    neonSql = neon(DATABASE_URL)
  }
  return neonSql
}

// Query helper - uses $1, $2 placeholders (PostgreSQL native)
async function query(text: string, params: any[] = []): Promise<any[]> {
  const s = await sql()
  const result = await s.query(text, params)
  return result as any[]
}

// Ensure tables exist
async function ensureTables() {
  await query(`CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, logo TEXT, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, video_url TEXT DEFAULT '', updated_at TIMESTAMPTZ DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS members (id SERIAL PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT DEFAULT '', game_account_id TEXT DEFAULT '', avatar TEXT DEFAULT '', profile_url TEXT DEFAULT '', captain INTEGER DEFAULT 0)`)
  await query(`CREATE TABLE IF NOT EXISTS player_stats (game_account_id TEXT PRIMARY KEY, player_name TEXT DEFAULT '', win INTEGER DEFAULT 0, lose INTEGER DEFAULT 0, rank_tier INTEGER DEFAULT 0, leaderboard_rank INTEGER, mmr REAL DEFAULT 0, top_heroes TEXT DEFAULT '[]', recent_matches TEXT DEFAULT '[]', is_private INTEGER DEFAULT 0, last_updated TIMESTAMPTZ DEFAULT NOW())`)
  await query(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`)
}

let tablesReady = false
// Simple in-memory cache with TTL
const cache = new Map<string, { data: any; expires: number }>()
function getCached(key: string, ttlMs: number): any | null {
  const entry = cache.get(key)
  if (entry && entry.expires > Date.now()) return entry.data
  return null
}
function setCache(key: string, data: any, ttlMs: number) {
  cache.set(key, { data, expires: Date.now() + ttlMs })
}

// Auth token cache
let currentToken: { value: string; expiresAt: string } | null = null
async function getAccessToken(): Promise<string> {
  if (currentToken && new Date(currentToken.expiresAt) > new Date()) return currentToken.value
  const resp = await fetch('https://publicapi.challengermode.com/mk1/v1/auth/access_keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshKey: REFRESH_KEY }),
  })
  if (!resp.ok) throw new Error(`Auth failed: ${resp.status}`)
  currentToken = await resp.json() as { value: string; expiresAt: string }
  return currentToken.value
}

// Fetch teams from Challengermode and store in Neon
async function fetchAndStoreTeams(): Promise<number> {
  const token = await getAccessToken()
  const gql = `{
    tournament(tournamentId: "${TOURNAMENT_ID}") {
      attendance {
        signups {
          lineups {
            name
            logo(size: MEDIUM) { url }
            members {
              captain
              gameAccountId
              user {
                username
                profilePicture(size: SMALL) { url }
                profileUrl
              }
            }
          }
        }
      }
    }
  }`
  const resp = await fetch('https://publicapi.challengermode.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'x-application-id': APP_ID },
    body: JSON.stringify({ query: gql }),
  })
  if (!resp.ok) throw new Error(`GraphQL failed: ${resp.status}`)
  const json = await resp.json() as any
  if (json.errors) throw new Error(json.errors[0]?.message)

  const lineups = json.data.tournament.attendance.signups.lineups
  const teams = lineups.filter((l: any) => l.members.length >= 5).map((l: any, i: number) => ({
    id: String(i + 1), name: l.name,
    logo: l.logo?.url || 'https://image1.challengermode.com/0baba6b8-fa10-44ae-2de0-08deddc82054_256_256',
    members: l.members.map((m: any) => ({
      name: m.user.username, role: m.captain ? 'Captain' : '',
      gameAccountId: m.gameAccountId, avatar: m.user.profilePicture?.url || '',
      profileUrl: m.user.profileUrl, captain: m.captain,
    })),
  }))

  // Preserve video URLs
  const existing = await query('SELECT id, video_url FROM teams')
  const videoUrls = new Map<string, string>()
  for (const row of existing) if (row.video_url) videoUrls.set(row.id, row.video_url)

  // Clear and re-insert
  await query('DELETE FROM members')
  await query('DELETE FROM teams')

  for (const team of teams) {
    await query('INSERT INTO teams (id, name, logo, wins, losses, video_url) VALUES ($1, $2, $3, 0, 0, $4)',
      [team.id, team.name, team.logo, videoUrls.get(team.id) || ''])
    for (const m of team.members) {
      await query('INSERT INTO members (team_id, name, role, game_account_id, avatar, profile_url, captain) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [team.id, m.name, m.role, m.gameAccountId, m.avatar, m.profileUrl, m.captain ? 1 : 0])
    }
  }

  await query("INSERT INTO meta (key, value) VALUES ('lastUpdated', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(Date.now())])
  await query("INSERT INTO meta (key, value) VALUES ('teamCount', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(teams.length)])

  return teams.length
}

// Hero maps
const HERO_MAP: Record<string, string> = {"1":"Anti-Mage","2":"Axe","3":"Bane","4":"Bloodseeker","5":"Crystal Maiden","6":"Drow Ranger","7":"Earthshaker","8":"Juggernaut","9":"Mirana","10":"Morphling","11":"Shadow Fiend","12":"Phantom Lancer","13":"Puck","14":"Pudge","15":"Razor","16":"Sand King","17":"Storm Spirit","18":"Sven","19":"Tiny","20":"Vengeful Spirit","21":"Windranger","22":"Zeus","23":"Kunkka","25":"Lina","26":"Lion","27":"Shadow Shaman","28":"Slardar","29":"Tidehunter","30":"Witch Doctor","31":"Lich","32":"Riki","33":"Enigma","34":"Tinker","35":"Sniper","36":"Necrophos","37":"Warlock","38":"Beastmaster","39":"Queen of Pain","40":"Venomancer","41":"Faceless Void","42":"Wraith King","43":"Death Prophet","44":"Phantom Assassin","45":"Pugna","46":"Templar Assassin","47":"Viper","48":"Luna","49":"Dragon Knight","50":"Dazzle","51":"Clockwerk","52":"Leshrac","53":"Nature's Prophet","54":"Lifestealer","55":"Dark Seer","56":"Clinkz","57":"Omniknight","58":"Enchantress","59":"Huskar","60":"Night Stalker","61":"Broodmother","62":"Bounty Hunter","63":"Weaver","64":"Jakiro","65":"Batrider","66":"Chen","67":"Spectre","68":"Ancient Apparition","69":"Doom","70":"Ursa","71":"Spirit Breaker","72":"Gyrocopter","73":"Alchemist","74":"Invoker","75":"Silencer","76":"Outworld Destroyer","77":"Lycan","78":"Brewmaster","79":"Shadow Demon","80":"Lone Druid","81":"Chaos Knight","82":"Meepo","83":"Treant Protector","84":"Ogre Magi","85":"Undying","86":"Rubick","87":"Disruptor","88":"Nyx Assassin","89":"Naga Siren","90":"Keeper of the Light","91":"Io","92":"Visage","93":"Slark","94":"Medusa","95":"Troll Warlord","96":"Centaur Warrunner","97":"Magnus","98":"Timbersaw","99":"Bristleback","100":"Tusk","101":"Skywrath Mage","102":"Abaddon","103":"Elder Titan","104":"Legion Commander","105":"Techies","106":"Ember Spirit","107":"Earth Spirit","108":"Underlord","109":"Terrorblade","110":"Phoenix","111":"Oracle","112":"Winter Wyvern","113":"Arc Warden","114":"Monkey King","119":"Dark Willow","120":"Pangolier","121":"Grimstroke","123":"Hoodwink","126":"Void Spirit","128":"Snapfire","129":"Mars","131":"Ringmaster","135":"Dawnbreaker","136":"Marci","137":"Primal Beast","138":"Muerta","145":"Kez"}
const HERO_NAME: Record<string, string> = {"1":"antimage","2":"axe","3":"bane","4":"bloodseeker","5":"crystal_maiden","6":"drow_ranger","7":"earthshaker","8":"juggernaut","9":"mirana","10":"morphling","11":"nevermore","12":"phantom_lancer","13":"puck","14":"pudge","15":"razor","16":"sand_king","17":"storm_spirit","18":"sven","19":"tiny","20":"vengefulspirit","21":"windrunner","22":"zuus","23":"kunkka","25":"lina","26":"lion","27":"shadow_shaman","28":"slardar","29":"tidehunter","30":"witch_doctor","31":"lich","32":"riki","33":"enigma","34":"tinker","35":"sniper","36":"necrolyte","37":"warlock","38":"beastmaster","39":"queenofpain","40":"venomancer","41":"faceless_void","42":"skeleton_king","43":"death_prophet","44":"phantom_assassin","45":"pugna","46":"templar_assassin","47":"viper","48":"luna","49":"dragon_knight","50":"dazzle","51":"rattletrap","52":"leshrac","53":"furion","54":"life_stealer","55":"dark_seer","56":"clinkz","57":"omniknight","58":"enchantress","59":"huskar","60":"night_stalker","61":"broodmother","62":"bounty_hunter","63":"weaver","64":"jakiro","65":"batrider","66":"chen","67":"spectre","68":"ancient_apparition","69":"doom_bringer","70":"ursa","71":"spirit_breaker","72":"gyrocopter","73":"alchemist","74":"invoker","75":"silencer","76":"obsidian_destroyer","77":"lycan","78":"brewmaster","79":"shadow_demon","80":"lone_druid","81":"chaos_knight","82":"meepo","83":"treant","84":"ogre_magi","85":"undying","86":"rubick","87":"disruptor","88":"nyx_assassin","89":"naga_siren","90":"keeper_of_the_light","91":"wisp","92":"visage","93":"slark","94":"medusa","95":"troll_warlord","96":"centaur","97":"magnataur","98":"shredder","99":"bristleback","100":"tusk","101":"skywrath_mage","102":"abaddon","103":"elder_titan","104":"legion_commander","105":"techies","106":"ember_spirit","107":"earth_spirit","108":"abyssal_underlord","109":"terrorblade","110":"phoenix","111":"oracle","112":"winter_wyvern","113":"arc_warden","114":"monkey_king","119":"dark_willow","120":"pangolier","121":"grimstroke","123":"hoodwink","126":"void_spirit","128":"snapfire","129":"mars","131":"ringmaster","135":"dawnbreaker","136":"marci","137":"primal_beast","138":"muerta","145":"kez"}

function parseDotaId(gaid: string): string | null { const m = gaid.match(/\[U:\d+:(\d+)\]/); return m ? m[1] : null }

async function fetchPlayerStats(gaid: string, name: string): Promise<any> {
  const dotaId = parseDotaId(gaid)
  if (!dotaId) return null
  const [profile, wl, recent, heroes] = await Promise.all([
    fetch(`https://api.opendota.com/api/players/${dotaId}`).then(r => r.json()),
    fetch(`https://api.opendota.com/api/players/${dotaId}/wl`).then(r => r.json()),
    fetch(`https://api.opendota.com/api/players/${dotaId}/recentMatches`).then(r => r.json()),
    fetch(`https://api.opendota.com/api/players/${dotaId}/heroes`).then(r => r.json()),
  ])
  const isPrivate = (wl.win || 0) === 0 && (wl.lose || 0) === 0 && (recent || []).length === 0
  const topHeroes = (heroes || []).sort((a: any, b: any) => b.games - a.games).slice(0, 3).map((h: any) => ({
    heroId: h.hero_id, heroName: HERO_MAP[h.hero_id] || `#${h.hero_id}`,
    heroImage: `/api/hero-image/${HERO_NAME[h.hero_id] || 'antimage'}.png`,
      heroVideo: `/api/hero-video/${HERO_NAME[h.hero_id] || 'antimage'}.webm`,
    games: h.games, win: h.win, winRate: h.games > 0 ? Math.round((h.win / h.games) * 100) : 0,
  }))
  const matches = (recent || []).slice(0, 5).map((m: any) => ({
    matchId: m.match_id, heroId: m.hero_id, heroName: HERO_MAP[m.hero_id] || `#${m.hero_id}`,
    heroImage: `/api/hero-image/${HERO_NAME[m.hero_id] || 'antimage'}.png`,
      heroVideo: `/api/hero-video/${HERO_NAME[m.hero_id] || 'antimage'}.webm`,
    won: m.player_slot < 128 ? m.radiant_win : !m.radiant_win,
    kills: m.kills, deaths: m.deaths, assists: m.assists, duration: m.duration,
    startTime: m.start_time, gpm: m.gold_per_min, xpm: m.xp_per_min, heroDamage: m.hero_damage,
  }))
  const stats = {
    gameAccountId: gaid, playerName: name,
    win: wl.win || 0, lose: wl.lose || 0,
    winRate: (wl.win || 0) + (wl.lose || 0) > 0 ? Math.round(((wl.win || 0) / ((wl.win || 0) + (wl.lose || 0))) * 100) : 0,
    rankTier: profile.rank_tier || 0, leaderboardRank: profile.leaderboard_rank || null,
    mmr: profile.computed_mmr || 0, topHeroes, recentMatches: matches,
    isPrivate, lastUpdated: new Date().toISOString(),
  }
  // Best-effort store in DB (don't block on failure)
  try {
    await query(
      `INSERT INTO player_stats (game_account_id, player_name, win, lose, rank_tier, leaderboard_rank, mmr, top_heroes, recent_matches, is_private, last_updated) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()) ON CONFLICT (game_account_id) DO UPDATE SET player_name=EXCLUDED.player_name, win=EXCLUDED.win, lose=EXCLUDED.lose, rank_tier=EXCLUDED.rank_tier, leaderboard_rank=EXCLUDED.leaderboard_rank, mmr=EXCLUDED.mmr, top_heroes=EXCLUDED.top_heroes, recent_matches=EXCLUDED.recent_matches, is_private=EXCLUDED.is_private, last_updated=EXCLUDED.last_updated`,
      [gaid, name, stats.win, stats.lose, stats.rankTier, stats.leaderboardRank, stats.mmr, JSON.stringify(topHeroes), JSON.stringify(matches), isPrivate ? 1 : 0]
    )
  } catch (e: any) { console.error(`DB store failed for ${name}:`, e.message) }
  return stats
}

async function fetchBracket() {
  const token = await getAccessToken()
  const resp = await fetch('https://publicapi.challengermode.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'x-application-id': APP_ID },
    body: JSON.stringify({ query: `{ tournament(tournamentId: "${TOURNAMENT_ID}") { state stages { format index lineupCount } } }` }),
  })
  if (!resp.ok) throw new Error(`GraphQL bracket failed: ${resp.status}`)
  const json = await resp.json() as any
  if (json.errors) throw new Error(json.errors[0]?.message)
  const t = json.data.tournament
  await query("INSERT INTO meta (key, value) VALUES ('bracketState', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [t.state])
  await query("INSERT INTO meta (key, value) VALUES ('bracketStages', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(t.stages)])
}

// Response helper
function json(res: VercelResponse, data: any, status = 200) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  return res.status(status).json(data)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return json(res, {}, 200)

  try {
    if (!tablesReady) { await ensureTables(); tablesReady = true }

    const url = decodeURIComponent(req.url || '')
    const method = req.method || 'GET'

    // GET /api/teams
    if (method === 'GET' && url === '/api/teams') {
      const cached = getCached('teams', 60000)
      if (cached) return json(res, cached)
      const countResult = await query('SELECT COUNT(*) as count FROM teams')
      if (Number(countResult[0]?.count) === 0) {
        try { await fetchAndStoreTeams() } catch (e: any) { console.error('Auto-refresh failed:', e.message) }
      }
      const teams = await query('SELECT * FROM teams')
      const result = []
      for (const t of teams) {
        const members = await query('SELECT * FROM members WHERE team_id = $1', [t.id])
        result.push({ id: t.id, name: t.name, logo: t.logo, wins: t.wins, losses: t.losses, videoUrl: t.video_url || '', members: members.map((m: any) => ({ name: m.name, role: m.role, gameAccountId: m.game_account_id, avatar: m.avatar, profileUrl: m.profile_url, captain: m.captain === 1 })) })
      }
      const lastUpdated = await query("SELECT value FROM meta WHERE key = 'lastUpdated'")
      const teamsResponse = { teams: result, lastUpdated: lastUpdated[0] ? Number(lastUpdated[0].value) : null }
      setCache('teams', teamsResponse, 60000)
      return json(res, teamsResponse)
    }

    // POST /api/refresh
    if (method === 'POST' && url === '/api/refresh') {
      const count = await fetchAndStoreTeams()
      return json(res, { success: true, teamCount: count })
    }

    // GET /api/bracket
    if (method === 'GET' && url === '/api/bracket') {
      const cachedBracket = getCached('bracket', 60000)
      if (cachedBracket) return json(res, cachedBracket)
      const state = await query("SELECT value FROM meta WHERE key = 'bracketState'")
      const stages = await query("SELECT value FROM meta WHERE key = 'bracketStages'")
      if (!state[0]?.value || state[0].value === 'UNKNOWN') {
        try { await fetchBracket() } catch (e: any) { console.error('Auto-fetch bracket failed:', e.message) }
        const freshState = await query("SELECT value FROM meta WHERE key = 'bracketState'")
        const freshStages = await query("SELECT value FROM meta WHERE key = 'bracketStages'")
        return json(res, { state: freshState[0]?.value || 'UNKNOWN', stages: freshStages[0] ? JSON.parse(freshStages[0].value) : [] })
      }
      return json(res, { state: state[0]?.value || 'UNKNOWN', stages: stages[0] ? JSON.parse(stages[0].value) : [] })
    }

    // POST /api/bracket/refresh
    if (method === 'POST' && url === '/api/bracket/refresh') {
      await fetchBracket()
      const state = await query("SELECT value FROM meta WHERE key = 'bracketState'")
      const stages = await query("SELECT value FROM meta WHERE key = 'bracketStages'")
      return json(res, { success: true, state: state[0]?.value || 'UNKNOWN', stages: stages[0] ? JSON.parse(stages[0].value) : [] })
    }

    // GET /api/player-stats
    if (method === 'GET' && url === '/api/player-stats') {
      const rows = await query('SELECT * FROM player_stats')
      const stats: Record<string, any> = {}
      for (const r of rows) { stats[r.game_account_id] = { gameAccountId: r.game_account_id, playerName: r.player_name, win: r.win, lose: r.lose, winRate: r.win + r.lose > 0 ? Math.round((r.win / (r.win + r.lose)) * 100) : 0, rankTier: r.rank_tier, leaderboardRank: r.leaderboard_rank, mmr: r.mmr, topHeroes: JSON.parse(r.top_heroes || '[]'), recentMatches: JSON.parse(r.recent_matches || '[]'), isPrivate: r.is_private === 1, lastUpdated: r.last_updated } }
      return json(res, { stats })
    }

    // GET /api/player-stats/:id
    if (method === 'GET' && url.match(/^\/api\/player-stats\/[^/]+$/)) {
      const id = url.split('/api/player-stats/')[1]
      const row = (await query('SELECT * FROM player_stats WHERE game_account_id = $1', [id]))[0]
      if (!row) return json(res, { stats: null })
      return json(res, { stats: { gameAccountId: row.game_account_id, playerName: row.player_name, win: row.win, lose: row.lose, winRate: row.win + row.lose > 0 ? Math.round((row.win / (row.win + row.lose)) * 100) : 0, rankTier: row.rank_tier, leaderboardRank: row.leaderboard_rank, mmr: row.mmr, topHeroes: JSON.parse(row.top_heroes || '[]'), recentMatches: JSON.parse(row.recent_matches || '[]'), isPrivate: row.is_private === 1, lastUpdated: row.last_updated } })
    }

    // POST /api/player-stats/:id/fetch
    if (method === 'POST' && url.match(/^\/api\/player-stats\/[^/]+\/fetch$/)) {
      const id = url.split('/api/player-stats/')[1].split('/')[0]
      const row = (await query('SELECT name FROM members WHERE game_account_id = $1', [id]))[0]
      const stats = await fetchPlayerStats(id, row?.name || 'Unknown')
      if (!stats) return json(res, { stats: null })
      return json(res, { stats })
    }

    // PUT /api/teams/:id/video
    if (method === 'PUT' && url.match(/^\/api\/teams\/[^/]+\/video$/)) {
      const id = url.split('/api/teams/')[1].split('/')[0]
      const body = req.body || {}
      await query('UPDATE teams SET video_url = $1 WHERE id = $2', [body.videoUrl || '', id])
      return json(res, { success: true })
    }



    // GET /api/hero-video/:name - proxy hero videos from Steam CDN
    if (method === 'GET' && url.match(/^\/api\/hero-video\/[^/]+$/)) {
      const heroName = url.split('/api/hero-video/')[1]
      const cacheKey = 'video-' + heroName
      const cached = getCached(cacheKey, 86400000) // 24h cache
      if (cached) {
        res.setHeader('Content-Type', cached.contentType)
        res.setHeader('Cache-Control', 'public, max-age=86400')
        return res.status(200).send(cached.data)
      }
      try {
        const videoUrl = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/videos/dota_react/heroes/' + heroName
        const resp = await fetch(videoUrl)
        if (!resp.ok) return json(res, { error: 'Video not found' }, 404)
        const buffer = await resp.arrayBuffer()
        const contentType = resp.headers.get('content-type') || 'video/webm'
        setCache(cacheKey, { data: Buffer.from(buffer), contentType }, 86400000)
        res.setHeader('Content-Type', contentType)
        res.setHeader('Cache-Control', 'public, max-age=86400')
        return res.status(200).send(Buffer.from(buffer))
      } catch (e) {
        return json(res, { error: 'Failed to fetch hero video' }, 500)
      }
    }

    // GET /api/hero-image/:name - proxy hero images from Steam CDN
    if (method === 'GET' && url.match(/^\/api\/hero-image\/[^/]+$/)) {
      const heroName = url.split('/api/hero-image/')[1]
      const cacheKey = 'hero-' + heroName
      const cached = getCached(cacheKey, 86400000) // 24h cache
      if (cached) {
        res.setHeader('Content-Type', cached.contentType)
        res.setHeader('Cache-Control', 'public, max-age=86400')
        return res.status(200).send(cached.data)
      }
      try {
        const heroUrl = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/' + heroName
        const resp = await fetch(heroUrl)
        if (!resp.ok) return json(res, { error: 'Hero not found' }, 404)
        const buffer = await resp.arrayBuffer()
        const contentType = resp.headers.get('content-type') || 'image/png'
        setCache(cacheKey, { data: Buffer.from(buffer), contentType }, 86400000)
        res.setHeader('Content-Type', contentType)
        res.setHeader('Cache-Control', 'public, max-age=86400')
        return res.status(200).send(Buffer.from(buffer))
      } catch (e) {
        return json(res, { error: 'Failed to fetch hero image' }, 500)
      }
    }

    return json(res, { error: 'Not found' }, 404)
  } catch (err: any) {
    console.error('API Error:', err.message)
    return json(res, { error: err.message }, 500)
  }
}


