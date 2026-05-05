"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { ChevronRightIcon, FlameIcon, FolderSearchIcon, ShieldIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from "@/components/ai-elements/task";

// ---------------------------------------------------------------------------
// Bellows data-part shapes (mirrors the ones the route emits in route.ts).
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

interface BellowsToolUseFinal {
  name: string;
  label: string;
  denied: boolean;
}

interface BellowsToolsFinalDataPart {
  turns: number;
  tools: BellowsToolUseFinal[];
  stopReason: string;
}

interface BellowsSessionPart {
  type: "data-bellows-session";
  data: BellowsSessionDataPart;
}

interface BellowsToolStartPart {
  type: "data-bellows-tool-start";
  data: BellowsToolStartDataPart;
}

interface BellowsToolEndPart {
  type: "data-bellows-tool-end";
  data: BellowsToolEndDataPart;
}

interface BellowsToolsFinalPart {
  type: "data-bellows-tools-final";
  data: BellowsToolsFinalDataPart;
}

type MessagePart = UIMessage["parts"][number];

function getPartType(part: MessagePart): string {
  return (part as { type: string }).type;
}

function isSessionPart(part: MessagePart): part is BellowsSessionPart {
  return getPartType(part) === "data-bellows-session";
}

function isToolStartPart(part: MessagePart): part is BellowsToolStartPart {
  return getPartType(part) === "data-bellows-tool-start";
}

function isToolEndPart(part: MessagePart): part is BellowsToolEndPart {
  return getPartType(part) === "data-bellows-tool-end";
}

function isToolsFinalPart(part: MessagePart): part is BellowsToolsFinalPart {
  return getPartType(part) === "data-bellows-tools-final";
}

// ---------------------------------------------------------------------------
// Per-message tool accumulator. Lives in render — recomputed each pass from
// the message's parts (which is the canonical event log).
// ---------------------------------------------------------------------------

type ToolStatus = "running" | "ok" | "error" | "denied";

interface ToolRow {
  id: string;
  name: string;
  label: string;
  status: ToolStatus;
  error?: string;
}

interface MessageBellowsState {
  session?: BellowsSessionDataPart;
  /** Live tool rows keyed by id, in arrival order. */
  liveTools: ToolRow[];
  /** If the final summary arrived, this is the canonical replacement. */
  finalSummary?: BellowsToolsFinalDataPart;
}

function buildBellowsState(parts: readonly MessagePart[]): MessageBellowsState {
  const liveById = new Map<string, ToolRow>();
  const order: string[] = [];
  let session: BellowsSessionDataPart | undefined;
  let finalSummary: BellowsToolsFinalDataPart | undefined;

  for (const part of parts) {
    if (isSessionPart(part)) {
      session = part.data;
      continue;
    }
    if (isToolStartPart(part)) {
      const { id, name, label } = part.data;
      if (!liveById.has(id)) order.push(id);
      liveById.set(id, { id, name, label, status: "running" });
      continue;
    }
    if (isToolEndPart(part)) {
      const existing = liveById.get(part.data.id);
      const status: ToolStatus = part.data.denied
        ? "denied"
        : part.data.ok
          ? "ok"
          : "error";
      if (existing) {
        liveById.set(existing.id, { ...existing, status, error: part.data.error });
      } else {
        // tool-end with no matching start — surface it anyway.
        order.push(part.data.id);
        liveById.set(part.data.id, {
          id: part.data.id,
          name: "(unknown)",
          label: "",
          status,
          error: part.data.error,
        });
      }
      continue;
    }
    if (isToolsFinalPart(part)) {
      finalSummary = part.data;
      continue;
    }
  }

  return {
    session,
    liveTools: order.map((id) => liveById.get(id)!).filter(Boolean),
    finalSummary,
  };
}

const SUGGESTIONS = [
  "Hi! What are you?",
  "What model are you running on?",
  "List the files in your sandbox.",
  "Tell me a quick joke about Rust.",
  "Write me a 200-word paragraph about Rust ownership.",
  "Explain how SSE differs from WebSockets in 5 bullets.",
];

