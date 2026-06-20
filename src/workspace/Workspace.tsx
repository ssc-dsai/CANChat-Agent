import { useEffect, useState } from 'preact/hooks';
import type { BackgroundEvent } from '../shared/messages';
import type { AgentStatus, ChatMessageView, DataExport, FileArtifact, PlanView } from '../shared/types';
import { ToolManager } from './ToolManager';
import { SkillEditor } from './SkillEditor';
import { DataViewer } from './DataViewer';
import { DatasetBrowser } from './DatasetBrowser';
import { ImageViewer } from './ImageViewer';

type WorkspaceView = 'chat' | 'tools' | 'skills' | 'data' | 'datasets' | 'image' | 'settings';

export function Workspace() {
  const [status, setStatus] = useState<AgentStatus>('idle');
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [view, setView] = useState<WorkspaceView>('chat');
  const [exports, setExports] = useState<DataExport[]>([]);
  const [focusedExport, setFocusedExport] = useState<DataExport | null>(null);
  const [focusedImage, setFocusedImage] = useState<string | null>(null);
  const [focusedFileArtifact, setFocusedFileArtifact] = useState<FileArtifact | null>(null);
  const [port, setPort] = useState<chrome.runtime.Port | null>(null);
  const [input, setInput] = useState('');

  useEffect(() => {
    const p = chrome.runtime.connect({ name: 'sidebar' });
    p.postMessage({ type: 'get_state' });
    p.onMessage.addListener((event: BackgroundEvent) => {
      switch (event.type) {
        case 'full_state':
          setStatus(event.status);
          setMessages(event.messages);
          setPlan(event.plan);
          break;
        case 'chat_message': {
          setMessages((m) => [...m, event.message]);
          const exp = event.message.dataExport;
          if (exp) {
            setExports((prev) => {
              const next = prev.find((d) => d === exp) ? prev : [...prev, exp];
              if (next.length > 0) setFocusedExport(next[next.length - 1]);
              return next;
            });
          }
          if (event.message.fileArtifact) {
            setFocusedFileArtifact(event.message.fileArtifact);
          }
          if (event.message.images && event.message.images.length > 0) {
            setFocusedImage(event.message.images[0]);
          }
          break;
        }
        case 'status':
          setStatus(event.status);
          break;
        case 'plan_update':
          setPlan(event.plan);
          break;
      }
    });
    p.onDisconnect.addListener(() => {
      setPort(null);
    });
    setPort(p);
    return () => p.disconnect();
  }, []);

  const busy = status !== 'idle';
  const send = () => {
    const text = input.trim();
    if (!text || !port || busy) return;
    port.postMessage({ type: 'user_message', text });
    setInput('');
  };

  const latestExport = exports.length > 0 ? exports[exports.length - 1] : null;
  const displayExport = focusedExport ?? latestExport;

  const rightPane = () => {
    switch (view) {
      case 'tools':
        return <ToolManager />;
      case 'skills':
        return <SkillEditor />;
      case 'datasets':
        return <DatasetBrowser />;
      case 'data':
        return displayExport
          ? <DataViewer data={displayExport} allExports={exports} onSelectExport={setFocusedExport} />
          : <div class="ws-placeholder">No data export to view.</div>;
      case 'image':
        return focusedImage ? <ImageViewer imageUrl={focusedImage} /> : <div class="ws-placeholder">No image to view.</div>;
      default:
        return (
          <div class="ws-detail-panes">
            {latestExport && (
              <div class="ws-detail-card" onClick={() => setView('data')}>
                <strong>Latest data</strong>
                <p>{latestExport.title} ({latestExport.rows.length} rows{exports.length > 1 ? `, ${exports.length} exports` : ''})</p>
              </div>
            )}
            {focusedImage && (
              <div class="ws-detail-card" onClick={() => setView('image')}>
                <strong>Latest image</strong>
                <img src={focusedImage} alt="captured snapshot" class="ws-thumb" />
              </div>
            )}
            {focusedFileArtifact && (
              <div class="ws-detail-card">
                <strong>Latest file</strong>
                <p>{focusedFileArtifact.filename}</p>
              </div>
            )}
          </div>
        );
    }
  };

  return (
    <div class="ws-root">
      <header class="ws-header">
        <span class={`ws-status ws-status-${status}`}>
          <span class="ws-dot" />
          {status}
        </span>
        <span class="ws-title">CANChat Agent workspace</span>
        <nav class="ws-nav">
          <button class="ws-nav-btn" onClick={() => setView('chat')}>Chat</button>
          <button class="ws-nav-btn" onClick={() => setView('tools')}>Tools</button>
          <button class="ws-nav-btn" onClick={() => setView('skills')}>Skills</button>
          <button class="ws-nav-btn" onClick={() => setView('datasets')}>Datasets</button>
          {displayExport && <button class="ws-nav-btn" onClick={() => setView('data')}>Data{exports.length > 1 ? ` (${exports.length})` : ''}</button>}
          {focusedImage && <button class="ws-nav-btn" onClick={() => setView('image')}>Image</button>}
        </nav>
      </header>
      <div class="ws-body">
        <aside class="ws-sidebar">
          <div class="ws-message-list">
            {messages.map((m, i) => (
              <div key={i} class={`ws-msg ws-msg-${m.role}`}>
                {m.text && <p>{m.text.slice(0, 200)}</p>}
                {m.dataExport && <span class="ws-tag">Table: {m.dataExport.title}</span>}
                {m.fileArtifact && <span class="ws-tag">File: {m.fileArtifact.filename}</span>}
                {m.images && <span class="ws-tag">{m.images.length} image(s)</span>}
              </div>
            ))}
          </div>
          {plan && (
            <div class="ws-plan">
              <strong>Plan</strong>
              {plan.steps.map((s, i) => (
                <div key={i} class={`ws-plan-step ws-plan-${s.status}`}>{s.text}</div>
              ))}
            </div>
          )}
          <div class="ws-composer">
            <textarea
              class="ws-composer-input"
              value={input}
              placeholder={busy ? 'Working…' : 'Message the agent…'}
              disabled={!port}
              onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button class="ws-btn ws-btn-primary" disabled={!input.trim() || busy || !port} onClick={send}>Send</button>
          </div>
        </aside>
        <main class="ws-main">
          {rightPane()}
        </main>
      </div>
    </div>
  );
}
