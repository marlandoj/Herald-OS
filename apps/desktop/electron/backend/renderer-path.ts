/**
 * Decode a renderer REST path once for authorization, without changing the wire path.
 * Escaped identifiers (e.g. MCP names) are supported, but path structure must be
 * unambiguous to URL parsing and the backend's path decoder. This is not a global
 * renderer credential boundary: other inherited REST/file/terminal powers remain.
 */
export function rendererApiPath(target: unknown): string | undefined {
  if (typeof target !== 'string' || !target.startsWith('/api/') ||
    /[\s\\?#]/.test(target) || target.includes('//')) return undefined
  try {
    if (new URL(target, 'http://hermes.invalid').pathname !== target) return undefined
    const wireSegments = target.split('/')
    const segments = wireSegments.map((segment, index) => {
      const decoded = decodeURIComponent(segment)
      // Never permit encoded separators, controls or dot-segment traversal.
      if (/[\/\\\p{Cc}\p{Cf}]/u.test(decoded) || decoded === '.' || decoded === '..') throw new Error('Invalid path')
      // MCP's named routes use a single-decoded string key, not another URL. A
      // literal percent is data only in that identifier position; escape-shaped
      // percent sequences remain ambiguous and fail closed, including %2f/%2e.
      const mcpName = index === 4 && wireSegments[1] === 'api' && wireSegments[2] === 'mcp' &&
        wireSegments[3] === 'servers' && (wireSegments.length === 5 ||
          (wireSegments.length === 6 && ['enabled', 'test', 'auth'].includes(wireSegments[5]!)))
      if (decoded.includes('%') && (!mcpName || /%[0-9a-f]{2}/i.test(decoded))) throw new Error('Ambiguous percent')
      if (segment.includes('%') && encodeURIComponent(decoded) !== segment) throw new Error('Noncanonical path')
      return decoded
    })
    return segments.join('/')
  } catch {
    return undefined
  }
}
