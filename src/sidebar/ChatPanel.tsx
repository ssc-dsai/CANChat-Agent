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
  // The input is a contenteditable editor (so inserted bookmark URLs can render
  // bold). `text` mirrors its plain text for logic/button state; the element
  // itself is uncontrolled — never re-render its content from state.
  const [text, setText] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  // @-mention of browser bookmarks.
  const [mention, setMention] = useState<{ query: string } | null>(null);
  const [bookmarks, setBookmarks] = useState<Array<{ title: string; url: string }>>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  const getEditorText = () =>
    (editorRef.current?.innerText ?? '').replace(/\u00a0/g, ' ');
  const syncText = () => setText(getEditorText());
  const setEditorText = (value: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.textContent = value;
    setText(value);
    // caret to end
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    el.focus();
  };
  const clearEditor = () => {
    if (editorRef.current) editorRef.current.innerHTML = '';
    setText('');
    setMention(null);
    setBookmarks([]);
  };

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
  const slashMatch = /^\/([a-z0-9-]*)$/i.exec(text.trim().split(/\s/)[0] ?? '');
  const hintItems: Array<{ id: string; name: string; description: string }> = [
    ...(skills.some((s) => s.name.toLowerCase() === 'learn')
      ? []
      : [{ id: 'builtin-learn', name: 'learn', description: 'Explore this site and save a reusable playbook' }]),
    ...skills.map((s) => ({ id: s.id, name: s.name, description: s.description })),
  ];
  const matchingSkills =
    text.startsWith('/') && slashMatch
      ? hintItems.filter((s) => s.name.startsWith(slashMatch[1].toLowerCase()))
      : [];

  // Locate the active @-mention token (text node + offsets) at the caret.
  const mentionRangeAtCaret = (): { node: Text; start: number; end: number; query: string } | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !editorRef.current) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !editorRef.current.contains(node)) return null;
    const offset = range.startOffset;
    const before = (node.textContent ?? '').slice(0, offset);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (!m) return null;
    return { node: node as Text, start: offset - m[1].length - 1, end: offset, query: m[1] };
  };

  const updateMention = () => {
    const found = mentionRangeAtCaret();
    setMention(found ? { query: found.query } : null);
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
    const found = mentionRangeAtCaret();
    const editor = editorRef.current;
    const sel = window.getSelection();
    if (!found || !editor || !sel) return;
    // Replace the "@query" span with a bold URL node + a trailing space.
    const del = document.createRange();
    del.setStart(found.node, found.start);
    del.setEnd(found.node, found.end);
    del.deleteContents();
    const space = document.createTextNode(' ');
    const bold = document.createElement('span');
    bold.className = 'mention-bold';
    bold.textContent = url;
    del.insertNode(space);
    del.insertNode(bold);
    // Caret into the (normal-weight) space node so typing continues unbolded.
    const after = document.createRange();
    after.setStart(space, space.length);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    editor.focus();
    setMention(null);
    setBookmarks([]);
    syncText();
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
    const message = getEditorText().trim();
    if (!message || disabled || busy) return;
    send({ type: 'user_message', text: message });
    clearEditor();
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
                onMouseDown={(e) => {
                  e.preventDefault();
                  setEditorText(`/${s.name} `);
                }}
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
                  e.preventDefault(); // keep focus in the editor
                  insertBookmark(b.url);
                }}
              >
                <span class="mention-title">{b.title}</span>
                <span class="mention-url">{b.url}</span>
              </button>
            ))}
          </div>
        )}
        <div
          ref={editorRef}
          class="chat-input"
          contentEditable={!disabled}
          role="textbox"
          aria-multiline="true"
          data-placeholder={disabled ? 'Configure a model in Settings first' : 'Ask the agent… (@ for bookmarks)'}
          onInput={() => {
            // Keep :empty true when only a stray <br> remains, so the placeholder shows.
            if (editorRef.current && !getEditorText().trim()) editorRef.current.innerHTML = '';
            syncText();
            updateMention();
          }}
          onKeyUp={() => updateMention()}
          onMouseUp={() => updateMention()}
          onPaste={(e) => {
            // Plain-text paste only — no foreign formatting in the editor.
            e.preventDefault();
            const pasted = e.clipboardData?.getData('text/plain') ?? '';
            document.execCommand('insertText', false, pasted);
          }}
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
          <button class="btn btn-primary" onClick={submit} disabled={disabled || busy || !text.trim()}>
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
