import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { request } from 'node:https'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { sourceUrlSchema } from '../model.ts'

const blocked = new BlockList()
for (const [network, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blocked.addSubnet(network, bits, 'ipv4')
blocked.addSubnet('2001:db8::', 32, 'ipv6')
blocked.addSubnet('2001::', 23, 'ipv6')
blocked.addSubnet('2002::', 16, 'ipv6')
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address)
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !blocked.check(address, 'ipv6')
}
export interface PublicHttpResult { readonly status: number; readonly text: string; readonly headers: Readonly<Record<string, string>> }
export type PublicHttp = (url: string, options?: { readonly signal?: AbortSignal | undefined; readonly etag?: string | undefined; readonly modifiedSince?: string | undefined; readonly bearer?: string | undefined }) => Promise<PublicHttpResult>
const maxBodyBytes = 8 * 1024 * 1024 // An interactive feed, not a bulk dataset or media download.

export const publicHttp: PublicHttp = async (rawUrl, options = {}) => {
  let url = new URL(sourceUrlSchema.parse(rawUrl))
  const deadline = AbortSignal.timeout(15000)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  for (let redirect = 0; redirect <= 3; redirect++) {
    signal.throwIfAborted()
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const resolved = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true })
    if (!resolved.length || resolved.some(entry => !isPublicAddress(entry.address))) throw new Error('Source destination is not a public internet address')
    const pinned = resolved[0]!
    const response = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
      const req = request(url, {
        signal,
        // Pin the vetted address at connection time; retain the original Host/SNI for TLS.
        lookup: (_host, settings, callback) => { if (settings.all) callback(null, [{ address: pinned.address, family: pinned.family }]); else callback(null, pinned.address, pinned.family) },
        headers: { 'User-Agent': 'Leitbild-SituationMonitor/1.0 (+https://leitbild.app)', Accept: 'application/geo+json, application/json, application/atom+xml, application/rss+xml, application/xml, text/xml', 'Accept-Encoding': 'gzip, deflate, br', ...(options.etag ? { 'If-None-Match': options.etag } : {}), ...(options.modifiedSince ? { 'If-Modified-Since': options.modifiedSince } : {}), ...(options.bearer ? { Authorization: 'Bearer ' + options.bearer } : {}) },
      }, res => {
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(res.headers)) if (typeof value === 'string') headers[key] = value
        const chunks: Buffer[] = []
        let bytes = 0
        res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBodyBytes) res.destroy(new Error('Source response exceeds 8 MiB limit')); else chunks.push(chunk) })
        res.on('error', reject)
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end()
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location
      if (!location || redirect === 3) throw new Error('Invalid or excessive source redirects')
      const next = new URL(sourceUrlSchema.parse(new URL(location, url).href))
      if (options.bearer && next.origin !== url.origin) throw new Error('Credentialed source redirected to another origin')
      url = next
      continue
    }
    const encoding = response.headers['content-encoding']
    const decompressOptions = { maxOutputLength: maxBodyBytes }
    const body = response.body.length === 0 ? response.body : encoding === 'gzip' ? gunzipSync(response.body, decompressOptions) : encoding === 'br' ? brotliDecompressSync(response.body, decompressOptions) : encoding === 'deflate' ? inflateSync(response.body, decompressOptions) : response.body
    if (encoding && !['gzip', 'br', 'deflate', 'identity'].includes(encoding)) throw new Error('Unsupported response compression')
    if (body.length > maxBodyBytes) throw new Error('Decoded source response exceeds 8 MiB limit')
    return { status: response.status, headers: response.headers, text: body.toString('utf8') }
  }
  throw new Error('Source redirect limit exceeded')
}
