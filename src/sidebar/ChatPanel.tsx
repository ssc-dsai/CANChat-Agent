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
  approval: { requestId: string; description: string } | null;
  authNotice: { origin: string; message: string } | null;
  permissionNotice: { origin: string; message: string } | null;
  send: (command: SidebarCommand) => void;
  disabled: boolean;
}

export function ChatPanel({
  messages,
  status,
  approval,
  authNotice,
  permissionNotice,
  send,
  disabled,
}: Props) {
  const [input, setInput] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

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

  // Skill name hints while typing a /command.
  const slashMatch = /^\/([a-z0-9-]*)$/i.exec(input.trim().split(/\s/)[0] ?? '');
  const matchingSkills =
    input.startsWith('/') && slashMatch
      ? skills.filter((s) => s.name.startsWith(slashMatch[1].toLowerCase()))
      : [];

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
              <div class="prompt-detail">{approval.description}</div>
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
        <textarea
          class="chat-input"
          rows={2}
          placeholder={disabled ? 'Configure a model in Settings first' : 'Ask the agent…'}
          value={input}
          disabled={disabled}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
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
