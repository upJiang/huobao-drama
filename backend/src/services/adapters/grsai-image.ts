/**
 * Grsai 图片 Adapter — gpt-image-2.5
 * POST /v1/api/generate  { model, prompt, aspectRatio, replyType: async, images? }
 * GET  /v1/api/result?id=
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { grsaiImageAspect } from './grsai-prompt'
import { grsaiBearerHeaders, grsaiGenerateUrl, grsaiResultUrl, parseGrsaiGenerate, parseGrsaiPoll, grsaiMediaUrl } from './grsai-http'

const DEFAULT_MODEL = 'gpt-image-2.5'

function parseReferenceImages(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String).map((url) => url.trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

export class GrsaiImageAdapter implements ImageProviderAdapter {
  provider = 'grsai'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const model = (record.model || config.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL
    const prompt = (record.prompt || '').trim()
    if (!prompt) throw new Error('Grsai 生图需要提示词')
    const images = parseReferenceImages(record.referenceImages).slice(0, 9)
    const body: Record<string, unknown> = {
      model,
      prompt,
      aspectRatio: grsaiImageAspect(record.size),
      replyType: 'async',
    }
    if (images.length) body.images = images
    if (model === 'gpt-image-2' || model === 'gpt-image-2.5') body.quality = 'auto'

    return {
      url: grsaiGenerateUrl(config.baseUrl),
      method: 'POST',
      headers: grsaiBearerHeaders(config.apiKey),
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    const parsed = parseGrsaiGenerate(result)
    return { isAsync: parsed.isAsync, taskId: parsed.taskId, imageUrl: parsed.mediaUrl }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: grsaiResultUrl(config.baseUrl, taskId),
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const parsed = parseGrsaiPoll(result)
    return { status: parsed.status, imageUrl: parsed.mediaUrl, error: parsed.error }
  }

  extractImageUrl(result: any): string | null {
    return grsaiMediaUrl(result)
  }

  extractImageBase64(): { data: string; mimeType: string } | null {
    return null
  }
}
