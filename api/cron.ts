import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow Vercel cron or internal calls
  const auth = req.headers.authorization
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    // Import and call the main handler's refresh logic
    const mainHandler = (await import('./index.js')).default
    const fakeReq = { url: '/api/refresh', method: 'POST', body: {}, headers: {} } as any
    const fakeRes = {
      status: () => ({ json: (d: any) => d }),
      setHeader: () => {},
      json: (d: any) => d,
    } as any
    await mainHandler(fakeReq, fakeRes)
    return res.json({ success: true, timestamp: new Date().toISOString() })
  } catch (err: any) {
    console.error('Cron error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
