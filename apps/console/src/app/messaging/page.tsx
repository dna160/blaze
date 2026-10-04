"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ConversationListResponse, ConversationSummary, ThreadMessage, ThreadResponse } from "@rentos/contracts";

import { ConsoleShell } from "@/components/ConsoleShell";
import { apiFetch, ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { notifyUnreadMessagesChanged } from "@/lib/unread-messages";

const LIST_POLL_MS = 10_000;
const THREAD_POLL_MS = 5_000;

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (isToday) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

/** Delivery state, as WhatsApp itself shows it. FAILED carries Meta's reason on hover. */
function StatusGlyph({ status, error }: { status: string; error?: string | null }) {
  if (status === "FAILED") {
    return (
      <span title={error ?? "Failed"} className="text-red-600">
        failed
      </span>
    );
  }
  if (status === "READ") return <span className="text-sky-600" title="Read">✓✓</span>;
  if (status === "DELIVERED") return <span className="text-slate-400" title="Delivered">✓✓</span>;
  if (status === "SENT") return <span className="text-slate-400" title="Sent">✓</span>;
  return <span className="text-slate-300" title={status}>·</span>;
}

/**
 * The WhatsApp inbox. A number on the Cloud API has no phone app behind it, so
 * this is the only place these conversations can be read or answered.
 *
 * Polling rather than sockets: one branch's message volume does not justify a
 * second transport, and a 5-second thread refresh is below the threshold where
 * a conversation feels stale.
 */
export default function MessagingPage() {
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [selected, setSelected] = useState<{ tenantId: string; phone: string } | null>(null);
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [q, setQ] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [branch, setBranch] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const loadConversations = useCallback(async () => {
    const token = authClient.getToken();
    if (!token) return router.push("/login");
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (unreadOnly) params.set("unreadOnly", "true");
    if (branch) params.set("tenantId", branch);
    try {
      const data = await apiFetch<ConversationListResponse>(`/messaging/conversations?${params}`, { token });
      setConversations(data.items);
      setListError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return router.push("/login");
      setListError((err as Error).message);
    }
  }, [q, unreadOnly, branch, router]);

  const loadThread = useCallback(async () => {
    if (!selected) return;
    const token = authClient.getToken();
    if (!token) return;
    try {
      const data = await apiFetch<ThreadResponse>(
        `/messaging/conversations/${selected.tenantId}/${selected.phone}/messages`,
        { token },
      );
      setThread(data);
      // Opening the thread is what marks it read server-side; clear the pill
      // locally so the list does not lag a poll behind.
      setConversations((prev) =>
        prev
          ? prev.map((c) =>
              c.tenantId === selected.tenantId && c.phone === selected.phone ? { ...c, unreadCount: 0 } : c,
            )
          : prev,
      );
      notifyUnreadMessagesChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) router.push("/login");
    }
  }, [selected, router]);

  useEffect(() => {
    void loadConversations();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadConversations();
    }, LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadConversations]);

  useEffect(() => {
    void loadThread();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadThread();
    }, THREAD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread?.messages.length]);

  const branches = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of conversations ?? []) map.set(c.tenantId, c.tenantName);
    return [...map.entries()];
  }, [conversations]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !selected || sending) return;
    const token = authClient.getToken();
    setSending(true);
    setSendError(null);
    try {
      const sent = await apiFetch<ThreadMessage>(
        `/messaging/conversations/${selected.tenantId}/${selected.phone}/reply`,
        { token, method: "POST", body: { text } },
      );
      setThread((prev) => (prev ? { ...prev, messages: [...prev.messages, sent] } : prev));
      setDraft("");
      void loadConversations();
    } catch (err) {
      // Keep the draft: the usual failures (window closed, number not on the
      // test number's allow-list) are fixable, and retyping is a second penalty.
      setSendError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  const selectedConversation = conversations?.find(
    (c) => c.tenantId === selected?.tenantId && c.phone === selected?.phone,
  );

  return (
    <ConsoleShell>
      <div className="flex h-[calc(100vh-9rem)] gap-4">
        {/* Conversation list */}
        <aside className={`flex w-full flex-col rounded-lg border border-brand-600/10 bg-white md:w-80 ${selected ? "hidden md:flex" : "flex"}`}>
          <div className="space-y-2 border-b border-brand-600/10 p-3">
            <div className="flex items-center justify-between">
              <h1 className="text-lg font-semibold">Messages</h1>
              <Link href="/settings/messaging" className="text-xs text-brand-700/60 hover:text-accent-500">
                Number &amp; auto-reply
              </Link>
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name or number"
              className="w-full rounded border border-slate-300 px-3 py-1.5 text-sm"
            />
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
                Unread only
              </label>
              {branches.length > 1 && (
                <select value={branch} onChange={(e) => setBranch(e.target.value)} className="rounded border border-slate-300 px-2 py-1">
                  <option value="">All branches</option>
                  {branches.map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {listError && <p className="p-3 text-sm text-red-700">{listError}</p>}
            {conversations === null && <p className="p-3 text-sm text-brand-700/60">Loading…</p>}
            {conversations?.length === 0 && (
              <p className="p-4 text-sm text-brand-700/60">
                No conversations yet. Messages customers send to your WhatsApp number will appear here.
              </p>
            )}
            {conversations?.map((c) => {
              const active = c.tenantId === selected?.tenantId && c.phone === selected?.phone;
              return (
                <button
                  key={`${c.tenantId}:${c.phone}`}
                  onClick={() => { setSelected({ tenantId: c.tenantId, phone: c.phone }); setThread(null); setSendError(null); }}
                  className={`block w-full border-b border-brand-600/5 px-3 py-2.5 text-left hover:bg-brand-700/5 ${active ? "bg-brand-700/10" : ""}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{c.displayName ?? `+${c.phone}`}</span>
                    <span className="shrink-0 text-xs text-brand-700/50">{relativeTime(c.lastMessage.at)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-brand-700/60">
                      {c.lastMessage.direction === "out" && "You: "}
                      {c.lastMessage.text}
                    </span>
                    {c.unreadCount > 0 ? (
                      <span className="shrink-0 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                        {c.unreadCount > 99 ? "99+" : c.unreadCount}
                      </span>
                    ) : (
                      c.lastMessage.direction === "out" && (
                        <span className="shrink-0 text-[10px]"><StatusGlyph status={c.lastMessage.status} /></span>
                      )
                    )}
                  </div>
                  {branches.length > 1 && <span className="text-[10px] text-brand-700/40">{c.tenantName}</span>}
                </button>
              );
            })}
          </div>
        </aside>

        {/* Thread */}
        <section className={`flex flex-1 flex-col rounded-lg border border-brand-600/10 bg-white ${selected ? "flex" : "hidden md:flex"}`}>
          {!selected ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-brand-700/50">
              Pick a conversation to read it.
            </div>
          ) : (
            <>
              <header className="flex items-center justify-between border-b border-brand-600/10 px-4 py-3">
                <div className="min-w-0">
                  <button onClick={() => setSelected(null)} className="mb-0.5 text-xs text-brand-700/60 md:hidden">
                    ← All conversations
                  </button>
                  <div className="truncate text-sm font-semibold">
                    {thread?.customer?.fullName ?? selectedConversation?.displayName ?? `+${selected.phone}`}
                  </div>
                  <div className="text-xs text-brand-700/50">
                    +{selected.phone}
                    {thread?.customer && (
                      <>
                        {" · "}
                        <Link href={`/clients/${thread.customer.id}`} className="hover:text-accent-500">Open client</Link>
                      </>
                    )}
                  </div>
                </div>
                <span className={`shrink-0 rounded px-2 py-1 text-xs ${thread?.canReply ? "bg-green-100 text-green-800" : "bg-slate-200 text-slate-600"}`}>
                  {thread?.canReply
                    ? `Reply window open until ${new Date(thread.windowOpenUntil!).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`
                    : "Window closed — customer must message first"}
                </span>
              </header>

              <div className="flex-1 space-y-2 overflow-y-auto p-4">
                {thread === null && <p className="text-sm text-brand-700/60">Loading…</p>}
                {thread?.messages.map((m, i) => {
                  const prev = thread.messages[i - 1];
                  const newDay = !prev || dayLabel(prev.at) !== dayLabel(m.at);
                  return (
                    <div key={m.id}>
                      {newDay && (
                        <div className="my-3 text-center text-[11px] uppercase tracking-wide text-brand-700/40">{dayLabel(m.at)}</div>
                      )}
                      <div className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${m.direction === "out" ? "bg-brand-700 text-white" : "bg-slate-100 text-slate-900"}`}>
                          {m.kind === "media" && (
                            <div className="mb-1 text-xs opacity-70">
                              [{String(m.payload.waMessageType ?? "attachment")}]
                              {typeof m.payload.caption === "string" ? ` ${m.payload.caption}` : ""}
                            </div>
                          )}
                          <div className="whitespace-pre-wrap break-words">{m.text}</div>
                          <div className={`mt-1 flex items-center gap-1.5 text-[10px] ${m.direction === "out" ? "text-white/70" : "text-slate-500"}`}>
                            <span>{new Date(m.at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}</span>
                            {m.kind === "auto_reply" && <span>· Auto</span>}
                            {m.kind === "template" && <span>· {m.templateKey}</span>}
                            {m.direction === "out" && <StatusGlyph status={m.status} error={m.error} />}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              <form onSubmit={send} className="border-t border-brand-600/10 p-3">
                {sendError && <p className="mb-2 rounded bg-red-50 px-3 py-2 text-xs text-red-800">{sendError}</p>}
                <div className="flex gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send(e as unknown as React.FormEvent);
                      }
                    }}
                    disabled={!thread?.canReply || sending}
                    rows={2}
                    maxLength={4096}
                    placeholder={thread?.canReply ? "Type a reply… (Enter to send, Shift+Enter for a new line)" : "You can only reply within 24 hours of the customer's last message."}
                    className="flex-1 resize-none rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
                  />
                  <button
                    type="submit"
                    disabled={!thread?.canReply || sending || !draft.trim()}
                    className="shrink-0 self-end rounded bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {sending ? "Sending…" : "Send"}
                  </button>
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </ConsoleShell>
  );
}
