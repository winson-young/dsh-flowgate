
window.__ModuleLoader__.load({
  id: 'dsh-flowgate',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement
    const useEffect = react.useEffect
    const useState = react.useState
    const useRef = react.useRef

    const API = '/api/flowgate'
    const STYLE_ID = 'dsh-flowgate-styles'
    const POLL_MS = 1500

    const CSS_TEXT = `
.fg-root, .fg-root *, .fg-dock, .fg-dock * { box-sizing: border-box; }
.fg-root {
  container: flowgate / inline-size;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  font-size: 13px;
  line-height: 1.6;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
}
.fg-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 20px;
  padding: 16px 22px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  flex: none;
}
.fg-brand { display: flex; align-items: center; gap: 11px; min-width: 0; flex: 1 1 230px; }
.fg-brand-mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 11px;
  background: var(--dsw-alias-interactive-bg-hover);
}
.fg-heading { min-width: 0; }
.fg-title { font-weight: 650; font-size: 14px; line-height: 1.5; letter-spacing: 0.015em; }
.fg-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.fg-task-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 48ch; }
.fg-toolbar { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.fg-spacer { flex: 1; }
.fg-icon { width: 16px; height: 16px; flex: none; vertical-align: middle; }
.fg-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 184px minmax(0, 1fr) 320px;
  grid-template-rows: minmax(0, 1fr);
  grid-template-areas: 'nav main side';
}
.fg-body.collapsed { grid-template-columns: 184px minmax(0, 1fr); grid-template-areas: 'nav main'; }
.fg-nav {
  grid-area: nav;
  min-width: 0;
  overflow: auto;
  padding: 22px 12px;
  border-right: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.fg-nav-heading { padding: 0 12px 16px; }
.fg-nav-heading .fg-tiny { margin-top: 4px; }
.fg-stage-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.fg-stage {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 12px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  cursor: default;
}
.fg-stage.on {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, var(--dsw-alias-border-l2));
  background: var(--dsw-alias-state-business-tertiary);
}
.fg-stage-top { display: flex; align-items: center; gap: 9px; min-width: 0; }
.fg-stage-idx {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 27px;
  height: 27px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  font-size: 11px;
  line-height: 1;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-base);
}
.fg-stage.on .fg-stage-idx { color: var(--dsw-alias-state-business-primary); border-color: currentColor; }
.fg-stage.passed .fg-stage-idx { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-tertiary); }
.fg-stage-name { font-size: 13px; line-height: 1.5; font-weight: 550; }
.fg-stage.on .fg-stage-name { font-weight: 650; }
.fg-stage-out { margin-left: 36px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.fg-stage-status { margin-left: 36px; }
.fg-stage.skipped_by_user .fg-stage-idx { border-style: dashed; }
.fg-main {
  grid-area: main;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  /* 底部让出输入框的高度：视图带 data-conversation-composer-overlay 后，输入框是浮在
     视图之上的绝对定位元素（ConversationRoot.module.css:294），不留 clearance 会把
     卡片最后一行压在输入框下面。--dsh-composer-height 由 ConversationRoot 的
     seat observer 实时发布（ConversationRoot.tsx:46）。 */
  padding: 26px clamp(18px, 2.4cqi, 36px) calc(var(--dsh-composer-height, 152px) + 20px);
  scrollbar-gutter: stable;
}
.fg-root > .fg-main { flex: 1; }
.fg-content { display: flex; flex-direction: column; gap: 20px; width: 100%; max-width: 1040px; margin-inline: auto; min-width: 0; }
.fg-main-intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 0 2px 2px; }
.fg-main-intro h1 { margin: 5px 0 6px; font-size: 23px; line-height: 1.35; font-weight: 650; letter-spacing: -0.025em; }
.fg-main-intro p { margin: 0; max-width: 64ch; }
.fg-main-intro > .fg-badge { margin-top: 5px; }
.fg-side {
  grid-area: side;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 18px 16px 28px;
  gap: 16px;
  border-left: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  scrollbar-gutter: stable;
}
.fg-gate, .fg-settings { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.fg-gate {
  grid-area: gate;
  padding: 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
}
.fg-gate.ready { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, var(--dsw-alias-border-l2)); }
.fg-gate-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.fg-gate .fg-btn { width: 100%; }
.fg-gate .fg-doc-actions { display: flex; flex-direction: column; }
.fg-gate .fg-doc-actions .fg-btn { flex: none; }
.fg-gate .fg-doc-actions .fg-btn:first-child { flex: none; }
/* 放弃入口：与门禁按钮用一条虚线分开，视觉上降级，避免和主操作抢注意力。 */
.fg-abandon { margin-top: 2px; padding-top: 12px; border-top: 1px dashed var(--dsw-alias-border-l1); }
.fg-abandon .fg-tiny { margin-bottom: 2px; }
.fg-settings { grid-area: settings; padding: 6px 0; gap: 16px; }
.fg-settings-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 4px; }
.fg-settings-section { display: flex; flex-direction: column; gap: 9px; padding: 0 4px 16px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.fg-settings-section:last-of-type { border-bottom: 0; padding-bottom: 0; }
.fg-settings-section h3 { margin: 0; }
.fg-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.fg-settings-section > .fg-btn { align-self: flex-start; }
.fg-setting-items { display: flex; flex-direction: column; gap: 3px; }
.fg-settings .fg-btn { padding: 7px 10px; font-size: 12px; line-height: 1.5; }
.fg-settings .fg-row .fg-badge { max-width: 100%; }
.fg-settings-note { padding: 0 4px; }
.fg-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  flex-shrink: 0;
  padding: 20px 22px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1);
}
.fg-card.grow { min-height: 440px; }
.fg-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.fg-card-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; margin: 0; font-weight: 650; font-size: 14px; line-height: 1.5; }
.fg-q { max-width: 52ch; font-size: 20px; line-height: 1.5; font-weight: 600; letter-spacing: -0.015em; }
.fg-muted { color: var(--dsw-alias-label-secondary); line-height: 1.7; overflow-wrap: anywhere; }
.fg-tiny { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.fg-empty { padding: 14px 0; }
.fg-opt {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 7px;
  text-align: left;
  width: 100%;
  min-width: 0;
  padding: 15px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease;
}
.fg-opt:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-interactive-bg-hover); }
.fg-opt:disabled { opacity: 0.5; cursor: not-allowed; }
.fg-opt.rec { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-tertiary) 55%, var(--dsw-alias-bg-layer-1)); }
.fg-opt-label { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-weight: 600; line-height: 1.5; }
.fg-opt-label > .fg-badge { margin-left: auto; }
.fg-opt-tradeoff { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.fg-options { gap: 10px; }
.fg-custom-answer { display: flex; flex-wrap: wrap; gap: 8px; }
.fg-custom-answer .fg-input { width: auto; flex: 1 1 180px; }
.fg-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
.fg-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 36px;
  max-width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  font-weight: 500;
  text-align: center;
  overflow-wrap: anywhere;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease;
}
.fg-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l4); background: var(--dsw-alias-interactive-bg-hover); }
.fg-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.fg-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground); font-weight: 600; }
.fg-btn.primary:hover:not(:disabled) { opacity: 0.88; }
.fg-btn.danger { color: var(--dsw-alias-state-error-primary); }
.fg-btn.danger:hover:not(:disabled) { border-color: var(--dsw-alias-state-error-secondary); background: var(--dsw-alias-interactive-bg-hover-danger); }
.fg-btn.quiet { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.fg-btn.quiet:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.fg-root :is(button, input, textarea):focus-visible, .fg-dock button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; }
.fg-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 18px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.fg-badge.ok { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-secondary) 28%, var(--dsw-alias-border-l2)); background: var(--dsw-alias-state-success-tertiary); }
.fg-badge.warn { color: var(--dsw-alias-state-warn-label); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-secondary) 28%, var(--dsw-alias-border-l2)); background: var(--dsw-alias-state-warn-tertiary); }
.fg-badge.bad { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-secondary) 28%, var(--dsw-alias-border-l2)); background: var(--dsw-alias-interactive-bg-hover-danger); }
.fg-badge.info { color: var(--dsw-alias-state-business-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, var(--dsw-alias-border-l2)); background: var(--dsw-alias-state-business-tertiary); }
.fg-doc { display: flex; min-width: 0; min-height: 380px; height: 48vh; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; }
.fg-doc iframe { flex: 1; width: 100%; min-width: 0; min-height: 380px; border: 0; background: transparent; }
.fg-doc-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.fg-doc-actions .fg-btn:first-child { flex: 1 1 180px; }
.fg-preset-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.fg-list { display: flex; flex-direction: column; min-width: 0; gap: 8px; }
.fg-item { display: flex; align-items: baseline; flex-wrap: wrap; min-width: 0; gap: 8px 12px; padding: 11px 13px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); overflow-wrap: anywhere; }
.fg-item > :not(.fg-badge) { min-width: 0; }
.fg-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.fg-rule { display: flex; flex-direction: column; gap: 3px; }
.fg-report-group { display: flex; flex-direction: column; gap: 10px; }
.fg-report-group + .fg-report-group { border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 18px; }
.fg-finding { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 5px 10px; }
.fg-finding .fg-badge { grid-row: span 2; align-self: start; margin-top: 1px; }
.fg-finding .fg-finding-summary { grid-column: 2; }
.fg-test-point { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 4px 10px; }
.fg-test-point > .fg-tiny { grid-column: 2; }
.fg-check { display: flex; align-items: flex-start; min-width: 0; gap: 9px; padding: 9px 8px; border-radius: 8px; cursor: pointer; }
.fg-check:hover { background: var(--dsw-alias-interactive-bg-hover); }
.fg-check input { width: 15px; height: 15px; margin: 3px 0 0; flex: none; accent-color: var(--dsw-alias-brand-primary); cursor: inherit; }
.fg-check > span { min-width: 0; }
.fg-check .fg-tiny { margin-top: 3px; font-size: 11px; line-height: 1.6; }
.fg-grant { margin: 2px 0 6px 24px; border-left: 2px solid var(--dsw-alias-state-warn-secondary); border-radius: 0 8px 8px 0; }
.fg-input, .fg-textarea { width: 100%; min-width: 0; padding: 9px 11px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-base); color: inherit; font: inherit; font-size: 12px; line-height: 1.6; }
.fg-input::placeholder, .fg-textarea::placeholder { color: var(--dsw-alias-label-tertiary); opacity: 1; }
.fg-textarea { min-height: 88px; resize: vertical; }
.fg-form { padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-base); }
.fg-err { padding: 12px 14px; border: 1px solid var(--dsw-alias-state-error-secondary); border-radius: 9px; background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.fg-banner { padding: 12px 22px 0; flex: none; }
.fg-hr { height: 1px; flex: none; background: var(--dsw-alias-border-l2); }
.fg-sec-title { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; font-weight: 600; }
/* 与输入框等宽：dock 槽和输入栏是 .composerStack 里的兄弟节点（ConversationRoot.tsx:164-165），
   而输入框卡片的几何是「列宽减去两侧 clearance，上限 card-max-width」（InputBar.module.css:28/63-64）。
   这里照同一套算式算，两侧边缘才能和输入框对齐；同槽的 Todo / Goal 条刻意再内缩 4×dock-inset，
   那是它们比输入框略窄的设计，不是等宽。 */
.fg-dock {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px 10px;
  min-width: 0;
  width: calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px));
  max-width: var(--dsh-composer-card-max-width, 780px);
  margin: 0 auto 8px;
  padding: 9px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.5;
}
.fg-welcome { display: flex; flex-direction: column; justify-content: center; gap: 24px; width: min(100%, 760px); min-height: 70%; margin: 0 auto; }
.fg-welcome h1 { margin: 0; font-size: 26px; line-height: 1.35; font-weight: 650; letter-spacing: -0.025em; }
.fg-welcome p { margin: 10px 0 0; }
.fg-welcome-steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.fg-welcome-step { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; }
@container flowgate (max-width: 1180px) {
  .fg-body { grid-template-columns: minmax(0, 1fr) 294px; grid-template-rows: auto minmax(0, 1fr); grid-template-areas: 'nav nav' 'main side'; }
  .fg-body.collapsed { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'nav' 'main'; }
  .fg-nav { padding: 10px 18px; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
  .fg-nav-heading { display: none; }
  .fg-stage-list { flex-direction: row; gap: 8px; }
  .fg-stage { flex: 1 1 0; padding: 9px 10px; }
  .fg-stage-out, .fg-stage-status { display: none; }
  .fg-stage-top { gap: 7px; }
  .fg-stage-name { font-size: 12px; }
  .fg-side { padding: 16px 12px 24px; }
  .fg-main { padding: 22px 20px calc(var(--dsh-composer-height, 152px) + 16px); }
  .fg-head { padding: 14px 18px; }
  .fg-toolbar { gap: 6px; }
  .fg-card { padding: 18px; }
}
@container flowgate (max-width: 820px) {
  .fg-body { overflow: auto; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto auto; grid-template-areas: 'nav' 'gate' 'main' 'settings'; align-content: start; padding-bottom: calc(var(--dsh-composer-height, 152px) + 12px); }
  .fg-body.collapsed { grid-template-rows: auto auto; grid-template-areas: 'nav' 'main'; }
  .fg-nav { overflow: visible; padding: 10px 14px; }
  .fg-side { display: contents; }
  .fg-gate { margin: 16px 16px 0; padding: 14px; }
  .fg-gate > .fg-btn, .fg-gate .fg-doc-actions > .fg-btn { width: auto; flex: 1 1 180px; }
  .fg-gate { flex-direction: row; flex-wrap: wrap; gap: 8px; }
  .fg-gate > :not(.fg-btn) { width: 100%; }
  .fg-gate .fg-doc-actions { flex-direction: row; }
  .fg-gate .fg-doc-actions .fg-btn:first-child { flex: 1 1 180px; }
  .fg-main { min-height: auto; overflow: visible; padding: 22px 16px 8px; scrollbar-gutter: auto; }
  .fg-settings { margin: 0 16px; padding: 18px 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; }
  .fg-settings-section { padding-inline: 0; }
  .fg-main-intro h1 { font-size: 21px; }
  .fg-head { gap: 10px; padding: 14px 16px; }
  .fg-toolbar { justify-content: flex-start; }
  .fg-stage-list { gap: 4px; }
  .fg-stage { padding: 8px 6px; }
  .fg-stage-idx { width: 24px; height: 24px; }
  .fg-content { gap: 16px; }
  .fg-q { font-size: 18px; }
  .fg-task-title { max-width: 100%; }
}
@container flowgate (max-width: 480px) {
  .fg-head { padding: 12px; }
  .fg-toolbar { width: 100%; }
  .fg-toolbar > .fg-badge { max-width: 100%; white-space: normal; }
  .fg-nav { padding: 8px; }
  .fg-stage-top { flex-direction: column; gap: 4px; }
  .fg-stage-name { font-size: 11px; }
  .fg-gate { margin-inline: 12px; }
  .fg-main { padding: 20px 12px 6px; }
  .fg-card { padding: 16px; border-radius: 12px; }
  .fg-card-title { font-size: 13px; }
  .fg-main-intro { flex-direction: column; gap: 10px; }
  .fg-main-intro > .fg-badge { margin-top: 0; }
  .fg-settings { margin-inline: 12px; }
  .fg-preset-options { grid-template-columns: minmax(0, 1fr); }
  .fg-welcome-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: reduce) {
  .fg-root *, .fg-dock * { transition: none; }
}
`

    let sharedSheet = null

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (sharedSheet || document.getElementById(STYLE_ID)) return
      try {
        if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
          const sheet = new CSSStyleSheet()
          sheet.replaceSync(CSS_TEXT)
          document.adoptedStyleSheets = Array.from(document.adoptedStyleSheets).concat(sheet)
          sharedSheet = sheet
          return
        }
      } catch (error) {
        // 落到 <style> 路径
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS_TEXT
      document.head.appendChild(style)
    }

    // -----------------------------------------------------------------------
    // 数据层：客户端只拉取 + 渲染 + 回调，流程逻辑全在宿主
    // -----------------------------------------------------------------------

    const EMPTY = { view: null, error: null }

    /** sessionId → { view, error } */
    const entries = new Map()
    /** sessionId → Set<listener> */
    const listeners = new Map()
    /** sessionId → interval */
    const timers = new Map()

    function emit(sessionId) {
      const set = listeners.get(sessionId)
      if (!set) return
      for (const fn of Array.from(set)) fn()
    }

    function setEntry(sessionId, next) {
      entries.set(sessionId, next)
      emit(sessionId)
    }

    async function pull(sessionId) {
      try {
        const res = await fetch(API + '/state?sessionId=' + encodeURIComponent(sessionId), {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
        if (!res.ok) throw new Error('宿主返回 HTTP ' + res.status)
        const view = await res.json()
        setEntry(sessionId, { view, error: null })
      } catch (error) {
        const prev = entries.get(sessionId) || EMPTY
        setEntry(sessionId, { view: prev.view, error: error?.message ?? String(error) })
      }
    }

    function subscribe(sessionId, fn) {
      let set = listeners.get(sessionId)
      if (!set) {
        set = new Set()
        listeners.set(sessionId, set)
      }
      set.add(fn)
      if (!timers.has(sessionId)) {
        void pull(sessionId)
        const timer = setInterval(() => { void pull(sessionId) }, POLL_MS)
        timers.set(sessionId, timer)
      }
      return () => {
        set.delete(fn)
        if (set.size === 0) {
          const timer = timers.get(sessionId)
          if (timer) clearInterval(timer)
          timers.delete(sessionId)
        }
      }
    }

    function useEntry(sessionId) {
      const [entry, setState] = useState(() => entries.get(sessionId) || EMPTY)
      useEffect(() => {
        let alive = true
        const sync = () => { if (alive) setState(entries.get(sessionId) || EMPTY) }
        sync()
        const unsubscribe = subscribe(sessionId, sync)
        return () => { alive = false; unsubscribe() }
      }, [sessionId])
      return entry
    }

    /** 提交一次按钮操作；返回错误文案或 null。 */
    async function act(sessionId, action, payload) {
      try {
        const res = await fetch(API + '/action', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, action, payload: payload || {} }),
        })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(data?.error || '宿主返回 HTTP ' + res.status)
        if (data && typeof data === 'object' && 'active' in data) setEntry(sessionId, { view: data, error: null })
        else void pull(sessionId)
        return null
      } catch (error) {
        const message = error?.message ?? String(error)
        const prev = entries.get(sessionId) || EMPTY
        setEntry(sessionId, { view: prev.view, error: message })
        return message
      }
    }

    // -----------------------------------------------------------------------
    // 原子组件
    // -----------------------------------------------------------------------

    function Icon({ name }) {
      const paths = {
        workbench: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
        refresh: 'M20 7v5h-5 M4 17v-5h5 M6.1 7a7 7 0 0 1 11.5-2L20 8 M4 16l2.4 3A7 7 0 0 0 18 17',
        panel: 'M4 4h16v16H4z M14 4v16',
        check: 'M5 12l4 4L19 6',
        lock: 'M6 10h12v10H6z M8 10V7a4 4 0 0 1 8 0v3',
      }
      return h('svg', { className: 'fg-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: paths[name] || paths.workbench }))
    }

    function Badge({ tone, children }) {
      return h('span', { className: 'fg-badge' + (tone ? ' ' + tone : '') }, children)
    }

    function Btn({ children, onClick, disabled, tone, title, expanded, controls }) {
      return h('button', {
        type: 'button',
        className: 'fg-btn' + (tone ? ' ' + tone : ''),
        onClick,
        disabled: Boolean(disabled),
        title,
        'aria-expanded': expanded,
        'aria-controls': controls,
      }, children)
    }

    function Card({ title, children, grow, extra }) {
      return h('section', { className: 'fg-card' + (grow ? ' grow' : '') },
        title ? h('div', { className: 'fg-card-head' }, h('h2', { className: 'fg-card-title' }, title), extra) : null,
        children)
    }

    function Empty({ children }) {
      return h('div', { className: 'fg-muted fg-empty' }, children)
    }

    const STAGE_TONE = { passed: 'ok', active: 'info', skipped_by_user: '', pending: '' }
    const STAGE_TEXT = { passed: '已通过', active: '进行中', skipped_by_user: '已跳过', pending: '待开始' }
    const VERDICT_TONE = { pass: 'ok', blocking: 'bad', advisory: 'warn' }
    const VERDICT_TEXT = { pass: '通过', blocking: '有阻塞项', advisory: '有建议项' }
    const SEV_TONE = { CRITICAL: 'bad', MAJOR: 'warn', MINOR: '' }
    const RESULT_TONE = { pass: 'ok', fail: 'bad', uncovered: 'warn' }
    const RESULT_TEXT = { pass: '通过', fail: '失败', uncovered: '未覆盖' }

    // -----------------------------------------------------------------------
    // S1：追问卡片
    // -----------------------------------------------------------------------

    function GrillCard({ sessionId, pending }) {
      const [custom, setCustom] = useState('')
      const [showCustom, setShowCustom] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)

      useEffect(() => {
        setCustom('')
        setShowCustom(false)
        setError(null)
        setNotice(null)
      }, [pending.id])

      const options = Array.isArray(pending.options) ? pending.options : []
      const recommended = Number.isInteger(pending.recommended) ? pending.recommended : 0

      const submit = async (choiceIndex, customText) => {
        setBusy(true)
        setError(null)
        const failure = await act(sessionId, 'answer', { choiceIndex, customText: customText || '' })
        setBusy(false)
        if (failure) setError(failure)
      }

      return h(Card, { title: ['决策问题', h(Badge, { key: 'c', tone: 'info' }, 'S1 需求分析')] },
        h('div', { className: 'fg-q' }, pending.question),
        pending.context ? h('div', { className: 'fg-muted' }, pending.context) : null,
        h('div', { className: 'fg-list fg-options' }, options.map((option, index) =>
          h('button', {
            key: 'opt-' + index,
            type: 'button',
            className: 'fg-opt' + (index === recommended ? ' rec' : ''),
            disabled: busy,
            onClick: () => { void submit(index, '') },
          },
            h('span', { className: 'fg-opt-label' },
              h('span', null, option?.label ?? '选项 ' + (index + 1)),
              index === recommended ? h(Badge, { tone: 'info' }, '推荐') : null),
            option?.tradeoff ? h('span', { className: 'fg-opt-tradeoff' }, option.tradeoff) : null))),
        pending.allowCustom === false ? null : (showCustom
          ? h('div', { className: 'fg-custom-answer' },
              h('input', {
                className: 'fg-input',
                'aria-label': '自定义答案',
                value: custom,
                placeholder: '用一句话说明你的选择',
                autoFocus: true,
                onChange: (event) => setCustom(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && custom.trim()) void submit(-1, custom.trim())
                },
              }),
              h(Btn, {
                tone: 'primary',
                disabled: busy || !custom.trim(),
                onClick: () => { void submit(-1, custom.trim()) },
              }, '提交'))
          : h('div', { className: 'fg-row' },
              h(Btn, { onClick: () => setShowCustom(true), disabled: busy }, '自定义'),
              // PRD 4.1.1：跳过不推进、不放行，卡片保持在前。
              h(Btn, { disabled: busy, onClick: () => setNotice('跳过不会放行追问：必须选择一个选项（或填自定义）才能继续。') }, '跳过'))),
        error ? h('div', { className: 'fg-err' }, error) : null,
        notice ? h('div', { className: 'fg-muted' }, notice) : null,
        h('div', { className: 'fg-tiny' }, '必须选择一项才能继续：追问不放行，也不会替你假设答案。'))
    }

    // -----------------------------------------------------------------------
    // S1：需求文档
    // -----------------------------------------------------------------------

    function DocGate({ sessionId, view, waiting, busy, setBusy }) {
      const run = async (decision) => {
        setBusy(true)
        await act(sessionId, 'doc', { decision })
        setBusy(false)
      }
      if (!waiting) {
        return h('div', { className: 'fg-tiny' }, '门禁未就绪：等 Agent 提交需求文档后，这里会出现「批准并冻结 scope」。')
      }
      return h('div', { className: 'fg-doc-actions' },
        h(Btn, { tone: 'primary', disabled: busy, onClick: () => { void run('approve') } }, '批准并冻结 scope'),
        h(Btn, { disabled: busy, onClick: () => { void run('revise') } }, '修改需求'),
        h(Btn, { disabled: busy, onClick: () => { void run('skip') } }, '跳过评审，直接开发'))
    }

    function PresetPicker({ sessionId, view, busy, setBusy }) {
      const presets = view.presets || {}
      const keys = Object.keys(presets)
      const recommended = view.doc?.recommendedPreset
      const choose = async (key) => {
        setBusy(true)
        await act(sessionId, 'preset', { preset: key })
        setBusy(false)
      }
      return h('div', { className: 'fg-list' },
        h('div', { className: 'fg-sec-title' }, '执行档位'),
        h('div', { className: 'fg-preset-options' }, keys.map((key) => h('button', {
          key: 'preset-' + key,
          type: 'button',
          className: 'fg-opt' + (view.preset === key ? ' rec' : ''),
          'aria-pressed': view.preset === key,
          disabled: busy,
          onClick: () => { void choose(key) },
        },
          h('span', { className: 'fg-opt-label' },
            h('span', null, presets[key]?.label ?? key),
            view.preset === key ? h(Badge, { tone: 'ok' }, '当前') : (key === recommended ? h(Badge, { tone: 'info' }, '推荐') : null)),
          h('span', { className: 'fg-opt-tradeoff' }, presets[key]?.summary ?? '')))),
        view.doc?.reason ? h('div', { className: 'fg-tiny' }, '推荐理由：' + view.doc.reason) : null)
    }

    function DocCard({ sessionId, view, waiting }) {
      const [busy, setBusy] = useState(false)
      const doc = view.doc || {}
      return h(Card, { title: ['需求文档', h(Badge, { key: 'b', tone: 'info' }, '自包含 HTML')], grow: true },
        h('div', { className: 'fg-doc' },
          h('iframe', { title: '需求文档预览', sandbox: '', srcDoc: doc.html || '' })),
        h('div', { className: 'fg-hr' }),
        h(PresetPicker, { sessionId, view, busy, setBusy }),
        h('div', { className: 'fg-hr' }),
        h(DocGate, { sessionId, view, waiting, busy, setBusy }),
        h('div', { className: 'fg-tiny' },
          '「批准并冻结 scope」= S1 出口门禁通过；「跳过评审，直接开发」仍会冻结 scope，但记为用户跳过。'))
    }

    // -----------------------------------------------------------------------
    // S2：开发
    // -----------------------------------------------------------------------

    function ScopeBlock({ scope }) {
      const data = scope?.data || {}
      const files = Array.isArray(data.in_scope?.files_expected_to_change) ? data.in_scope.files_expected_to_change : []
      const capabilities = Array.isArray(data.in_scope?.capabilities) ? data.in_scope.capabilities : []
      const outOfScope = Array.isArray(data.out_of_scope_explicitly) ? data.out_of_scope_explicitly : []
      const criteria = Array.isArray(data.acceptance_criteria) ? data.acceptance_criteria : []
      return h(Card, { title: ['冻结 scope', scope?.frozen ? h(Badge, { key: 'f', tone: 'ok' }, '已冻结') : h(Badge, { key: 'f', tone: 'warn' }, '未冻结')] },
        scope?.withoutDocApproval ? h('div', { className: 'fg-tiny' }, '注意：scope 是在需求文档未获批准的情况下冻结的。') : null,
        h('div', { className: 'fg-sec-title' }, '允许改动的文件'),
        files.length
          ? h('div', { className: 'fg-list' }, files.map((file, index) => h('div', { key: 'f-' + index, className: 'fg-item' },
              h('span', { className: 'fg-mono' }, file))))
          : h(Empty, null, '未声明文件白名单——任何写操作都会被阻断。'),
        capabilities.length ? h('div', { className: 'fg-sec-title' }, '要交付的能力') : null,
        capabilities.length ? h('div', { className: 'fg-list' }, capabilities.map((item, index) => h('div', { key: 'c-' + index, className: 'fg-item' }, item))) : null,
        outOfScope.length ? h('div', { className: 'fg-sec-title' }, '明确不做') : null,
        outOfScope.length ? h('div', { className: 'fg-list' }, outOfScope.map((item, index) => h('div', { key: 'o-' + index, className: 'fg-item' }, item))) : null,
        criteria.length ? h('div', { className: 'fg-sec-title' }, '验收标准') : null,
        criteria.length ? h('div', { className: 'fg-list' }, criteria.map((item, index) => h('div', { key: 'a-' + index, className: 'fg-item' },
          h('div', null,
            h('div', { className: 'fg-mono' }, item?.id ?? 'AC-' + (index + 1)),
            h('div', null, '当 ' + (item?.when ?? '') ),
            h('div', null, '则 ' + (item?.then ?? '')))))) : null)
    }

    /** PRD 4.5：开发规则在 S2 里是结构化检查清单，S3 会逐条核对。 */
    function RuleCard({ view }) {
      const rules = Array.isArray(view.rules) ? view.rules : []
      return h(Card, { title: ['开发规则检查清单', h(Badge, { key: 's', tone: 'info' }, 'S2 开发')] },
        rules.length
          ? h('div', { className: 'fg-list' }, rules.map((rule, index) => h('div', { key: 'r-' + index, className: 'fg-item fg-rule' },
              h('strong', null, rule.name),
              (rule.points ?? []).length
                ? h('div', { className: 'fg-tiny' }, (rule.points ?? []).join('；'))
                : null)))
          : h(Empty, null, '当前没有启用的开发规则。可以在右侧「阶段设置 → 开发规则」里勾选或追加。'),
        h('div', { className: 'fg-tiny' }, 'S3 的正确性与风格角度会逐条核对这些规则，未遵守的会出现在评审发现里。'))
    }

    function DevCard({ view }) {
      const changes = view.devChanges
      const files = Array.isArray(changes?.files) ? changes.files : []
      const untracked = Array.isArray(changes?.untracked) ? changes.untracked : []
      return h(Card, { title: ['开发变更', h(Badge, { key: 's', tone: 'info' }, 'S2 开发')] },
        changes
          ? h('div', null,
              h('div', { className: 'fg-row' },
                h(Badge, { tone: 'info' }, files.length + ' 个文件'),
                h(Badge, { tone: 'ok' }, '+' + (changes.added ?? 0)),
                h(Badge, { tone: 'bad' }, '-' + (changes.removed ?? 0)),
                untracked.length ? h(Badge, { key: 'u', tone: 'warn' }, untracked.length + ' 个新增') : null),
              files.length
                ? h('div', { className: 'fg-list', style: { marginTop: '8px' } }, files.map((file, index) =>
                    h('div', { key: 'd-' + index, className: 'fg-item' },
                      untracked.includes(file) ? h(Badge, { tone: 'warn' }, '新增') : null,
                      h('span', { className: 'fg-mono' }, file))))
                : h('div', { className: 'fg-tiny' }, 'git 未报告任何改动。'),
              // 采集不到不等于没有变更：把宿主给的原因原样显示，别让空摘要看起来像「什么都没改」。
              changes.error ? h('div', { className: 'fg-err' }, changes.error) : null)
          : h(Empty, null, '变更摘要会在点击「完成开发」时由宿主自动采集（文件列表 + 行数），不需要手贴 diff。'),
        h('div', { className: 'fg-tiny' }, '开发期间，任何对 scope 白名单之外文件的写操作都会被宿主端拦截；变更性 shell 同样被拒绝。'))
    }

    // -----------------------------------------------------------------------
    // S3：评审
    // -----------------------------------------------------------------------

    function ReviewCard({ view }) {
      const review = view.review
      if (!review) {
        return h(Card, { title: ['评审报告', h(Badge, { key: 'r', tone: 'info' }, 'S3 评审')] },
          h(Empty, null, '等待只读评审子代理提交结构化报告（每个角度一节，每条发现带 file:line 与 severity）。'))
      }
      const angles = Array.isArray(review.angles) ? review.angles : []
      return h(Card, { title: ['评审报告', h(Badge, { key: 'r', tone: 'info' }, 'S3 评审'),
        review.blocking > 0 ? h(Badge, { key: 'b', tone: 'bad' }, review.blocking + ' 个阻塞项') : h(Badge, { key: 'b', tone: 'ok' }, '无阻塞项')] },
        angles.map((angle, index) => h('section', { key: 'ang-' + index, className: 'fg-report-group' },
          h('div', { className: 'fg-row' },
            h('strong', null, angle?.name ?? '角度 ' + (index + 1)),
            h(Badge, { tone: VERDICT_TONE[angle?.verdict] ?? '' }, VERDICT_TEXT[angle?.verdict] ?? String(angle?.verdict ?? '')),
            angle?.suggestUpgrade ? h(Badge, { tone: 'warn' }, '建议升档') : null),
          (Array.isArray(angle?.findings) ? angle.findings : []).length
            ? h('div', { className: 'fg-list' }, angle.findings.map((finding, fIndex) => h('div', { key: 'fi-' + fIndex, className: 'fg-item fg-finding' },
                h(Badge, { tone: SEV_TONE[finding?.severity] ?? '' }, finding?.severity ?? 'MINOR'),
                h('span', { className: 'fg-mono' }, (finding?.file ?? '') + (finding?.line ? ':' + finding.line : '')),
                h('span', { className: 'fg-finding-summary' }, finding?.summary ?? ''))))
            : h('div', { className: 'fg-tiny' }, '该角度没有发现。'))),
        // D4：升档只改执行深度不改范围。发现落在 scope 外时，重做 S2 也修不了，得回 S1。
        (Array.isArray(view.reviewOutsideScope) && view.reviewOutsideScope.length)
          ? h('div', { className: 'fg-err' },
              '有 ' + view.reviewOutsideScope.length + ' 条发现落在冻结 scope 之外（' +
              view.reviewOutsideScope.map((item) => item.file).join('、') +
              '）。重做开发修不了它们：要先回到需求分析阶段更新 scope.json 并重新批准。')
          : null)
    }

    // -----------------------------------------------------------------------
    // S4：测试
    // -----------------------------------------------------------------------

    function TestCard({ view }) {
      const test = view.test
      if (!test) {
        return h(Card, { title: ['测试报告', h(Badge, { key: 't', tone: 'info' }, 'S4 测试')] },
          h(Empty, null, '等待测试执行单元按方向提交结果（每个方向 × 每个要点：通过 / 失败 / 未覆盖）。'))
      }
      const directions = Array.isArray(test.directions) ? test.directions : []
      return h(Card, { title: ['测试报告', h(Badge, { key: 't', tone: 'info' }, 'S4 测试')] },
        directions.map((direction, index) => {
          const points = Array.isArray(direction?.points) ? direction.points : []
          const failed = points.filter((point) => point?.result === 'fail').length
          return h('section', { key: 'dir-' + index, className: 'fg-report-group' },
            h('div', { className: 'fg-row' },
              h('strong', null, direction?.name ?? '方向 ' + (index + 1)),
              failed > 0 ? h(Badge, { tone: 'bad' }, failed + ' 项失败') : h(Badge, { tone: 'ok' }, '全部通过')),
            h('div', { className: 'fg-list' }, points.map((point, pIndex) => h('div', { key: 'p-' + pIndex, className: 'fg-item fg-test-point' },
              h(Badge, { tone: RESULT_TONE[point?.result] ?? '' }, RESULT_TEXT[point?.result] ?? String(point?.result ?? '')),
              h('span', null, point?.point ?? ''),
              point?.detail ? h('span', { className: 'fg-tiny' }, point.detail) : null))))
        }))
    }

    // -----------------------------------------------------------------------
    // 左侧阶段导航（不可点击：阶段之间没有自由导航）
    // -----------------------------------------------------------------------

    function StageNav({ view }) {
      const stages = Array.isArray(view.stages) ? view.stages : []
      return h('nav', { className: 'fg-nav', 'aria-label': '流程阶段' },
        h('div', { className: 'fg-nav-heading' },
          h('div', { className: 'fg-sec-title' }, '流程阶段'),
          h('div', { className: 'fg-tiny' }, '按门禁顺序推进')),
        h('ol', { className: 'fg-stage-list' }, stages.map((stage, index) => {
          const status = stage?.status ?? 'pending'
          const tone = STAGE_TONE[status] ?? ''
          return h('li', {
            key: 'nav-' + index,
            className: 'fg-stage ' + status + (status === 'active' ? ' on' : ''),
            'aria-current': status === 'active' ? 'step' : undefined,
            'aria-label': (stage?.label ?? '') + ' · ' + (STAGE_TEXT[status] ?? status),
            title: '阶段之间没有自由导航，只能通过门禁推进或回退',
          },
            h('div', { className: 'fg-stage-top' },
              h('span', { className: 'fg-stage-idx' }, status === 'passed' ? h(Icon, { name: 'check' }) : stage?.id ?? 'S' + (index + 1)),
              h('span', { className: 'fg-stage-name' }, stage?.label ?? '')),
            h('div', { className: 'fg-stage-out' }, stage?.output ?? ''),
            status === 'active' || status === 'pending' ? null : h('div', { className: 'fg-stage-status' }, h(Badge, { tone }, STAGE_TEXT[status] ?? status)))
        })))
    }

    // -----------------------------------------------------------------------
    // 右侧：阶段设置
    // -----------------------------------------------------------------------

    function CheckRow({ checked, name, points, onChange }) {
      return h('label', { className: 'fg-check' },
        // aria-label 让勾选框对辅助技术和自动化测试都可定位（同一面板里有多个同类勾选框）。
        h('input', { type: 'checkbox', checked, 'aria-label': name, onChange: (event) => onChange(event.target.checked) }),
        h('span', null,
          h('div', null, name),
          Array.isArray(points) && points.length
            ? h('div', { className: 'fg-tiny' }, points.join(' · '))
            : null))
    }

    function SettingsPanel({ sessionId, view }) {
      const [busy, setBusy] = useState(false)
      const [adding, setAdding] = useState(null)
      const [name, setName] = useState('')
      const [points, setPoints] = useState('')
      const [needsWrite, setNeedsWrite] = useState(false)

      const angleIds = new Set((view.angles || []).map((angle) => angle.id))
      const directionIds = new Set((view.directions || []).map((direction) => direction.id))
      const angleCatalog = Array.isArray(view.angleCatalog) ? view.angleCatalog : []
      const directionCatalog = Array.isArray(view.directionCatalog) ? view.directionCatalog : []
      const ruleCatalog = Array.isArray(view.ruleCatalog) ? view.ruleCatalog : []
      const ruleIds = new Set(Array.isArray(view.ruleIds) ? view.ruleIds : (view.rules || []).map((rule) => rule.id))

      const toggle = async (action, id, enabled) => {
        setBusy(true)
        await act(sessionId, action, { id, enabled })
        setBusy(false)
      }

      const submit = async () => {
        if (!name.trim()) return
        setBusy(true)
        const list = points.split('\n').map((line) => line.trim()).filter(Boolean)
        const payload = { name: name.trim(), points: list }
        if (adding === 'direction' && needsWrite) payload.needsWrite = true
        await act(sessionId, adding === 'angle' ? 'addAngle' : adding === 'rule' ? 'addRule' : 'addDirection', payload)
        setBusy(false)
        setName('')
        setPoints('')
        setNeedsWrite(false)
        setAdding(null)
      }

      const canUpgrade = view.preset === 'fast' && !view.finished

      return h('section', { className: 'fg-settings', 'aria-label': '阶段设置' },
        h('div', { className: 'fg-settings-heading' },
          h('h2', { className: 'fg-card-title' }, '阶段设置')),
        h('section', { className: 'fg-settings-section', 'aria-label': '执行档位' },
        h('h3', { className: 'fg-sec-title' }, '执行档位'),
        h('div', { className: 'fg-row' },
          h(Badge, { tone: 'info' }, view.presetInfo?.label ?? view.preset ?? ''),
          canUpgrade ? h(Btn, {
            disabled: busy,
            onClick: async () => { setBusy(true); await act(sessionId, 'upgrade', { preset: 'strict' }); setBusy(false) },
          }, '升档到大需求严格执行') : null),
        canUpgrade && view.stage === 'S3'
          ? h('div', { className: 'fg-tiny' }, '若评审已发现 scope 内的问题，升档会让流程回到 S2 按严格参数重做（scope 不会自动扩充）。')
          : null),
        h('section', { className: 'fg-settings-section', 'aria-label': '评审角度' },
        h('h3', { className: 'fg-sec-title' }, '评审角度'),
        h('div', { className: 'fg-setting-items' }, angleCatalog.map((angle) => h(CheckRow, {
          key: 'angle-' + angle.id,
          checked: angleIds.has(angle.id),
          name: angle.name,
          points: angle.points,
          onChange: (enabled) => { void toggle('toggleAngle', angle.id, enabled) },
        }))),
        adding === 'angle'
          ? h('div', { className: 'fg-list fg-form' },
              h('label', { className: 'fg-field' },
                h('span', { className: 'fg-sec-title' }, '角度名称'),
                h('input', { className: 'fg-input', placeholder: '角度名称', value: name, onChange: (event) => setName(event.target.value) })),
              h('label', { className: 'fg-field' },
                h('span', { className: 'fg-sec-title' }, '检查要点，每行一条'),
                h('textarea', { className: 'fg-textarea', placeholder: '检查要点，每行一条', value: points, onChange: (event) => setPoints(event.target.value) })),
              h('div', { className: 'fg-row' },
                h(Btn, { tone: 'primary', disabled: busy || !name.trim(), onClick: () => { void submit() } }, '追加'),
                h(Btn, { disabled: busy, onClick: () => { setAdding(null); setName(''); setPoints('') } }, '取消')))
          : h('div', null, h(Btn, { disabled: busy, onClick: () => setAdding('angle') }, '追加自定义角度'))),
        h('section', { className: 'fg-settings-section', 'aria-label': '测试方向' },
        h('h3', { className: 'fg-sec-title' }, '测试方向'),
        h('div', { className: 'fg-setting-items' }, directionCatalog.map((direction) => h('div', { key: 'dir-' + direction.id },
          h(CheckRow, {
            checked: directionIds.has(direction.id),
            name: direction.name,
            points: direction.points,
            onChange: (enabled) => { void toggle('toggleDirection', direction.id, enabled) },
          }),
          // D2：v1 唯一的写权限例外，必须由用户在这里显式勾选。
          direction.needsWrite
            ? h('label', { className: 'fg-check fg-grant' },
                h('input', {
                  type: 'checkbox',
                  checked: direction.writeGranted === true,
                  disabled: busy || view.stage !== 'S4',
                  onChange: (event) => { void toggle('toggleWriteGrant', direction.id, event.target.checked) },
                }),
                h('span', null,
                  h('div', null, '授权执行变更性命令'),
                  h('div', { className: 'fg-tiny' },
                    view.stage === 'S4'
                      ? '该方向声明需要写权限。授权只覆盖 shell 命令，代码写工具仍然被拒绝。'
                      : '写权限例外只在 S4 测试阶段开放。')))
            : null))),
        adding === 'direction'
          ? h('div', { className: 'fg-list fg-form' },
              h('label', { className: 'fg-field' },
                h('span', { className: 'fg-sec-title' }, '方向名称'),
                h('input', { className: 'fg-input', placeholder: '方向名称', value: name, onChange: (event) => setName(event.target.value) })),
              h('label', { className: 'fg-field' },
                h('span', { className: 'fg-sec-title' }, '验证要点，每行一条'),
                h('textarea', { className: 'fg-textarea', placeholder: '验证要点，每行一条', value: points, onChange: (event) => setPoints(event.target.value) })),
              h('label', { className: 'fg-check' },
                h('input', { type: 'checkbox', checked: needsWrite, onChange: (event) => setNeedsWrite(event.target.checked) }),
                h('span', null,
                  h('div', null, '这个方向需要写权限'),
                  h('div', { className: 'fg-tiny' }, '勾选后该方向会出现在 S4 的授权清单里，仍需用户在 S4 再显式勾选一次才生效。'))),
              h('div', { className: 'fg-row' },
                h(Btn, { tone: 'primary', disabled: busy || !name.trim(), onClick: () => { void submit() } }, '追加'),
                h(Btn, { disabled: busy, onClick: () => { setAdding(null); setName(''); setPoints(''); setNeedsWrite(false) } }, '取消')))
          : h('div', null, h(Btn, { disabled: busy, onClick: () => setAdding('direction') }, '追加自定义方向'))),
        h('section', { className: 'fg-settings-section', 'aria-label': '开发规则' },
        h('h3', { className: 'fg-sec-title' }, '开发规则'),
        h('div', { className: 'fg-setting-items' }, ruleCatalog.map((rule) => h(CheckRow, {
          key: 'rule-' + rule.id,
          checked: ruleIds.has(rule.id),
          name: rule.name,
          points: rule.points,
          onChange: (enabled) => { void toggle('toggleRule', rule.id, enabled) },
        }))),
        adding === 'rule'
          ? h('div', { className: 'fg-list fg-form' },
              h('label', { className: 'fg-field' },
                h('span', { className: 'fg-sec-title' }, '规则名称'),
                h('input', { className: 'fg-input', placeholder: '规则名称', value: name, onChange: (event) => setName(event.target.value) })),
              h('label', { className: 'fg-field' },
                h('span', { className: 'fg-sec-title' }, '检查要点，每行一条'),
                h('textarea', { className: 'fg-textarea', placeholder: '检查要点，每行一条', value: points, onChange: (event) => setPoints(event.target.value) })),
              h('div', { className: 'fg-row' },
                h(Btn, { tone: 'primary', disabled: busy || !name.trim(), onClick: () => { void submit() } }, '追加'),
                h(Btn, { disabled: busy, onClick: () => { setAdding(null); setName(''); setPoints('') } }, '取消')))
          : h('div', null, h(Btn, { disabled: busy, onClick: () => setAdding('rule') }, '追加自定义开发规则'))),
        h('div', { className: 'fg-tiny fg-settings-note' }, '追加只会在内置集合上加条目，不会替换内置角度、方向或规则。'))
    }

    // -----------------------------------------------------------------------
    // 右侧：门禁
    // -----------------------------------------------------------------------

    function GatePanel({ sessionId, view }) {
      const [busy, setBusy] = useState(false)
      // 放弃是不可撤销的（阶段记录会作废），所以要点两次：第一次只是把按钮换成确认。
      const [confirmCancel, setConfirmCancel] = useState(false)
      const waiting = Boolean(view.waiting)
      const gate = async (decision, to) => {
        setBusy(true)
        await act(sessionId, 'gate', { decision, to })
        setBusy(false)
      }
      const cancel = async () => {
        setBusy(true)
        await act(sessionId, 'cancel', { reason: '用户在工作台放弃这次流程' })
        setBusy(false)
        setConfirmCancel(false)
      }
      const head = h('div', { className: 'fg-gate-heading' },
        h('h2', { className: 'fg-card-title' }, h(Icon, { name: 'lock' }), '出口门禁'),
        h(Badge, {
          tone: view.cancelled ? 'warn' : view.finished ? 'ok' : waiting ? 'info' : '',
        }, view.cancelled ? '已放弃' : view.finished ? '已完成' : waiting ? '等待确认' : '准备中'))

      if (view.finished) {
        return h('section', { className: 'fg-gate', 'aria-label': '出口门禁' },
          head,
          h('div', { className: 'fg-row' },
            view.cancelled
              ? h(Badge, { tone: 'warn' }, '流程已放弃')
              : h(Badge, { tone: 'ok' }, '流程已结束')),
          h('div', { className: 'fg-tiny' }, view.cancelled
            ? '这次流程已放弃（' + (view.cancelReason || '用户主动放弃') + '），scope 已解冻。空态可以直接开始新流程，放弃记录已写入 flows.jsonl。'
            : '四个阶段的产物、门禁操作与跳过标记已写入 flows.jsonl。'))
      }

      const note = waiting
        ? null
        : h('div', { className: 'fg-tiny' }, '门禁未就绪：Agent 正在推进，等它请求门禁后按钮才可用。')

      // 随时可以放弃：不必等门禁就绪，也不受阶段限制。
      const abandon = h('div', { className: 'fg-abandon' },
        confirmCancel
          ? h('div', { className: 'fg-row' },
            h('span', { className: 'fg-tiny' }, '放弃后这次流程的阶段记录与门禁结果都会作废，确定吗？'),
            h(Btn, { tone: 'danger', disabled: busy, onClick: () => { void cancel() } }, '确认放弃'),
            h(Btn, { disabled: busy, onClick: () => setConfirmCancel(false) }, '再想想'))
          : h(Btn, { disabled: busy, onClick: () => setConfirmCancel(true) }, '放弃这次流程'))

      const foot = [note, abandon]

      if (view.stage === 'S1') {
        return h('section', { className: 'fg-gate' + (waiting && !view.finished ? ' ready' : ''), 'aria-label': '出口门禁' },
          head, h(DocGate, { sessionId, view, waiting, busy, setBusy }), foot)
      }

      if (view.stage === 'S2') {
        return h('section', { className: 'fg-gate' + (waiting && !view.finished ? ' ready' : ''), 'aria-label': '出口门禁' },
          head,
          h(Btn, { tone: 'primary', disabled: busy || !waiting, onClick: () => { void gate('pass') } }, '完成开发'),
          h(Btn, { disabled: busy || !waiting, onClick: () => { void gate('skip') } }, '跳过门禁，直接评审'),
          h(Btn, { tone: 'danger', disabled: busy || !waiting, onClick: () => { void gate('back', 'S1') } }, '回到需求分析调整 scope'),
          foot)
      }

      if (view.stage === 'S3') {
        // D4：发现落在 scope 外时，退回开发修不了——这时把回 S1 的入口放到修复之前。
        const overflow = Array.isArray(view.reviewOutsideScope) ? view.reviewOutsideScope : []
        return h('section', { className: 'fg-gate' + (waiting && !view.finished ? ' ready' : ''), 'aria-label': '出口门禁' },
          head,
          h(Btn, { tone: 'primary', disabled: busy || !waiting, onClick: () => { void gate('pass') } }, '通过评审，进入测试'),
          overflow.length
            ? h('div', { className: 'fg-tiny' }, '评审有 ' + overflow.length + ' 条发现落在冻结 scope 之外：退回开发修复也改不到它们，要先调 scope。')
            : null,
          overflow.length
            ? h(Btn, { tone: 'danger', disabled: busy || !waiting, onClick: () => { void gate('back', 'S1') } }, '回到需求分析调整 scope')
            : null,
          h(Btn, { disabled: busy || !waiting, onClick: () => { void gate('back', 'S2') } }, '退回开发修复'),
          h(Btn, { disabled: busy || !waiting, onClick: () => { void gate('skip') } }, '跳过评审，直接测试'),
          foot)
      }

      return h('section', { className: 'fg-gate' + (waiting && !view.finished ? ' ready' : ''), 'aria-label': '出口门禁' },
        head,
        h(Btn, { tone: 'primary', disabled: busy || !waiting, onClick: () => { void gate('pass') } }, '验收通过，结束流程'),
        h(Btn, { disabled: busy || !waiting, onClick: () => { void gate('back', 'S2') } }, '退回开发修复'),
        h(Btn, { disabled: busy || !waiting, onClick: () => { void gate('skip') } }, '跳过测试门禁'),
        foot)
    }

    // -----------------------------------------------------------------------
    // 工作台主视图
    // -----------------------------------------------------------------------

    function stageIndex(stages, id) {
      const found = (stages || []).findIndex((stage) => stage?.id === id)
      return found < 0 ? 0 : found
    }

    function WorkbenchHeading({ subtitle }) {
      return h('div', { className: 'fg-brand' },
        h('span', { className: 'fg-brand-mark' }, h(Icon, { name: 'workbench' })),
        h('div', { className: 'fg-heading' },
          h('div', { className: 'fg-title' }, '流程工作台'),
          subtitle ? h('div', { className: 'fg-sub fg-task-title', title: subtitle }, subtitle) : null))
    }

    function StageIntro({ view, stages, currentIndex }) {
      const descriptions = {
        S1: '明确关键决策，确认需求与本次开发的范围。',
        S2: '对照冻结范围与开发规则，完成本次代码变更。',
        S3: '查看各个角度的评审发现，确认结果后进入测试。',
        S4: '逐项核对测试结果，确认本次交付达到验收标准。',
      }
      return h('div', { className: 'fg-main-intro' },
        h('div', null,
          h('div', { className: 'fg-tiny' }, '第 ' + (currentIndex + 1) + ' / 4 阶段'),
          h('h1', null, stages[currentIndex]?.label ?? '当前阶段'),
          h('p', { className: 'fg-muted' }, descriptions[view.stage] ?? '')),
        h(Badge, { tone: view.finished ? 'ok' : view.waiting ? 'info' : '' },
          view.finished ? '流程已结束' : view.waiting ? '等待你的确认' : '进行中'))
    }

    /**
     * 空态的一键启动：标题可选、档位可选，点一下就能进 S1。
     * 客户端只把 sessionId 交给宿主，工作目录由宿主从会话里解析。
     */
    function StartPanel({ sessionId, presets }) {
      const [title, setTitle] = useState('')
      const [preset, setPreset] = useState('fast')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const keys = Object.keys(presets || {})
      const options = keys.length ? keys : ['fast', 'strict']
      const begin = async () => {
        if (busy) return
        setBusy(true)
        const message = await act(sessionId, 'start', { title: title.trim(), preset })
        setError(message)
        setBusy(false)
      }
      return h(Card, { title: '开始一次新流程' },
        h('div', { className: 'fg-muted' }, '给这次任务起个名字（可以留空），选一个执行档位，然后直接开始——不需要先在对话里让 Agent 调用工具。'),
        h('label', { className: 'fg-field' },
          h('span', { className: 'fg-sec-title' }, '任务标题（可选）'),
          h('input', {
            className: 'fg-input',
            type: 'text',
            value: title,
            placeholder: '例如：会话过期返回 401',
            onChange: (event) => setTitle(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void begin()
              }
            },
          })),
        h('div', { className: 'fg-field' },
          h('span', { className: 'fg-sec-title' }, '执行档位'),
          h('div', { className: 'fg-preset-options' }, options.map((key) => h('button', {
            key: 'start-preset-' + key,
            type: 'button',
            className: 'fg-opt' + (preset === key ? ' rec' : ''),
            'aria-pressed': preset === key,
            disabled: busy,
            onClick: () => setPreset(key),
          },
            h('span', { className: 'fg-opt-label' }, h('span', null, presets?.[key]?.label ?? key)),
            h('span', { className: 'fg-opt-tradeoff' }, presets?.[key]?.summary ?? ''))))),
        h('div', { className: 'fg-row' },
          h(Btn, { tone: 'primary', disabled: busy, onClick: () => { void begin() } }, busy ? '正在启动…' : '开始需求分析')),
        error ? h('div', { className: 'fg-err', role: 'alert' }, error) : null,
        h('div', { className: 'fg-tiny' }, '也可以让 Agent 调用 flowgate_start 启动。阶段顺序是硬性的：S1 需求分析 → S2 开发 → S3 评审 → S4 测试，只能通过门禁推进或回退。'))
    }
    /* 把视图声明成「自己拥有滚动条」：ConversationRoot 用 :has() 认这个属性
       （ConversationRoot.module.css:272-292），认到之后 .scrollBody 不再是滚动容器，
       viewArea 变成 flex:1 1 0 + overflow:hidden，本视图里的 .fg-main / .fg-body 自己滚。
       不加这个属性时 .viewArea 是 flex:1 0 auto + min-height:auto，.fg-root 的 height:100%
       解析成 auto、内容整个摊开在 .scrollBody 里，于是「切到本 tab」会继承聊天视图留下的
       scrollTop，被浏览器 clamp 到新内容的最大值——表现就是一切过来就停在最下面。
       ui-trajectory 是官方同一形态的生产用例（TrajectoryView.tsx:447）。 */
    const ROOT_PROPS = { className: 'fg-root', 'data-conversation-composer-overlay': '' }

    function WorkbenchView(props) {
      const sessionId = props?.sessionId
      const entry = useEntry(sessionId)
      const [collapsed, setCollapsed] = useState(false)
      const [refreshing, setRefreshing] = useState(false)

      if (!sessionId) return null
      const view = entry.view

      if (!view) {
        return h('div', ROOT_PROPS,
          h('header', { className: 'fg-head' }, h(WorkbenchHeading)),
          h('div', { className: 'fg-main' },
            h('div', { className: 'fg-content' },
              entry.error
                ? h('div', { className: 'fg-err', role: 'alert' }, entry.error)
                : h('div', { className: 'fg-muted fg-empty', role: 'status' }, '正在连接宿主端…'))))
      }

      if (!view.active) {
        return h('div', ROOT_PROPS,
          h('header', { className: 'fg-head' }, h(WorkbenchHeading, { subtitle: '当前会话还没有流程' })),
          h('div', { className: 'fg-main' },
            h('div', { className: 'fg-welcome' },
              h('div', null,
                h('div', { className: 'fg-tiny' }, '从需求到验收'),
                h('h1', null, '让每一步开发都有据可循'),
                h('p', { className: 'fg-muted' }, '明确范围、专注开发，经过独立评审与测试后交付。')),
              h('div', { className: 'fg-welcome-steps' }, ['需求分析', '开发', '评审', '测试'].map((label, index) =>
                h('div', { className: 'fg-welcome-step', key: label },
                  h('span', { className: 'fg-tiny' }, '0' + (index + 1)),
                  h('strong', null, label)))),
              h(StartPanel, { sessionId, presets: view.presets }))))
      }

      const stages = Array.isArray(view.stages) ? view.stages : []
      const currentIndex = stageIndex(stages, view.stage)

      const main = []
      if (view.stage === 'S1') {
        if (view.grill?.pending) {
          main.push(h(GrillCard, { key: 'grill', sessionId, pending: view.grill.pending }))
          if (view.grill.answeredCount) {
            main.push(h('div', { key: 'grill-count', className: 'fg-tiny' }, '已回答 ' + view.grill.answeredCount + ' 个决策问题'))
          }
        } else if (view.doc?.html) main.push(h(DocCard, { key: 'doc', sessionId, view, waiting: Boolean(view.waiting) }))
        else main.push(h(Card, { key: 'wait', title: ['需求分析', h(Badge, { key: 'w', tone: 'info' }, 'S1')] },
          h(Empty, null, view.doc?.revisedAt
            ? '你点了「修改需求」。补齐未决项后，Agent 会重新提交需求文档供你批准。'
            : '等待 Agent 提出第一个决策问题。追问会以卡片形式出现在这里，点选项即可回答，不需要键盘输入。'),
          view.grill?.answeredCount ? h('div', { className: 'fg-tiny' }, '已回答 ' + view.grill.answeredCount + ' 个决策问题') : null))
      } else if (view.stage === 'S2') {
        main.push(h(DevCard, { key: 'dev', view }))
        main.push(h(RuleCard, { key: 'rules', view }))
        main.push(h(ScopeBlock, { key: 'scope', scope: view.scope }))
      } else if (view.stage === 'S3') {
        main.push(h(ReviewCard, { key: 'review', view }))
        main.push(h(ScopeBlock, { key: 'scope', scope: view.scope }))
      } else if (view.stage === 'S4') {
        main.push(h(TestCard, { key: 'test', view }))
      }

      return h('div', ROOT_PROPS,
        h('header', { className: 'fg-head' },
          h(WorkbenchHeading, { subtitle: view.title || '未命名需求' }),
          h('div', { className: 'fg-toolbar' },
            h(Badge, { tone: 'info' }, 'S' + (currentIndex + 1) + '/4 · ' + (stages[currentIndex]?.label ?? '')),
            view.skippedCount > 0 ? h(Badge, { tone: 'warn' }, '本流程有 ' + view.skippedCount + ' 个阶段被跳过') : null,
            h(Btn, {
              tone: 'quiet',
              disabled: refreshing,
              title: '立即从宿主端拉取最新状态',
              onClick: async () => { setRefreshing(true); await pull(sessionId); setRefreshing(false) },
            }, h(Icon, { name: 'refresh' }), '刷新'),
            h(Btn, {
              onClick: () => setCollapsed((value) => !value),
              expanded: !collapsed,
              controls: collapsed ? undefined : 'flowgate-side-' + sessionId,
            }, h(Icon, { name: 'panel' }), collapsed ? '显示设置' : '收起设置'))),
        entry.error ? h('div', { className: 'fg-banner' }, h('div', { className: 'fg-err', role: 'alert' }, entry.error)) : null,
        h('div', { className: 'fg-body' + (collapsed ? ' collapsed' : '') },
          h(StageNav, { view }),
          h('main', { className: 'fg-main', 'aria-label': '当前阶段内容' },
            h('div', { className: 'fg-content' }, h(StageIntro, { view, stages, currentIndex }), main)),
          collapsed ? null : h('aside', { className: 'fg-side', id: 'flowgate-side-' + sessionId, 'aria-label': '门禁与阶段设置' },
            h(GatePanel, { sessionId, view }),
            h(SettingsPanel, { sessionId, view }))))
    }

    // -----------------------------------------------------------------------
    // 输入区上方的常驻条
    // -----------------------------------------------------------------------

    function FlowgateDock(props) {
      const sessionId = props?.sessionId
      const entry = useEntry(sessionId)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      if (!sessionId) return null
      const view = entry.view
      if (!view) return null
      // 没有流程时也要能开：输入区上方就是最顺手的入口。
      if (!view.active) {
        const begin = async () => {
          if (busy) return
          setBusy(true)
          setError(await act(sessionId, 'start', { preset: 'fast' }))
          setBusy(false)
        }
        return h('div', { className: 'fg-dock' },
          h('span', { className: 'fg-badge info' }, '未启动'),
          h('span', null, '这个会话还没有流程'),
          h('span', { className: 'fg-spacer' }),
          error ? h('span', { className: 'fg-err', role: 'alert' }, error) : null,
          h(Btn, { tone: 'primary', disabled: busy, onClick: () => { void begin() } }, busy ? '正在启动…' : '开始需求分析'))
      }
      const stages = Array.isArray(view.stages) ? view.stages : []
      const index = stageIndex(stages, view.stage)
      return h('div', { className: 'fg-dock' },
        h('span', { className: 'fg-badge info' }, 'S' + (index + 1) + ' ' + (stages[index]?.label ?? '')),
        view.finished
          ? h('span', null, '流程已结束')
          : h('span', null, view.waiting ? '门禁等你点击确认' : '等待 Agent 推进'),
        view.skippedCount > 0 ? h('span', { className: 'fg-badge warn' }, '已跳过 ' + view.skippedCount + ' 个阶段') : null,
        h('span', { className: 'fg-spacer' }),
        h('span', { className: 'fg-tiny' }, '在「流程工作台」视图里操作'))
    }

    // -----------------------------------------------------------------------
    // 插件入口
    // -----------------------------------------------------------------------

    function apply(ctx) {
      ensureStyles()
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'flowgate',
        order: 8,
        label: () => '流程工作台',
      }, WorkbenchView))
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'flowgate-dock',
        order: 5,
      }, FlowgateDock))
    }

    exports.name = 'dsh-flowgate'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})


