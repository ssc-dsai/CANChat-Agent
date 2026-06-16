# Visual design review — CANChat Agent side panel

**Goal:** make the extension *beautiful, minimalist, accessible, and easy to learn*, using
the MySSC+ purple/magenta palette as a brand base. Evaluated against Nielsen Norman
Group's [5 principles of visual design](https://www.nngroup.com/articles/principles-visual-design/)
— **scale, visual hierarchy, balance, contrast, Gestalt** — plus WCAG 2.1 AA.

Grounded in the live UI (`docs/usability/screenshots/`) and the current tokens in
[styles.css](../src/sidebar/styles.css).

---

## TL;DR — what to change first

1. **Adopt a purple/magenta brand palette** (replaces the generic `#2f6fdb` blue). One
   set of tokens drives the whole UI; semantic colours (ok/warn/error) stay green/amber/red.
2. **Calm the header.** It crams a brand, a large status pill, a 3-button text-scaler, and
   4 icon buttons into ~400 px. Demote the status pill, retire the randomized "ransom-note"
   animation, and move text-scaling out of the always-on toolbar.
3. **Lean on spacing, not boxes.** Borders/panels everywhere create visual noise; group with
   whitespace (Gestalt proximity) and reserve borders for true containers.
4. **Fix accessibility floors:** visible keyboard focus rings, ≥44 px touch targets, and
   raise dim-text contrast to AA.
5. **One brand gradient, used once** (header), not on every accent — minimalism.

Severity legend: **P1** do first · **P2** high value · **P3** polish.

---

## 1. Colour & brand — the palette (P1)

