"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { ChevronRightIcon, FlameIcon, FolderSearchIcon, ShieldIcon } from "lucide-react";
import { useState } from "react";

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

interface BellowsToolUse {
  name: string;
  label: string;
  denied: boolean;
}

interface BellowsToolDataPart {
  filesRead: string[];
  /** Every tool call (name + arg label + denied flag). */
  tools?: BellowsToolUse[];
  denied: string[];
  turns: number;
  provider: string;
  sessionId: string;
}

interface BellowsToolPart {
  type: "data-bellows-tools";
  data: BellowsToolDataPart;
}

function isBellowsToolPart(
  part: UIMessage["parts"][number],
): part is BellowsToolPart {
  return (part as { type: string }).type === "data-bellows-tools";
}

const SUGGESTIONS = [
  "Hi! What are you?",
  "What model are you running on?",
  "List the files in your sandbox.",
  "Tell me a quick joke about Rust.",
];

export default function Page() {
  const [text, setText] = useState("");
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  const isBusy = status === "submitted" || status === "streaming";

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
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.parts.map((part, i) => {
                    const key = `${message.id}-${i}`;

                    if (part.type === "text") {
                      return (
                        <MessageResponse key={key}>{part.text}</MessageResponse>
                      );
                    }

                    if (isBellowsToolPart(part)) {
                      const { tools, filesRead, turns, provider, sessionId } =
                        part.data;
                      // Prefer the new tools[] array; fall back to filesRead
                      // for older deployments that only emit the legacy field.
                      const allTools: BellowsToolUse[] =
                        tools && tools.length > 0
                          ? tools
                          : filesRead.map((f) => ({
                              name: "fs_read",
                              label: f,
                              denied: false,
                            }));
                      const events = allTools.length;
                      const summary = `${turns} model turn${turns === 1 ? "" : "s"} · ${events} tool ${
                        events === 1 ? "call" : "calls"
                      } · ${provider}`;

                      return (
                        <Task key={key} className="mb-2 w-full" defaultOpen>
                          <TaskTrigger title={summary} />
                          <TaskContent>
                            {allTools.length === 0 ? (
                              <TaskItem>
                                <span className="text-muted-foreground">
                                  (no tools used this turn)
                                </span>
                              </TaskItem>
                            ) : null}
                            {allTools.map((t, ti) => (
                              <TaskItem key={`t-${ti}-${t.name}-${t.label}`}>
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
                            {sessionId ? (
                              <TaskItem>
                                <span className="text-muted-foreground">
                                  session
                                </span>{" "}
                                <TaskItemFile>{sessionId}</TaskItemFile>
                              </TaskItem>
                            ) : null}
                          </TaskContent>
                        </Task>
                      );
                    }

                    return null;
                  })}
                </MessageContent>
              </Message>
            ))
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
