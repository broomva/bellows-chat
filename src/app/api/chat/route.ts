import {
  type UIMessage,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";

/**
 * Chat API — adapter between Vercel AI SDK's UIMessage protocol and the
 * Bellows `chat-agent` workflow on Railway.
 *
 * Wire shape:
 *
 *   UI (useChat) -> UIMessage[] -> /api/chat
 *      -> POST {bellowsUrl}/v1/agents/chat-agent
 *         { messages: [{role: "user"|"assistant", content: string}, ...] }
 *      -> Bellows replays history into a fresh Session, runs the
 *         autonomous loop, and returns a single ChatOutput JSON.
 *      -> we adapt that into a UIMessageStream:
 *         - one "data-bellows-tools" data part with tool / hook metadata
 *         - chunked "text-delta" parts (24-char / 25 ms) for typing UX
 *
 * Multi-turn context retention: useChat sends the FULL message history on
 * every request (this is the AI SDK convention). chat-agent replays that
 * history into its session, so context is preserved across turns without
 * any server-side session storage.
 *
 * Bellows v0.2-pre still buffers the response (real SSE is on the
 * roadmap). Chunking here is a presentation-layer typing effect; the
 * underlying agent call is honest single-shot per user turn.
 */

export const runtime = "nodejs";
export const maxDuration = 90;

const BELLOWS_URL =
  process.env.BELLOWS_URL ?? "https://bellows-production.up.railway.app";

interface BellowsChatResponse {
  answer: string;
  files_read?: string[];
  turns?: number;
  session_id?: string;
  provider?: string;
  error?: string;
}

interface BellowsToolDataPart {
  filesRead: string[];
  denied: string[];
  turns: number;
  provider: string;
  sessionId: string;
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

async function* chunkText(text: string, size = 24, delayMs = 25): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) {
    yield text.slice(i, i + size);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function POST(req: Request) {
  const body = (await req.json()) as { messages?: UIMessage[] };
  const messages = toBellowsMessages(body.messages ?? []);

  if (messages.length === 0) {
    return new Response("missing user message", { status: 400 });
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      let result: BellowsChatResponse;

      try {
        const upstream = await fetch(`${BELLOWS_URL}/v1/agents/chat-agent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages }),
        });
        if (!upstream.ok) {
          const text = await upstream.text();
          writer.write({
            type: "error",
            errorText: `bellows HTTP ${upstream.status}: ${text.slice(0, 500)}`,
          });
          return;
        }
        result = (await upstream.json()) as BellowsChatResponse;
      } catch (err) {
        writer.write({
          type: "error",
          errorText: `bellows unreachable: ${(err as Error).message}`,
        });
        return;
      }

      if (result.error) {
        writer.write({
          type: "error",
          errorText: `bellows error: ${result.error}`,
        });
        return;
      }

      // Surface bellows tool activity + hook stats as a typed data part.
      const toolData: BellowsToolDataPart = {
        filesRead: result.files_read ?? [],
        denied: [],
        turns: result.turns ?? 0,
        provider: result.provider ?? "unknown",
        sessionId: result.session_id ?? "",
      };
      writer.write({ type: "data-bellows-tools", data: toolData });

      // Stream the answer as text-delta chunks for the typing effect.
      const id = crypto.randomUUID();
      writer.write({ type: "text-start", id });
      for await (const chunk of chunkText(result.answer)) {
        writer.write({ type: "text-delta", id, delta: chunk });
      }
      writer.write({ type: "text-end", id });
    },
  });

  return createUIMessageStreamResponse({ stream });
}
