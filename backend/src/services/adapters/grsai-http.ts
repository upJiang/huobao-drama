/**
 * Grsai 统一生成接口：POST /v1/api/generate ，轮询 GET /v1/api/result?id=
 * 图片和视频共用同一套状态：running / succeeded / failed / violation。
 */
import { joinProviderUrl } from './url'

export function grsaiGenerateUrl(baseUrl: string): string {
  return joinProviderUrl(baseUrl, '/v1/api', '/generate')
}

export function grsaiResultUrl(baseUrl: string, taskId: string): string {
  const raw = joinProviderUrl(baseUrl, '/v1/api', '/result')
  try {
    const url = new URL(raw)
    url.searchParams.set('id', taskId)
    return url.toString()
  } catch {
    const sep = raw.includes('?') ? '&' : '?'
    return `${raw}${sep}id=${encodeURIComponent(taskId)}`
  }
}

export function grsaiBearerHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
}

export function unwrapGrsai(result: any): any {
  const data = result?.data
  if (data && typeof data === 'object' && (data.id || data.status || data.results)) return data
  return result
}

export function grsaiMediaUrl(result: any): string | null {
  const body = unwrapGrsai(result)
  const url = body?.results?.[0]?.url || body?.url
  return typeof url === 'string' && url.trim() ? url.trim() : null
}

export function parseGrsaiGenerate(result: any): { isAsync: boolean; taskId?: string; mediaUrl?: string } {
  const body = unwrapGrsai(result)
  const status = String(body?.status || '').toLowerCase()
  const mediaUrl = grsaiMediaUrl(result) || undefined
  if (status === 'failed' || status === 'violation') {
    throw new Error(String(body?.error || (status === 'violation' ? '内容未通过审核' : '生成失败')))
  }
  if ((status === 'succeeded' || status === 'success' || status === 'completed') && mediaUrl) {
    return { isAsync: false, mediaUrl }
  }
  if (body?.id) return { isAsync: true, taskId: String(body.id) }
  if (mediaUrl) return { isAsync: false, mediaUrl }
  throw new Error(String(body?.error || 'No task id or media url in response'))
}

export function parseGrsaiPoll(result: any): { status: 'processing' | 'completed' | 'failed'; mediaUrl?: string; error?: string } {
  const body = unwrapGrsai(result)
  const status = String(body?.status || '').toLowerCase()
  if (status === 'succeeded' || status === 'success' || status === 'completed' || status === 'done') {
    const mediaUrl = grsaiMediaUrl(result) || undefined
    if (!mediaUrl) return { status: 'failed', error: String(body?.error || '生成完成但没有返回地址') }
    return { status: 'completed', mediaUrl }
  }
  if (status === 'failed' || status === 'violation' || status === 'cancelled' || status === 'expired') {
    return {
      status: 'failed',
      error: String(body?.error || (status === 'violation' ? '内容未通过审核' : '生成失败')),
    }
  }
  return { status: 'processing' }
}
