import {
  type UIMessage,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";

/**
 * Chat API — adapter between Vercel AI SDK's UIMessage protocol and the
 * Bellows `chat-agent` workflow on Railway.
 *
 * Wire shape (v0.2-pre-streaming, native SSE):
 *
 *   UI (useChat) -> UIMessage[] -> /api/chat
 *      -> POST {bellowsUrl}/v1/agents/chat-agent/stream
 *         (Accept: text/event-stream)
 *         { messages: [{role: "user"|"assistant", content: string}, ...] }
 *      -> Bellows replays history into a fresh Session, runs the
 *         autonomous loop, and emits an SSE stream of contract events
 *         (session_start | turn_start | text_delta | tool_use_start |
 *          tool_use_end | done | error).
 *      -> we translate each event into a UIMessageStream chunk per the
 *         Translation Table in /tmp/bellows-stream-contract.md.
 *
 * Multi-turn context retention: useChat sends the FULL message history on
 * every request (this is the AI SDK convention). chat-agent replays that
 * history into its session, so context is preserved across turns without
 * any server-side session storage.
 *
 * The artificial chunkText generator from v0.1 is GONE. Streaming is now
 * driven by the upstream model's actual token cadence.
 */

export const runtime = "nodejs";
export const maxDuration = 300;

const BELLOWS_URL =
  process.env.BELLOWS_URL ?? "https://bellows-production.up.railway.app";

// ---------------------------------------------------------------------------
// Bellows contract (mirror of /tmp/bellows-stream-contract.md)
// ---------------------------------------------------------------------------

interface BellowsToolUse {
  name: string;
  label: string;
  denied: boolean;
}

interface BellowsSessionStart {
  type: "session_start";
  session_id: string;
  model: string;
  provider: string;
}

interface BellowsTurnStart {
  type: "turn_start";
  turn: number;
}

interface BellowsTextDelta {
  type: "text_delta";
  turn: number;
  delta: string;
}

interface BellowsToolUseStart {
  type: "tool_use_start";
  turn: number;
  id: string;
  name: string;
  label: string;
}

interface BellowsToolUseEnd {
  type: "tool_use_end";
  turn: number;
  id: string;
  name: string;
  ok: boolean;
  denied: boolean;
  error?: string;
}

interface BellowsDone {
  type: "done";
  turns: number;
  tools: BellowsToolUse[];
  stop_reason: string;
  session_id: string;
}

interface BellowsError {
  type: "error";
  message: string;
}

type BellowsEvent =
  | BellowsSessionStart
  | BellowsTurnStart
  | BellowsTextDelta
  | BellowsToolUseStart
  | BellowsToolUseEnd
  | BellowsDone
  | BellowsError;

// ---------------------------------------------------------------------------
// UIMessageStream data part shapes (mirrors of the page.tsx tagged union)
// ---------------------------------------------------------------------------

interface BellowsSessionDataPart {
  sessionId: string;
  model: string;
  provider: string;
}

interface BellowsToolStartDataPart {
  id: string;
  name: string;
  label: string;
}

interface BellowsToolEndDataPart {
  id: string;
  ok: boolean;
  denied: boolean;
  error?: string;
}

interface BellowsToolsFinalDataPart {
  turns: number;
  tools: BellowsToolUse[];
  stopReason: string;
}

interface OutgoingChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Convert the AI SDK's UIMessage[] into the simple {role, content} shape
 * chat-agent expects. Strips empty messages, joins multi-part text
 * (rare — useChat sends one text part per turn), and clamps the role to
 * what the workflow accepts.
 */
function toBellowsMessages(uiMessages: UIMessage[]): OutgoingChatMessage[] {
  const out: OutgoingChatMessage[] = [];
  for (const m of uiMessages) {
    const text = m.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim();
    if (!text) continue;
    out.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: text,
    });
  }
  return out;
}

/**
 * Robust SSE line parser.
 *
 * Handles:
 *  - chunk boundaries that split events mid-frame (we buffer until \n\n)
 *  - multi-line `data:` fields (joined with \n per the SSE spec)
 *  - blank-line keepalives and comment lines (`:` prefix)
 *  - the `[DONE]` sentinel
 *
 * Yields parsed Bellows events. Lines that fail JSON.parse are surfaced
 * as a synthetic `error` event so the caller can decide what to do.
 */
