import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export const connectStdio = (server: Server): Promise<void> => {
  const transport = new StdioServerTransport();
  return server.connect(transport);
};
