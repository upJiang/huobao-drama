/**
 * Grok Imagine 图片生成 Adapter（OpenAI 兼容 /v1/images/generations）
 * 文生图: POST /v1/images/generations → { data: [{ url }] }
 * 参考图: POST /v1/images/edits ，image.url 支持公网地址或 data URL
 * 尺寸用 aspect_ratio（由项目里的 1920x1080 等 size 换算），不传 OpenAI 的 size 像素值
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'
import { snapAspectRatio } from './grok-aspect'

const DEFAULT_MODEL = 'grok-imagine-image'

const IMAGE_RATIOS = [
  '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
  '2:1', '1:2', '21:9', '5:2', '19.5:9', '9:19.5', '20:9', '9:20',
] as const

function parseReferenceImages(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

export class GrokImageAdapter implements ImageProviderAdapter {
  provider = 'grok'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const model = record.model || config.model || DEFAULT_MODEL
    const aspectRatio = snapAspectRatio(record.size, IMAGE_RATIOS, '16:9')
    const refs = parseReferenceImages(record.referenceImages)
    const body: Record<string, unknown> = {
      model,
      prompt: record.prompt || '',
      n: 1,
      response_format: 'url',
      aspect_ratio: aspectRatio,
    }

    // 有参考图走 edits；只取第一张（Grok 编辑接口的 image 是单图）
    if (refs.length) {
      body.image = { url: refs[0] }
      return {
        url: joinProviderUrl(config.baseUrl, '/v1', '/images/edits'),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body,
      }
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    const imageUrl = this.extractImageUrl(result)
    if (imageUrl) return { isAsync: false, imageUrl }
    if (this.extractImageBase64(result)) return { isAsync: false }
    const taskId = result?.request_id || result?.task_id
    if (taskId) return { isAsync: true, taskId: String(taskId) }
    const message = result?.error?.message || result?.error || 'No image URL in response'
    throw new Error(typeof message === 'string' ? message : 'No image URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/images/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const status = String(result?.status || '').toLowerCase()
    if (status === 'done' || status === 'completed' || status === 'succeeded' || this.extractImageUrl(result)) {
      return { status: 'completed', imageUrl: this.extractImageUrl(result) || undefined }
    }
    if (status === 'failed' || status === 'expired' || status === 'cancelled') {
      const err = result?.error
      const msg = typeof err === 'string' ? err : (err?.message || '图片生成失败')
      return { status: 'failed', error: msg }
    }
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result?.data?.[0]?.url || result?.url || result?.image?.url || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result?.data?.[0]?.b64_json
    if (!b64) return null
    const mime = result?.data?.[0]?.mime_type || 'image/png'
    return { data: b64, mimeType: mime }
  }
}