async function* parseBellowsSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<BellowsEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines. Both \n\n and \r\n\r\n
      // are valid frame separators; normalize CRLF to LF first.
      buffer = buffer.replace(/\r\n/g, "\n");

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = parseFrame(frame);
        if (event) yield event;
      }
    }
    // Flush a trailing frame if the upstream ended without a final \n\n.
    const tail = buffer.trim();
    if (tail.length > 0) {
      const event = parseFrame(tail);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): BellowsEvent | null {
  // Concatenate every `data:` line. Comment lines (`:` prefix) and other
  // SSE fields (`event:`, `id:`, `retry:`) are ignored — the contract uses
  // only `data:`.
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      // Per SSE spec: strip exactly one leading space after the colon.
      const v = line.slice(5);
      dataLines.push(v.startsWith(" ") ? v.slice(1) : v);
    }
  }
  if (dataLines.length === 0) return null;

  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return null;

  try {
    return JSON.parse(payload) as BellowsEvent;
  } catch (e) {
    return {
      type: "error",
      message: `bellows SSE decode failure: ${(e as Error).message} (payload: ${payload.slice(0, 200)})`,
    };
  }
}

export async function POST(req: Request) {
  const body = (await req.json()) as { messages?: UIMessage[] };
  const messages = toBellowsMessages(body.messages ?? []);

  if (messages.length === 0) {
    return new Response("missing user message", { status: 400 });
  }

  // Forward client aborts to the upstream Bellows fetch so the server-side
  // tool loop can cancel its in-flight Anthropic call.
  const upstreamAbort = new AbortController();
  const onClientAbort = () => upstreamAbort.abort();
  req.signal.addEventListener("abort", onClientAbort, { once: true });

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // One stable id per request — reused across every text-delta.
      const textId = crypto.randomUUID();
      let textStarted = false;

      const ensureTextStart = () => {
        if (!textStarted) {
          writer.write({ type: "text-start", id: textId });
          textStarted = true;
        }
      };
      const ensureTextEnd = () => {
        if (textStarted) {
          writer.write({ type: "text-end", id: textId });
          textStarted = false;
        }
      };

      let upstream: Response;
      try {
        upstream = await fetch(`${BELLOWS_URL}/v1/agents/chat-agent/stream`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify({ messages }),
          signal: upstreamAbort.signal,
        });
      } catch (err) {
        writer.write({
          type: "error",
          errorText: `bellows unreachable: ${(err as Error).message}`,
        });
        return;
      }

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        writer.write({
          type: "error",
          errorText: `bellows HTTP ${upstream.status}: ${text.slice(0, 500)}`,
        });
        return;
      }

      if (!upstream.body) {
        writer.write({
          type: "error",
          errorText: "bellows returned no response body",
        });
        return;
      }

      try {
        for await (const ev of parseBellowsSSE(upstream.body, req.signal)) {
          switch (ev.type) {
            case "session_start":
              writer.write({
                type: "data-bellows-session",
                data: {
                  sessionId: ev.session_id,
                  model: ev.model,
                  provider: ev.provider,
                } satisfies BellowsSessionDataPart,
              });
              break;

            case "turn_start":
              // Suppressed — implicit in text-start, per the contract's
              // Translation Table.
              break;

            case "text_delta":
              ensureTextStart();
              writer.write({
                type: "text-delta",
                id: textId,
                delta: ev.delta,
              });
              break;

            case "tool_use_start":
              writer.write({
                type: "data-bellows-tool-start",
                data: {
                  id: ev.id,
                  name: ev.name,
                  label: ev.label,
                } satisfies BellowsToolStartDataPart,
              });
              break;

            case "tool_use_end":
              writer.write({
                type: "data-bellows-tool-end",
                data: {
                  id: ev.id,
                  ok: ev.ok,
                  denied: ev.denied,
                  error: ev.error,
                } satisfies BellowsToolEndDataPart,
              });
              break;

            case "done":
              ensureTextEnd();
              writer.write({
                type: "data-bellows-tools-final",
                data: {
                  turns: ev.turns,
                  tools: ev.tools,
                  stopReason: ev.stop_reason,
                } satisfies BellowsToolsFinalDataPart,
              });
              return;

            case "error":
              ensureTextEnd();
              writer.write({
                type: "error",
                errorText: `bellows error: ${ev.message}`,
              });
              return;
          }
        }

        // Stream ended without an explicit `done` or `error` — close the
        // text channel cleanly so the UI doesn't hang on an open paragraph.
        ensureTextEnd();
      } catch (err) {
        ensureTextEnd();
        if ((err as { name?: string }).name === "AbortError") {
          // Client closed the connection — nothing to report.
          return;
        }
        writer.write({
          type: "error",
          errorText: `bellows stream interrupted: ${(err as Error).message}`,
        });
      } finally {
        req.signal.removeEventListener("abort", onClientAbort);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
