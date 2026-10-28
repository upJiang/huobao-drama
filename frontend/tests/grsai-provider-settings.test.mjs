import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const settingsPage = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')
const episode = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const ai = readFileSync(new URL('../../backend/src/services/ai.ts', import.meta.url), 'utf8')

test('settings keeps Grok text and adds a separate Grsai media preset', () => {
  assert.match(settingsPage, /grok: \{ label: 'Grok 兼容网关'/)
  assert.match(settingsPage, /grsai: \{ label: 'Grsai 图片', baseUrl: 'https:\/\/grsaiapi\.com', models: \['gpt-image-2\.5'\] \}/)
  assert.match(settingsPage, /grsai: \{ label: 'Grsai MiniMax H3', baseUrl: 'https:\/\/grsaiapi\.com', models: \['minimax-h3'\] \}/)
  assert.doesNotMatch(settingsPage, /text:\s*\{[^}]*grsai/s)
  assert.match(ai, /text: \['openai', 'gemini', 'volcengine', 'grok'\]/)
  assert.match(ai, /'grsai'/)
})

test('episode workspace locks characters first and chains Grsai shots', () => {
  assert.match(episode, /grsai: \{ '480p': '480p', '720p': '768p', '1080p': '1080p' \}/)
  assert.match(episode, /provider === 'grsai'\) return \[\.\.\.charAssets, sceneAsset, \.\.\.propAssets\]/)
  assert.match(episode, /for \(const sb of targets\) await genVid\(sb, \{ silent: true \}\)/)
  assert.match(episode, /不得无故消失/)
})
