import { useEffect, useRef, useState } from 'preact/hooks';
import type { SidebarCommand } from '../shared/messages';
import type { AgentStatus, ChatMessageView } from '../shared/types';
import { Markdown } from './Markdown';

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
  const listRef = useRef<HTMLDivElement>(null);

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
        {messages.map((m, i) => (
          <div key={i} class={`msg msg-${m.role}`}>
            {m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}
          </div>
        ))}

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
