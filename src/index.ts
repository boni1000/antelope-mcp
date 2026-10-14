#!/usr/bin/env node
/**
 * antelope-mcp: an MCP server (stdio) for any Antelope chain.
 * Logs go to stderr; stdout belongs to the MCP protocol.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Chain } from './chain.js'
import { loadConfig } from './config.js'
import { registerReadTools } from './read.js'
import { Signer } from './signer.js'
import { registerWriteTools } from './write.js'

export const VERSION = '0.1.0'

async function main() {
  const cfg = loadConfig()
  const chain = new Chain(cfg.url, 15000, cfg.maxRps)
  if (cfg.chainId) {
    // Refuse to run against the wrong chain (e.g. a mainnet URL in a testnet setup).
    const info = await chain.info()
    if (info.chain_id !== cfg.chainId) throw new Error(`ANTELOPE_CHAIN_ID mismatch: ${cfg.url} serves chain ${info.chain_id}`)
  }
  let signer: Signer | undefined
  if (cfg.signer) {
    signer = new Signer(cfg.signer)
    await signer.verify(chain) // key must belong to the permission; allowed actions come from the chain
    delete process.env.ANTELOPE_PRIVATE_KEY
  }
  const server = new McpServer({ name: 'antelope-mcp', version: VERSION })
  registerReadTools(server, chain, cfg)
  registerWriteTools(server, chain, cfg, signer)
  await server.connect(new StdioServerTransport())
  const mode = signer ? `signing as ${signer.authority} for ${signer.allowed.length ? signer.allowed.join(', ') : 'no actions'}` : 'read + prepare (no key)'
  console.error(`antelope-mcp ${VERSION} ready on ${cfg.chainName ?? cfg.url}: ${mode}`)
}

main().catch((e) => {
  console.error(`antelope-mcp: ${e.message}`)
  process.exit(1)
})
