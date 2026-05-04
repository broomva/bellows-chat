import {
  type UIMessage,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";

/**
 * Chat API — adapter between Vercel AI SDK's UIMessage protocol and the
 * Bellows agent harness running on Railway.
 *
 * The flow:
 *
 *   UI (useChat) -> UIMessage[] -> /api/chat
 *      -> POST {bellowsUrl}/v1/agents/repo-scout {start_path, question}
 *      -> Bellows runs the autonomous loop end-to-end on Railway
 *      -> JSON {answer, files_read[], turns, hook_events, ...} returned
 *      -> we adapt that into a UIMessageStream:
 *         - a "data-bellows-tools" data part carrying tool/hook metadata
 *         - chunked text-delta parts so the UI feels like real streaming
 *
 * Because Bellows v0.2-pre returns a single buffered JSON (real SSE
 * streaming is on the v0.2 roadmap), we artificially chunk the answer at
 * 24-char boundaries with a small delay to give the typing effect. The
 * underlying agent is honest single-shot.
 */

export const runtime = "nodejs";
export const maxDuration = 90;

const BELLOWS_URL = process.env.BELLOWS_URL ?? "https://bellows-production.up.railway.app";

interface BellowsHookEvents {
  workflow_starts?: number;
  step_starts?: number;
  pre_inference?: number;
  post_inference?: number;
  pre_tool_use?: number;
  post_tool_use?: number;
  denied_paths?: string[];
}

interface BellowsResponse {
  answer: string;
  files_read?: string[];
  turns?: number;
  session_id?: string;
  provider?: string;
  hook_events?: BellowsHookEvents;
  error?: string;
}

interface BellowsToolDataPart {
  filesRead: string[];
  denied: string[];
  turns: number;
  provider: string;
  sessionId: string;
}

function extractQuestion(messages: UIMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  return lastUser.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .trim();
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
  const messages = body.messages ?? [];
  const question = extractQuestion(messages);

  if (!question) {
    return new Response("missing user message", { status: 400 });
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      let result: BellowsResponse;

      try {
        const upstream = await fetch(`${BELLOWS_URL}/v1/agents/repo-scout`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ start_path: ".", question }),
        });
        if (!upstream.ok) {
          const text = await upstream.text();
          writer.write({
            type: "error",
            errorText: `bellows HTTP ${upstream.status}: ${text.slice(0, 500)}`,
          });
          return;
        }
        result = (await upstream.json()) as BellowsResponse;
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

      // Surface bellows tool activity + hook stats as a typed data part
      // the UI can render as a Task component above the answer.
      const data: BellowsToolDataPart = {
        filesRead: result.files_read ?? [],
        denied: result.hook_events?.denied_paths ?? [],
        turns: result.turns ?? 0,
        provider: result.provider ?? "unknown",
        sessionId: result.session_id ?? "",
      };
      writer.write({
        type: "data-bellows-tools",
        data,
      });

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
