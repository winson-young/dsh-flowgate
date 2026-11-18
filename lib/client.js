
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
.fg-root, .fg-root * { box-sizing: border-box; }
/* 对齐官方 ui-theme：标签、控件、条目、内容块、卡片与弹窗分层使用圆角。
   左侧栏面板是唯一根，跟随宿主主题取值。 */
.fg-root {
  --fg-radius-badge: var(--dsw-radius-xs, 4px);
  --fg-radius-control: var(--dsw-radius-sm, 8px);
  --fg-radius-item: var(--dsw-radius-md, 12px);
  --fg-radius-surface: var(--dsw-radius-lg, 16px);
  --fg-radius-panel: var(--dsw-radius-xl, 20px);
  --fg-radius-dialog: var(--dsw-radius-panel, 28px);
}
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
  border-radius: var(--fg-radius-item);
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
  border-radius: var(--fg-radius-surface);
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
  border-radius: var(--fg-radius-control);
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
  border-radius: var(--fg-radius-panel);
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
/* 工作区默认规则：与「本次流程」的临时勾选分开呈现，避免保存动作被误认为即时生效。 */
.fg-ws-rules {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px dashed var(--dsw-alias-border-l1);
  border-radius: var(--fg-radius-control);
  background: var(--dsw-alias-bg-layer-1);
}
.fg-ws-rules .fg-btn { padding: 6px 10px; }
/* 设置摘要 + 弹窗：侧栏只留摘要，四组配置在弹窗里按分组切换，列表限高独立滚动。 */
.fg-settings-summary { display: flex; flex-direction: column; gap: 10px; padding: 0 4px; }
.fg-settings-summary .fg-btn { align-self: flex-start; }
.fg-modal {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent);
}
.fg-modal-card {
  display: flex;
  flex-direction: column;
  width: min(960px, 100%);
  max-height: min(84vh, 760px);
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--fg-radius-dialog);
  background: var(--dsw-alias-bg-base);
  box-shadow: 0 24px 64px color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent);
}
.fg-modal-card:focus { outline: none; }
.fg-modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.fg-modal-heading { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.fg-modal-head .fg-btn { flex: none; }
.fg-modal-body { display: grid; grid-template-columns: 196px minmax(0, 1fr); flex: 1 1 auto; min-height: 0; }
.fg-modal-nav {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  border-right: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.fg-modal-tab {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: var(--fg-radius-control);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
}
.fg-modal-tab:hover { background: var(--dsw-alias-interactive-bg-hover); }
.fg-modal-tab.on { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); font-weight: 600; }
.fg-modal-tab-count { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; }
.fg-modal-pane { display: flex; flex-direction: column; gap: 10px; min-height: 0; padding: 14px 16px 16px; }
.fg-modal-pane-head { display: flex; flex-direction: column; gap: 3px; flex: none; }
.fg-modal-pane-head h3 { margin: 0; font-size: 13px; font-weight: 650; }
.fg-modal-actions, .fg-modal-form { flex: none; }
.fg-modal-actions .fg-btn { padding: 7px 10px; font-size: 12px; }
.fg-modal-list { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; min-height: 0; overflow: auto; padding-right: 4px; }
.fg-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  flex-shrink: 0;
  padding: 20px 22px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--fg-radius-panel);
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
  border-radius: var(--fg-radius-surface);
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
.fg-required { color: var(--dsw-alias-state-error-primary); }
.fg-decision-opt { flex-direction: row; align-items: flex-start; gap: 12px; padding: 16px; }
.fg-opt-index { display: grid; place-items: center; flex: none; width: 28px; height: 28px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--fg-radius-control); color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 600; }
.fg-decision-opt.rec .fg-opt-index { color: var(--dsw-alias-state-business-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent); }
.fg-opt-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 5px; }
.fg-opt-arrow { flex: none; align-self: center; color: var(--dsw-alias-label-tertiary); }
.fg-custom-answer { flex-direction: column; }
.fg-workspace-primary { min-width: 0; }
.fg-current-flow h3 { margin: 0; font-size: 20px; overflow-wrap: anywhere; }
.fg-current-flow p, .fg-start-section p { margin: 0; overflow-wrap: anywhere; }
.fg-hub > .fg-head { gap: 16px; padding: 22px clamp(16px, 2.4cqi, 32px); }
.fg-hub > .fg-head > .fg-heading { flex: 1; }
.fg-hub > .fg-head h1 { margin: 3px 0 4px; font-size: 23px; font-weight: 650; line-height: 1.4; letter-spacing: -.025em; overflow-wrap: anywhere; }
.fg-hub > .fg-head p { margin: 0; font-size: 12px; }
.fg-hub > .fg-main > .fg-content { width: 100%; max-width: 1080px; margin-inline: auto; }
.fg-hub .fg-ws-row { min-height: 112px; padding: 18px; gap: 8px; }
.fg-hub .fg-ws-name { font-size: 15px; }
.fg-hub .fg-hub-pick { padding-top: 8px; }
.fg-root :is(button, summary, input, textarea):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; }
@container flowgate (max-width: 480px) {
  .fg-decision-opt { padding: 12px; gap: 9px; }
  .fg-opt-arrow { display: none; }
  .fg-hub-ws { grid-template-columns: minmax(0, 1fr); }
}
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
  border-radius: var(--fg-radius-control);
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
.fg-btn:hover:not(:disabled) { border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 30%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary); }
.fg-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.fg-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground); font-weight: 600; }
/* 主按钮必须覆盖普通 hover 的底色与文字色，避免反色文字落在普通按钮的浅底上。 */
.fg-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); border-color: var(--dsw-alias-button-primary-hover); color: var(--dsw-alias-label-primary-foreground); }
.fg-btn.danger { color: var(--dsw-alias-state-error-primary); }
.fg-btn.danger:hover:not(:disabled) { border-color: var(--dsw-alias-state-error-secondary); background: var(--dsw-alias-interactive-bg-hover-danger); color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 85%, var(--dsw-alias-label-primary)); }
.fg-btn.quiet { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.fg-btn.quiet:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.fg-root :is(button, input, textarea):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; }
.fg-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--fg-radius-badge);
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
.fg-doc { display: flex; min-width: 0; min-height: 380px; height: 48vh; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--fg-radius-surface); }
.fg-doc iframe { flex: 1; width: 100%; min-width: 0; min-height: 380px; border: 0; background: transparent; }
.fg-doc-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.fg-doc-actions .fg-btn:first-child { flex: 1 1 180px; }
.fg-preset-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.fg-list { display: flex; flex-direction: column; min-width: 0; gap: 8px; }
.fg-item { display: flex; align-items: baseline; flex-wrap: wrap; min-width: 0; gap: 8px 12px; padding: 11px 13px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--fg-radius-item); background: var(--dsw-alias-bg-base); overflow-wrap: anywhere; }
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
.fg-check { display: flex; align-items: flex-start; min-width: 0; gap: 9px; padding: 9px 8px; border-radius: var(--fg-radius-control); cursor: pointer; }
.fg-check:hover { background: var(--dsw-alias-interactive-bg-hover); }
.fg-check input { width: 15px; height: 15px; margin: 3px 0 0; flex: none; accent-color: var(--dsw-alias-brand-primary); cursor: inherit; }
.fg-check > span { min-width: 0; }
.fg-check .fg-tiny { margin-top: 3px; font-size: 11px; line-height: 1.6; }
.fg-grant { margin: 2px 0 6px 24px; border-left: 2px solid var(--dsw-alias-state-warn-secondary); border-radius: 0 var(--fg-radius-control) var(--fg-radius-control) 0; }
.fg-input, .fg-textarea { width: 100%; min-width: 0; padding: 9px 11px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--fg-radius-control); background: var(--dsw-alias-bg-base); color: inherit; font: inherit; font-size: 12px; line-height: 1.6; }
.fg-input::placeholder, .fg-textarea::placeholder { color: var(--dsw-alias-label-tertiary); opacity: 1; }
.fg-textarea { min-height: 88px; border-radius: var(--fg-radius-surface); resize: vertical; }
.fg-form { padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--fg-radius-surface); background: var(--dsw-alias-bg-base); }
.fg-err { padding: 12px 14px; border: 1px solid var(--dsw-alias-state-error-secondary); border-radius: var(--fg-radius-surface); background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
/* 头部下方：阶段进度 + 正在进行的那一步。宿主每 1.5 秒给一份新视图，界面自己会动。 */
.fg-progress {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 9px 22px 11px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  flex: none;
}
.fg-live { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1 1 260px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.fg-live-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fg-live-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-state-business-primary); animation: fg-live 1.4s ease-in-out infinite; }
@keyframes fg-live { 0%, 100% { opacity: 0.25; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1); } }
.fg-track { position: relative; flex: 1 1 160px; height: 6px; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-interactive-bg-hover); overflow: hidden; }
.fg-fill { position: absolute; inset: 0 auto 0 0; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-state-business-primary); transition: width 400ms ease; }
.fg-pct { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); min-width: 3ch; text-align: right; }
.fg-elapsed { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); }
.fg-banner { padding: 12px 22px 0; flex: none; }
.fg-hr { height: 1px; flex: none; background: var(--dsw-alias-border-l2); }
.fg-sec-title { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; font-weight: 600; }
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
  .fg-progress { padding: 8px 18px 10px; }
  .fg-live { flex-basis: 100%; }
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
  .fg-settings { margin: 0 16px; padding: 18px 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--fg-radius-panel); }
  .fg-settings-section { padding-inline: 0; }
  .fg-main-intro h1 { font-size: 21px; }
  .fg-head { gap: 10px; padding: 14px 16px; }
  .fg-progress { padding: 8px 16px 10px; gap: 6px 10px; }
  .fg-toolbar { justify-content: flex-start; }
  .fg-stage-list { gap: 4px; }
  .fg-stage { padding: 8px 6px; }
  .fg-stage-idx { width: 24px; height: 24px; }
  .fg-content { gap: 16px; }
  .fg-q { font-size: 18px; }
  .fg-task-title { max-width: 100%; }
}
@container flowgate (max-width: 720px) {
  .fg-modal { padding: 12px; }
  .fg-modal-card { width: 100%; max-height: none; height: calc(100vh - 24px); }
  .fg-modal-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .fg-modal-nav { flex-direction: row; overflow: auto; padding: 10px; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
  .fg-modal-tab { width: auto; white-space: nowrap; }
  .fg-modal-tab-count { display: none; }
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
  .fg-card { padding: 16px; }
  .fg-card-title { font-size: 13px; }
  .fg-main-intro { flex-direction: column; gap: 10px; }
  .fg-main-intro > .fg-badge { margin-top: 0; }
  .fg-settings { margin-inline: 12px; }
  .fg-preset-options { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .fg-root * { transition: none; }
}
/* 左侧栏全局面板：先挑工作区，再挑那条流程。根复用 .fg-root 的布局，
   这里只补条目形态，避免出现第二套按钮/卡片视觉。 */
.fg-hub-ws { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.fg-ws-row {
  display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; text-align: left;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--fg-radius-item);
  background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; cursor: pointer;
}
.fg-ws-row:hover { border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 30%, var(--dsw-alias-border-l2)); }
.fg-ws-row.on { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-state-business-tertiary); }
.fg-ws-name { font-weight: 600; overflow-wrap: anywhere; }
.fg-ws-path { color: var(--dsw-alias-label-tertiary); font-size: 11px; overflow-wrap: anywhere; }
.fg-flow-list { display: flex; flex-direction: column; gap: 8px; }
.fg-flow-row {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 14px; text-align: left;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--fg-radius-item);
  background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; cursor: pointer;
}
.fg-flow-row:hover { border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 30%, var(--dsw-alias-border-l2)); }
.fg-flow-row-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1 1 auto; }
.fg-flow-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 面板没有浮层输入框，不需要会话页那 152px 的 composer clearance。 */
.fg-hub > .fg-main { padding: 22px clamp(16px, 2.4cqi, 32px) 32px; }
.fg-hub-section { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.fg-workspace-overview { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 18px; }
.fg-workspace-tools { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.fg-workspace-card { padding: 18px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--fg-radius-panel); background: var(--dsw-alias-bg-layer-1); }
.fg-section-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; min-width: 0; }
.fg-section-head h2 { font-size: 14px; margin: 0; font-weight: 650; }
.fg-flow-history > summary { cursor: pointer; list-style: none; }
.fg-flow-history > summary::-webkit-details-marker { display: none; }
.fg-flow-history > summary::after { content: '＋'; color: var(--dsw-alias-label-tertiary); }
.fg-flow-history[open] > summary::after { content: '−'; }
.fg-flow-history[open] > summary { margin-bottom: 14px; }
.fg-flow-history .fg-flow-list { max-height: 360px; overflow: auto; scrollbar-gutter: stable; }
.fg-pagination { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding-top: 14px; margin-top: 12px; border-top: 1px solid var(--dsw-alias-border-l2); }
.fg-pagination .fg-row { margin-left: auto; }
.fg-rule-preview { display: flex; flex-wrap: wrap; gap: 6px; }
.fg-rule-preview .fg-badge { flex: 0 1 auto; min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.fg-workspace-rule-body { display: flex; flex-direction: column; gap: 12px; overflow: auto; min-height: 0; padding: 18px; }
.fg-workspace-rule-body .fg-modal-list { flex: none; overflow: visible; }
.fg-workspace-rule-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; min-width: 0; }
.fg-workspace-rule-row .fg-check { flex: 1; }
.fg-workspace-rule-row > .fg-row { flex: none; }
.fg-workspace-rule-footer { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding: 14px 18px; border-top: 1px solid var(--dsw-alias-border-l2); }
@container flowgate (min-width: 900px) {
  .fg-workspace-overview { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
}
@container flowgate (max-width: 480px) {
  .fg-workspace-card { padding: 14px; }
  .fg-workspace-rule-row { flex-wrap: wrap; }
  .fg-workspace-rule-row > .fg-row { margin-left: auto; }
}
.fg-hub-section > h2 { margin: 0; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: 0.02em; }
.fg-icon-btn {
  display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0;
  background: transparent; color: inherit; cursor: pointer; border-radius: var(--fg-radius-badge);
}
.fg-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
/* 选择页：工作区可以挑已有的，也可以挑一个目录把它加进来。 */
.fg-hub-pick { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.fg-hub-pick-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
/* 添加成功后的「导入了几条任务、几条规则」：一次性提示，不占常驻位置。 */
.fg-hub-notice { padding: 6px 10px; margin-top: 6px; border-radius: 8px; border: 1px dashed var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
/* 面板里的流程详情：宿主侧栏只有 264–420px，会话页那套 184px/1fr/320px 三列在这里没有位置，
   所以详情按单列堆叠，阶段条压成横向小格。门禁确认、改规则、放弃流程都在这一列里做完。 */
.fg-hub-flow { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.fg-hub-flow .fg-nav { grid-area: auto; overflow: visible; padding: 0; border-right: 0; background: transparent; }
.fg-hub-flow .fg-nav-heading { padding: 0 0 8px; }
.fg-hub-flow .fg-stage-list { flex-direction: row; gap: 6px; }
.fg-hub-flow .fg-stage { flex: 1 1 0; min-width: 0; padding: 8px 6px; gap: 5px; }
.fg-hub-flow .fg-stage-top { flex-direction: column; align-items: flex-start; gap: 5px; }
.fg-hub-flow .fg-stage-idx { width: 22px; height: 22px; }
.fg-hub-flow .fg-stage-name { font-size: 11px; }
.fg-hub-flow .fg-stage-out, .fg-hub-flow .fg-stage-status { display: none; }
.fg-hub-flow .fg-main-intro { flex-direction: column; gap: 8px; padding: 0; }
.fg-hub-flow .fg-main-intro h1 { margin: 4px 0 6px; font-size: 18px; }
.fg-hub-flow .fg-content { gap: 16px; }
.fg-hub-side { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.fg-hub-flow .fg-gate { grid-area: auto; padding: 14px; margin: 0; }
.fg-hub-flow .fg-settings { grid-area: auto; margin: 0; padding: 0; }
.fg-hub-flow .fg-card { padding: 14px; }
.fg-hub-flow .fg-progress {
  flex: none; padding: 8px 10px; gap: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--fg-radius-control);
  background: var(--dsw-alias-bg-layer-1);
}
/* 面板里没有浮层输入框，也不需要自己滚：外层 .fg-main 已经在滚了，
   会话页那 152px composer clearance 与内部滚动都要去掉，否则详情底部凭空多出一屏空白。 */
.fg-hub-flow > .fg-main { padding: 0 0 4px; overflow: visible; grid-area: auto; }
.fg-hub-flow .fg-toolbar { flex-wrap: wrap; gap: 8px; }
.fg-hub-flow .fg-live { flex-basis: 100%; }
@container flowgate (min-width: 900px) {
  .fg-hub-flow:has(> .fg-nav) { display: grid; grid-template-columns: minmax(0, 1fr) 280px; align-items: start; gap: 18px; }
  .fg-hub-flow > :is(.fg-toolbar, .fg-progress, .fg-banner, .fg-nav) { grid-column: 1 / -1; }
  .fg-hub-flow > .fg-main { grid-column: 1; }
  .fg-hub-flow > .fg-hub-side { grid-column: 2; }
  .fg-hub-flow .fg-stage { padding: 12px; }
  .fg-hub-flow .fg-stage-top { flex-direction: row; align-items: center; gap: 8px; }
  .fg-hub-flow .fg-stage-name { font-size: 12px; }
  .fg-hub-flow .fg-card { padding: 22px; }
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

    /**
     * 左侧栏面板的数据层。
     * 面板拿不到 sessionId，也不能假设宿主里的工作区都归它管：
     * 名单由用户在面板里逐个添加，宿主只按名单读盘。
     */
    async function postJson(path, body) {
      const res = await fetch(API + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || '宿主返回 HTTP ' + res.status)
      return data
    }

    /** 名单里有什么。空数组就是「用户还没添加过任何工作区」。 */
    async function pullMembers() {
      const data = await postJson('/hub/members', {})
      return {
        members: Array.isArray(data?.members) ? data.members : [],
        file: typeof data?.file === 'string' ? data.file : null,
      }
    }

    /** 把一个目录加进名单；宿主顺带返回它已有的任务与规则。 */
    async function addMember(path) {
      return postJson('/hub/add', { path })
    }

    /** 只从名单里拿掉，不动那个目录里的任何文件。 */
    async function removeMember(path) {
      return postJson('/hub/remove', { path })
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
        plus: 'M12 5v14 M5 12h14',
        lock: 'M6 10h12v10H6z M8 10V7a4 4 0 0 1 8 0v3',
      }
      return h('svg', { className: 'fg-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: paths[name] || paths.workbench }))
    }

    function Badge({ tone, children }) {
      return h('span', { className: 'fg-badge' + (tone ? ' ' + tone : '') }, children)
    }

    function Btn({ children, onClick, disabled, tone, title, expanded, controls, buttonRef, 'aria-label': ariaLabel }) {
      return h('button', {
        type: 'button',
        className: 'fg-btn' + (tone ? ' ' + tone : ''),
        onClick,
        disabled: Boolean(disabled),
        title,
        'aria-expanded': expanded,
        'aria-controls': controls,
        'aria-label': ariaLabel,
        ref: buttonRef,
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
      const sending = useRef(false)
      useEffect(() => { setCustom(''); setShowCustom(false); setError(null) }, [pending.id])
      const options = Array.isArray(pending.options) ? pending.options : []
      const recommended = Number.isInteger(pending.recommended) ? pending.recommended : 0
      const submit = async (choiceIndex, customText) => {
        if (sending.current) return
        sending.current = true
        setBusy(true)
        setError(null)
        const failure = await act(sessionId, 'answer', { choiceIndex, customText: customText || '' })
        sending.current = false
        setBusy(false)
        if (failure) setError(failure)
      }
      return h(Card, { title: ['拍板', h(Badge, { key: 'c', tone: 'info' }, 'S1 需求分析')] },
        h('div', { className: 'fg-q' }, pending.question),
        pending.context ? h('div', { className: 'fg-muted' }, pending.context) : null,
        h('div', { className: 'fg-list fg-options', 'aria-busy': busy }, options.map((option, index) =>
          h('button', {
            key: 'opt-' + index, type: 'button',
            className: 'fg-opt fg-decision-opt' + (index === recommended ? ' rec' : ''),
            disabled: busy, onClick: () => { void submit(index, '') },
          },
            h('span', { className: 'fg-opt-index', 'aria-hidden': true }, String.fromCharCode(65 + index)),
            h('span', { className: 'fg-opt-copy' },
              h('span', { className: 'fg-opt-label' }, option?.label ?? '选项 ' + (index + 1),
                index === recommended ? h(Badge, { tone: 'info' }, '推荐') : null),
              option?.tradeoff ? h('span', { className: 'fg-opt-tradeoff' }, option.tradeoff) : null),
            h('span', { className: 'fg-opt-arrow', 'aria-hidden': true }, '→')))),
        pending.allowCustom === false ? null : (showCustom
          ? h('div', { className: 'fg-custom-answer' },
              h('textarea', { className: 'fg-textarea', 'aria-label': '自定义答案', rows: 3,
                value: custom, placeholder: '填写你的方案或补充意见…', autoFocus: true, disabled: busy,
                onChange: (event) => setCustom(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent?.isComposing) {
                    event.preventDefault()
                    if (custom.trim()) void submit(-1, custom.trim())
                  }
                },
              }),
              h('div', { className: 'fg-row' },
                h(Btn, { tone: 'primary', disabled: busy || !custom.trim(), onClick: () => { void submit(-1, custom.trim()) } }, busy ? '提交中…' : '提交答案'),
                h(Btn, { tone: 'quiet', disabled: busy, onClick: () => setShowCustom(false) }, '取消'),
                h('span', { className: 'fg-tiny' }, 'Ctrl / ⌘ + Enter')))
          : h('div', { className: 'fg-row' }, h(Btn, { tone: 'quiet', onClick: () => setShowCustom(true), disabled: busy }, '自定义答案'))),
        error ? h('div', { className: 'fg-err', role: 'alert' }, error) : null)
    }

    // -----------------------------------------------------------------------
    // S1：需求文档
    // -----------------------------------------------------------------------

    function DocGate({ sessionId, view, pending, busy, setBusy }) {
      const run = async (decision) => {
        setBusy(true)
        await act(sessionId, 'doc', { decision })
        setBusy(false)
      }
      // 待批准是流程状态，不再跟着某次工具调用走：只要文档在、还没决策，按钮就在。
      if (!pending) {
        if (view.finished) {
          return h('div', { className: 'fg-tiny' }, view.cancelled
            ? '这次流程已放弃，需求文档只作查看，不能再确认。'
            : '流程已结束，需求文档只作查看。')
        }
        return h('div', { className: 'fg-tiny' }, view.doc?.decision
          ? '这份需求文档已经确认过。'
          : '等待 Agent 提交需求文档。')
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

    function DocCard({ sessionId, view }) {
      const [busy, setBusy] = useState(false)
      const doc = view.doc || {}
      return h(Card, { title: ['需求文档', h(Badge, { key: 'b', tone: 'info' }, '自包含 HTML')], grow: true },
        h('div', { className: 'fg-doc' },
          h('iframe', { title: '需求文档预览', sandbox: '', srcDoc: doc.html || '' })),
        h('div', { className: 'fg-hr' }),
        h(PresetPicker, { sessionId, view, busy, setBusy }),
        h('div', { className: 'fg-hr' }),
        // 提交它的那次调用可能已经被中断；文档还在就说明还能确认。
        doc.interrupted && doc.pending
          ? h('div', { className: 'fg-tiny' }, '上次的确认请求被中断（工具调用超时或宿主重启），文档已保存，仍然可以直接确认。')
          : null,
        h(DocGate, { sessionId, view, pending: doc.pending === true, busy, setBusy }),
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
          : h(Empty, null, '完成开发后生成变更摘要。'),
        h('div', { className: 'fg-tiny' }, '仅允许修改 scope 内的文件，变更性 shell 不可用。'))
    }

    // -----------------------------------------------------------------------
    // S3：评审
    // -----------------------------------------------------------------------

    function ReviewCard({ view }) {
      const review = view.review
      if (!review) {
        return h(Card, { title: ['评审报告', h(Badge, { key: 'r', tone: 'info' }, 'S3 评审')] },
          h(Empty, null, '等待提交评审报告。'))
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
          h(Empty, null, '等待提交测试报告。'))
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
          h('div', { className: 'fg-sec-title' }, '流程阶段')),
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

    // -----------------------------------------------------------------------
    // 设置弹窗：四组配置各自成面板，弹窗内切换，避免侧栏里一路往下滚
    // -----------------------------------------------------------------------

    // 分组顺序即弹窗左侧导航顺序；stage 用来决定打开时落在哪一组。
    const SETTING_GROUPS = [
      { id: 'preset', label: '执行档位', stage: 'S1' },
      { id: 'rules', label: '开发规则', stage: 'S2' },
      { id: 'angles', label: '评审角度', stage: 'S3' },
      { id: 'directions', label: '测试方向', stage: 'S4' },
    ]

    const SETTING_GROUP_BY_STAGE = { S1: 'preset', S2: 'rules', S3: 'angles', S4: 'directions' }

    // 导航里的计数用短标签，避免长档位名把分组栏撑开。
    const PRESET_SHORT = { fast: '快速', strict: '严格' }

    function settingGroupOfStage(stage) {
      return SETTING_GROUP_BY_STAGE[stage] ?? 'preset'
    }

    // 侧栏摘要与弹窗分组栏用同一口径的「已选 n/m」，避免两处各算一遍。
    function settingCounts(view) {
      const ruleIds = Array.isArray(view.ruleIds) ? view.ruleIds : (view.rules || []).map((rule) => rule.id)
      return {
        angles: (view.angles || []).length + '/' + (view.angleCatalog || []).length,
        directions: (view.directions || []).length + '/' + (view.directionCatalog || []).length,
        rules: new Set(ruleIds).size + '/' + (view.ruleCatalog || []).length,
      }
    }

    /**
     * 模态外壳：遮罩 + 居中对话框。Esc 与点遮罩都能关，打开时锁背景滚动，
     * 关闭由调用方负责把焦点还给触发按钮。测试环境的 document 是极简替身，
     * 所以这里对 body / addEventListener 都做存在性判断。
     * Tab 在卡片内首尾循环：没有这条，键盘用户会顺着背景页面跑出弹窗。
     */
    const FOCUSABLE_SELECTOR = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
    let dialogSeq = 0

    function Modal({ labelledBy, onClose, children }) {
      const cardRef = useRef(null)
      const closeRef = useRef(onClose)
      closeRef.current = onClose

      const trapTab = (event) => {
        if (event.key !== 'Tab') return
        // 真实浏览器里 cardRef 一定在；currentTarget 只是测试环境（无 DOM 宿主）的兜底，
        // 两条路径不等价，别把它当成可以去掉 ref 的理由。
        const card = cardRef.current ?? event.currentTarget
        if (!card || typeof card.querySelectorAll !== 'function') return
        const focusables = Array.from(card.querySelectorAll(FOCUSABLE_SELECTOR))
          .filter((node) => node && node.disabled !== true)
        // 只有一个可聚焦元素时拦 Tab 会把焦点焊死，放行浏览器默认行为反而能用地址栏出去。
        if (focusables.length <= 1) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (event.shiftKey) {
          // 卡片本身（tabIndex=-1）不在列表里，Shift+Tab 从它出发会退到背景。
          if (event.target === first || event.target === card) {
            event.preventDefault()
            last.focus()
          }
          return
        }
        if (event.target === last) {
          event.preventDefault()
          first.focus()
        }
      }

      useEffect(() => {
        const card = cardRef.current
        if (card && typeof card.focus === 'function') card.focus()
        if (typeof document === 'undefined') return undefined
        const onKeyDown = (event) => { if (event.key === 'Escape') closeRef.current?.() }
        const canListen = typeof document.addEventListener === 'function'
        if (canListen) document.addEventListener('keydown', onKeyDown)
        const body = document.body
        const previousOverflow = body?.style?.overflow
        if (body?.style) body.style.overflow = 'hidden'
        return () => {
          if (canListen) document.removeEventListener('keydown', onKeyDown)
          if (body?.style && previousOverflow !== undefined) body.style.overflow = previousOverflow
        }
      }, [])

      return h('div', {
        className: 'fg-modal',
        onClick: (event) => { if (event.target === event.currentTarget) closeRef.current?.() },
      }, h('div', {
        className: 'fg-modal-card',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': labelledBy,
        tabIndex: -1,
        ref: cardRef,
        onKeyDown: trapTab,
      }, children))
    }

    function SettingsDialog({ sessionId, view, onClose }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [adding, setAdding] = useState(null)
      const [name, setName] = useState('')
      const [points, setPoints] = useState('')
      const [needsWrite, setNeedsWrite] = useState(false)
      const [group, setGroup] = useState(() => settingGroupOfStage(view.stage))
      // 每个弹窗实例用独立标题 id，多实例同屏时 aria-labelledby 不会撞；计数刻意不回退。
      const titleIdRef = useRef(null)
      if (titleIdRef.current === null) {
        dialogSeq += 1
        titleIdRef.current = 'fg-settings-title-' + dialogSeq
      }
      const titleId = titleIdRef.current

      const angleIds = new Set((view.angles || []).map((angle) => angle.id))
      const directionIds = new Set((view.directions || []).map((direction) => direction.id))
      const angleCatalog = Array.isArray(view.angleCatalog) ? view.angleCatalog : []
      const directionCatalog = Array.isArray(view.directionCatalog) ? view.directionCatalog : []
      const ruleCatalog = Array.isArray(view.ruleCatalog) ? view.ruleCatalog : []
      const ruleIds = new Set(Array.isArray(view.ruleIds) ? view.ruleIds : (view.rules || []).map((rule) => rule.id))

      const counts = { preset: PRESET_SHORT[view.preset] ?? view.preset ?? '', ...settingCounts(view) }
      // 规则来源必须显式：用户改的到底是「本次」还是「以后每次」，不能靠猜。
      const wsRules = view.workspaceRules || {}
      const sourceLabel = { flow: '本次流程临时调整', workspace: '工作区默认', default: '内置默认' }[view.ruleSource] || '内置默认'
      const runDefaultAction = async (action) => {
        setBusy(true)
        setError(null)
        const message = await act(sessionId, action, {})
        setBusy(false)
        if (message) setError(message)
      }

      const toggle = async (action, id, enabled) => {
        setBusy(true)
        await act(sessionId, action, { id, enabled })
        setBusy(false)
      }

      const resetForm = () => {
        setAdding(null)
        setName('')
        setPoints('')
        setNeedsWrite(false)
      }

      const submit = async () => {
        if (!name.trim()) return
        setBusy(true)
        const list = points.split('\n').map((line) => line.trim()).filter(Boolean)
        const payload = { name: name.trim(), points: list }
        if (adding === 'direction' && needsWrite) payload.needsWrite = true
        await act(sessionId, adding === 'angle' ? 'addAngle' : adding === 'rule' ? 'addRule' : 'addDirection', payload)
        setBusy(false)
        resetForm()
      }

      const canUpgrade = view.preset === 'fast' && !view.finished

      // 追加表单与触发按钮都固定在列表上方：列表再长，入口也不会被挤到屏幕外。
      const addArea = (kind, labels) => adding === kind
        ? h('div', { className: 'fg-list fg-form fg-modal-form' },
            h('label', { className: 'fg-field' },
              h('span', { className: 'fg-sec-title' }, labels.name),
              h('input', { className: 'fg-input', placeholder: labels.name, value: name, onChange: (event) => setName(event.target.value) })),
            h('label', { className: 'fg-field' },
              h('span', { className: 'fg-sec-title' }, labels.points),
              h('textarea', { className: 'fg-textarea', placeholder: labels.points, value: points, onChange: (event) => setPoints(event.target.value) })),
            kind === 'direction'
              ? h('label', { className: 'fg-check' },
                  h('input', { type: 'checkbox', checked: needsWrite, onChange: (event) => setNeedsWrite(event.target.checked) }),
                  h('span', null,
                    h('div', null, '这个方向需要写权限'),
                    h('div', { className: 'fg-tiny' }, '勾选后该方向会出现在 S4 的授权清单里，仍需用户在 S4 再显式勾选一次才生效。')))
              : null,
            h('div', { className: 'fg-row' },
              h(Btn, { tone: 'primary', disabled: busy || !name.trim(), onClick: () => { void submit() } }, '追加'),
              h(Btn, { disabled: busy, onClick: resetForm }, '取消')))
        : h('div', { className: 'fg-modal-actions' }, h(Btn, { disabled: busy, onClick: () => setAdding(kind) }, labels.add))

      const paneHead = (title, note) => h('div', { className: 'fg-modal-pane-head' },
        h('h3', null, title),
        note ? h('div', { className: 'fg-tiny' }, note) : null)

      const panes = {
        preset: h('div', { className: 'fg-modal-pane' },
          paneHead('执行档位', '档位决定各阶段的参数强度，S3 评审前都可以升档。'),
          h('div', { className: 'fg-row' },
            h(Badge, { tone: 'info' }, view.presetInfo?.label ?? view.preset ?? ''),
            canUpgrade ? h(Btn, {
              disabled: busy,
              onClick: async () => { setBusy(true); await act(sessionId, 'upgrade', { preset: 'strict' }); setBusy(false) },
            }, '升档到大需求严格执行') : null),
          canUpgrade && view.stage === 'S3'
            ? h('div', { className: 'fg-tiny' }, '若评审已发现 scope 内的问题，升档会让流程回到 S2 按严格参数重做（scope 不会自动扩充）。')
            : null),
        rules: h('div', { className: 'fg-modal-pane' },
          paneHead('开发规则', 'S2 按这些规则开发，S3 的正确性与风格角度会逐条核对。'),
          h('div', { className: 'fg-ws-rules', title: '规则配置：.dsh-flowgate/config.json' },
            h('div', { className: 'fg-row' },
              h('span', { className: 'fg-sec-title' }, '当前来源'),
              h(Badge, { tone: view.ruleSource === 'workspace' ? 'ok' : 'info' }, sourceLabel)),
            h('div', { className: 'fg-tiny' }, '勾选与追加只影响本次流程；保存后，这个工作区里的新流程会自动继承同一套规则。'),
            h('div', { className: 'fg-row' },
              h(Btn, { disabled: busy, onClick: () => { void runDefaultAction('saveRuleDefaults') } }, '保存为工作区默认'),
              wsRules.configured
                ? h(Btn, { disabled: busy, onClick: () => { void runDefaultAction('clearRuleDefaults') } }, '清除工作区默认')
                : null),
            h('div', { className: 'fg-tiny' },
              wsRules.configured
                ? '已保存 ' + (wsRules.ruleIds || []).length + ' 条规则到 ' + (wsRules.file || '.dsh-flowgate/config.json') + '。'
                : '还没有工作区默认，当前用的是内置默认规则。')),
          error ? h('div', { className: 'fg-tiny' }, '操作失败：' + error) : null,
          addArea('rule', { name: '规则名称', points: '检查要点，每行一条', add: '追加自定义开发规则' }),
          h('div', { className: 'fg-modal-list' }, ruleCatalog.map((rule) => h(CheckRow, {
            key: 'rule-' + rule.id,
            checked: ruleIds.has(rule.id),
            name: rule.name,
            points: rule.points,
            onChange: (enabled) => { void toggle('toggleRule', rule.id, enabled) },
          })))),
        angles: h('div', { className: 'fg-modal-pane' },
          paneHead('评审角度', 'S3 按选中的角度评审，未选中的角度不参与本轮。'),
          addArea('angle', { name: '角度名称', points: '检查要点，每行一条', add: '追加自定义角度' }),
          h('div', { className: 'fg-modal-list' }, angleCatalog.map((angle) => h(CheckRow, {
            key: 'angle-' + angle.id,
            checked: angleIds.has(angle.id),
            name: angle.name,
            points: angle.points,
            onChange: (enabled) => { void toggle('toggleAngle', angle.id, enabled) },
          })))),
        directions: h('div', { className: 'fg-modal-pane' },
          paneHead('测试方向', 'S4 按选中的方向验证；需要写权限的方向要在这里声明，再在 S4 显式授权。'),
          addArea('direction', { name: '方向名称', points: '验证要点，每行一条', add: '追加自定义方向' }),
          h('div', { className: 'fg-modal-list' }, directionCatalog.map((direction) => h('div', { key: 'dir-' + direction.id },
            h(CheckRow, {
              checked: directionIds.has(direction.id),
              name: direction.name,
              points: direction.points,
              onChange: (enabled) => { void toggle('toggleDirection', direction.id, enabled) },
            }),
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
              : null)))),
      }

      return h(Modal, { labelledBy: titleId, onClose },
        h('div', { className: 'fg-modal-head' },
          h('div', { className: 'fg-modal-heading' },
            h('h2', { id: titleId, className: 'fg-card-title' }, '阶段设置'),
            h('div', { className: 'fg-tiny' }, '按分组配置，改动即时生效；Esc 或点遮罩关闭。')),
          h(Btn, { onClick: onClose, title: '关闭设置' }, '关闭')),
        h('div', { className: 'fg-modal-body' },
          h('nav', { className: 'fg-modal-nav', 'aria-label': '设置分组' },
            SETTING_GROUPS.map((item) => h('button', {
              key: item.id,
              type: 'button',
              className: 'fg-modal-tab' + (group === item.id ? ' on' : ''),
              'aria-current': group === item.id ? 'true' : undefined,
              onClick: () => { resetForm(); setGroup(item.id) },
            }, h('span', null, item.label), h('span', { className: 'fg-modal-tab-count' }, counts[item.id])))),
          panes[group] ?? panes.preset))
    }

    function SettingsPanel({ sessionId, view }) {
      const [open, setOpen] = useState(false)
      const triggerRef = useRef(null)

      const counts = settingCounts(view)

      // 关闭后把焦点交给触发按钮，键盘用户可以接着操作。
      const close = () => {
        setOpen(false)
        const trigger = triggerRef.current
        if (trigger && typeof trigger.focus === 'function') trigger.focus()
      }

      return h('section', { className: 'fg-settings', 'aria-label': '阶段设置' },
        h('div', { className: 'fg-settings-heading' },
          h('h2', { className: 'fg-card-title' }, '阶段设置')),
        h('div', { className: 'fg-settings-summary' },
          h('div', { className: 'fg-tiny' }, '评审角度 ' + counts.angles + ' · 测试方向 ' + counts.directions + ' · 开发规则 ' + counts.rules),
          h(Btn, {
            tone: 'primary',
            buttonRef: triggerRef,
            expanded: open,
            title: '打开设置弹窗，按分组配置角度、方向与规则',
            onClick: () => setOpen(true),
          }, '配置角度与规则')),
        open ? h(SettingsDialog, { sessionId, view, onClose: close }) : null)
    }

    // -----------------------------------------------------------------------
    // 右侧：门禁
    // -----------------------------------------------------------------------

    function GatePanel({ sessionId, view }) {
      const [busy, setBusy] = useState(false)
      // 放弃是不可撤销的（阶段记录会作废），所以要点两次：第一次只是把按钮换成确认。
      const [confirmCancel, setConfirmCancel] = useState(false)
      const waiting = Boolean(view.waiting)
      // 门禁请求被中断后等待器就没了，但只要产物已交，按钮仍然该能点。
      const gatePending = Boolean(view.gate?.pending)
      const ready = waiting || gatePending
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
          tone: view.cancelled ? 'warn' : view.finished ? 'ok' : ready ? 'info' : '',
        }, view.cancelled ? '已放弃' : view.finished ? '已完成' : ready ? '等待确认' : '准备中'))

      if (view.finished) {
        return h('section', { className: 'fg-gate', 'aria-label': '出口门禁' },
          head,
          h('div', { className: 'fg-row' },
            view.cancelled
              ? h(Badge, { tone: 'warn' }, '流程已放弃')
              : h(Badge, { tone: 'ok' }, '流程已结束')),
          h('div', { className: 'fg-tiny' }, view.cancelled
            ? '流程已放弃，scope 已解冻。' + (view.cancelReason ? ' 原因：' + view.cancelReason : '')
            : '产物和确认记录已保存。'))
      }

      // 界面启动后 Agent 可能没被唤醒：这时别让用户干等，直接告诉他去对话里补一句。
      const wakeFailed = Boolean(view.nudge) && view.nudge.ok === false
      const note = ready
        ? null
        : h('div', { className: 'fg-tiny', key: 'gate-note' }, wakeFailed
          ? '没能自动唤醒 Agent（' + (view.nudge.reason || '宿主没有返回这个会话的 Agent') + '）。再点一次「开始需求分析」会重试；也可以回到对话里发一句「继续」，Agent 收到后就会接着做需求分析。'
          : '等待 Agent 提交本阶段结果。')

      // 等待器没了但产物还在：说明那次请求被中断了，用户的点击照样有效。
      const interruptedNote = gatePending && !waiting
        ? h('div', { className: 'fg-tiny', key: 'gate-interrupted' }, '上次的门禁请求被中断，仍可直接确认。')
        : null

      // 随时可以放弃：不必等门禁就绪，也不受阶段限制。
      const abandon = h('div', { className: 'fg-abandon', key: 'gate-abandon' },
        confirmCancel
          ? h('div', { className: 'fg-row' },
            h('span', { className: 'fg-tiny' }, '放弃后这次流程的阶段记录与门禁结果都会作废，确定吗？'),
            h(Btn, { tone: 'danger', disabled: busy, onClick: () => { void cancel() } }, '确认放弃'),
            h(Btn, { disabled: busy, onClick: () => setConfirmCancel(false) }, '再想想'))
          : h(Btn, { disabled: busy, onClick: () => setConfirmCancel(true) }, '放弃这次流程'))

      const foot = [note, interruptedNote, abandon]

      if (view.stage === 'S1') {
        return h('section', { className: 'fg-gate' + (ready && !view.finished ? ' ready' : ''), 'aria-label': '出口门禁' },
          head, h(DocGate, { sessionId, view, pending: Boolean(view.doc?.pending), busy, setBusy }), foot)
      }

      if (view.stage === 'S2') {
        return h('section', { className: 'fg-gate' + (ready && !view.finished ? ' ready' : ''), 'aria-label': '出口门禁' },
          head,
          h(Btn, { tone: 'primary', disabled: busy || !ready, onClick: () => { void gate('pass') } }, '完成开发'),
          h(Btn, { disabled: busy || !ready, onClick: () => { void gate('skip') } }, '跳过门禁，直接评审'),
          h(Btn, { tone: 'danger', disabled: busy || !ready, onClick: () => { void gate('back', 'S1') } }, '回到需求分析调整 scope'),
          foot)
      }

      if (view.stage === 'S3') {
        // D4：发现落在 scope 外时，退回开发修不了——这时把回 S1 的入口放到修复之前。
        const overflow = Array.isArray(view.reviewOutsideScope) ? view.reviewOutsideScope : []
        return h('section', { className: 'fg-gate' + (ready && !view.finished ? ' ready' : ''), 'aria-label': '出口门禁' },
          head,
          h(Btn, { tone: 'primary', disabled: busy || !ready, onClick: () => { void gate('pass') } }, '通过评审，进入测试'),
          overflow.length
            ? h('div', { className: 'fg-tiny' }, '评审有 ' + overflow.length + ' 条发现落在冻结 scope 之外：退回开发修复也改不到它们，要先调 scope。')
            : null,
          overflow.length
            ? h(Btn, { tone: 'danger', disabled: busy || !ready, onClick: () => { void gate('back', 'S1') } }, '回到需求分析调整 scope')
            : null,
          h(Btn, { disabled: busy || !ready, onClick: () => { void gate('back', 'S2') } }, '退回开发修复'),
          h(Btn, { disabled: busy || !ready, onClick: () => { void gate('skip') } }, '跳过评审，直接测试'),
          foot)
      }

      return h('section', { className: 'fg-gate' + (ready && !view.finished ? ' ready' : ''), 'aria-label': '出口门禁' },
        head,
        h(Btn, { tone: 'primary', disabled: busy || !ready, onClick: () => { void gate('pass') } }, '验收通过，结束流程'),
        h(Btn, { disabled: busy || !ready, onClick: () => { void gate('back', 'S2') } }, '退回开发修复'),
        h(Btn, { disabled: busy || !ready, onClick: () => { void gate('skip') } }, '跳过测试门禁'),
        foot)
    }

    // -----------------------------------------------------------------------
    // 工作台主视图
    // -----------------------------------------------------------------------

    function stageIndex(stages, id) {
      const found = (stages || []).findIndex((stage) => stage?.id === id)
      return found < 0 ? 0 : found
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
     * 一键启动：标题可选、档位可选，点一下就能进 S1。
     * 客户端只把 sessionId 交给宿主，工作目录由宿主从会话里解析。
     * 左侧栏面板不绑定会话，所以传 resolveSession：点开始时才去宿主那里要（或建）一个会话；
     * 会话视图里则直接传 sessionId。
     */
    const PRESET_FALLBACK = {
      fast: { label: '小功能快速开发', summary: '小范围修改、简单功能' },
      strict: { label: '大需求严格执行', summary: '多模块变更、需要更充分的检查' },
    }

    function StartPanel({ sessionId, presets, resolveSession, onStarted, compact = false, draft, onDraftChange }) {
      const [localDraft, setLocalDraft] = useState({ brief: '', title: '', preset: 'fast' })
      const { brief, title, preset } = draft || localDraft
      const updateDraft = (patch) => {
        const next = { brief, title, preset, ...patch }
        if (typeof onDraftChange === 'function') onDraftChange(next)
        else setLocalDraft(next)
      }
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const keys = Object.keys(presets || {})
      const options = keys.length ? keys : ['fast', 'strict']
      // 面板不绑定会话，拿不到宿主返回的 presets；用同一份档位文案兜底，别显示成裸的 fast / strict。
      const presetInfo = (key) => presets?.[key] || PRESET_FALLBACK[key] || { label: key, summary: '' }
      const begin = async () => {
        if (busy) return
        // 需求描述必填：留空启动时 Agent 只能自己猜目标，那是缺陷而不是快捷方式。
        const text = brief.trim()
        if (!text) {
          setError('先写一句这次要做什么，再开始流程。')
          return
        }
        setBusy(true)
        let target = sessionId
        if (!target && typeof resolveSession === 'function') {
          try {
            target = await resolveSession()
          } catch (err) {
            setError(err?.message ?? String(err))
            setBusy(false)
            return
          }
        }
        if (!target) {
          setError('宿主没有可用的会话，没法在这里启动流程。')
          setBusy(false)
          return
        }
        // brief 是需求原文：宿主用它派生标题，Agent 在 S1 直接读它提问，用户不必再复述一遍。
        const message = await act(target, 'start', { title: title.trim(), preset, brief: text })
        setError(message)
        setBusy(false)
        if (!message && typeof onStarted === 'function') onStarted(target)
      }
      return h(Card, { title: compact ? null : '开始一次新流程' },
        h('label', { className: 'fg-field' },
          h('span', { className: 'fg-sec-title' }, '需求描述 ', h('span', { className: 'fg-required', 'aria-hidden': true }, '*')),
          h('textarea', {
            className: 'fg-textarea',
            rows: 4,
            required: true,
            'aria-required': true,
            disabled: busy,
            value: brief,
            placeholder: '描述目标、预期效果或需要解决的问题…',
            onChange: (event) => updateDraft({ brief: event.target.value }),
            onKeyDown: (event) => {
              // 多行输入里 Enter 是换行，用 Ctrl/Cmd + Enter 提交。
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void begin()
              }
            },
          })),
        h('label', { className: 'fg-field' },
          h('span', { className: 'fg-sec-title' }, '任务标题（可选）'),
          h('input', {
            className: 'fg-input',
            type: 'text',
            value: title,
            placeholder: '默认使用需求第一行',
            onChange: (event) => updateDraft({ title: event.target.value }),
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
            onClick: () => updateDraft({ preset: key }),
          },
            h('span', { className: 'fg-opt-label' }, h('span', null, presetInfo(key).label)),
            h('span', { className: 'fg-opt-tradeoff' }, presetInfo(key).summary))))),
        h('div', { className: 'fg-row' },
          h(Btn, { tone: 'primary', disabled: busy || !brief.trim(), onClick: () => { void begin() } }, busy ? '正在启动…' : '开始需求分析')),
        error ? h('div', { className: 'fg-err', role: 'alert' }, error) : null)
    }
    /** 把毫秒说成人话：进度条右边那一小块。 */
    function elapsedText(ms) {
      const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
      if (total < 60) return total + ' 秒'
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      if (minutes < 60) return seconds ? minutes + ' 分 ' + seconds + ' 秒' : minutes + ' 分钟'
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return rest ? hours + ' 小时 ' + rest + ' 分' : hours + ' 小时'
    }

    /**
     * 头部下方的实时条：阶段进度 + 正在进行的那一步 + 已用时。
     * 数据全部来自宿主视图（每 1.5 秒轮询一次），组件自己不设计时器，
     * 这样界面和宿主说的永远是同一件事。
     */
    function ProgressStrip(props) {
      const view = props?.view
      const progress = view?.progress
      if (!progress || view.finished) return null
      const index = Math.max(0, Math.min(3, Number(progress.stageIndex) || 0))
      const percent = Math.max(0, Math.min(100, Math.round(Number(progress.percent) || 0)))
      const label = progress.label || ''
      const waiting = Boolean(view.waiting)
      const doing = waiting
        ? '门禁等你确认'
        : view.activity?.text
          ? '正在' + view.activity.text
          : '等待 Agent 下一步'
      return h('div', { className: 'fg-progress', role: 'status', 'aria-live': 'polite', 'aria-label': '流程进度' },
        h('span', { className: 'fg-live' },
          waiting ? null : h('span', { className: 'fg-live-dot' }),
          h('span', { className: 'fg-live-text' }, 'S' + (index + 1) + ' ' + label + ' · ' + doing)),
        h('div', { className: 'fg-track', title: '已完成 ' + percent + '%' },
          h('div', { className: 'fg-fill', style: { width: percent + '%' } })),
        h('span', { className: 'fg-pct' }, percent + '%'),
        h('span', { className: 'fg-elapsed' }, '已用 ' + elapsedText(view.elapsedMs)))
    }

function FlowDetail(props) {
      const sessionId = props?.sessionId
      const entry = useEntry(sessionId)
      const [refreshing, setRefreshing] = useState(false)
      const view = entry.view

      if (!sessionId) return null

      if (!view) {
        return h('div', { className: 'fg-hub-flow' },
          entry.error
            ? h('div', { className: 'fg-err', role: 'alert' }, entry.error)
            : h('div', { className: 'fg-muted fg-empty', role: 'status' }, '正在连接宿主端…'))
      }

      // 这个会话还没有流程（或已经结束）：直接把启动入口放在详情里。
      // 宿主 start() 遇到已结束的旧流程会新建一条，所以结束态的入口点下去就是新流程。
      if (!view.active) {
        return h('div', { className: 'fg-hub-flow' },
          entry.error ? h('div', { className: 'fg-err', role: 'alert' }, entry.error) : null,
          h('div', { className: 'fg-tiny' }, '当前会话还没有流程'),
          props?.allowStart === false ? null : h(StartPanel, { sessionId, presets: view.presets }))
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
        } else if (view.doc?.html) main.push(h(DocCard, { key: 'doc', sessionId, view }))
        else main.push(h(Card, { key: 'wait', title: ['需求分析', h(Badge, { key: 'w', tone: 'info' }, 'S1')] },
          h(Empty, null, view.doc?.revisedAt
            ? '你点了「修改需求」。补齐未决项后，Agent 会重新提交需求文档供你批准。'
            : 'Agent 正在分析需求…'),
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

      if (view.finished && props?.allowStart !== false) {
        main.push(h('div', { key: 'restart' },
          h('div', { className: 'fg-tiny' }, view.cancelled
            ? '这次流程已放弃，下面可以直接开始新流程。'
            : '这次流程已结束，下面可以直接开始新流程。'),
          h(StartPanel, { sessionId, presets: view.presets })))
      }

      return h('div', { className: 'fg-hub-flow' },
        h('div', { className: 'fg-toolbar' },
          h(Badge, { tone: 'info' }, 'S' + (currentIndex + 1) + '/4 · ' + (stages[currentIndex]?.label ?? '')),
          view.skippedCount > 0 ? h(Badge, { tone: 'warn' }, '本流程有 ' + view.skippedCount + ' 个阶段被跳过') : null,
          h(Btn, {
            tone: 'quiet',
            disabled: refreshing,
            title: '立即从宿主端拉取最新状态',
            onClick: async () => { setRefreshing(true); await pull(sessionId); setRefreshing(false) },
          }, h(Icon, { name: 'refresh' }), '刷新')),
        h(ProgressStrip, { key: 'progress', view }),
        entry.error ? h('div', { className: 'fg-banner' }, h('div', { className: 'fg-err', role: 'alert' }, entry.error)) : null,
        h(StageNav, { view }),
        h('main', { className: 'fg-main', 'aria-label': '当前阶段内容' },
          h('div', { className: 'fg-content' }, h(StageIntro, { view, stages, currentIndex }), main)),
        h('aside', { className: 'fg-hub-side', 'aria-label': '阶段操作' },
          h(GatePanel, { sessionId, view }),
          h(SettingsPanel, { sessionId, view })))
    }

    // -----------------------------------------------------------------------
    // 左侧栏全局面板：先选工作区，再看这个工作区的流程
    // -----------------------------------------------------------------------

    /** 面板根节点：不复用会话视图的滚动契约（那套只对 conversation 生效）。 */
    const HUB_ROOT_PROPS = { className: 'fg-root fg-hub' }

    function HubWorkspaceTab(props) {
      return h('button', {
        type: 'button',
        className: 'fg-ws-row',
        onClick: props.onClick,
        title: props.path,
      },
        h('span', { className: 'fg-ws-name' }, props.name),
        h('span', { className: 'fg-ws-path' }, props.path),
        h('span', { className: 'fg-tiny' }, props.hint || '进入 →'))
    }

    function HubFlowRow(props) {
      const flow = props.flow
      const tone = flow.waiting ? 'warn' : flow.cancelled ? 'bad' : flow.finished ? 'ok' : 'info'
      const state = flow.waiting
        ? '等你确认'
        : flow.cancelled
          ? '已放弃'
          : flow.finished
            ? '已结束'
            : '进行中'
      return h('button', {
        type: 'button',
        className: 'fg-flow-row',
        onClick: props.onClick,
        title: flow.brief || flow.title,
      },
        h('span', { className: 'fg-flow-row-main' },
          h('span', { className: 'fg-flow-title' }, flow.title || '未命名需求'),
          h('span', { className: 'fg-tiny' },
            'S' + (Number(String(flow.stage).replace('S', '')) || 1) + ' ' + (flow.stageLabel || '') +
            ' · ' + (flow.percent || 0) + '%' +
            (flow.skippedCount > 0 ? ' · 跳过 ' + flow.skippedCount + ' 个阶段' : ''))),
        h('span', { className: 'fg-badge ' + tone }, state))
    }

    /**
     * 面板不属于任何会话，所以拿不到 props.sessionId。
     * 它管的是「用户添加过的工作区」这份名单：
     *   名单为空 → 只给两个入口（添加工作区 / 添加目录），不把宿主的工作区全摊开；
     *   添加之后 → 宿主顺手把这个目录已有的任务与规则读回来，不用再挑；
     *   名单非空 → 点进去看那个目录的任务与规则。
     * 门禁确认、改规则、追加范围仍按会话投递，所以详情里给一个「打开会话」。
     */
    function WorkspaceRulesCard({ path, missing, revision, onSaved }) {
      const [rules, setRules] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [draft, setDraft] = useState(null)
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState(false)
      const sending = useRef(false)
      const trigger = useRef(null)
      const titleId = useRef(null)
      if (!titleId.current) titleId.current = 'fg-workspace-rules-' + (++dialogSeq)

      useEffect(() => {
        let alive = true
        if (missing) { setLoading(false); return undefined }
        setLoading(true)
        postJson('/hub/rules', { path })
          .then((data) => { if (alive) { setRules(data.rules); setError(null) } })
          .catch((err) => { if (alive) setError(err?.message ?? String(err)) })
          .finally(() => { if (alive) setLoading(false) })
        return () => { alive = false }
      }, [path, missing, revision])

      const close = () => {
        if (sending.current) return
        setDraft(null)
        setForm(null)
        setError(null)
        trigger.current?.focus?.()
      }
      const open = (event) => {
        trigger.current = event?.currentTarget
        setDraft({ ids: [...rules.ids], custom: rules.custom.map((rule) => ({ ...rule, points: [...rule.points] })), reset: false })
        setForm(null)
        setError(null)
      }
      const update = (patch) => setDraft((value) => ({ ...value, ...patch, reset: false }))
      const addRule = () => {
        if (!form?.name.trim()) return
        const id = form.id || 'workspace-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2))
        const rule = { id, name: form.name.trim(), points: form.points.split('\n').map((point) => point.trim()).filter(Boolean) }
        update({
          custom: draft.custom.filter((entry) => entry.id !== id).concat([rule]),
          ids: form.id ? draft.ids : draft.ids.concat([id]),
        })
        setForm(null)
      }
      const save = async () => {
        if (sending.current || !draft || form) return
        sending.current = true
        setBusy(true)
        setError(null)
        try {
          const data = await postJson('/hub/rules', { path, rules: draft.reset ? null : { ids: draft.ids, custom: draft.custom } })
          setRules(data.rules)
          setDraft(null)
          setForm(null)
          onSaved?.()
          trigger.current?.focus?.()
        } catch (err) {
          setError(err?.message ?? String(err))
        } finally {
          sending.current = false
          setBusy(false)
        }
      }
      const customIds = new Set((rules?.custom || []).map((rule) => rule.id))
      const builtins = (rules?.catalog || []).filter((rule) => !customIds.has(rule.id))
      const active = (rules?.catalog || []).filter((rule) => rules.ids.includes(rule.id))
      const catalog = draft ? builtins.concat(draft.custom) : []
      return h('section', { className: 'fg-hub-section fg-workspace-card fg-workspace-rules', 'aria-label': '工作区规则' },
        h('div', { className: 'fg-section-head' },
          h('div', null, h('h2', null, '工作区规则'),
            h('div', { className: 'fg-tiny', title: '规则配置：.dsh-flowgate/config.json' },
              missing ? '目录不可用' : loading ? '正在读取…' : rules ? (rules.configured ? '工作区默认' : '使用内置默认规则') + ' · ' + active.length + ' 条启用' : '规则读取失败')),
          h(Btn, { disabled: missing || loading || !rules, onClick: open }, '编辑规则')),
        active.length ? h('div', { className: 'fg-rule-preview' },
          active.slice(0, 3).map((rule) => h(Badge, { key: rule.id }, rule.name)),
          active.length > 3 ? h('span', { className: 'fg-tiny' }, '+' + (active.length - 3)) : null) : null,
        error && !draft ? h('div', { className: 'fg-err', role: 'alert' }, error) : null,
        draft ? h(Modal, { labelledBy: titleId.current, onClose: close },
          h('div', { className: 'fg-modal-head' },
            h('div', { className: 'fg-modal-heading' },
              h('h2', { id: titleId.current, className: 'fg-card-title' }, '工作区规则'),
              h('div', { className: 'fg-tiny' }, '未单独设置规则的流程将使用此配置。')),
            h(Btn, { disabled: busy, onClick: close, title: '关闭工作区规则' }, '关闭')),
          h('div', { className: 'fg-workspace-rule-body' },
            error ? h('div', { className: 'fg-err', role: 'alert' }, error) : null,
            h('div', { className: 'fg-section-head' },
              h('span', { className: 'fg-sec-title' }, '已启用 ' + draft.ids.length + ' / ' + catalog.length),
              h(Btn, { disabled: busy || Boolean(form), onClick: () => setForm({ name: '', points: '' }) }, h(Icon, { name: 'plus' }), '添加规则')),
            form ? h('div', { className: 'fg-list fg-form fg-modal-form' },
              h('label', { className: 'fg-field' }, h('span', { className: 'fg-sec-title' }, '规则名称 ', h('span', { className: 'fg-required', 'aria-hidden': true }, '*')),
                h('input', { className: 'fg-input', required: true, disabled: busy, placeholder: '规则名称', value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }) })),
              h('label', { className: 'fg-field' }, h('span', { className: 'fg-sec-title' }, '检查要点'),
                h('textarea', { className: 'fg-textarea', disabled: busy, placeholder: '检查要点，每行一条', value: form.points, onChange: (event) => setForm({ ...form, points: event.target.value }) })),
              h('div', { className: 'fg-row' },
                h(Btn, { disabled: busy || !form.name.trim(), onClick: addRule }, form.id ? '更新规则' : '加入列表'),
                h(Btn, { disabled: busy, onClick: () => setForm(null) }, '取消编辑'))) : null,
            draft.reset ? h('div', { className: 'fg-tiny', role: 'status' }, '已恢复内置默认，保存后生效。') : null,
            h('div', { className: 'fg-modal-list' }, catalog.map((rule) => {
              const custom = draft.custom.some((entry) => entry.id === rule.id)
              return h('div', { className: 'fg-workspace-rule-row', key: rule.id },
                h('label', { className: 'fg-check' },
                  h('input', { type: 'checkbox', disabled: busy, checked: draft.ids.includes(rule.id), onChange: (event) => update({ ids: event.target.checked ? draft.ids.concat([rule.id]) : draft.ids.filter((id) => id !== rule.id) }) }),
                  h('span', null, h('div', null, rule.name), rule.points?.length ? h('div', { className: 'fg-tiny' }, rule.points.join(' · ')) : null)),
                custom ? h('div', { className: 'fg-row' },
                  h(Btn, { tone: 'quiet', disabled: busy || Boolean(form), 'aria-label': '编辑规则：' + rule.name, onClick: () => setForm({ ...rule, points: rule.points.join('\n') }) }, '编辑'),
                  h(Btn, { tone: 'quiet', disabled: busy || Boolean(form), 'aria-label': '移除规则：' + rule.name, onClick: () => update({ ids: draft.ids.filter((id) => id !== rule.id), custom: draft.custom.filter((entry) => entry.id !== rule.id) }) }, '移除')) : null)
            }))),
          h('div', { className: 'fg-workspace-rule-footer' },
            h(Btn, { disabled: busy || Boolean(form), onClick: () => { setDraft({ ids: builtins.map((rule) => rule.id), custom: [], reset: true }) } }, '恢复内置默认'),
            h('div', { className: 'fg-row' },
              h(Btn, { disabled: busy, onClick: close }, '取消'),
              h(Btn, { tone: 'primary', disabled: busy || Boolean(form), onClick: () => { void save() } }, busy ? '保存中…' : '保存规则')))) : null)
    }

    function HubPanel(props) {
      const useHubWorkspaces = props?.useHubWorkspaces
      // selector 返回整个快照：引用稳定，避免每次渲染都换一个新数组。
      const snapshot = useHubWorkspaces ? useHubWorkspaces((value) => value) : null
      const hostWorkspaces = Array.isArray(snapshot?.items) ? snapshot.items : []
      const hubActions = props?.hubActions || null

      const [members, setMembers] = useState([])
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [tick, setTick] = useState(0)
      const [picking, setPicking] = useState(false)
      const [adding, setAdding] = useState(false)
      const [busyPath, setBusyPath] = useState(null)
      // 记目录而不是 workspaceId：目录才是读盘入参，也不怕工作区被删了重建。
      const [selected, setSelected] = useState(null)
      const [opened, setOpened] = useState(null)
      const [page, setPage] = useState({ path: null, number: 1 })
      const [pageData, setPageData] = useState(null)
      // 读盘刷新会暂时卸载启动表单；按目录保留未提交草稿，成功启动后再清空。
      const [startDrafts, setStartDrafts] = useState({})
      const [flowLoading, setFlowLoading] = useState(false)
      const [flowError, setFlowError] = useState(null)
      const pageNumber = page.path === selected ? page.number : 1
      const missingSelected = members.find((item) => item.path === selected)?.missing === true

      useEffect(() => {
        let alive = true
        if (!selected || missingSelected) {
          setFlowLoading(false)
          return undefined
        }
        setFlowLoading(true)
        setFlowError(null)
        postJson('/hub/flows', { path: selected, page: pageNumber, pageSize: 10 })
          .then((data) => {
            if (!Object.prototype.hasOwnProperty.call(data || {}, 'currentFlow')) {
              throw new Error('流程数据不完整，请更新并重启宿主后重试')
            }
            if (alive) setPageData({ ...data, path: selected, requested: pageNumber })
          })
          .catch((err) => { if (alive) setFlowError(err?.message ?? String(err)) })
          .finally(() => { if (alive) setFlowLoading(false) })
        return () => { alive = false }
      }, [selected, pageNumber, tick, missingSelected])

      useEffect(() => {
        let alive = true
        setLoading(true)
        pullMembers()
          .then((value) => {
            if (!alive) return
            setMembers(value.members)
            setError(null)
          })
          .catch((err) => { if (alive) setError(err?.message ?? String(err)) })
          .finally(() => { if (alive) setLoading(false) })
        return () => { alive = false }
      }, [tick])

      /** 添加一个目录：先确保它是宿主的工作区，再登记进名单。 */
      const add = async (path, ensureWorkspace) => {
        if (!path || busyPath) return
        setBusyPath(path)
        setError(null)
        setNotice(null)
        try {
          if (ensureWorkspace) {
            if (!hubActions) throw new Error('宿主没有工作区服务，无法登记这个目录')
            await hubActions.createWorkspace(path)
          }
          const data = await addMember(path)
          const member = data?.member || null
          if (member) {
            setMembers((prev) => prev.filter((item) => item.path !== member.path).concat([member]))
          }
          const imported = data?.imported || {}
          const flows = Number(imported.flows ?? (member ? member.flowCount : 0)) || 0
          const rules = Number(imported.rules ?? 0) || 0
          const custom = Number(imported.customRules ?? 0) || 0
          setAdding(false)
          setSelected(path)
          setPage({ path, number: 1 })
          setOpened(null)
          // 「顺手导入」要说得出来：加了几条任务、几条规则。
          setNotice('已添加：导入 ' + flows + ' 条任务、' + rules + ' 条规则' + (custom > 0 ? '（含自定义 ' + custom + ' 条）' : ''))
        } catch (err) {
          setError(err?.message ?? String(err))
        } finally {
          setBusyPath(null)
        }
      }

      /** 调宿主的目录选择器；选中的目录即使还不是工作区也会被登记。 */
      const pick = async () => {
        if (picking || !hubActions) return
        setPicking(true)
        setError(null)
        try {
          const path = await hubActions.pickDirectory()
          if (!path) return
          await add(path, true)
        } catch (err) {
          setError(err?.message ?? String(err))
        } finally {
          setPicking(false)
        }
      }

      /** 只从名单里拿掉；目录里的 flows/ 与 config.json 一个字节都不动。 */
      const remove = async (path) => {
        setError(null)
        setNotice(null)
        try {
          await removeMember(path)
          setMembers((prev) => prev.filter((item) => item.path !== path))
          setSelected(null)
          setOpened(null)
        } catch (err) {
          setError(err?.message ?? String(err))
        }
      }

      const errorLine = error ? h('div', { className: 'fg-err', role: 'alert' }, error) : null

      if (!selected) {
        const known = new Set(members.map((item) => item.path))
        const candidates = hostWorkspaces.filter((item) => item.path && !known.has(item.path))
        return h('div', HUB_ROOT_PROPS,
          h('header', { className: 'fg-head' },
            h('div', { className: 'fg-heading' },
              h('div', { className: 'fg-tiny' }, '流程工作台'),
              h('h1', null, '工作区'),
              h('p', { className: 'fg-muted' },
                members.length > 0
                  ? members.length + ' 个工作区'
                  : '添加工作区，开始管理开发流程。'))),
          h('div', { className: 'fg-main' },
            h('div', { className: 'fg-content' },
              h('section', { className: 'fg-hub-section' },
                members.length > 0 ? h('h2', null, '已添加的工作区') : null,
                loading && members.length === 0
                  ? h('div', { className: 'fg-muted fg-empty', role: 'status' }, '正在读取…')
                  : members.length === 0
                    ? h('div', { className: 'fg-muted fg-empty' },
                      '添加第一个工作区，集中查看需求、进度与待办。')
                    : h('div', { className: 'fg-hub-ws' }, members.map((item) => h(HubWorkspaceTab, {
                      key: item.path,
                      name: item.name || item.path,
                      path: item.path,
                      hint: item.missing
                        ? '目录不在了'
                        : (item.waitingCount > 0
                          ? item.flowCount + ' 条 · ' + item.waitingCount + ' 条待确认'
                          : item.flowCount + ' 条任务'),
                      onClick: () => { setSelected(item.path); setPage({ path: item.path, number: 1 }); setOpened(null); setNotice(null); setError(null) },
                    }))),
                h('div', { className: 'fg-hub-pick' },
                  h('div', { className: 'fg-hub-pick-row' },
                    h(Btn, { tone: 'primary', disabled: Boolean(busyPath) || picking || !hubActions, onClick: () => { void pick() } },
                      picking ? '正在打开…' : '添加目录…'),
                    h(Btn, { tone: 'quiet', disabled: Boolean(busyPath), onClick: () => setAdding((value) => !value) },
                      adding ? '收起列表' : '添加工作区')),
                  !hubActions ? h('div', { className: 'fg-tiny' }, '目录选择暂不可用，请添加已有工作区。') : null,
                  adding
                    ? h('div', { className: 'fg-hub-ws' },
                      candidates.length === 0
                        ? h('div', { className: 'fg-muted fg-empty' }, '没有可添加的工作区')
                        : candidates.map((item) => h(HubWorkspaceTab, {
                          key: item.workspaceId || item.path,
                          name: item.title || item.path,
                          path: item.path,
                          hint: busyPath === item.path ? '正在添加…' : '添加',
                          onClick: () => { void add(item.path, false) },
                        })))
                    : null,
                  errorLine)))))
      }

      const member = members.find((item) => item.path === selected) || null
      const workspaceData = pageData?.path === selected ? pageData : null
      const currentPage = workspaceData?.requested === pageNumber ? workspaceData : null
      const currentFlow = workspaceData?.currentFlow || null
      const flows = currentPage?.flows || []
      const total = currentPage?.total ?? member?.flowCount ?? 0
      const pageCount = currentPage?.totalPages || 1
      const displayedPage = currentPage?.page || 1
      const changePage = (number) => { setOpened(null); setPage({ path: selected, number }) }
      const name = member ? (member.name || member.path) : selected

      const header = h('header', { className: 'fg-head' },
        h('div', { className: 'fg-heading' },
          h('div', { className: 'fg-tiny' }, selected),
          h('h1', null, name),
          h('p', { className: 'fg-muted' },
            member && member.missing
              ? '目录不可用，可从列表移除。'
              : !member && loading
                ? '正在读取…'
                : member && member.activeCount > 0
                  ? '进行中 ' + member.activeCount + ' 条' + (member.waitingCount > 0 ? '，其中 ' + member.waitingCount + ' 条在等你确认' : '')
                  : '暂无进行中的流程')),
        h('div', { className: 'fg-toolbar' },
          h(Btn, { tone: 'quiet', onClick: () => { setSelected(null); setOpened(null); setError(null); setNotice(null) } }, '工作区列表'),
          h(Btn, { tone: 'quiet', disabled: loading || flowLoading, title: '重新读盘', onClick: () => setTick((value) => value + 1) },
            h(Icon, { name: 'refresh' }), '刷新'),
          h(Btn, { tone: 'quiet', onClick: () => { void remove(selected) } }, '移除')))

      const body = []
      if (notice) {
        body.push(h('div', { key: 'notice', className: 'fg-tiny fg-hub-notice', role: 'status' }, notice))
      }
      if (errorLine) body.push(h('div', { key: 'error' }, errorLine))
      const history = h('details', { key: 'history-' + selected, className: 'fg-workspace-card fg-flow-history', open: false },
        h('summary', { className: 'fg-section-head' },
          h('h2', null, '流程记录'), h(Badge, null, total + ' 条')),
        member?.missing
          ? h('div', { className: 'fg-muted fg-empty' }, '目录不可用')
          : flowError
            ? h('div', { className: 'fg-err', role: 'alert' }, flowError,
                h(Btn, { onClick: () => setTick((value) => value + 1) }, '重试'))
            : flowLoading || !currentPage
              ? h('div', { className: 'fg-muted fg-empty', role: 'status' }, '正在读取…')
              : flows.length === 0
                ? h('div', { className: 'fg-muted fg-empty' }, '暂无流程记录')
                : h('div', { className: 'fg-flow-list' }, flows.map((flow) => h(HubFlowRow, {
                    key: flow.id,
                    flow,
                    onClick: () => setOpened(opened && opened.id === flow.id ? null : { ...flow, workspace: selected }),
                  }))),
        total > 0 && !member?.missing ? h('nav', { className: 'fg-pagination', 'aria-label': '流程记录分页' },
          h('span', { className: 'fg-tiny', role: 'status', 'aria-live': 'polite' }, '第 ' + displayedPage + ' / ' + pageCount + ' 页 · 每页 10 条'),
          h('div', { className: 'fg-row' },
            h(Btn, { disabled: flowLoading || !currentPage || displayedPage <= 1, onClick: () => changePage(displayedPage - 1) }, '上一页'),
            h(Btn, { disabled: flowLoading || !currentPage || displayedPage >= pageCount, onClick: () => changePage(displayedPage + 1) }, '下一页'))) : null)

      const start = h('section', { key: 'start-' + selected, className: 'fg-hub-section fg-workspace-card fg-start-section', 'aria-label': '开始新流程' },
        h('div', { className: 'fg-section-head' }, h('h2', null, '开始新流程')),
        h('p', { className: 'fg-muted' }, '写下这次要完成的需求，从需求分析开始。'),
        h(StartPanel, {
          presets: null,
          compact: true,
          draft: startDrafts[selected],
          onDraftChange: (draft) => setStartDrafts((prev) => ({ ...prev, [selected]: draft })),
          resolveSession: !member?.missing && hubActions?.sessionForWorkspace
            ? () => hubActions.sessionForWorkspace(selected)
            : null,
          onStarted: () => {
            setNotice('流程已启动')
            setStartDrafts((prev) => {
              const next = { ...prev }
              delete next[selected]
              return next
            })
            setPageData(null)
            setOpened(null)
            setPage({ path: selected, number: 1 })
            setTick((value) => value + 1)
          },
        }))
      let primary
      if (member?.missing || (!member && !loading)) {
        primary = h('div', { className: 'fg-workspace-card fg-muted', role: 'status' }, '目录不可用，请返回工作区列表检查。')
      } else if (flowError) {
        primary = h('div', { className: 'fg-workspace-card fg-err', role: 'alert' }, flowError,
          h(Btn, { onClick: () => setTick((value) => value + 1) }, '重试'))
      } else if (currentFlow) {
        primary = h('section', { className: 'fg-hub-section fg-workspace-card fg-current-flow', 'aria-label': '当前流程' },
          h('div', { className: 'fg-section-head' },
            h('h2', null, '当前流程'),
            h(Badge, { tone: currentFlow.waiting ? 'warn' : 'info' }, currentFlow.waiting ? '等你确认' : '进行中')),
          h('h3', null, currentFlow.title || '未命名需求'),
          h('div', { className: 'fg-tiny' }, currentFlow.stage + ' · ' + currentFlow.stageLabel),
          currentFlow.brief ? h('p', { className: 'fg-muted' }, currentFlow.brief) : null,
          h('div', { className: 'fg-row' }, h(Btn, {
            tone: 'primary',
            onClick: () => setOpened({ ...currentFlow, workspace: selected }),
          }, '继续流程')))
      } else if (flowLoading || !workspaceData || !member) {
        primary = h('div', { className: 'fg-workspace-card fg-muted', role: 'status' }, '正在读取当前流程…')
      } else {
        primary = start
      }
      body.push(h('div', { key: 'overview', className: 'fg-workspace-overview' },
        h('div', { className: 'fg-workspace-primary' }, primary),
        h('aside', { className: 'fg-workspace-tools', 'aria-label': '工作区配置' },
          h(WorkspaceRulesCard, { key: selected, path: selected, missing: member?.missing, revision: tick, onSaved: () => { setNotice('工作区规则已保存'); setTick((value) => value + 1) } }))))

      if (opened?.workspace === selected && !member?.missing) {
        // 详情里直接放完整工作台：门禁确认、改规则、看文档与评审结果都在这里做，
        // 会话里不再有单独的「本次流程」入口，所以这里必须能做完一件事。
        body.push(h('section', { key: 'detail', className: 'fg-hub-section' },
          h('h2', null, opened.title || '未命名需求'),
          h('div', { className: 'fg-hub-pick-row' },
            opened.brief ? h('span', { className: 'fg-tiny' }, opened.brief) : null,
            h(Btn, {
              tone: 'quiet',
              disabled: !hubActions,
              title: '在会话里打开这条流程（需要和 Agent 对话时用）',
              onClick: () => {
                if (!hubActions) return
                try {
                  hubActions.openSession(opened.sessionId)
                } catch (err) {
                  setError(err?.message ?? String(err))
                }
              },
            }, '打开会话'),
            h(Btn, { tone: 'quiet', onClick: () => setOpened(null) }, '收起')),
          h(FlowDetail, { sessionId: opened.sessionId, allowStart: false })))
      }
      body.push(history)

      return h('div', HUB_ROOT_PROPS,
        header,
        h('div', { className: 'fg-main' },
          h('div', { className: 'fg-content' }, body)))
    }

    /** 侧栏图标：和宿主 panellist 其它条目一样只画字形，按钮外壳由侧栏提供。 */
    function HubPanelIcon(props) {
      const size = Number(props?.size) || 20
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('path', { d: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z' }))
    }



    // -----------------------------------------------------------------------
    // 插件入口
    // -----------------------------------------------------------------------

    /** 侧栏条目 id 与 main 的 key 必须同名：点条目就是打开这个 key 的面板。 */
    const PANEL_ID = 'flowgate-hub'

    /**
     * 宿主服务软取。用 ctx.get 而不是写进 exports.inject：
     * 宿主没装 ui-workspace 时面板必须照常能用，
     * 只是退化成「只能从已有工作区里挑」。
     * 每次现取（不缓存）——本插件可能先于 ui-workspace 激活。
     */
    function service(ctx, name) {
      if (typeof ctx.get === 'function') return ctx.get(name)
      return ctx[name]
    }

    function apply(ctx) {
      ensureStyles()
      // 面板能做的三件宿主动作：挑目录、把目录登记成工作区、跳到某个会话。
      // 全部包成普通函数交给面板，面板自己不碰服务查找。
      const hubActions = {
        // 取消返回 null，调用方据此什么都不做。
        pickDirectory: () => {
          const ui = service(ctx, 'uiWorkspace')
          return ui?.pickDirectory ? ui.pickDirectory() : Promise.resolve(null)
        },
        // 宿主的工作区 create 是幂等的：目录已经是工作区就原样返回，不会重复登记。
        createWorkspace: (path) => {
          const workspaces = service(ctx, 'workspaces')
          if (!workspaces?.create) return Promise.reject(new Error('宿主没有工作区服务，无法登记这个目录'))
          return workspaces.create({ path })
        },
        openSession: (sessionId) => {
          const ui = service(ctx, 'uiWorkspace')
          if (!ui?.openSession) throw new Error('宿主没有会话导航服务，请从左侧栏进入那个会话')
          ui.openSession(sessionId)
        },
        // 面板没有会话，开流程时要先落到一个会话上：连着这个工作区的那个（没有就新建一个 blank）。
        // 会话本身不弹出切换，用户留在面板里继续看流程。
        sessionForWorkspace: async (path) => {
          const ui = service(ctx, 'uiWorkspace')
          if (!ui?.connectWorkspace) throw new Error('宿主没有会话服务，没法在这里启动流程')
          const workspaces = service(ctx, 'workspaces')
          let workspaceId
          try {
            const snapshot = workspaces?.list?.getSnapshot?.()
            const hit = (snapshot?.items || []).find((item) => item.path === path)
            workspaceId = hit?.workspaceId
          } catch (err) {
            workspaceId = undefined
          }
          if (!workspaceId) throw new Error('这个目录还不是宿主的工作区，先从工作区列表里重新添加一次')
          return await ui.connectWorkspace(workspaceId)
        },
      }
      // inject factory 是惰性的：挂载时才跑，那时 ui-workspace 已经激活。
      // 拿到 list 就缓存一份，免得每次渲染都换一个 hooks 对象。
      let hooks = null
      const faceOf = () => {
        if (!hooks) {
          const workspaces = service(ctx, 'workspaces')
          if (workspaces?.list) hooks = { hubWorkspaces: workspaces.list }
        }
        return { hooks: hooks || {}, hubActions }
      }
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: () => '流程工作台',
      }, HubPanelIcon));
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: faceOf,
      }, HubPanel));
    }

    exports.name = 'dsh-flowgate'
    exports.inject = ['slots']
    exports.apply = apply
    // 面板里的流程详情是被 HubPanel 当普通组件内嵌的，没有独立插槽可供外部取用；
    // 一并导出来，单测才能直接渲染它（面板入口要点两次才到得了）。
    exports.components = { FlowDetail }
    return module.exports
  },
})