**Problem.** The accent is a generic blue (`--accent: #2f6fdb`, [styles.css:10](../src/sidebar/styles.css#L10));
the user bubble is dark blue (`--accent-dim`, [styles.css:579](../src/sidebar/styles.css#L579)).
There is no brand identity and nothing ties it to MySSC+.

**Palette derived from the images.** MySSC+ runs a deep indigo→magenta gradient over a near‑white
canvas, a dark plum nav bar, and small teal accents. Proposed tokens (chosen for WCAG AA — body
text ≥ 4.5:1, large/UI ≥ 3:1):

```css
/* Light */
--brand-700:#56206E;  /* pressed / strong */
--brand-600:#6E2A8C;  /* PRIMARY accent: links, buttons, focus  (~7:1 on white) */
--brand-500:#8A35A8;  /* hover tint base */
--magenta-500:#C0249E;/* SECONDARY accent — gradients & highlights only, used sparingly */
--brand-grad: linear-gradient(135deg,#6E2A8C 0%,#C0249E 100%); /* header/hero ONLY */
--brand-soft:#F1E9F6; /* selected-row / focus halo / active-tab wash */

--bg:#ffffff;
--bg-panel:#F7F4FA;   /* a hair of violet, warmer than today's grey */
--bg-input:#EFEAF4;
--border:#E0D8E8;     /* lighter; let spacing do the grouping */
--text:#1C1726;       /* near-black plum, not pure grey */
--text-dim:#5A5366;   /* darkened from #686a74 → clears AA on panels */

/* Dark */
--brand-600:#C892E0;  /* lighten for contrast on dark */
--brand-soft:#2C2440;
--bg:#181421; --bg-panel:#211B2D; --bg-input:#2A2338; --border:#3A3147;
--text:#ECE8F2; --text-dim:#A79FB6;
```

**Keep semantic colours distinct.** Do **not** tint ok/warn/error toward purple — accessibility
depends on hue separation. Today's green/amber/red are fine; only nudge them to sit harmoniously.

**Where it applies:** `--accent*` everywhere it's referenced today (buttons, links, focus,
active tab, the user bubble, the `.status-thinking/acting` pill). The **gradient is used exactly
once** — the header strip — so it reads as "the brand," not as decoration.

---

## 2. Scale & visual hierarchy (P1)

NN/g: use ~3 sizes; make the important thing bigger; mute the rest.

- **The status pill out-shouts the brand.** `● Idle` is a 22 px filled pill, the same visual
  weight as the product name ([styles.css:137](../src/sidebar/styles.css#L137)). For a
  resting state that's backwards. **Recommend:** idle = a quiet inline dot + dim text (no pill
  fill); reserve the filled/coloured pill for *active* states (thinking/acting/error) where
  motion of status actually matters.
- **Retire the "ransom-note" status animation** (`.status-anim`, randomized per-letter font /
  weight / italic / scale, [styles.css:170-186](../src/sidebar/styles.css#L170) + Sidebar.tsx).
  It directly fights minimalism *and* legibility, and it's an accessibility problem (motion +
  unstable glyph metrics). Replace with a single calm pulse on the status dot, gated behind
  `prefers-reduced-motion`.
- **Establish a type scale.** Right now sizes sprawl from 10 px to 14 px ad hoc
  (`.app-version` 10, `.conv-sub` 11, lots of 12, body 13, title 14). Collapse to a 4-step
  scale: **15/13/12/11** = title / body / label / meta. Tabular-nums only for the build stamp.
- **One H1 per surface.** The brand title is the only thing that should be bold + largest in the
  header; everything else is a control.

---

## 3. Balance, density & minimalism — the header (P1)

The header packs: brand+status (stacked), a `A− 100% A+` segmented scaler, then **History,
Save, Delete, Settings** icon buttons — 7–8 interactive targets across 400 px
([04-chat-response.png](usability/screenshots/04-chat-response.png)). It's the busiest, least
calm part of the app.

**Recommendations**
- ~~**Move text-scaling out of the always-on header.**~~ **Kept in the header by request** —
  it's used constantly, so it stays one-click. Width trimmed so it doesn't crowd the brand.
- **Separate destructive from routine.** ✅ *Done:* the trash can is now a **compose icon
  labelled "New chat"** — honest, since `clearConversation` keeps the previous conversation in
  History ([agentRuntime.ts:807](../src/background/agentRuntime.ts#L807)). Reframing it removes
  the "did I just delete that?" hazard without an extra confirm.
- **Demote the status** (see §2). ✅ *Done:* idle is a quiet dot + dim label; the filled pill
  appears only for working/attention states.
- Target header = **brand · status · [History] [Save] [New chat] [Settings]** with the scaler.

Same idea for the **context toolbar** (`Screenshot · Capture full page · Knowledge base name ·
Add tab · Add group`, [03/04 screenshots]): five mixed-purpose controls that wrap. Consider an
input + a single "＋ Add" split, and icon+label chips for capture actions, so the row reads as two
groups (capture | knowledge base) instead of five peers.

---

## 4. Gestalt: group with space, not borders (P2)

Almost every block has its own 1 px border + panel fill (`.export-card`, `.prompt-card`,
`.conv-item`, `.site-form`, `.settings-card` sections…). Stacked, these create a "boxes inside
boxes" look that fights minimalism.

- **Proximity over enclosure:** increase vertical rhythm (e.g. 16 px between groups, 6–8 px
  within) and drop borders on elements that are already separated by space. Keep borders only
  where content could otherwise run together (tables, the settings modal edge, inputs).
- **Lighten remaining borders** (`--border` → the lighter value above) so they whisper.
- **Consistent radius scale:** today radii range 4→12 px arbitrarily. Standardize to **6 (inputs/
  chips) / 10 (cards) / 999 (pills)**.

---

## 5. Contrast & accessibility (P1 — hard requirements)

- **Dim text:** `--text-dim:#686a74` on `--bg-panel:#f2f3f6` is ≈ 4.0:1 — *below* AA for the
  many 11–12 px labels (`.conv-sub`, `.export-dims`, field hints). Darken to ~`#5A5366` (above).
- **Visible keyboard focus.** Inputs only shift `border-color` on focus and icon buttons have
  **no** `:focus-visible` style at all ([styles.css:212](../src/sidebar/styles.css#L212),
  [796](../src/sidebar/styles.css#L796)). Add a 2 px `--brand-600` focus ring (`box-shadow:
  0 0 0 3px var(--brand-soft)`) to every focusable control. This is a keyboard-a11y gap, not
  polish.
- **Touch targets.** `.icon-btn` is ~30 px (7 px padding) and the scale buttons are smaller
  ([styles.css:221](../src/sidebar/styles.css#L221), [246](../src/sidebar/styles.css#L246)).
  Bump interactive controls to **≥40–44 px** hit area (padding or min-width/height).
- **Magenta is decorative only.** `--magenta-500` (#C0249E) is ~4:1 on white — fine for the
  gradient and large UI, **not** for body text or small links. Keep links/body on `--brand-600`.
- **Respect `prefers-reduced-motion`** for the status pulse and the mic-recording pulse
  ([styles.css:826](../src/sidebar/styles.css#L826)).
- **Don't rely on colour alone** for the context/plan/activity status dots — they already pair a
  shape/label in most places; verify each has a text or icon partner.

---

## 6. Learnability & labels / IA (P2)

The recent usability pass already fixed the big learnability issues (onboarding, tabbed Settings,
plain-language toolbar, error guidance + Retry, history search). Building on that:

- **"New chat" beats a bare trash icon.** Frame the primary repeated action as starting fresh
  ("＋ New") rather than "Delete," and surface "find past chats in History" so clearing never
  feels like data loss.
- **First-message affordances.** The empty state explains *what* to do well
  ([03-empty-chat.png](usability/screenshots/03-empty-chat.png)); add 2–3 **example prompt
  chips** ("Summarize this page", "Compare my open tabs") for one-tap starts — the single
  biggest learnability lever for chat UIs.
- **Tooltips on every icon-only control** (some already have `title`/`aria-label` from the U5
  pass — audit for 100% coverage, since labels are now hidden by §3's compaction).
- **Consistent close affordance:** standardize on the SVG ✕ icon everywhere (some overlays use a
  text `✕`).

---

## 7. Component-level polish (P3)

- **Buttons:** give `.btn-primary` the brand fill and a subtle hover lift; keep secondary
  `.btn` ghost-style but on the new neutrals. One primary button per view.
- **User bubble:** swap dark blue for `--brand-600`; keep white text (contrast holds). Consider
  the assistant bubble *borderless* on `--bg-panel` for a lighter thread.
- **Inputs:** unify the focus ring (§5); the contenteditable composer, settings fields, repo
  input, and search box currently each restyle focus slightly differently.
- **Label chips:** the 8-colour chip palette is good and accessible — align its violet/pink
  entries to the new brand hues so user labels feel part of the same family.
- **Active settings tab** already uses `--accent`; it'll inherit the brand automatically.

---

## Suggested rollout (low-risk, reversible)

All of this is CSS-token-driven, so it can land in safe phases and be A/B-eyeballed via the
existing Playwright walkthrough (regenerate `docs/usability/screenshots/`):

| Phase | Scope | Risk |
|------|-------|------|
| **1** ✅ | Swap palette tokens (§1) + contrast/focus/touch fixes (§5) | low — token + a11y only |
| **2** ✅ | Header declutter: demote status, retire ransom animation, "New chat" reframe (§2–3) | low — markup tweaks |
| **3** ✅ | Gestalt spacing/border/radius pass (§4) + button/bubble restyle (§7) | low — CSS |
| **4** | Example-prompt chips + label/IA wording (§6) | small component work |

*Phases 1–3 shipped. The text-scaler was intentionally retained in the header (used constantly).
Phase 3 unified control radii to 8px, gave history cards a borderless resting state (grouped by
fill + spacing, accent border on hover), loosened thread rhythm, and added button press feedback.*

Verification each phase: `mise run typecheck` · `npm run build` · `npx playwright test walkthrough`
(screenshots) · `npm test`. No behavioural logic changes — purely presentational + a11y.

---

### What's already strong (keep)

Onboarding-first config, tabbed Settings, approval gating, Test-connection probe, the empty-state
copy, the accessible label-chip system, light/dark via `prefers-color-scheme`, and Enter-to-send +
@/# mentions. The bones are good — this is a re-skin and a declutter, not a rebuild.
