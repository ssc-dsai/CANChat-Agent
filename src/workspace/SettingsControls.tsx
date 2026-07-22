// Shared building blocks for the workspace settings surfaces (Models page's
// connection + advanced sections): a Mac-style grouped card with an uppercase
// title and dim description, and a labelled toggle row. Extracted so every
// section renders the same card chrome (.settings-group-body) instead of
// re-implementing it with drifting markup.

import type { ComponentChildren } from 'preact';

export function Group({ title, desc, children }: { title: string; desc?: string; children: ComponentChildren }) {
  return (
    <section class="settings-group">
      <h3 class="settings-group-title">{title}</h3>
      {desc && <p class="settings-group-desc">{desc}</p>}
      <div class="settings-group-body">{children}</div>
    </section>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  note,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  note?: string;
}) {
  return (
    <label class="toggle-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span class="toggle-text">
        <span class="toggle-label">{label}</span>
        {note && <span class="toggle-note">{note}</span>}
      </span>
    </label>
  );
}
