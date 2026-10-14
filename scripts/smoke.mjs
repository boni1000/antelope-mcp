// Smoke test over a real MCP stdio connection: node scripts/smoke.mjs <chain-url> '<json list of [tool, args]>'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const [url, callsJson] = process.argv.slice(2)
const client = new Client({ name: 'smoke', version: '0' })
await client.connect(new StdioClientTransport({ command: 'node', args: [process.env.SMOKE_SERVER ?? 'dist/index.js'], env: { ...process.env, ANTELOPE_URL: url }, stderr: 'ignore' }))
const { tools } = await client.listTools()
console.log(`tools: ${tools.map((t) => t.name).join(', ')}`)
for (const [tool, args] of JSON.parse(callsJson)) {
  const t0 = Date.now()
  const r = await client.callTool({ name: tool, arguments: args })
  const text = r.content[0].text
  console.log(`\n### ${tool} ${JSON.stringify(args)} -> ${r.isError ? 'ERROR' : 'ok'} (${Date.now() - t0} ms)\n${text.length > 900 && !process.env.SMOKE_FULL ? text.slice(0, 900) + " …" : text}`)
}
await client.close()
