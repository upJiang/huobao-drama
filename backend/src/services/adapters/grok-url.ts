/**
 * Grok 网关有时把成片地址写成相对路径（/v1/videos/{id}/content），
 * 并且下载该地址必须带同一把 Bearer key。第三方 CDN（如 imgen.x.ai）的绝对地址不附带密钥。
 */
export function resolveGrokAssetUrl(baseUrl: string, assetUrl: string): string {
  if (!assetUrl) return assetUrl
  if (/^https?:\/\//i.test(assetUrl)) return assetUrl
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL(assetUrl, base).toString()
}

export function grokAssetRequestHeaders(baseUrl: string, apiKey: string, assetUrl: string): Record<string, string> | undefined {
  if (!apiKey || !assetUrl) return undefined
  try {
    const absolute = resolveGrokAssetUrl(baseUrl, assetUrl)
    const assetOrigin = new URL(absolute).origin
    const gatewayOrigin = new URL(baseUrl).origin
    if (assetOrigin !== gatewayOrigin) return undefined
    return { Authorization: `Bearer ${apiKey}` }
  } catch {
    return undefined
  }
}