export default function Page() {
  const [text, setText] = useState("");
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  const isBusy = status === "submitted" || status === "streaming";

  // The id of the last assistant message — used to scope the typing cursor
  // and isAnimating to only the message that's actively streaming.
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant") return messages[i].id;
    }
    return null;
  }, [messages]);

  const submit = (raw: string) => {
    const t = raw.trim();
    if (!t || isBusy) return;
    sendMessage({ text: t });
    setText("");
  };

  const handlePromptSubmit = (msg: PromptInputMessage) => {
    if (msg.text) submit(msg.text);
  };

  return (
    <div className="mx-auto flex h-dvh max-w-4xl flex-col px-4 py-3 md:py-5">
      <header className="flex flex-wrap items-center gap-3 pb-3">
        <FlameIcon className="size-5 shrink-0 text-amber-500" />
        <div className="flex flex-col">
          <h1 className="text-base font-semibold tracking-tight">
            bellows · chat-agent
          </h1>
          <p className="text-xs text-muted-foreground">
            rust agent harness · claude haiku 4.5 · railway · vercel ai sdk
          </p>
        </div>
        <a
          href="https://github.com/broomva/bellows"
          target="_blank"
          rel="noreferrer"
          className="ml-auto rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
        >
          github.com/broomva/bellows
        </a>
      </header>

      <Conversation className="flex-1 rounded-lg border bg-card">
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={<FolderSearchIcon className="size-12 text-muted-foreground" />}
              title="Talk to bellows-chat"
              description="A real conversational agent running on a Rust harness on Railway. It keeps context across turns, can use fs_list / fs_read / bash on its sandbox when you ask, and surfaces every tool call below the reply."
            >
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => submit(s)}
                    disabled={isBusy}
                    className="rounded-full border border-dashed px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </ConversationEmptyState>
          ) : (
            messages.map((message) => {
              const isLastAssistant =
                message.role === "assistant" && message.id === lastAssistantId;
              const isStreamingThisMessage =
                isLastAssistant && status === "streaming";
              const bellowsState = buildBellowsState(message.parts);

              // Render data parts ONCE per message (not interleaved), so the
              // Task widget appears as a single block beside the assistant
              // text. We render them after the text so the prose stays the
              // visual focus and the tool log lives below it.
              const textParts: { key: string; text: string }[] = [];
              for (let i = 0; i < message.parts.length; i += 1) {
                const part = message.parts[i];
                if (part.type === "text") {
                  textParts.push({
                    key: `${message.id}-text-${i}`,
                    text: part.text,
                  });
                }
              }

              const hasAnyToolActivity =
                bellowsState.liveTools.length > 0 ||
                bellowsState.finalSummary !== undefined;
              const showTaskWidget =
                message.role === "assistant" &&
                (hasAnyToolActivity || bellowsState.session !== undefined);

              return (
                <Message from={message.role} key={message.id}>
                  <MessageContent>
                    {textParts.map((tp) =>
                      message.role === "assistant" ? (
                        <MessageResponse
                          key={tp.key}
                          isAnimating={isStreamingThisMessage}
                          caret="block"
                        >
                          {tp.text}
                        </MessageResponse>
                      ) : (
                        <MessageResponse key={tp.key}>{tp.text}</MessageResponse>
                      ),
                    )}

                    {showTaskWidget ? (
                      <TaskWidget
                        state={bellowsState}
                        isStreaming={isStreamingThisMessage}
                      />
                    ) : null}
                  </MessageContent>
                </Message>
              );
            })
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {error ? (
        <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {error.message}
        </div>
      ) : null}

      <PromptInput onSubmit={handlePromptSubmit} className="mt-3">
        <PromptInputBody>
          <PromptInputTextarea
            placeholder="Ask the bellows agent — it will use fs_list / fs_read on its sandbox to investigate."
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            disabled={isBusy}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <ChevronRightIcon className="size-3" />
              backend: bellows on railway
            </span>
          </PromptInputTools>
          <PromptInputSubmit
            disabled={!text.trim() || isBusy}
            status={status}
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task widget — renders both the live (streaming) tool rows and the final
// canonical summary. While streaming, prefer the live accumulator; once
// `data-bellows-tools-final` arrives, swap to the canonical list (this also
// reconciles any out-of-order events).
// ---------------------------------------------------------------------------

interface TaskWidgetProps {
  state: MessageBellowsState;
  isStreaming: boolean;
}

function TaskWidget({ state, isStreaming }: TaskWidgetProps) {
  const { session, liveTools, finalSummary } = state;

  // While streaming OR if we never received `done`, show live rows.
  // Once `data-bellows-tools-final` arrives, show the canonical list.
  const useFinal = finalSummary !== undefined && !isStreaming;

  const turns = finalSummary?.turns ?? 0;
  const events = useFinal
    ? (finalSummary?.tools.length ?? 0)
    : liveTools.length;
  const provider = session?.provider ?? "bellows";
  const summary = isStreaming
    ? `streaming · ${events} tool ${events === 1 ? "call" : "calls"} · ${provider}`
    : `${turns} model turn${turns === 1 ? "" : "s"} · ${events} tool ${
        events === 1 ? "call" : "calls"
      } · ${provider}`;

  return (
    <Task className="mb-2 w-full" defaultOpen>
      <TaskTrigger title={summary} />
      <TaskContent>
        {useFinal ? (
          <FinalToolList tools={finalSummary?.tools ?? []} />
        ) : (
          <LiveToolList rows={liveTools} />
        )}
        {session?.sessionId ? (
          <TaskItem>
            <span className="text-muted-foreground">session</span>{" "}
            <TaskItemFile>{session.sessionId}</TaskItemFile>
          </TaskItem>
        ) : null}
      </TaskContent>
    </Task>
  );
}

function LiveToolList({ rows }: { rows: ToolRow[] }) {
  if (rows.length === 0) {
    return (
      <TaskItem>
        <span className="text-muted-foreground">
          (waiting for the agent to call a tool…)
        </span>
      </TaskItem>
    );
  }

  return (
    <>
      {rows.map((row) => (
        <TaskItem key={`live-${row.id}`}>
          {row.status === "running" ? (
            <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400">
              <span className="inline-block size-2 animate-pulse rounded-full bg-current" />
              {row.name}
            </span>
          ) : row.status === "denied" ? (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <ShieldIcon className="size-3" />
              denied
            </span>
          ) : row.status === "error" ? (
            <span className="text-destructive">{row.name} (error)</span>
          ) : (
            <span className="text-emerald-600 dark:text-emerald-400">
              {row.name}
            </span>
          )}{" "}
          {row.label ? <TaskItemFile>{row.label}</TaskItemFile> : null}
          {row.status === "denied" ? (
            <span className="ml-1 text-muted-foreground">
              {row.name} blocked by allow-deny hook
            </span>
          ) : null}
          {row.status === "error" && row.error ? (
            <span className="ml-1 text-muted-foreground">{row.error}</span>
          ) : null}
        </TaskItem>
      ))}
    </>
  );
}

function FinalToolList({ tools }: { tools: BellowsToolUseFinal[] }) {
  if (tools.length === 0) {
    return (
      <TaskItem>
        <span className="text-muted-foreground">
          (no tools used this turn)
        </span>
      </TaskItem>
    );
  }
  return (
    <>
      {tools.map((t, ti) => (
        <TaskItem key={`final-${ti}-${t.name}-${t.label}`}>
          {t.denied ? (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <ShieldIcon className="size-3" />
              denied
            </span>
          ) : (
            <span className="text-emerald-600 dark:text-emerald-400">
              {t.name}
            </span>
          )}{" "}
          <TaskItemFile>{t.label}</TaskItemFile>
          {t.denied ? (
            <span className="ml-1 text-muted-foreground">
              {t.name} blocked by allow-deny hook
            </span>
          ) : null}
        </TaskItem>
      ))}
    </>
  );
}
