/**
 * Local development mock for the Bellows native SSE endpoint.
 *
 * Emits the `/tmp/bellows-stream-contract.md` event sequence on a 50 ms
 * cadence so we can validate the Next.js route + page wiring without a
 * working backend. Activated by setting:
 *
 *   BELLOWS_URL=http://localhost:3000/api/mock-bellows
 *
 * This path mirrors the real backend's URL shape:
 *   /v1/agents/{name}/stream
 * so the only thing the production cutover needs is a different base URL.
 *
 * NOT shipped to production — gated behind NODE_ENV !== "production".
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MockBellowsEvent {
  delayMs: number;
  payload: Record<string, unknown>;
}

function buildScript(userText: string): MockBellowsEvent[] {
  const sessionId = `01KMOCK${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

  // A modestly sized response that tests Streamdown's markdown rendering
  // (heading + bullets + inline code + code fence + bold).
  const answer = userText.toLowerCase().includes("rust")
    ? [
        "## Rust ownership in 200 words\n\n",
        "Rust's **ownership** model is the language's way of guaranteeing ",
        "memory safety without a garbage collector. ",
        "Three rules govern it:\n\n",
        "- Each value has a single *owner*.\n",
        "- When the owner goes out of scope, the value is dropped.\n",
        "- You can borrow a value either immutably (`&T`) any number of times, ",
        "or mutably (`&mut T`) exactly once at a time.\n\n",
        "```rust\nfn main() {\n",
        "    let s = String::from(\"hello\");\n",
        "    take(s);          // ownership moved\n",
        "    // println!(\"{s}\"); // <- compile error: use after move\n",
        "}\n\n",
        "fn take(s: String) {\n",
        "    println!(\"got {s}\");\n",
        "}\n```\n\n",
        "These rules make data races impossible at compile time and let the ",
        "compiler insert deallocations deterministically. They are also the ",
        "reason async Rust feels so different from async JavaScript: futures ",
        "are values you own, not callbacks the runtime keeps alive for you.",
      ]
    : userText.toLowerCase().includes("sse")
      ? [
          "## SSE vs WebSockets\n\n",
          "- **Direction**: SSE is server → client only. WS is full-duplex.\n",
          "- **Transport**: SSE rides plain HTTP/1.1 (or HTTP/2). WS does an ",
          "HTTP Upgrade and then speaks its own framed binary protocol.\n",
          "- **Reconnect**: SSE's `EventSource` reconnects automatically and ",
          "supports `Last-Event-ID` for resume. WS clients have to roll their own.\n",
          "- **Proxies**: SSE is just chunked HTTP, so it survives most ",
          "corporate proxies. WS is sometimes blocked.\n",
          "- **When to pick which**: SSE for one-way streams (LLM tokens, log ",
          "tails, build progress). WS for bidirectional (chat presence, RPC).\n",
        ]
      : [
          "I am `bellows`, a Rust agent harness. ",
          "I run on Railway and stream tokens via SSE — ",
          "this reply is being generated **incrementally**, not all at once. ",
          "Watch the Task widget below: tools light up *while* I'm thinking.",
        ];

  // Simulate one fs_list + one fs_read tool call interleaved with text.
  const events: MockBellowsEvent[] = [
    {
      delayMs: 50,
      payload: {
        type: "session_start",
        session_id: sessionId,
        model: "claude-haiku-4-5",
        provider: "anthropic",
      },
    },
    { delayMs: 50, payload: { type: "turn_start", turn: 0 } },
    {
      delayMs: 100,
      payload: {
        type: "tool_use_start",
        turn: 0,
        id: "toolu_mock_01",
        name: "fs_list",
        label: "/sandbox",
      },
    },
    {
      delayMs: 200,
      payload: {
        type: "tool_use_end",
        turn: 0,
        id: "toolu_mock_01",
        name: "fs_list",
        ok: true,
        denied: false,
      },
    },
    {
      delayMs: 50,
      payload: {
        type: "tool_use_start",
        turn: 0,
        id: "toolu_mock_02",
        name: "fs_read",
        label: "/sandbox/README.md",
      },
    },
    {
      delayMs: 200,
      payload: {
        type: "tool_use_end",
        turn: 0,
        id: "toolu_mock_02",
        name: "fs_read",
        ok: true,
        denied: false,
      },
    },
    { delayMs: 50, payload: { type: "turn_start", turn: 1 } },
  ];

  for (const chunk of answer) {
    events.push({
      delayMs: 50,
      payload: { type: "text_delta", turn: 1, delta: chunk },
    });
  }

  events.push({
    delayMs: 50,
    payload: {
      type: "done",
      turns: 2,
      tools: [
        { name: "fs_list", label: "/sandbox", denied: false },
        { name: "fs_read", label: "/sandbox/README.md", denied: false },
      ],
      stop_reason: "end_turn",
      session_id: sessionId,
    },
  });

  return events;
}

interface MockRequestBody {
  messages?: { role: string; content: string }[];
}

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return new Response("mock disabled in production", { status: 404 });
  }

  let userText = "";
  try {
    const body = (await req.json()) as MockRequestBody;
    const lastUser = (body.messages ?? [])
      .filter((m) => m.role === "user")
      .at(-1);
    userText = lastUser?.content ?? "";
  } catch {
    // ignore; fall through with empty userText
  }

  const events = buildScript(userText);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const ev of events) {
          if (req.signal.aborted) break;
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, ev.delayMs);
            const onAbort = () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            };
            req.signal.addEventListener("abort", onAbort, { once: true });
          });
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(ev.payload)}\n\n`),
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
