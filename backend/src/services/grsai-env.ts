/**
 * 用环境变量写入 Grsai 图片 / 视频两条配置。
 * 只在 GRSAI_API_KEY 与 GRSAI_BASE_URL 都存在时生效。
 * 不写文本配置，也不改已有的 Grok 行。第一次插入时优先级取该类型最高，
 * 因此和 Grok 一起配置时，图片和视频默认走 Grsai，文本仍走 Grok。
 */
import { now } from '../utils/response.js'

const CONFIGS = [
  { serviceType: 'image' as const, name: 'Grsai 图片' },
  { serviceType: 'video' as const, name: 'Grsai 视频' },
]

export interface GrsaiEnvConfig {
  apiKey: string
  baseUrl: string
  imageModel: string
  videoModel: string
}

export function readGrsaiEnv(): GrsaiEnvConfig | null {
  const apiKey = (process.env.GRSAI_API_KEY || '').trim()
  const baseUrl = (process.env.GRSAI_BASE_URL || '').trim().replace(/\/+$/, '')
  if (!apiKey || !baseUrl) return null
  return {
    apiKey,
    baseUrl,
    imageModel: (process.env.GRSAI_IMAGE_MODEL || '').trim() || 'gpt-image-2.5',
    videoModel: (process.env.GRSAI_VIDEO_MODEL || '').trim() || 'minimax-h3',
  }
}

function modelFor(env: GrsaiEnvConfig, serviceType: 'image' | 'video'): string {
  return serviceType === 'image' ? env.imageModel : env.videoModel
}

export async function bootstrapGrsaiConfigs(): Promise<void> {
  const env = readGrsaiEnv()
  if (!env) return

  const { eq } = await import('drizzle-orm')
  const { db, schema } = await import('../db/index.js')

  for (const item of CONFIGS) {
    const rows = await db.select().from(schema.aiServiceConfigs)
      .where(eq(schema.aiServiceConfigs.serviceType, item.serviceType))
    const existing = rows.find((row) => row.name === item.name && (row.provider || '').toLowerCase() === 'grsai')
    const ts = now()
    const model = JSON.stringify([modelFor(env, item.serviceType)])

    if (existing) {
      await db.update(schema.aiServiceConfigs).set({
        provider: 'grsai',
        baseUrl: env.baseUrl,
        apiKey: env.apiKey,
        model,
        isActive: true,
        updatedAt: ts,
      }).where(eq(schema.aiServiceConfigs.id, existing.id))
      continue
    }

    const maxPriority = rows.reduce((max, row) => Math.max(max, row.priority || 0), 0)
    await db.insert(schema.aiServiceConfigs).values({
      serviceType: item.serviceType,
      provider: 'grsai',
      name: item.name,
      baseUrl: env.baseUrl,
      apiKey: env.apiKey,
      model,
      priority: maxPriority + 1,
      isActive: true,
      createdAt: ts,
      updatedAt: ts,
    })
  }

  console.log(`🎬 已从环境变量同步 Grsai 图片/视频配置（${env.baseUrl}），文本配置未改动`)
}
