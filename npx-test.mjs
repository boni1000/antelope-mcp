import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const spec = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'npx-test-'))
const cache = mkdtempSync(join(tmpdir(), 'npm-cache-'))
const t0 = Date.now()
const client = new Client({ name: 'npx-test', version: '0' })
await client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', spec], cwd: dir, env: { ...process.env, npm_config_cache: cache, ANTELOPE_URL: 'https://jungle4.greymass.com', ANTELOPE_CHAIN_NAME: 'Jungle4' }, stderr: 'ignore' }), { timeout: 240000 })
const { tools } = await client.listTools()
const r = await client.callTool({ name: 'chain_info', arguments: {} })
console.log(`${spec.slice(0, 60)}: started in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${tools.length} tools, chain_info -> ${JSON.parse(r.content[0].text).name} ${JSON.parse(r.content[0].text).server_version}`)
await client.close()
