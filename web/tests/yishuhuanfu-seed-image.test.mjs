import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { createPinia } from 'pinia'
import { createServer } from 'vite'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'

const require = createRequire(import.meta.url)
const { setup: setupSsrStyles } = createRequire(require.resolve('naive-ui'))('@css-render/vue3-ssr')

test('the Yishu Huanfu seed claim button displays the seed image returned by the activity API', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({
    root,
    configFile: false,
    appType: 'custom',
    plugins: [vue()],
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['naive-ui'] },
  })
  try {
    const { default: Panel } = await server.ssrLoadModule('/src/components/activity/YishuHuanfuActivityPanel.vue')
    const { default: api } = await server.ssrLoadModule('/src/api/index.ts')
    const { useAccountStore } = await server.ssrLoadModule('/src/stores/account.ts')
    const { useYishuHuanfuStore } = await server.ssrLoadModule('/src/stores/yishuhuanfu.ts')
    const seedImage = '/game-config/seed_images_named/seed_images/20307.png'
    const snapshot = {
      activityId: '2026111708',
      active: true,
      seed: { id: '20307', name: '红薯种子', image: seedImage, balance: '28', balanceKnown: true },
      actions: { claimSeed: { enabled: true, available: true, availabilityKnown: true } },
    }
    t.mock.method(api, 'get', async url => ({
      data: { ok: true, data: url === '/api/activity-center/yishuhuanfu' ? snapshot : {} },
    }))

    const pinia = createPinia()
    const app = createSSRApp(Panel).use(pinia)
    setupSsrStyles(app)
    const accounts = useAccountStore(pinia)
    accounts.accounts = [{ id: 'seed-image-fixture', name: 'Fixture' }]
    accounts.currentAccountId = 'seed-image-fixture'
    assert.equal(await useYishuHuanfuStore(pinia).load(accounts.currentAccountId), true)

    const html = await renderToString(app)
    const claimButton = html.match(/<button\b[^>]*>.*?<\/button>/gs)?.find(button => button.includes('领取红薯种子'))
    assert.ok(claimButton, 'the seed claim button is rendered')
    assert.match(claimButton, /<img\b[^>]*src="\/game-config\/seed_images_named\/seed_images\/20307\.png"/)
  }
  finally {
    await server.close()
  }
})
