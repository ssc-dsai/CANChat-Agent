import { useEffect, useRef, useState } from 'preact/hooks';
import type { SidebarCommand } from '../shared/messages';
import type { AgentStatus, ChatMessageView, Skill } from '../shared/types';
import { Markdown } from './Markdown';

/** Split a trailing "Source tabs:" / "Sources:" block off the answer body. */
function splitSources(text: string): { body: string; sources: string | null } {
  const match = /(?:^|\n)(Source tabs?:|Sources:)\s*\n/i.exec(text);
  if (!match) return { body: text, sources: null };
  return {
    body: text.slice(0, match.index).trimEnd(),
    sources: text.slice(match.index).trim(),
  };
}

interface Props {
  messages: ChatMessageView[];
  status: AgentStatus;
  approval: { requestId: string; description: string; detail: string } | null;
  authNotice: { origin: string; message: string } | null;
  permissionNotice: { origin: string; message: string } | null;
  pendingSnapshots: string[];
  canDistill: boolean;
  send: (command: SidebarCommand) => void;
  disabled: boolean;
}

function MessageImages({ images }: { images: string[] }) {
  return (
    <div class="msg-images">
      {images.map((src, i) => (
        <img
          key={i}
          src={src}
          class="msg-image"
          alt={`Snapshot ${i + 1}`}
          onClick={() => void chrome.tabs.create({ url: src })}
        />
      ))}
    </div>
  );
}

