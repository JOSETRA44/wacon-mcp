// A minimal Agent Client Protocol agent, speaking the real wire format over
// stdio (JSON-RPC 2.0, one message per line). It records what the client
// sent so tests can assert on it, and plays a scripted turn:
//   text chunk → tool_call read_messages → update with ids → permission
//   request → propose_reply tool call → end_turn.
import { createInterface } from "node:readline";

const log = [];
let nextId = 1000;
const waiting = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

process.stdout.write("some agents log a banner first\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) {
    waiting.get(msg.id)?.(msg.result ?? msg.error);
    waiting.delete(msg.id);
    return;
  }
  log.push({ method: msg.method, params: msg.params });
  if (msg.method === "initialize") return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  if (msg.method === "session/new")
    return send({
      id: msg.id,
      result: {
        sessionId: "S1",
        configOptions: [
          { id: "model", name: "Modelo", category: "model", type: "select", currentValue: "pro", options: [{ group: "g", name: "Gemini", options: [{ value: "pro", name: "Gemini Pro" }, { value: "flash", name: "Gemini Flash", description: "rápido" }] }] },
        ],
      },
    });
  if (msg.method === "session/set_config_option") return send({ id: msg.id, result: { configOptions: [] } });
  if (msg.method === "session/cancel") return;
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    const text = msg.params.prompt[0].text;
    if (text.includes("FAIL")) return send({ id: msg.id, error: { code: -32000, message: "Authentication required" } });
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hola, " } });
    update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: "read_messages (wacon MCP Server)", status: "pending", rawInput: { chat: "a@lid", limit: 2 } });
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: '[{"id":"m2","text":"x"},{"id":"m3"}]' } }] });
    const perm = await ask("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "t2", title: "remember_fact" },
      options: [
        { optionId: "ok", name: "Permitir", kind: "allow_once" },
        { optionId: "no", name: "Rechazar", kind: "reject_once" },
      ],
    });
    log.push({ method: "permission-answer", params: perm });
    update(sid, { sessionUpdate: "tool_call", toolCallId: "t3", title: "propose_reply", status: "completed", rawInput: { chat: "a@lid", text: "¡Claro, nos vemos a las 8!" } });
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "**listo**." } });
    // Echo what we received so the test can inspect the whole exchange.
    update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: JSON.stringify(log) } });
    return send({ id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 30 } } });
  }
});
