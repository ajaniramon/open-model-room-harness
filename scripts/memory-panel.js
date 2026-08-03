import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../src/config.js";
import { MemoryStore } from "../src/memory-store.js";

const root = resolve(import.meta.dirname, "..");
const pagePath = resolve(root, "scripts", "memory-panel.html");

// Only these fields leave the process. The panel never needs credentials, paths or
// anything else from the runtime configuration.
export function toPanelRecord(record) {
  return {
    id: record.id,
    text: record.text,
    keys: record.keys,
    subject: record.subject.displayName || record.subject.userId,
    subjectId: record.subject.userId,
    guildId: record.scope.guildId,
    channelId: record.scope.channelId,
    privacy: record.privacy,
    significance: record.significance,
    origin: record.source?.origin || "explicit",
    createdAt: record.createdAt,
  };
}

export function toPanelPayload(records, { maxChars, maxItems, generatedAt }) {
  return {
    generatedAt,
    budget: { maxChars, maxItems, perRecordOverhead: 40 },
    records: records.map(toPanelRecord),
  };
}

async function loadPayload() {
  const store = await new MemoryStore({
    path: config.memoryStorePath,
    retentionDays: config.memoryRetentionDays,
    maxTextChars: config.memoryMaxTextChars,
    logger: { warn: () => undefined },
  }).load();
  return toPanelPayload(store.active(), {
    maxChars: config.memoryInjectionMaxChars,
    maxItems: config.memoryInjectionMaxItems,
    generatedAt: new Date().toISOString(),
  });
}

export function createPanelServer() {
  return createServer(async (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "text/plain" }).end("Method not allowed");
      return;
    }
    try {
      if (request.url === "/api/memories") {
        const body = JSON.stringify(await loadPayload());
        response
          .writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
          .end(body);
        return;
      }
      if (request.url === "/" || request.url === "/index.html") {
        response
          .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
          .end(await readFile(pagePath, "utf8"));
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    } catch (error) {
      console.error("Memory panel request failed", error);
      response.writeHead(500, { "content-type": "text/plain" }).end("Internal error");
    }
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (invokedDirectly) {
  const port = Number.parseInt(process.env.JJ_MEMORY_PANEL_PORT || "4380", 10);
  // Bound to loopback on purpose: the panel shows private Discord memory.
  createPanelServer().listen(port, "127.0.0.1", () => {
    console.log(`JJ memory panel: http://127.0.0.1:${port}`);
    console.log(`Reading ${config.memoryStorePath}`);
  });
}