export function ChatPanel({
  messages,
  status,
  approval,
  authNotice,
  permissionNotice,
  pendingSnapshots,
  canDistill,
  send,
  disabled,
}: Props) {
  const [input, setInput] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // @-mention of browser bookmarks: { query, start } where start is the '@' index.
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [bookmarks, setBookmarks] = useState<Array<{ title: string; url: string }>>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  useEffect(() => {
    const load = () =>
      chrome.storage.local.get('ba_skills').then((r) => {
        setSkills(Array.isArray(r.ba_skills) ? (r.ba_skills as Skill[]) : []);
      });
    load();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ('ba_skills' in changes) load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Skill name hints while typing a /command. Includes the built-in /learn.
  const slashMatch = /^\/([a-z0-9-]*)$/i.exec(input.trim().split(/\s/)[0] ?? '');
  const hintItems: Array<{ id: string; name: string; description: string }> = [
    ...(skills.some((s) => s.name.toLowerCase() === 'learn')
      ? []
      : [{ id: 'builtin-learn', name: 'learn', description: 'Explore this site and save a reusable playbook' }]),
    ...skills.map((s) => ({ id: s.id, name: s.name, description: s.description })),
  ];
  const matchingSkills =
    input.startsWith('/') && slashMatch
      ? hintItems.filter((s) => s.name.startsWith(slashMatch[1].toLowerCase()))
      : [];

  // Track the active @-mention token from the caret position.
  const updateMention = (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart ?? el.value.length;
    const m = /(?:^|\s)@([^\s@]*)$/.exec(el.value.slice(0, caret));
    setMention(m ? { query: m[1], start: caret - m[1].length - 1 } : null);
  };

  // Fetch matching bookmarks (debounced) while a mention is being typed.
  useEffect(() => {
    if (!mention || typeof chrome === 'undefined' || !chrome.bookmarks) {
      setBookmarks([]);
      return;
    }
    let cancelled = false;
    const q = mention.query.trim();
    const ql = q.toLowerCase();
    const rank = (n: chrome.bookmarks.BookmarkTreeNode) => {
      const t = (n.title ?? '').toLowerCase();
      if (t.startsWith(ql)) return 0;
      if (t.includes(ql)) return 1;
      return 2;
    };
    const timer = setTimeout(async () => {
      let nodes: chrome.bookmarks.BookmarkTreeNode[] = [];
      try {
        nodes = q ? await chrome.bookmarks.search(q) : await chrome.bookmarks.getRecent(8);
      } catch {
        nodes = [];
      }
      if (cancelled) return;
      const items = nodes
        .filter((n) => n.url)
        .filter(
          (n) =>
            !q ||
            (n.title ?? '').toLowerCase().includes(ql) ||
            (n.url ?? '').toLowerCase().includes(ql),
        )
        .sort((a, b) => rank(a) - rank(b))
        .slice(0, 8)
        .map((n) => ({ title: n.title || n.url!, url: n.url! }));
      setBookmarks(items);
      setMentionIndex(0);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mention]);

  const mentionOpen = mention !== null && bookmarks.length > 0;

  const insertBookmark = (url: string) => {
    if (!mention) return;
    const end = mention.start + 1 + mention.query.length;
    const before = input.slice(0, mention.start);
    const after = input.slice(end);
    const next = `${before}${url} ${after}`;
    setInput(next);
    setMention(null);
    setBookmarks([]);
    const caret = (before + url + ' ').length;
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (t) {
        t.focus();
        t.selectionStart = t.selectionEnd = caret;
      }
    });
  };

  const copyMessage = async (index: number, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex((c) => (c === index ? null : c)), 1500);
  };

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, approval, authNotice, permissionNotice]);

  // Permission requests must run in a user-gesture handler in an extension page.
  const grant = async (origins: string[]) => {
    const granted = await chrome.permissions.request({ origins });
    if (granted) send({ type: 'resume_agent' });
  };

  const busy = status === 'thinking' || status === 'acting' || status === 'awaiting_approval' || status === 'auth_required';

  const submit = () => {
    const text = input.trim();
    if (!text || disabled || busy) return;
    send({ type: 'user_message', text });
    setInput('');
    setMention(null);
    setBookmarks([]);
  };

  return (
    <div class="chat">
      <div class="chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <div class="chat-empty">
            Ask about the current page, your open tabs, or anything on the web. Add tabs to
            context above, or just ask — the agent will use the browser when it needs to.
          </div>
        )}
        {messages.map((m, i) => {
          const { body, sources } = m.role === 'assistant' ? splitSources(m.text) : { body: m.text, sources: null };
          return (
          <div key={i} class={`msg msg-${m.role}`}>
            {m.images && m.images.length > 0 && <MessageImages images={m.images} />}
            {m.role === 'assistant' ? (
              <>
                <Markdown text={body} />
                {sources && (
                  <div class="citations">
                    <Markdown text={sources} />
                  </div>
                )}
                <div class="msg-actions">
                  <button
                    class="copy-btn"
                    title="Copy to clipboard"
                    onClick={() => copyMessage(i, m.text)}
                  >
                    {copiedIndex === i ? '✓ Copied' : '⧉ Copy'}
                  </button>
                </div>
              </>
            ) : (
              m.text
            )}
          </div>
          );
        })}

        {authNotice && (
          <div class="prompt-card">
            <div>{authNotice.message}</div>
            <div class="prompt-actions">
              <button class="btn btn-primary" onClick={() => send({ type: 'resume_agent' })}>
                Resume
              </button>
              <button class="btn" onClick={() => send({ type: 'stop_task' })}>
                Stop task
              </button>
            </div>
          </div>
        )}

        {permissionNotice && (
          <div class="prompt-card">
            <div>{permissionNotice.message}</div>
            <div class="prompt-actions">
              <button
                class="btn btn-primary"
                onClick={() => grant([permissionNotice.origin + '/*'])}
              >
                Allow this site
              </button>
              <button class="btn" onClick={() => grant(['<all_urls>'])}>
                Allow all sites
              </button>
              <button class="btn" onClick={() => send({ type: 'stop_task' })}>
                Stop task
              </button>
            </div>
          </div>
        )}

        {approval && (
          <div class="prompt-card">
            <div>
              <strong>Approve action?</strong>
              <div class="prompt-reason">{approval.description}</div>
              <details class="prompt-tech">
                <summary>Technical detail</summary>
                <div class="prompt-detail">{approval.detail}</div>
              </details>
            </div>
            <div class="prompt-actions">
              <button
                class="btn btn-primary"
                onClick={() => send({ type: 'approval_response', requestId: approval.requestId, approved: true })}
              >
                Approve
              </button>
              <button
                class="btn"
                onClick={() => send({ type: 'approval_response', requestId: approval.requestId, approved: false })}
              >
                Deny
              </button>
            </div>
          </div>
        )}
      </div>

      <div class="chat-input-row">
        {canDistill && (
          <div class="distill-chip">
            <span>Save this workflow as a reusable skill?</span>
            <button class="btn btn-small btn-primary" onClick={() => send({ type: 'distill_skill' })}>
              Save skill
            </button>
            <button class="icon-btn" title="Dismiss" onClick={() => send({ type: 'dismiss_distill' })}>
              ✕
            </button>
          </div>
        )}
        {pendingSnapshots.length > 0 && (
          <div class="snapshot-pending">
            {pendingSnapshots.map((src, i) => (
              <img key={i} src={src} class="snapshot-thumb" alt={`Pending snapshot ${i + 1}`} />
            ))}
            <span class="snapshot-label">
              {pendingSnapshots.length} snapshot{pendingSnapshots.length > 1 ? 's' : ''} attached
            </span>
            <button
              class="icon-btn"
              title="Discard snapshots"
              onClick={() => send({ type: 'discard_snapshots' })}
            >
              ✕
            </button>
          </div>
        )}
        {matchingSkills.length > 0 && (
          <div class="skill-hints">
            {matchingSkills.map((s) => (
              <button
                key={s.id}
                class="skill-hint"
                title={s.description}
                onClick={() => setInput(`/${s.name} `)}
              >
                /{s.name}
              </button>
            ))}
          </div>
        )}
        {mentionOpen && (
          <div class="mention-menu">
            {bookmarks.map((b, i) => (
              <button
                key={b.url}
                class={`mention-item ${i === mentionIndex ? 'active' : ''}`}
                title={b.url}
                onMouseEnter={() => setMentionIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus in the textarea
                  insertBookmark(b.url);
                }}
              >
                <span class="mention-title">{b.title}</span>
                <span class="mention-url">{b.url}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          class="chat-input"
          rows={2}
          placeholder={disabled ? 'Configure a model in Settings first' : 'Ask the agent… (@ for bookmarks)'}
          value={input}
          disabled={disabled}
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement;
            setInput(el.value);
            updateMention(el);
          }}
          onKeyUp={(e) => updateMention(e.target as HTMLTextAreaElement)}
          onClick={(e) => updateMention(e.target as HTMLTextAreaElement)}
          onKeyDown={(e) => {
            if (mentionOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionIndex((i) => (i + 1) % bookmarks.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionIndex((i) => (i - 1 + bookmarks.length) % bookmarks.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                insertBookmark(bookmarks[mentionIndex].url);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMention(null);
                setBookmarks([]);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div class="chat-buttons">
          <button class="btn btn-primary" onClick={submit} disabled={disabled || busy || !input.trim()}>
            Send
          </button>
          {status === 'paused' ? (
            <button class="btn" onClick={() => send({ type: 'resume_agent' })}>
              Resume
            </button>
          ) : (
            <button class="btn" onClick={() => send({ type: 'pause_agent' })} disabled={!busy}>
              Pause
            </button>
          )}
          <button class="btn" onClick={() => send({ type: 'stop_task' })} disabled={status === 'idle'}>
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}
