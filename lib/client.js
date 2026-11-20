
/* flowgate-factory:start */
function flowgateFactory(require) {
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
.fg-root, .fg-root *, .fg-root *::before, .fg-root *::after { box-sizing: border-box; }
/* 对齐官方 ui-theme：标签、控件、条目、内容块、卡片与弹窗分层使用圆角。
   左侧栏面板是唯一根，跟随宿主主题取值。 */
.fg-root {
  --fg-radius-badge: 6px;
  --fg-radius-control: 10px;
  --fg-radius-item: 12px;
  --fg-radius-surface: 14px;
  --fg-radius-panel: 18px;
  --fg-radius-dialog: 22px;
  --fg-shadow: 0 2px 8px color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent);
  --fg-accent-border: color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, var(--dsw-alias-border-l2));
}
.fg-root {
  container: flowgate / inline-size;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  font-family: 'Segoe UI Variable', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
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
  border: 1px solid var(--fg-accent-border);
  border-radius: var(--fg-radius-item);
  color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-state-business-tertiary);
}
.fg-brand-mark .fg-icon { width: 21px; height: 21px; }
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
  flex-shrink: 0;
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
  transition: border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
}
.fg-opt:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-interactive-bg-hover); }
.fg-opt:disabled { opacity: 0.5; cursor: not-allowed; }
.fg-opt.rec { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-tertiary) 55%, var(--dsw-alias-bg-layer-1)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.fg-preset-options .fg-opt-label::after { content: ''; margin-left: auto; width: 15px; height: 15px; flex: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 50%; }
.fg-preset-options .fg-opt.rec .fg-opt-label::after { border: 5px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); }
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
.fg-hub > .fg-head { gap: 16px; padding: 24px clamp(16px, 3cqi, 40px); background: linear-gradient(115deg, var(--dsw-alias-bg-layer-1), color-mix(in srgb, var(--dsw-alias-state-business-tertiary) 35%, var(--dsw-alias-bg-layer-1))); }
.fg-hub > .fg-head > .fg-brand-mark { width: 44px; height: 44px; border-radius: 14px; }
.fg-hub > .fg-head > .fg-heading { flex: 1; }
.fg-hub > .fg-head h1 { margin: 3px 0 4px; font-size: clamp(22px, 2.5cqi, 28px); font-weight: 650; line-height: 1.3; letter-spacing: -.025em; overflow-wrap: anywhere; }
.fg-hub > .fg-head p { margin: 0; font-size: 12px; }
.fg-hub > .fg-main > .fg-content { width: 100%; max-width: 1080px; margin-inline: auto; }
.fg-hub .fg-ws-row { min-height: 160px; padding: 20px; gap: 8px; position: relative; box-shadow: var(--fg-shadow); }
.fg-ws-symbol { display: grid; place-items: center; width: 36px; height: 36px; margin-bottom: 4px; border-radius: 10px; background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-brand-primary); }
.fg-ws-symbol .fg-icon { width: 20px; height: 20px; }
.fg-ws-arrow { position: absolute; right: 18px; top: 26px; color: var(--dsw-alias-label-tertiary); transition: transform 160ms ease; }
.fg-ws-row:hover .fg-ws-arrow { transform: translateX(3px); color: var(--dsw-alias-brand-primary); }
.fg-hub .fg-ws-name { font-size: 15px; }
.fg-hub .fg-hub-pick { padding-top: 8px; }
.fg-root :is(button, summary, input, textarea, select, a, [tabindex]):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; }
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
  transition: border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
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
.fg-input, .fg-textarea { transition: border-color 160ms ease, box-shadow 160ms ease; width: 100%; min-width: 0; padding: 9px 11px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--fg-radius-control); background: var(--dsw-alias-bg-base); color: inherit; font: inherit; font-size: 12px; line-height: 1.6; }
.fg-input:focus, .fg-textarea:focus { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
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
  .fg-stage.accepted_with_risk .fg-stage-status { display: block; margin: 4px 0 0; }
  .fg-stage.accepted_with_risk .fg-stage-status .fg-tiny { display: none; }
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
  .fg-modal-card { width: 100%; max-height: none; height: calc(100vh - 24px); height: calc(100dvh - 24px); }
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
  .fg-root *, .fg-root *::before, .fg-root *::after { transition: none !important; animation: none !important; }
  .fg-root .fg-ws-row:hover, .fg-root .fg-ws-row:hover .fg-ws-arrow { transform: none; }
}
/* 左侧栏全局面板：先挑工作区，再挑那条流程。根复用 .fg-root 的布局，
   这里只补条目形态，避免出现第二套按钮/卡片视觉。 */
.fg-hub-ws { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); gap: 16px; }
.fg-ws-row {
  display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; text-align: left;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--fg-radius-item);
  background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; cursor: pointer;
}
.fg-ws-row { transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease; }
.fg-ws-row:hover { border-color: var(--fg-accent-border); transform: translateY(-2px); box-shadow: 0 8px 24px color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.fg-ws-row.on { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-state-business-tertiary); }
.fg-ws-name { font-weight: 600; overflow-wrap: anywhere; }
.fg-ws-path { color: var(--dsw-alias-label-tertiary); font-size: 11px; overflow-wrap: anywhere; }
.fg-flow-list { display: flex; flex-direction: column; gap: 8px; }
.fg-flow-row {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 14px; text-align: left;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--fg-radius-item);
  background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; cursor: pointer;
}
.fg-flow-row { transition: border-color 160ms ease, background-color 160ms ease; }
.fg-flow-row:hover { border-color: var(--fg-accent-border); background: var(--dsw-alias-bg-base); }
.fg-flow-row-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1 1 auto; }
.fg-flow-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fg-flow-summary { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 12px; }
/* 面板没有浮层输入框，不需要会话页那 152px 的 composer clearance。 */
.fg-hub > .fg-main { padding: 28px clamp(16px, 3cqi, 40px) 40px; }
.fg-hub-section { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.fg-workspace-overview { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 18px; }
.fg-workspace-tools { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.fg-workspace-card { padding: 24px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--fg-radius-panel); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--fg-shadow); }
.fg-section-head h2 { display: inline-flex; align-items: center; gap: 9px; }
.fg-section-head h2 > .fg-icon { color: var(--dsw-alias-brand-primary); width: 18px; height: 18px; }
.fg-start-section > .fg-card { padding: 0; border: 0; background: transparent; border-radius: 0; gap: 22px; }
.fg-start-section .fg-textarea { min-height: 130px; padding: 14px; font-size: 13px; background: var(--dsw-alias-bg-layer-1); }
.fg-start-section .fg-card > .fg-row:last-of-type > .fg-btn { min-height: 40px; padding-inline: 18px; }
.fg-section-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; min-width: 0; }
.fg-section-head h2 { font-size: 14px; margin: 0; font-weight: 650; }
.fg-flow-history > summary { cursor: pointer; list-style: none; }
.fg-flow-history > summary::-webkit-details-marker { display: none; }
.fg-flow-history > summary::after { content: ''; width: 7px; height: 7px; margin: 0 4px 4px auto; flex: none; border-right: 1.5px solid var(--dsw-alias-label-secondary); border-bottom: 1.5px solid var(--dsw-alias-label-secondary); transform: rotate(45deg); }
.fg-flow-history[open] > summary::after { transform: rotate(225deg); margin-bottom: 0; }
.fg-flow-history > summary > .fg-badge { margin-left: auto; }
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
.fg-stage-rule-summary { display: grid; gap: 10px; }
.fg-workspace-rule-item { padding-block: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.fg-rule-original { font-size: 12px; margin: 8px 0 4px 24px; overflow-wrap: anywhere; }
.fg-rule-original > summary, .fg-requirement-original > summary { cursor: pointer; color: var(--dsw-alias-label-secondary); }
.fg-rule-preset { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.fg-rule-preset .fg-input { width: auto; }
.fg-flow-requirement { min-width: 0; }
.fg-flow-requirement h2 { margin: 0 0 10px; overflow-wrap: anywhere; }
.fg-requirement { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.fg-requirement-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
.fg-requirement-original { font-size: 12px; }
.fg-requirement-original .fg-requirement-text { margin-top: 10px; }
.fg-workspace-rule-footer { flex-shrink: 0; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding: 14px 18px; border-top: 1px solid var(--dsw-alias-border-l2); }
@container flowgate (min-width: 900px) {
  .fg-workspace-overview { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
}
@container flowgate (max-width: 480px) {
  .fg-workspace-card { padding: 16px; }
  .fg-flow-row { align-items: flex-start; flex-wrap: wrap; }
  .fg-flow-row-main { flex-basis: 100%; }
  .fg-hub > .fg-head { gap: 12px; padding-block: 18px; }
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
.fg-hub-flow .fg-stage.accepted_with_risk .fg-stage-status { display: block; margin: 0; }
.fg-hub-flow .fg-stage.accepted_with_risk .fg-stage-status .fg-badge { max-width: 100%; padding: 2px 3px; white-space: normal; overflow-wrap: anywhere; line-height: 1.2; text-align: center; }
.fg-hub-flow .fg-stage.accepted_with_risk .fg-stage-status .fg-tiny { display: none; }
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

/* 会话输入框上方的阶段提示条：注册在宿主的 conversation.input.dock 槽，
   与任务条、目标条同一个座位，order 30 在排队消息(20)之后，目标是最靠近输入框。
   只读一行：现在第几步、要做什么、为什么停着。
   插槽本身不限制宽度；与宿主任务条/目标条使用相同的两侧留白、四份缩进和卡片上限。
   它不是 .fg-root 的后代，单独约束盒模型；旧宿主无这些变量时保持占满可用区域。 */
.fg-hint, .fg-hint *, .fg-hint *::before, .fg-hint *::after { box-sizing: border-box; }
.fg-hint {
  display: grid;
  grid-template-columns: minmax(0, 1fr) fit-content(65%);
  align-items: center;
  gap: 6px 16px;
  flex: none;
  width: calc(100% - 2 * var(--dsh-composer-side-clearance, 0px) - 4 * var(--dsh-composer-dock-inset, 0px));
  max-width: calc(var(--dsh-composer-card-max-width, 100%) - 4 * var(--dsh-composer-dock-inset, 0px));
  min-width: 0;
  padding: 7px 0;
  margin: 0 auto;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.fg-hint-content { display: flex; flex-direction: column; justify-content: center; gap: 4px; min-width: 0; }
.fg-hint-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.fg-hint-title { display: block; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--dsw-alias-label-primary); }
.fg-hint-stage {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.fg-hint.is-waiting .fg-hint-stage {
  color: var(--dsw-alias-state-warn-label);
}
.fg-hint-todo {
  min-width: 0;
  overflow-wrap: anywhere;
}
.fg-hint-why {
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.fg-ac-scroll { overflow-x: auto; }
.fg-ac-table { width: 100%; border-collapse: collapse; text-align: left; }
.fg-ac-table th, .fg-ac-table td { padding: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); vertical-align: top; overflow-wrap: anywhere; min-width: 8em; }
.fg-prewrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.fg-diagnostics { margin-top: 10px; }
.fg-diagnostics pre { font-size: 11px; max-height: 24em; overflow: auto; }
.fg-hint-actions { display: flex; align-items: center; align-content: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; min-width: 0; }
.fg-hint-actions > button { flex: 0 1 auto; }
.fg-gate-more summary, .fg-hint-more summary { cursor: pointer; color: var(--dsw-alias-label-secondary); }
.fg-gate-more summary { padding: 7px 0; }
.fg-gate-more .fg-list { margin-top: 8px; }
.fg-hint-more { position: relative; align-self: center; }
.fg-hint-more summary { padding: 4px 6px; white-space: nowrap; }
.fg-hint-more .fg-list { position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 10; width: max-content; max-width: min(280px, 85vw); min-width: 190px; padding: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); box-shadow: var(--fg-shadow); }
.fg-hint-more .fg-hint-btn { width: 100%; text-align: left; }
.fg-hint-message { grid-column: 1 / -1; min-width: 0; width: 100%; }
.fg-quick-report { min-height: 0; overflow: auto; padding: 18px; }
.fg-quick-report .fg-doc { min-height: 280px; height: min(62dvh, 640px); }
.fg-quick-report .fg-doc iframe { min-height: 280px; }
.fg-quick-report .fg-item { margin-bottom: 8px; }
.fg-hint-btn { max-width: 100%; min-height: 28px; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; font: inherit; font-weight: 600; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); overflow-wrap: anywhere; cursor: pointer; }
.fg-hint-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-brand-primary); }
.fg-hint-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; }
.fg-hint-btn:disabled { color: var(--dsw-alias-label-caption); border-color: var(--dsw-alias-border-l1); background: transparent; cursor: not-allowed; }
.fg-hint-btn-primary:not(:disabled) { color: var(--dsw-alias-label-primary-foreground); border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); }
.fg-hint-btn-primary:hover:not(:disabled) { color: var(--dsw-alias-label-primary-foreground); border-color: var(--dsw-alias-button-primary-hover); background: var(--dsw-alias-button-primary-hover); }
.fg-hint-btn-danger:not(:disabled) { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-secondary); background: var(--dsw-alias-interactive-bg-hover-danger); }
.fg-hint-err { flex: 1 1 100%; min-width: 0; color: var(--dsw-alias-state-warn-label); overflow-wrap: anywhere; }
.fg-hint-note { flex: 1 1 100%; min-width: 0; color: var(--dsw-alias-label-caption); overflow-wrap: anywhere; }
.fg-hint-elapsed {
  flex: none;
  white-space: nowrap;
  color: var(--dsw-alias-label-caption);
}
.fg-hint-info { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; min-width: 0; width: 100%; }
@media (max-width: 640px) {
  .fg-hint { grid-template-columns: minmax(0, 1fr); }
  .fg-hint-actions { justify-content: flex-start; }
}
.fg-hint-start { justify-self: end; max-width: 100%; min-height: 32px; padding: 5px 10px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 10px; font: inherit; font-weight: 600; color: var(--dsw-alias-label-primary-foreground); background: var(--dsw-alias-brand-primary); overflow-wrap: anywhere; cursor: pointer; }
.fg-hint-start:hover { background: var(--dsw-alias-button-primary-hover); border-color: var(--dsw-alias-button-primary-hover); }
.fg-hint-start:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; }
.fg-root.fg-quick-shell { display: contents; container: none; }
.fg-quick-shell dialog.fg-modal { width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; border: 0; color: inherit; font: inherit; }
.fg-quick-shell dialog::backdrop { background: transparent; }
.fg-quick-shell .fg-modal-card { width: min(760px, 100%); max-height: calc(100dvh - 48px); height: auto; }
.fg-quick-content { min-height: 0; overflow: auto; padding: 20px; }
.fg-quick-content > .fg-card { padding: 0; border: 0; background: transparent; }
@media (max-width: 540px) {
  .fg-quick-shell .fg-modal { padding: 12px; }
  .fg-quick-shell .fg-modal-card { max-height: calc(100dvh - 24px); }
  .fg-quick-content { padding: 16px; }
  .fg-quick-content .fg-preset-options { grid-template-columns: minmax(0, 1fr); }
}
`

    function ensureStyles(root) {
      if (typeof document === 'undefined') return
      const target = root || document
      const existing = target.getElementById?.(STYLE_ID) || target.querySelector?.('#' + STYLE_ID)
      if (existing) {
        if (existing.textContent !== CSS_TEXT) existing.textContent = CSS_TEXT
        return
      }
      try {
        if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in target) {
          const sheets = Array.from(target.adoptedStyleSheets)
          const previous = sheets.find((sheet) => sheet.__dshFlowgateStyleId === STYLE_ID)
          if (previous) {
            if (previous.__dshFlowgateCss !== CSS_TEXT) {
              previous.replaceSync(CSS_TEXT)
              previous.__dshFlowgateCss = CSS_TEXT
            }
            return
          }
          const sheet = new CSSStyleSheet()
          sheet.replaceSync(CSS_TEXT)
          sheet.__dshFlowgateStyleId = STYLE_ID
          sheet.__dshFlowgateCss = CSS_TEXT
          target.adoptedStyleSheets = sheets.concat(sheet)
          return
        }
      } catch (error) {
        // 落到 <style> 路径，包括不支持可构造样式表的 ShadowRoot。
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS_TEXT
      ;(target.head || target).appendChild(style)
    }

    function styleRoot(node) {
      if (node) ensureStyles(node.getRootNode?.())
    }

    let pageId = null
    try {
      if (typeof globalThis.crypto?.randomUUID === 'function') pageId = globalThis.crypto.randomUUID()
    } catch (error) { /* 无可靠页面身份时保持未核对。 */ }

    function pageViewport() {
      const width = window.innerWidth
      const height = window.innerHeight
      return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? { width, height } : null
    }

    let clientRevision = null
    const revisionReady = (async () => {
      try {
        if (!globalThis.crypto?.subtle || typeof TextEncoder !== 'function') return
        const source = flowgateFactory.toString().replaceAll('\r\n', '\n')
        const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
        clientRevision = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      } catch (error) {
        // 无 WebCrypto 或函数字符串不可用时保持未核对，不生成替代指纹。
      }
    })()

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
        const viewport = pageViewport()
        const revisionQuery = clientRevision ? '&clientRevision=' + encodeURIComponent(clientRevision) : ''
        const pageQuery = pageId && viewport
          ? '&pageId=' + encodeURIComponent(pageId) + '&viewportWidth=' + viewport.width + '&viewportHeight=' + viewport.height
          : ''
        const res = await fetch(API + '/state?sessionId=' + encodeURIComponent(sessionId) + revisionQuery + pageQuery, {
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

    // 仅在独立脚本显式调用时测量；参照元素由调用者指定，不扫描宿主私有结构。
    async function inspectLayout({ sessionId, element = '.fg-hint', references = [], tolerancePx = 1 } = {}) {
      await revisionReady
      if (sessionId) await pull(sessionId)
      const runtime = entries.get(sessionId)?.view?.runtime || null
      const version = entries.get(sessionId)?.view?.snapshot?.id || null
      const result = { clientRevision, pageId, runtime, version, evidenceId: null, viewport: null, measurements: [], status: 'uncovered', reason: '' }
      const uncovered = (reason) => ({ ...result, reason })
      if (!sessionId) return uncovered('必须明确指定真实任务的 sessionId。')
      if (typeof document === 'undefined' || typeof window.getComputedStyle !== 'function') return uncovered('当前环境没有浏览器布局测量能力。')
      const viewport = pageViewport()
      result.viewport = viewport ? { ...viewport, devicePixelRatio: window.devicePixelRatio } : null
      if (entries.get(sessionId)?.error) return uncovered('无法获取当前任务的页面版本核对结果。')
      if (!clientRevision || runtime?.status !== 'verified' || runtime.clientRevision !== clientRevision || runtime.expectedClientRevision !== clientRevision) return uncovered('页面版本尚未核对，无法记录有效布局证据。')
      if (!pageId || runtime.pageId !== pageId) return uncovered('当前页面实例身份尚未核对，无法记录有效布局证据。')
      if (!viewport || runtime.viewport?.width !== viewport.width || runtime.viewport?.height !== viewport.height) return uncovered('运行版本的视口与当前实测视口不一致，无法记录有效布局证据。')
      if (!version) return uncovered('当前任务缺少快照版本，无法保存布局采集回执。')
      if (!Number.isFinite(tolerancePx) || tolerancePx < 0) return uncovered('tolerancePx 必须是非负有限数值。')
      if (!Array.isArray(references) || !references.length) return uncovered('必须明确指定真实任务和目标参照元素。')
      try {
        const targets = typeof element === 'string'
          ? Array.from(document.querySelectorAll(element)).filter((node) => node.closest?.('[data-fg-session-id]')?.getAttribute('data-fg-session-id') === sessionId)
          : [element]
        if (targets.length !== 1) return uncovered('目标必须唯一匹配指定任务的真实元素。')
        const target = targets[0]
        if (!target || target.closest?.('[data-fg-session-id]')?.getAttribute('data-fg-session-id') !== sessionId) return uncovered('找不到指定任务的目标元素。')
        const root = target.getRootNode?.() || document
        const measure = (node) => {
          if (!node?.getBoundingClientRect || node.isConnected === false) return null
          const style = window.getComputedStyle(node)
          const rect = node.getBoundingClientRect()
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return null
          return Number.isFinite(rect.left) && Number.isFinite(rect.right) && rect.right > rect.left ? rect : null
        }
        const bounds = measure(target)
        if (!bounds) return uncovered('目标元素没有有效的可见布局测量。')
        for (const reference of references) {
          if (!reference?.name || typeof reference.selector !== 'string' || !reference.selector.trim()) return uncovered('每个参照都必须提供名称和明确的 selector。')
          const nodes = Array.from(root.querySelectorAll(reference.selector))
          if (nodes.length !== 1 || nodes[0] === target) return uncovered('参照 ' + reference.name + ' 必须唯一匹配其他真实元素。')
          const rect = measure(nodes[0])
          if (!rect) return uncovered('参照 ' + reference.name + ' 没有有效的可见布局测量。')
          result.measurements.push({ element: typeof element === 'string' ? element : target.tagName || 'element', reference: reference.name,
            left: bounds.left, right: bounds.right, referenceLeft: rect.left, referenceRight: rect.right })
        }
        const pass = result.measurements.every((item) => Math.abs(item.left - item.referenceLeft) <= tolerancePx && Math.abs(item.right - item.referenceRight) <= tolerancePx)
        const res = await fetch(API + '/action', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sessionId, action: 'layout-evidence', payload: { version, pageId, clientRevision, viewport, measurements: result.measurements } }),
        })
        if (!res.ok) return uncovered('布局采集回执保存失败：宿主返回 HTTP ' + res.status)
        const receipt = (await res.json())?.layoutEvidence
        if (!receipt?.id || receipt.version !== version || receipt.pageId !== pageId || receipt.clientRevision !== clientRevision ||
            receipt.viewport?.width !== viewport.width || receipt.viewport?.height !== viewport.height) return uncovered('布局采集回执缺失或与本次页面、版本、视口不一致。')
        if (pageViewport()?.width !== viewport.width || pageViewport()?.height !== viewport.height) return uncovered('保存采集回执期间视口已变化，请重新测量。')
        return { ...result, evidenceId: receipt.id, status: pass ? 'pass' : 'fail', reason: pass ? '真实 DOM 两侧边界在允许误差内。' : '真实 DOM 两侧边界超过允许误差。' }
      } catch (error) {
        return uncovered('浏览器测量未完成：' + (error?.message || String(error)))
      }
    }

    window.__DSH_FLOWGATE_DIAGNOSTICS__ = Object.freeze({ pageId, inspectLayout })

    function subscribe(sessionId, fn) {
      // 没有 sessionId 就没有可问的状态：不发无主请求，不起空转的轮询，
      // 也不在 listeners 里留下一个空键。
      if (!sessionId) return () => {}
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
      const [snapshot, setState] = useState(() => ({ sessionId, entry: entries.get(sessionId) || EMPTY }))
      useEffect(() => {
        let alive = true
        const sync = () => { if (alive) setState({ sessionId, entry: entries.get(sessionId) || EMPTY }) }
        sync()
        const unsubscribe = subscribe(sessionId, sync)
        return () => { alive = false; unsubscribe() }
      }, [sessionId])
      // 切会话的首帧先核对归属；不能等 effect 才清掉上一会话的视图。
      return snapshot.sessionId === sessionId ? snapshot.entry : entries.get(sessionId) || EMPTY
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
    async function postJson(path, body, init) {
      // init 只接受 signal：method/headers/body 由这里说了算，调用方传错也覆盖不掉请求语义。
      const res = await fetch(API + path, {
        credentials: 'same-origin',
        ...(init && init.signal ? { signal: init.signal } : {}),
        method: 'POST',
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

    function Icon({ name, size }) {
      const paths = {
        workbench: 'M5 3h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M15 3h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M5 15h4a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2Z M17 15v6 M14 18h6',
        folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z M3 10h18',
        arrow: 'M5 12h14 M13 6l6 6-6 6',
        back: 'M19 12H5 M11 6l-6 6 6 6',
        spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
        settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
        history: 'M3 4v5h5 M3.5 9a9 9 0 1 1 .8 8 M12 7v5l3 2',
        bolt: 'm13 2-9 12h7l-1 8 10-12h-7l1-8Z',
        shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z M8 12l3 3 5-6',
        refresh: 'M20 7v5h-5 M4 17v-5h5 M6.1 7a7 7 0 0 1 11.5-2L20 8 M4 16l2.4 3A7 7 0 0 0 18 17',
        panel: 'M4 4h16v16H4z M14 4v16',
        check: 'M5 12l4 4L19 6',
        plus: 'M12 5v14 M5 12h14',
        lock: 'M6 10h12v10H6z M8 10V7a4 4 0 0 1 8 0v3',
      }
      return h('svg', { className: 'fg-icon', width: size, height: size, style: size ? { width: size, height: size } : undefined, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: paths[name] || paths.workbench }))
    }

    function Badge({ tone, children }) {
      return h('span', { className: 'fg-badge' + (tone ? ' ' + tone : '') }, children)
    }

    function Btn({ children, icon, onClick, disabled, tone, title, expanded, controls, buttonRef, 'aria-label': ariaLabel }) {
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
      }, icon ? h(Icon, { name: icon }) : null, children)
    }

    function Card({ title, children, grow, extra }) {
      return h('section', { className: 'fg-card' + (grow ? ' grow' : '') },
        title ? h('div', { className: 'fg-card-head' }, h('h2', { className: 'fg-card-title' }, title), extra) : null,
        children)
    }

    function Empty({ children }) {
      return h('div', { className: 'fg-muted fg-empty' }, children)
    }

    const STAGE_TONE = { passed: 'ok', accepted_with_risk: 'warn', active: 'info', skipped_by_user: '', pending: '' }
    const STAGE_TEXT = { passed: '已通过', accepted_with_risk: '带风险继续', active: '进行中', skipped_by_user: '已跳过', pending: '待开始' }
    const VERDICT_TONE = { pass: 'ok', blocking: 'bad', advisory: 'warn' }
    const VERDICT_TEXT = { pass: '通过', blocking: '有阻塞项', advisory: '有建议项' }
    const SEV_TONE = { CRITICAL: 'bad', MAJOR: 'warn', MINOR: '' }
    const RESULT_TONE = { pass: 'ok', fail: 'bad', uncovered: 'warn', excluded: '' }
    const RESULT_TEXT = { pass: '通过', fail: '失败', uncovered: '未覆盖', excluded: '环境受限' }

    /** 回退留下的结论里还有哪些能直接用：一句话提示，别让用户以为整轮都要重跑。 */
    function carryOverHint(carryOver, key) {
      const group = Array.isArray(carryOver?.[key]) ? carryOver[key] : []
      const reusable = group.filter((entry) => entry?.reusable)
      if (!reusable.length) return null
      return '上一轮（' + (carryOver?.from ?? '?') + '）的 ' + reusable.length + ' 条结论本轮仍然成立，可直接复用：' +
        reusable.map((entry) => entry?.name || entry?.id).join('、')
    }

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

    /**
     * 冻结 scope 与「待冻结 scope」共用一套渲染。
     * S1 批准前必须看到 Agent 自报的白名单（P0-4）：用户点「批准并冻结 scope」时，
     * 真正被放行的就是这里列出的文件，看不到就等于盲签。
     */
    const AC_TEXT = { pending: '待验证', pass: '通过', fail: '未通过', uncovered: '未覆盖' }

    function acceptanceCounts(view) {
      const items = Array.isArray(view.acceptance?.items) ? view.acceptance.items : []
      const counts = { total: items.length, pending: 0, pass: 0, fail: 0, uncovered: 0 }
      for (const item of items) counts[Object.hasOwn(AC_TEXT, item.status) ? item.status : 'pending'] += 1
      return view.acceptance?.counts || counts
    }

    function finalGateLabel(view) {
      const counts = acceptanceCounts(view)
      const points = (view.test?.directions || []).flatMap((direction) => direction.points || [])
      if (counts.fail > 0 || points.some((point) => point.result === 'fail')) return '接受未通过项并结束'
      return counts.pending > 0 || counts.uncovered > 0 || points.some((point) => point.result !== 'pass') ? '接受未覆盖并结束' : '验收通过，结束流程'
    }

    function AcceptanceCard({ view }) {
      const acceptance = view.acceptance
      if (!acceptance) return null
      const items = Array.isArray(acceptance.items) ? acceptance.items : []
      const counts = acceptanceCounts(view)
      return h(Card, { title: '验收标准与证据' },
        h('div', { className: 'fg-tiny' }, '共 ' + counts.total + ' 项 · 通过 ' + counts.pass + ' · 未通过 ' + counts.fail + ' · 未覆盖 ' + counts.uncovered + ' · 待验证 ' + counts.pending),
        h('div', { className: 'fg-ac-scroll' }, h('table', { className: 'fg-ac-table' },
          h('thead', null, h('tr', null, ['验收标准', '验证方法与步骤', '状态', '证据与产物'].map((label) => h('th', { key: label, scope: 'col' }, label)))),
          h('tbody', null, items.map((item, index) => h('tr', { key: item.id || index },
            h('td', null, h('strong', null, item.id), h('div', null, '当 ' + (item.when || '')), h('div', null, '则 ' + (item.then || ''))),
            h('td', null, h('div', null, item.method || '未声明验证方法'), h('div', { className: 'fg-prewrap' }, item.procedure || '未声明验证步骤')),
            h('td', null, h(Badge, { tone: { pass: 'ok', fail: 'bad', uncovered: 'warn' }[item.status] || '' }, AC_TEXT[item.status] || '待验证'), item.reason ? h('div', { className: 'fg-tiny' }, item.reason) : null),
            h('td', null, h('div', { className: 'fg-prewrap' }, item.evidence || '尚无证据'), item.artifact ? h('div', { className: 'fg-mono' }, '产物：' + item.artifact) : null)))))))
    }

    function SummaryCard({ view }) {
      const summary = view.stageSummary
      if (!summary && !view.runtime && !view.snapshot) return null
      const counts = summary?.verification || acceptanceCounts(view)
      const stateText = { complete: '已完成', completed: '已完成', partial: '部分完成', pending: '待完成', verified: '已核对', mismatch: '版本不一致', unverified: '未核对', running: '执行中', idle: '空闲', failed: '失败', pass: '通过', fail: '未通过', uncovered: '未覆盖' }
      const line = (label, item, fallback) => h('div', { className: 'fg-item', key: label }, h('strong', null, label + '：'), item?.text || stateText[item?.status] || fallback)
      const run = view.runtime
      return h(Card, { title: '阶段摘要' },
        h('div', { className: 'fg-list' },
          line('实现', summary?.implementation, '尚无实现摘要'),
          h('div', { className: 'fg-item' }, h('strong', null, '验证：'), '通过 ' + counts.pass + ' / ' + counts.total + ' · 未通过 ' + counts.fail + ' · 未覆盖 ' + counts.uncovered + ' · 待验证 ' + counts.pending),
          line('生效', summary?.runtime, run ? stateText[run.status] || '未核对' : '未核对'),
          line('执行', summary?.execution, '尚无执行记录')),
        summary?.review ? h('div', { className: 'fg-tiny' }, '评审：本轮 ' + summary.review.fresh + ' · 复用 ' + summary.review.reused + ' · 合计 ' + summary.review.total) : null,
        summary?.test ? h('div', { className: 'fg-tiny' }, '测试：本轮 ' + summary.test.fresh + ' · 复用 ' + summary.test.reused + ' · 合计 ' + summary.test.total) : null,
        view.snapshot ? h('div', { className: 'fg-tiny' }, view.snapshot.complete ? '范围文件快照已完整采集。' : '范围文件快照采集不完整。', (view.snapshot.errors || []).map((error) => typeof error === 'string' ? error : error.message || JSON.stringify(error)).join('；')) : null,
        h('details', { className: 'fg-diagnostics' }, h('summary', null, '技术诊断'),
          h('pre', { className: 'fg-prewrap' }, JSON.stringify({ runtime: run, snapshot: view.snapshot, acceptanceVersion: view.acceptance?.version }, null, 2))))
    }

    function RemediationCard({ view }) {
      const remediation = view.remediation
      if (view.stage !== 'S2' || !remediation) return null
      const items = Array.isArray(remediation.items) ? remediation.items : []
      return h(Card, { title: '本轮修复清单' },
        h('div', { className: 'fg-muted' }, remediation.reason || '依据评审与验收结果修复'),
        remediation.note ? h('div', { className: 'fg-prewrap' }, remediation.note) : null,
        items.length ? h('div', { className: 'fg-list' }, items.map((item, index) => h('div', { className: 'fg-item', key: index },
          h(Badge, { tone: item.status === 'pass' || item.status === 'resolved' ? 'ok' : 'warn' }, item.status || '待修复'),
          h('strong', null, item.ac || '验收项'), ' · ' + (item.severity || '') + ' · ' + (item.source || ''),
          h('div', null, item.summary)))) : h(Empty, null, '没有自动生成的修复项，可补充退回说明。'),
        remediation.advisories?.length ? h('div', { className: 'fg-tiny' }, '另有 ' + remediation.advisories.length + ' 条建议，不计入修复要求。') : null)
    }

    function ScopeBlock({ scope, pending }) {
      // 待冻结的 pendingScope 是扁平结构，冻结后的 scope 才包在 data.in_scope 里。
      const frozen = scope?.frozen === true
      const data = frozen ? (scope?.data || {}) : (scope || {})
      const files = Array.isArray(data.in_scope?.files_expected_to_change)
        ? data.in_scope.files_expected_to_change
        : (Array.isArray(data.files_expected_to_change) ? data.files_expected_to_change : [])
      // 命令清单也是 scope 的一部分：用户批准的是「这些文件 + 这些命令」。
      const commands = Array.isArray(data.in_scope?.commands)
        ? data.in_scope.commands
        : (Array.isArray(data.commands) ? data.commands : [])
      const capabilities = Array.isArray(data.in_scope?.capabilities)
        ? data.in_scope.capabilities
        : (Array.isArray(data.capabilities) ? data.capabilities : [])
      // 影响面：为实现需求要动的共用契约与已知约束。评审拿它判断发现是否属于本次范围，
      // 所以它必须和文件白名单一起展示——用户批准 scope 时批准的也包括这部分。
      const contracts = Array.isArray(data.in_scope?.shared_contracts)
        ? data.in_scope.shared_contracts
        : (Array.isArray(data.shared_contracts) ? data.shared_contracts : [])
      const outOfScope = Array.isArray(data.out_of_scope_explicitly) ? data.out_of_scope_explicitly : []
      const criteria = Array.isArray(data.acceptance_criteria) ? data.acceptance_criteria : []
      const dropped = pending && Array.isArray(scope?.droppedScopeEntries) ? scope.droppedScopeEntries : []
      return h(Card, { title: [pending ? '待冻结 scope' : '冻结 scope', frozen
        ? h(Badge, { key: 'f', tone: 'ok' }, '已冻结')
        : h(Badge, { key: 'f', tone: 'warn' }, pending ? '批准后生效' : '未冻结')] },
        scope?.withoutDocApproval ? h('div', { className: 'fg-tiny' }, '注意：scope 是在需求文档未获批准的情况下冻结的。') : null,
        pending ? h('div', { className: 'fg-tiny' }, '这份清单由 Agent 随需求文档一并提交。点「批准并冻结 scope」后，开发阶段只允许改动下面列出的文件；项目根之外的路径与绝对路径会被插件剔除，不参与放行。') : null,
        // 被剔除的越界条目不能静默消失：用户批准前要知道 Agent 曾经报过什么。
        pending && (dropped.length
          ? h('div', null,
              h('div', { className: 'fg-sec-title' }, '已剔除的越界条目'),
              h('div', { className: 'fg-list' }, dropped.map((entry, index) => h('div', { key: 'x-' + index, className: 'fg-item fg-mono' }, entry))),
              h('div', { className: 'fg-tiny' }, '这些条目在项目根之外或不是合法相对路径，已被拒绝，不会放行任何写入。'))
          : null),
        h('div', { className: 'fg-sec-title' }, '允许改动的文件'),
        files.length
          ? h('div', { className: 'fg-list' }, files.map((file, index) => h('div', { key: 'f-' + index, className: 'fg-item' },
              h('span', { className: 'fg-mono' }, file))))
          : h(Empty, null, '未声明文件白名单——任何写操作都会被阻断。'),
        h('div', { className: 'fg-sec-title' }, '允许直接执行的命令'),
        commands.length
          ? h('div', null,
              h('div', { className: 'fg-list' }, commands.map((item, index) => h('div', { key: 'cmd-' + index, className: 'fg-item fg-mono' }, item))),
              h('div', { className: 'fg-tiny' }, '清单内的命令在 S2 / S4 直接执行，不需要再勾「允许执行构建/测试命令」；末尾 * 表示前缀通配。清单外的变更性命令仍然要授权。'))
          : h('div', { className: 'fg-tiny' }, '未列出可执行命令：S2 跑构建、S4 跑测试时，仍然需要你在工作台勾选授权。'),
        h('div', { className: 'fg-sec-title' }, '本次会动的共用契约与已知约束'),
        contracts.length
          ? h('div', null,
              h('div', { className: 'fg-list' }, contracts.map((item, index) => h('div', { key: 'k-' + index, className: 'fg-item' }, item))),
              h('div', { className: 'fg-tiny' }, '评审发现的归属据此判定：挂不上这里之外的验收标准、或落在上面文件白名单之外的发现，只作提示、不进重做清单。'))
          : h('div', { className: 'fg-tiny' }, '未声明影响面。评审只能按文件白名单猜边界，出现范围外发现时容易变成无休止的返工。'),
        capabilities.length ? h('div', { className: 'fg-sec-title' }, '要交付的能力') : null,
        capabilities.length ? h('div', { className: 'fg-list' }, capabilities.map((item, index) => h('div', { key: 'c-' + index, className: 'fg-item' }, item))) : null,
        outOfScope.length ? h('div', { className: 'fg-sec-title' }, '明确不做') : null,
        outOfScope.length ? h('div', { className: 'fg-list' }, outOfScope.map((item, index) => h('div', { key: 'o-' + index, className: 'fg-item' }, item))) : null,
        criteria.length ? h('div', { className: 'fg-sec-title' }, '验收标准') : null,
        criteria.length ? h('div', { className: 'fg-list' }, criteria.map((item, index) => h('div', { key: 'a-' + index, className: 'fg-item' },
          h('div', null,
            h('div', { className: 'fg-mono' }, item?.id ?? 'AC-' + (index + 1)),
            h('div', null, '当 ' + (item?.when ?? '') ),
            h('div', null, '则 ' + (item?.then ?? '')),
            h('div', null, '验证方法：' + (item?.method || '未声明')),
            h('div', { className: 'fg-prewrap' }, '验证步骤：' + (item?.procedure || '未声明')))))) : null)
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

    // 命令授权开关：S2 要跑构建、S4 要跑测试，两个阶段共用同一个开关与同一条后端校验。
    // scope 里列过 commands 时，清单内的命令直接放行，这个开关只兜底清单外的变更性命令。
    function ShellGrantToggle({ sessionId, view }) {
      const [busy, setBusy] = useState(false)
      const granted = view.shellGrant === true
      const listed = Array.isArray(view.scope?.data?.in_scope?.commands) ? view.scope.data.in_scope.commands : []
      const toggleShell = async (enabled) => {
        setBusy(true)
        await act(sessionId, 'toggleShellGrant', { enabled })
        setBusy(false)
      }
      return h('label', { className: 'fg-check fg-grant' },
        h('input', {
          type: 'checkbox',
          checked: granted,
          disabled: busy,
          onChange: (event) => { void toggleShell(event.target.checked) },
        }),
        h('span', null,
          h('div', null, '允许执行构建/测试命令'),
          h('div', { className: 'fg-tiny' }, listed.length
            ? 'scope 里已列 ' + listed.length + ' 条可执行命令，这些命令不需要这个开关。只有清单外的变更性命令才受这里控制：' +
              (granted ? '当前已授权，本次流程内一直有效。' : '当前未授权，清单外命令会被拒绝。')
            : granted
              ? '已授权：本次流程内有效，S2 开发与 S4 测试阶段都允许变更性 shell（npm run build、tsc、测试命令等）。代码写工具仍只按 scope 白名单放行；不想再放行时取消勾选即可。'
              : '默认关闭：只允许只读 shell 命令。需要跑构建或测试时再勾选；本次流程内一直有效，进 S4 或退回 S2 都不必重勾。')))
    }

    function DevCard({ sessionId, view }) {
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
        h('div', { className: 'fg-hr' }),
        h(ShellGrantToggle, { key: 'grant', sessionId, view }),
        h('div', { className: 'fg-tiny' }, '代码写工具始终只允许修改 scope 内的文件。'))
    }

    // -----------------------------------------------------------------------
    // S3：评审
    // -----------------------------------------------------------------------

    function FindingList({ angle, compact }) {
      const findings = Array.isArray(angle?.findings) ? angle.findings : []
      const row = (finding, index) => h('div', { key: 'fi-' + index, className: 'fg-item fg-finding' },
        h(Badge, { tone: SEV_TONE[finding?.severity] ?? '' }, finding?.severity ?? 'MINOR'),
        finding?.acMatched ? h(Badge, { tone: 'info' }, finding.ac) : null,
        h('span', { className: 'fg-mono' }, (finding?.file ?? '') + (finding?.line ? ':' + finding.line : '')),
        finding?.acMatched === false ? h(Badge, { tone: 'warn' }, '未归属验收标准') : null,
        finding?.acMatched && finding?.fileInScope === false ? h(Badge, { tone: 'warn' }, 'scope 外文件') : null,
        h('span', { className: 'fg-finding-summary' }, finding?.summary ?? ''))
      const visible = compact ? findings.slice(0, 3) : findings
      const remaining = compact ? findings.slice(3) : []
      const omitted = angle?.omittedCounts
      return h('div', { className: 'fg-list' },
        findings.length ? visible.map(row) : h('div', { className: 'fg-tiny' }, '该角度没有发现。'),
        remaining.length ? h('details', null, h('summary', null, '展开其余 ' + remaining.length + ' 条发现'), remaining.map(row)) : null,
        omitted?.total > 0 ? h('div', { className: 'fg-tiny' }, '另有 ' + omitted.total + ' 条发现超过保存上限，统计仍已计入：CRITICAL ' + (omitted.critical || 0) + ' · MAJOR ' + (omitted.major || 0) + ' · MINOR ' + (omitted.minor || 0)) : null)
    }

    function ReviewCard({ view }) {
      const review = view.review
      if (!review) {
        return h(Card, { title: ['评审报告', h(Badge, { key: 'r', tone: 'info' }, 'S3 评审')] },
          h(Empty, null, '等待提交评审报告。'))
      }
      const angles = Array.isArray(review.angles) ? review.angles : []
      // 部分重跑：复用上一轮结论的角度要标出来，否则用户分不清哪些是这次真跑过的。
      const reusedCount = Array.isArray(review.reused) ? review.reused.length : angles.filter((angle) => angle?.reused === true).length
      const findings = angles.flatMap((angle) => Array.isArray(angle?.findings) ? angle.findings : [])
      const counts = review.counts || { total: findings.length, critical: findings.filter((item) => item.severity === 'CRITICAL').length, major: findings.filter((item) => item.severity === 'MAJOR').length, minor: findings.filter((item) => item.severity === 'MINOR').length, blocking: review.blocking || 0, advisories: review.advisories || 0, unscoped: findings.filter((item) => item.acMatched === false || item.fileInScope === false).length }
      const verification = acceptanceCounts(view)
      const reuseHint = carryOverHint(view.carryOver, 'angles')
      return h(Card, { title: ['评审报告', h(Badge, { key: 'r', tone: 'info' }, 'S3 评审'),
        counts.blocking > 0 ? h(Badge, { key: 'b', tone: 'bad' }, counts.blocking + ' 个阻塞项') : h(Badge, { key: 'b', tone: 'ok' }, '无阻塞项'),
        counts.advisories > 0 ? h(Badge, { key: 'n', tone: 'warn' }, counts.advisories + ' 条仅提示') : null,
        reusedCount ? h(Badge, { key: 'u', tone: 'info' }, reusedCount + ' 项复用上轮') : null] },
        h('div', { className: 'fg-tiny' }, '共 ' + counts.total + ' 条发现 · CRITICAL ' + counts.critical + ' · MAJOR ' + counts.major + ' · MINOR ' + counts.minor + ' · 未归属 ' + counts.unscoped),
        h('div', { className: 'fg-tiny' }, '本轮评审 ' + (review.fresh ?? angles.length - reusedCount) + ' · 复用 ' + reusedCount + ' · 合计 ' + angles.length),
        view.acceptance ? h('div', { className: 'fg-tiny' }, '验收标准：未通过 ' + verification.fail + ' · 未覆盖 ' + verification.uncovered + ' · 待验证 ' + verification.pending) : null,
        reuseHint ? h('div', { className: 'fg-tiny' }, reuseHint) : null,
        // 挡在重做清单外的发现照样列出，但要标清楚：它们不会成为返工要求。
        h('div', { className: 'fg-tiny' }, '只有挂得上冻结 scope 验收标准（ac）、且文件在 scope 内的发现计入重做清单；其余只作提示。'),
        angles.map((angle, index) => h('section', { key: 'ang-' + index, className: 'fg-report-group' },
          h('div', { className: 'fg-row' },
            h('strong', null, angle?.name ?? '角度 ' + (index + 1)),
            h(Badge, { tone: VERDICT_TONE[angle?.verdict] ?? '' }, VERDICT_TEXT[angle?.verdict] ?? String(angle?.verdict ?? '')),
            angle?.reused ? h(Badge, { tone: 'info' }, '复用上轮') : null,
            angle?.suggestUpgrade ? h(Badge, { tone: 'warn' }, '建议升档') : null),
          h(FindingList, { angle, compact: view.preset === 'fast' }))),
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
      const reusedCount = Array.isArray(test.reused) ? test.reused.length : directions.filter((direction) => direction?.reused === true).length
      // 环境受限的点单独计数：它们不算失败，但也不该混进「全部通过」。
      const excludedCount = directions.reduce(
        (sum, direction) => sum + (Array.isArray(direction?.points) ? direction.points : []).filter((point) => point?.result === 'excluded').length,
        0,
      )
      const reuseHint = carryOverHint(view.carryOver, 'directions')
      return h(Card, { title: ['测试报告', h(Badge, { key: 't', tone: 'info' }, 'S4 测试'),
        excludedCount ? h(Badge, { key: 'e', tone: '' }, excludedCount + ' 项环境受限') : null,
        reusedCount ? h(Badge, { key: 'u', tone: 'info' }, reusedCount + ' 项复用上轮') : null] },
        reuseHint ? h('div', { className: 'fg-tiny' }, reuseHint) : null,
        h('div', { className: 'fg-tiny' }, '本轮测试 ' + (test.fresh ?? directions.length - reusedCount) + ' · 复用 ' + reusedCount + ' · 合计 ' + directions.length),
        directions.map((direction, index) => {
          const points = Array.isArray(direction?.points) ? direction.points : []
          const failed = points.filter((point) => point?.result === 'fail').length
          const excluded = points.filter((point) => point?.result === 'excluded').length
          const passed = points.filter((point) => point?.result === 'pass').length
          const uncovered = points.filter((point) => point?.result === 'uncovered').length
          return h('section', { key: 'dir-' + index, className: 'fg-report-group' },
            h('div', { className: 'fg-row' },
              h('strong', null, direction?.name ?? '方向 ' + (index + 1)),
              direction?.reused ? h(Badge, { tone: 'info' }, '复用上轮') : null,
              failed > 0 ? h(Badge, { tone: 'bad' }, failed + ' 项失败')
                : uncovered > 0 ? h(Badge, { tone: 'warn' }, passed + ' 项通过 / ' + uncovered + ' 项未覆盖' + (excluded ? ' / ' + excluded + ' 项环境受限' : ''))
                  : excluded > 0 ? h(Badge, { tone: '' }, passed + ' 项通过 / ' + excluded + ' 项环境受限')
                    : points.length ? h(Badge, { tone: 'ok' }, '全部通过') : h(Badge, { tone: '' }, '尚无验证要点')),
            h('div', { className: 'fg-list' }, points.map((point, pIndex) => h('div', { key: 'p-' + pIndex, className: 'fg-item fg-test-point' },
              h(Badge, { tone: RESULT_TONE[point?.result] ?? '' }, RESULT_TEXT[point?.result] ?? String(point?.result ?? '')),
              h('span', null, point?.point ?? ''),
              point?.detail ? h('span', { className: 'fg-tiny' }, point.detail) : null,
              point?.result === 'excluded' && point?.excludeReason
                ? h('span', { className: 'fg-tiny' }, '环境限制：' + point.excludeReason)
                : null))))
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
            status === 'active' || status === 'pending' ? null : h('div', { className: 'fg-stage-status' }, h(Badge, { tone }, STAGE_TEXT[status] ?? status),
               stage?.riskAcceptance?.reason ? h('div', { className: 'fg-tiny' }, '接受原因：' + stage.riskAcceptance.reason) : null))
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
      // 插件不认识的只读工具默认被拒；这一组是用户声明的出口。
      { id: 'allowlist', label: '只读豁免', stage: null },
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
        allowlist: (view.toolAllowlist || []).length,
      }
    }

    /**
     * 模态外壳：遮罩 + 居中对话框。Esc 与点遮罩都能关，打开时锁背景滚动，
     * 关闭由调用方负责把焦点还给触发按钮。测试环境的 document 是极简替身，
     * 所以这里对 body / addEventListener 都做存在性判断。
     * Tab 在卡片内首尾循环：没有这条，键盘用户会顺着背景页面跑出弹窗。
     */
    const FOCUSABLE_SELECTOR = 'button, input, select, textarea, a[href], details > summary:first-of-type:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
    let dialogSeq = 0

    function Modal({ labelledBy, onClose, children, initialFocusRef, topLayer = false }) {
      const overlayRef = useRef(null)
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
        // 保存期间控件可能全部禁用；仍将 Tab 留在模态框内，避免落到背景。
        if (focusables.length <= 1) {
          event.preventDefault()
          if (focusables.length === 1) focusables[0].focus()
          else card.focus?.()
          return
        }
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
        // 快捷弹窗进入浏览器顶层，避免被输入区的裁剪或层叠上下文限制。
        const overlay = overlayRef.current
        if (topLayer && typeof overlay?.showModal === 'function' && !overlay.open) overlay.showModal()
        const card = cardRef.current
        if (card && typeof card.focus === 'function') card.focus()
        initialFocusRef?.current?.focus()
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

      return h(topLayer ? 'dialog' : 'div', {
        className: 'fg-modal',
        ref: overlayRef,
        role: topLayer ? 'dialog' : undefined,
        'aria-modal': topLayer ? 'true' : undefined,
        'aria-labelledby': topLayer ? labelledBy : undefined,
        onKeyDown: topLayer ? trapTab : undefined,
        onCancel: topLayer ? (event) => { event.preventDefault(); closeRef.current?.() } : undefined,
        onClick: (event) => { if (event.target === event.currentTarget) closeRef.current?.() },
      }, h('div', {
        className: 'fg-modal-card',
        role: topLayer ? undefined : 'dialog',
        'aria-modal': topLayer ? undefined : 'true',
        'aria-labelledby': topLayer ? undefined : labelledBy,
        tabIndex: -1,
        ref: cardRef,
        onKeyDown: topLayer ? undefined : trapTab,
      }, children))
    }

    function SettingsDialog({ sessionId, view, onClose }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [adding, setAdding] = useState(null)
      const [name, setName] = useState('')
      const [points, setPoints] = useState('')
      const [needsWrite, setNeedsWrite] = useState(false)
      // 只读豁免名单：一行一个工具名，保存时整份覆盖。
      const [allowText, setAllowText] = useState((view.toolAllowlist || []).join('\n'))
      const [group, setGroup] = useState(() => settingGroupOfStage(view.stage))
      // 每个弹窗实例用独立标题 id，多实例同屏时 aria-labelledby 不会撞；计数刻意不回退。
      const titleIdRef = useRef(null)
      if (titleIdRef.current === null) {
        dialogSeq += 1
        titleIdRef.current = 'fg-settings-title-' + dialogSeq
      }
      const titleId = titleIdRef.current

      const configs = view.stageConfigs || {}
      const analysisCatalog = configs.S1?.catalog || []
      const analysisIds = new Set(configs.S1?.ids || [])
      const angleIds = new Set(configs.S3?.ids || (view.angles || []).map((angle) => angle.id))
      const directionIds = new Set(configs.S4?.ids || (view.directions || []).map((direction) => direction.id))
      const angleCatalog = configs.S3?.catalog || view.angleCatalog || []
      // 工作区默认不保存方向写权限声明，stageConfigs 的目录与流程实时状态可能不同步。
      // 只合并 writeGranted 不够：needsWrite / writeDeclared 不同步时，点完声明这一行永远显示「未声明」。
      const directionCatalog = (configs.S4?.catalog || view.directionCatalog || []).map((entry) => {
        const live = (view.directions || []).find((item) => item.id === entry.id)
        return { ...entry,
          needsWrite: live?.needsWrite === true || entry.needsWrite === true,
          writeDeclared: live?.writeDeclared === true || entry.writeDeclared === true,
          writeGranted: live?.writeGranted === true }
      })
      const ruleCatalog = configs.S2?.catalog || view.ruleCatalog || []
      const ruleIds = new Set(configs.S2?.ids || (Array.isArray(view.ruleIds) ? view.ruleIds : (view.rules || []).map((rule) => rule.id)))

      const counts = { preset: PRESET_SHORT[view.preset] ?? view.preset ?? '', ...settingCounts(view) }
      // 规则来源必须显式：用户改的到底是「本次」还是「以后每次」，不能靠猜。
      const wsRules = view.workspaceRules || {}
      const ruleSource = configs.S2?.source || view.ruleSource
      const sourceLabels = { flow: '本次流程临时调整', workspace: '工作区默认', default: '内置默认' }
      const sourceLabel = sourceLabels[ruleSource] || '内置默认'
      const runDefaultAction = async (action, payload = {}) => {
        setBusy(true)
        setError(null)
        const message = await act(sessionId, action, payload)
        setBusy(false)
        if (message) setError(message)
      }

      const stageSource = (stage) => h('div', { className: 'fg-ws-rules' },
        h('div', { className: 'fg-row' }, h('span', { className: 'fg-sec-title' }, '当前来源'),
          h(Badge, { tone: 'info' }, sourceLabels[configs[stage]?.source] || '内置默认'),
          configs[stage]?.source === 'flow' ? h(Btn, { disabled: busy, onClick: () => { void runDefaultAction('followStageDefaults', { stage }) } }, '跟随工作区默认') : null),
        h('div', { className: 'fg-tiny' }, '勾选与追加仅影响本次流程，工作区规则在工作区卡片中统一管理。'))
      const toggle = async (action, id, enabled) => {
        setBusy(true)
        const message = await act(sessionId, action, { id, enabled })
        setError(message)
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
        const message = await act(sessionId, adding === 'analysis' ? 'addAnalysisRule' : adding === 'angle' ? 'addAngle' : adding === 'rule' ? 'addRule' : 'addDirection', payload)
        setBusy(false)
        setError(message)
        if (!message) resetForm()
      }

      const canUpgrade = view.preset === 'fast' && !view.finished

      const saveAllowlist = async () => {
        const tools = allowText.split('\n').map((line) => line.trim()).filter(Boolean)
        await runDefaultAction('setToolAllowlist', { tools })
      }

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
            : null,
          paneHead('需求规则', 'S1 按这些规则明确需求与验收标准。'),
          stageSource('S1'),
          addArea('analysis', { name: '规则名称', points: '检查要点，每行一条', add: '追加自定义需求规则' }),
          h('div', { className: 'fg-modal-list' }, analysisCatalog.map((rule) => h(CheckRow, {
            key: 'analysis-' + rule.id, checked: analysisIds.has(rule.id), name: rule.name, points: rule.points,
            onChange: (enabled) => { void toggle('toggleAnalysisRule', rule.id, enabled) },
          })))),
        rules: h('div', { className: 'fg-modal-pane' },
          paneHead('开发规则', 'S2 按这些规则开发，S3 的正确性与风格角度会逐条核对。'),
          h('div', { className: 'fg-ws-rules', title: '规则配置：.dsh-flowgate/config.json' },
            h('div', { className: 'fg-row' },
              h('span', { className: 'fg-sec-title' }, '当前来源'),
              h(Badge, { tone: ruleSource === 'workspace' ? 'ok' : 'info' }, sourceLabel)),
            h('div', { className: 'fg-tiny' }, '勾选与追加只影响本次流程；保存后，这个工作区里的新流程会自动继承同一套规则。'),
            h('div', { className: 'fg-row' },
              ruleSource === 'flow' ? h(Btn, { disabled: busy, onClick: () => { void runDefaultAction('followStageDefaults', { stage: 'S2' }) } }, '跟随工作区默认') : null,
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
          stageSource('S3'),
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
          stageSource('S4'),
          // 原始声明列表：界面渲染出问题时，这一行能直接说明数据到底写进去了没有。
          h('div', { className: 'fg-tiny', 'aria-label': '本次流程已声明的写权限' },
            '本次流程已声明写权限：' + ((view.directionWriteDeclared || []).length
              ? (view.directionWriteDeclared || []).join('、')
              : '（无）')),
          addArea('direction', { name: '方向名称', points: '验证要点，每行一条', add: '追加自定义方向' }),
          h('div', { className: 'fg-modal-list' }, directionCatalog.map((direction) => h('div', { key: 'dir-' + direction.id },
            h(CheckRow, {
              checked: directionIds.has(direction.id),
              name: direction.name,
              points: direction.points,
              onChange: (enabled) => { void toggle('toggleDirection', direction.id, enabled) },
            }),
            // 已声明需要写权限：授权勾选只在 S4 才有意义。S1–S3 摆一个灰着的勾选框，
            // 会让人以为刚才那次声明没生效、反复去点，所以非 S4 阶段只报状态。
            direction.needsWrite
              ? h('div', { className: 'fg-grant' },
                  view.stage === 'S4'
                    ? h('label', { className: 'fg-check' },
                        h('input', {
                          type: 'checkbox',
                          checked: direction.writeGranted === true,
                          disabled: busy,
                          onChange: (event) => { void toggle('toggleWriteGrant', direction.id, event.target.checked) },
                        }),
                        h('span', null,
                          h('div', null, '授权执行变更性命令'),
                          h('div', { className: 'fg-tiny' },
                            '该方向声明需要写权限。授权只覆盖 shell 命令，代码写工具仍然被拒绝；写授权与命令授权都在本次流程内持续，只有重启 DSH（冷恢复）或放弃流程后才需要重新授权。')))
                    : h('div', { className: 'fg-row' },
                        h(Badge, { tone: 'info' }, '已声明需要写权限'),
                        h('span', { className: 'fg-tiny' }, '授权执行变更性命令只在 S4 测试阶段开放。')),
                  // 声明是配置、授权是本次流程的开关。声明必须能撤回，否则内置方向一旦声明就永远留在授权清单里。
                  // 撤销按钮不能放进 label：点它会连带切换同一个 label 里的勾选框。
                  direction.writeDeclared === true
                    ? h('div', { className: 'fg-row' }, h(Btn, {
                        tone: 'quiet',
                        disabled: busy,
                        onClick: () => { void toggle('declareDirectionWrite', direction.id, false) },
                      }, '撤销写权限声明'))
                    : null)
              // 内置方向（冒烟 / 功能 / 边界 / 回归）没有 needsWrite 字段，原来在这里没有任何入口，
              // 测试子代理只能拿到 pwd，测试命令一律被拒，最后全记成未覆盖。这里补上「先声明」这一步。
              // 这一步是按钮而不是勾选框：声明一旦生效，整个分支就换成「已声明」状态，
              // 勾选框的 checked 只能写死成 false，点了立刻弹回去，看起来就是「勾不动」。
              : h('div', { className: 'fg-grant' },
                  h(Btn, {
                    tone: 'quiet',
                    disabled: busy,
                    title: '声明后该方向进入 S4 授权清单，还需在 S4 再授权一次',
                    onClick: () => { void toggle('declareDirectionWrite', direction.id, true) },
                  }, '声明该方向需要写权限'),
                  h('div', { className: 'fg-tiny' },
                    '声明只是让这个方向出现在 S4 的授权清单里；声明后仍需在 S4 阶段再显式授权一次，测试子代理才能执行测试命令。')))))),
        allowlist: h('div', { className: 'fg-modal-pane' },
          paneHead('只读豁免', '插件只认自己登记过的只读工具。宿主新增的只读工具（例如刷新入口）默认被拒，在这里声明后放行。'),
          h('div', { className: 'fg-list fg-form' },
            h('label', { className: 'fg-field' },
              h('span', { className: 'fg-sec-title' }, '额外只读工具（一行一个）'),
              h('textarea', {
                className: 'fg-textarea',
                placeholder: '例如 unlag_refresh',
                value: allowText,
                onChange: (event) => setAllowText(event.target.value),
              })),
            h('div', { className: 'fg-row' },
              h(Btn, { tone: 'primary', disabled: busy, onClick: () => { void saveAllowlist() } }, '保存豁免名单'))),
          h('div', { className: 'fg-tiny' },
            '写工具、shell 与流程自身的状态工具不能靠这里豁免。豁免只对 Agent 主会话生效，评审 / 测试子代理仍然只能读文件。'),
          error ? h('div', { className: 'fg-err', role: 'alert' }, error) : null),
      }

      return h(Modal, { labelledBy: titleId, onClose },
        h('div', { className: 'fg-modal-head' },
          h('div', { className: 'fg-modal-heading' },
            h('h2', { id: titleId, className: 'fg-card-title' }, '阶段设置'),
            h('div', { className: 'fg-tiny' }, '按分组配置，改动即时生效；Esc 或点遮罩关闭。')),
          h(Btn, { onClick: onClose, title: '关闭设置' }, '关闭')),
        error ? h('div', { className: 'fg-err', role: 'alert' }, error) : null,
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
      const [returnNote, setReturnNote] = useState('')
      const [acceptanceNote, setAcceptanceNote] = useState('')
      const [error, setError] = useState(null)
      const hasExceptions = view.stage === 'S4' && finalGateLabel(view) !== '验收通过，结束流程'
      const reviewBlocked = view.stage === 'S3' && view.review?.blocking > 0
      // 放弃是不可撤销的（阶段记录会作废），所以要点两次：第一次只是把按钮换成确认。
      const [confirmCancel, setConfirmCancel] = useState(false)
      const waiting = Boolean(view.waiting)
      // 门禁请求被中断后等待器就没了，但只要产物已交，按钮仍然该能点。
      const gatePending = Boolean(view.gate?.pending)
      const ready = waiting || gatePending
      const gate = async (decision, to) => {
        setBusy(true)
        setError(null)
        const payload = { decision, to }
        if (decision === 'back' && returnNote.trim()) payload.note = returnNote.trim()
        if (decision === 'accept-risk') payload.reviewId = view.review?.id
        if (decision === 'pass' && hasExceptions) {
          payload.acceptUncovered = true
          if (acceptanceNote.trim()) payload.acceptanceNote = acceptanceNote.trim()
        }
        const failure = await act(sessionId, 'gate', payload)
        if (failure) setError(failure)
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

      const returnField = ['S3', 'S4'].includes(view.stage) ? h('label', { className: 'fg-list', key: 'return-note' }, '退回说明（可选）',
        h('textarea', { className: 'fg-textarea', rows: 2, value: returnNote, disabled: busy, 'aria-label': '退回说明（可选）', placeholder: '留空时按自动修复清单退回', onChange: (event) => setReturnNote(event.target.value) })) : null
      const foot = [error ? h('div', { className: 'fg-err', role: 'alert', key: 'gate-error' }, error) : null, returnField, note, interruptedNote, abandon]

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
          reviewBlocked ? h('div', { className: 'fg-tiny' }, '当前评审有 ' + view.review.blocking + ' 条阻塞发现，评审未通过。') : null,
          reviewBlocked
            ? h(Btn, { tone: 'primary', disabled: busy || !ready, onClick: () => { void gate('accept-risk') } }, '带风险进入测试')
            : h(Btn, { tone: 'primary', disabled: busy || !ready, onClick: () => { void gate('pass') } }, '通过评审，进入测试'),
          overflow.length
            ? h('div', { className: 'fg-tiny' }, '评审有 ' + overflow.length + ' 条发现落在冻结 scope 之外：退回开发修复也改不到它们，要先调 scope。')
            : null,
          h(Btn, { disabled: busy || !ready, onClick: () => { void gate('back', 'S2') } }, '退回开发修复'),
          h('details', { className: 'fg-gate-more' },
            h('summary', null, '更多操作'),
            h('div', { className: 'fg-list' },
              h(Btn, { tone: 'danger', disabled: busy || !ready, onClick: () => { void gate('back', 'S1') } }, '回到需求分析调整 scope'),
              reviewBlocked ? null : h(Btn, { disabled: busy || !ready, onClick: () => { void gate('skip') } }, '跳过评审，直接测试'))),
          foot)
      }

      return h('section', { className: 'fg-gate' + (ready && !view.finished ? ' ready' : ''), 'aria-label': '出口门禁' },
        head,
        hasExceptions ? h('div', { className: 'fg-tiny' }, '仍有验收项未通过或未覆盖，结束后会保留原状态和例外记录。') : null,
        hasExceptions ? h('label', { className: 'fg-list' }, '接受说明（可选）', h('textarea', { className: 'fg-textarea', rows: 2, value: acceptanceNote, disabled: busy, 'aria-label': '接受说明（可选）', onChange: (event) => setAcceptanceNote(event.target.value) })) : null,
        h(Btn, { tone: 'primary', disabled: busy || !ready, onClick: () => { void gate('pass') } }, finalGateLabel(view)),
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

    function deriveTitle(brief) {
      const first = String(brief || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ''
      const cleaned = first.replace(/^[#>*\-\s]+/, '').replace(/[。；;，,.！!？?]+$/, '').trim()
      return cleaned.length > 40 ? cleaned.slice(0, 40) + '…' : cleaned
    }
    function formatRequirement(brief) {
      return String(brief || '').replace(/\r\n?/g, '\n').trim().replace(/\n{3,}/g, '\n\n')
    }
    function RequirementSummary({ brief, summary }) {
      const text = (typeof summary === 'string' && summary.trim() ? summary : brief) || ''
      const [expanded, setExpanded] = useState(false)
      const contentId = useRef(null)
      if (!contentId.current) contentId.current = 'fg-requirement-' + (++dialogSeq)
      useEffect(() => { setExpanded(false) }, [text])
      if (!text && !brief) return null
      const long = text.length > 480 || text.split('\n').length > 6
      const preview = long ? text.split('\n').slice(0, 3).join('\n').slice(0, 240).trimEnd() + '…' : text
      return h('div', { className: 'fg-requirement', 'aria-label': '需求内容' },
        h('p', { id: contentId.current, className: 'fg-requirement-text' }, long && !expanded ? preview : text),
        long ? h('div', { className: 'fg-row' }, h(Btn, { tone: 'quiet', expanded, controls: contentId.current,
          onClick: () => setExpanded((value) => !value) }, expanded ? '收起整理稿' : '展开整理稿全文')) : null,
        brief ? h('details', { className: 'fg-requirement-original' }, h('summary', null, '查看需求原文'),
          h('p', { className: 'fg-requirement-text' }, brief)) : null)
    }
    /**
     * 标题与整理稿在点了「开始需求分析」之后才生成：生成和启动是同一次等待，表单里不出现预览。
     * 会话视图用 sessionId、工作区视图用 path 请求整理；宿主不可用或超时才回落。
     */
    // 比宿主端（lib/requirements.js 的 12000ms）多留 3 秒：让宿主先自己收网并给出降级结果，
    // 客户端只兜住彻底没有响应的情况。
    const PREPARE_TIMEOUT_MS = 15000
    async function prepareGenerated(brief, path, sessionId, options) {
      const local = { title: deriveTitle(brief), summary: formatRequirement(brief) }
      if (!path && !sessionId) return { ...local, degraded: 'unavailable' }
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      // 调用方（比如换不到会话）可以提前收网，不必白等一次模型；这种情况必须与真超时区分开。
      const outer = options?.signal
      let cancelled = false
      const relay = outer && controller ? () => { cancelled = true; controller.abort() } : null
      if (relay) { if (outer.aborted) relay(); else outer.addEventListener('abort', relay, { once: true }) }
      const timer = controller ? setTimeout(() => controller.abort(), PREPARE_TIMEOUT_MS) : null
      try {
        const data = await postJson('/hub/prepare', { ...(path ? { path } : { sessionId }), brief }, controller ? { signal: controller.signal } : undefined)
        // 模型可能只给回一半：缺哪个字段就用本地派生的那个，不把空标题交给流程。
        return {
          title: typeof data?.title === 'string' && data.title.trim() ? data.title : local.title,
          summary: typeof data?.summary === 'string' && data.summary.trim() ? data.summary : local.summary,
          degraded: data?.status === 'fallback' ? 'model-fallback' : null,
        }
      } catch (err) {
        // 静默降级是产品行为（绝不打断启动）；原因交给调用方写进诊断日志。
        return { ...local, degraded: cancelled ? 'cancelled' : err?.name === 'AbortError' ? 'timeout' : 'unavailable' }
      } finally {
        if (timer) clearTimeout(timer)
        if (relay) outer.removeEventListener('abort', relay)
      }
    }

    function StartPanel({ sessionId, path, presets, resolveSession, onStarted, compact = false, draft, onDraftChange, blockedReason, onBusyChange, inputRef, externallyBusy = false, startError, onStartError }) {
      // 用户只填需求原文：标题与整理稿在点开始之后才生成，表单里既不保存也不展示。
      const [localDraft, setLocalDraft] = useState({ brief: '', preset: 'fast' })
      const state = { brief: '', preset: 'fast', ...(draft || localDraft) }
      const { brief, preset } = state
      const latest = useRef(state)
      latest.current = state
      const updateDraft = (patch) => {
        const next = { ...latest.current, ...patch }
        latest.current = next
        if (typeof onDraftChange === 'function') onDraftChange(next)
        else setLocalDraft(next)
      }
      const changeBrief = (value) => updateDraft({ brief: value })
      const [localBusy, setBusy] = useState(false)
      const busy = localBusy || externallyBusy
      const sending = useRef(false)
      const [error, setError] = useState(null)
      const keys = Object.keys(presets || {})
      const options = keys.length ? keys : ['fast', 'strict']
      const presetInfo = (key) => presets?.[key] || PRESET_FALLBACK[key] || { label: key, summary: '' }
      const begin = async () => {
        if (sending.current || externallyBusy || blockedReason) return
        const value = latest.current
        if (!value.brief.trim()) { setError('先写一句这次要做什么，再开始流程。'); return }
        if (value.brief.length > 20000) { setError('需求描述最多支持 20000 个字符，请缩短后再开始。'); return }
        sending.current = true; setBusy(true); setError(null)
        onStartError?.(null)
        onBusyChange?.(true)
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        // 这次启动不会发生（换不到会话，或中途抛错）时，把还在飞的整理请求一并收掉，别白占一次模型。
        const cancelPreparing = (pending) => { if (controller) controller.abort(); void pending }
        let preparing = null
        try {
          // 找会话和生成标题与整理稿同时进行：两步互不空等，点击后只等最慢的一步。
          preparing = prepareGenerated(value.brief, path, sessionId, controller ? { signal: controller.signal } : undefined)
          const target = sessionId || (typeof resolveSession === 'function' ? await resolveSession() : '')
          if (!target) {
            cancelPreparing(preparing)
            setError('宿主没有可用的会话，没法在这里启动流程。')
            return
          }
          const generated = await preparing
          if (generated.degraded && generated.degraded !== 'cancelled') {
            // 降级照常启动，但原因要留下：否则「模型为什么没生效」在界面上永远无法诊断。
            console.warn('[dsh-flowgate] 自动生成标题与整理稿回落到原文派生：' + generated.degraded)
          }
          const message = await act(target, 'start', { title: generated.title, preset: value.preset,
            brief: value.brief, ...(generated.summary.trim() ? { summary: generated.summary } : {}) })
          setError(message)
          onStartError?.(message)
          if (!message && typeof onStarted === 'function') onStarted(target)
        } catch (err) {
          if (preparing) cancelPreparing(preparing)
          const message = err?.message ?? String(err)
          setError(message); onStartError?.(message)
        }
        finally { sending.current = false; setBusy(false); onBusyChange?.(false) }
      }
      return h(Card, { title: compact ? null : '开始一次新流程' },
        h('label', { className: 'fg-field' },
          h('span', { className: 'fg-sec-title' }, '需求描述 ', h('span', { className: 'fg-required', 'aria-hidden': true }, '*')),
          h('textarea', { className: 'fg-textarea', rows: 4, required: true, 'aria-required': true, 'aria-label': '需求原文', disabled: busy, ref: inputRef,
            value: brief, placeholder: '描述目标、预期效果或需要解决的问题…', onChange: (event) => changeBrief(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && !event.nativeEvent?.isComposing) { event.preventDefault(); void begin() } } })),
        brief.length > 20000 ? h('div', { className: 'fg-err', role: 'alert' }, '需求描述最多支持 20000 个字符，当前 ' + brief.length + ' 个。原文未被截断。') : null,
        h('div', { className: 'fg-field' }, h('span', { className: 'fg-sec-title' }, '执行档位'),
          h('div', { className: 'fg-preset-options' }, options.map((key) => h('button', { key: 'start-preset-' + key, type: 'button',
            className: 'fg-opt' + (preset === key ? ' rec' : ''), 'aria-pressed': preset === key, disabled: busy, onClick: () => updateDraft({ preset: key }) },
            h('span', { className: 'fg-opt-label' }, h(Icon, { name: key === 'fast' ? 'bolt' : 'shield' }), h('span', null, presetInfo(key).label)), h('span', { className: 'fg-opt-tradeoff' }, presetInfo(key).summary))))),
        blockedReason ? h('div', { className: 'fg-tiny', role: 'status' }, blockedReason) : null,
        h('div', { className: 'fg-row' }, h(Btn, { tone: 'primary', icon: 'arrow', disabled: busy || Boolean(blockedReason) || !brief.trim() || brief.length > 20000, onClick: () => { void begin() } }, busy ? '正在启动…' : '开始需求分析')),
        (error || startError) ? h('div', { className: 'fg-err', role: 'alert' }, error || startError) : null)
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

    /** 门禁停在 S1 需求确认与文档冻结时，要用户点的那个主按钮。 */
    const WAITING_ACTION = {
      answer: '等你回答上面的问题',
      doc: '等你点「批准并冻结 scope」',
    }

    /** 其余三个阶段的出口主按钮，文案与面板里的一字不差。 */
    const GATE_ACTION = {
      S1: '等你点「批准并冻结 scope」',
      S2: '等你点「完成开发」',
      S3: '等你点「通过评审，进入测试」',
      S4: '等你点「验收通过，结束流程」',
    }

    /**
     * 门禁在等什么：宿主给的 waitingKind 最准，取不到时按阶段回退到出口按钮。
     * 两处都没有就只说「等你确认」，不编一个不存在的按钮名。
     */
    function waitingAction(kind, stage, flow) {
      if (kind && WAITING_ACTION[kind]) return WAITING_ACTION[kind]
      if (stage === 'S4') return '等你点「' + finalGateLabel(flow) + '」'
      if (stage === 'S3' && flow?.review?.blocking > 0) return '等你点「带风险进入测试」或「退回开发修复」'
      return GATE_ACTION[stage] || '等你确认后继续'
    }

    /** 会话输入框上方的阶段提示与需求快捷入口；门禁仍在工作台中确认。 */
    // 草稿只留在当前页面内存中，按会话隔离；提交成功才清除。
    const quickDrafts = new Map()
    // 提交锁与草稿一样按会话保存；切走后回来也不能启动第二次。
    const quickStarts = new Map()

    /**
     * dock 上的阶段流转按钮：文案与置灰条件跟工作台门禁同源，点下去投递同一个 act。
     * 只在本会话拿得到完整视图时渲染——跨会话摘要没有 doc / gate 字段，判断不了门禁是否就绪。
     */
    function HintActions({ sessionId, view }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [confirmCancel, setConfirmCancel] = useState(false)
      const [reportOpen, setReportOpen] = useState(null)
      const reportTrigger = useRef(null)
      const reportId = useRef(null)
      if (!reportId.current) reportId.current = 'fg-report-title-' + (++dialogSeq)
      const wasReportOpen = useRef(false)
      useEffect(() => {
        if (!reportOpen && wasReportOpen.current) reportTrigger.current?.focus?.()
        wasReportOpen.current = Boolean(reportOpen)
      }, [reportOpen])
      const closeReport = () => setReportOpen(null)
      // 与 GatePanel 同源：宿主正在等，或门禁产物已交、只差人点。
      const ready = Boolean(view.waiting) || Boolean(view.gate?.pending)
      const run = async (action, payload) => {
        setBusy(true)
        setError(null)
        const failure = await act(sessionId, action, payload)
        if (failure) setError(failure)
        setBusy(false)
      }
      // 与 GatePanel 的 gate() 同源：S4 有例外项时一并提交接受声明。
      const gate = (decision, to) => {
        const payload = { decision, to }
        if (decision === 'pass' && view.stage === 'S4' && finalGateLabel(view) !== '验收通过，结束流程') payload.acceptUncovered = true
        if (decision === 'accept-risk') payload.reviewId = view.review?.id
        return run('gate', payload)
      }
      const item = (key, label, tone, disabled, onClick) => h('button', {
        key,
        type: 'button',
        className: 'fg-hint-btn' + (tone ? ' fg-hint-btn-' + tone : ''),
        disabled,
        onClick,
      }, label)
      const gated = (key, label, tone, onClick) => item(key, label, tone, busy || !ready, onClick)
      const overflow = Array.isArray(view.reviewOutsideScope) ? view.reviewOutsideScope : []
      const reviewBlocked = view.stage === 'S3' && view.review?.blocking > 0
      const actions = []
      if (view.stage === 'S1') {
        // 文档没交或已裁决时工作台也不给按钮，这里保持一致。
        if (view.doc?.pending) {
          actions.push(item('doc-approve', '批准并冻结 scope', 'primary', busy, () => run('doc', { decision: 'approve' })))
          actions.push(item('doc-revise', '修改需求', null, busy, () => run('doc', { decision: 'revise' })))
          actions.push(item('doc-skip', '跳过评审，直接开发', null, busy, () => run('doc', { decision: 'skip' })))
        }
      } else if (view.stage === 'S2') {
        actions.push(gated('gate-pass', '完成开发', 'primary', () => gate('pass')))
        actions.push(gated('gate-skip', '跳过门禁，直接评审', null, () => gate('skip')))
        actions.push(gated('gate-scope', '回到需求分析调整 scope', 'danger', () => gate('back', 'S1')))
      } else if (view.stage === 'S3') {
        actions.push(reviewBlocked
          ? gated('gate-risk', '带风险进入测试', 'primary', () => gate('accept-risk'))
          : gated('gate-pass', '通过评审，进入测试', 'primary', () => gate('pass')))
        // 有发现落在冻结 scope 之外时，退回开发也改不到，要先调 scope——说明与顺序都照工作台。
        if (overflow.length) actions.push(h('div', { key: 'scope-note', className: 'fg-hint-note' }, '评审有 ' + overflow.length + ' 条发现落在冻结 scope 之外：退回开发修复也改不到它们，要先调 scope。'))
        actions.push(gated('gate-back', '退回开发修复', null, () => gate('back', 'S2')))
        actions.push(h('details', { key: 'gate-more', className: 'fg-hint-more' },
          h('summary', null, '更多操作'),
          h('div', { className: 'fg-list' },
            gated('gate-scope', '回到需求分析调整 scope', 'danger', () => gate('back', 'S1')),
            reviewBlocked ? null : gated('gate-skip', '跳过评审，直接测试', null, () => gate('skip')),
            confirmCancel
              ? h(react.Fragment, null,
                  item('cancel-yes', '确认放弃', 'danger', busy, () => run('cancel', { reason: '用户在工作台放弃这次流程' })),
                  item('cancel-no', '再想想', null, busy, () => setConfirmCancel(false)))
              : item('cancel-ask', '放弃这次流程', 'danger', busy, () => setConfirmCancel(true)))))
      } else {
        // 兜底交给最后一档：工作台在 stage 认不出来时也落到这里，两边给出的按钮要一致。
        actions.push(gated('gate-pass', finalGateLabel(view), 'primary', () => gate('pass')))
        actions.push(gated('gate-back', '退回开发修复', null, () => gate('back', 'S2')))
        actions.push(gated('gate-skip', '跳过测试门禁', null, () => gate('skip')))
      }
      // 随时可以放弃：不必等门禁就绪，也不受阶段限制。
      if (view.stage !== 'S3') {
        if (confirmCancel) {
          actions.push(item('cancel-yes', '确认放弃', 'danger', busy, () => run('cancel', { reason: '用户在工作台放弃这次流程' })))
          actions.push(item('cancel-no', '再想想', null, busy, () => setConfirmCancel(false)))
        } else {
          actions.push(item('cancel-ask', '放弃这次流程', 'danger', busy, () => setConfirmCancel(true)))
        }
      }
      const findings = (view.review?.angles || []).flatMap((angle) => angle?.findings || [])
      const blocking = findings.filter((finding) => finding?.blocking === true)
      const advisories = findings.filter((finding) => finding?.blocking !== true)
      const points = (view.test?.directions || []).flatMap((direction) => (direction?.points || []).map((point) => ({ ...point, direction: direction?.name })))
      const groups = [
        ['fail', '未通过', 'bad'], ['uncovered', '未覆盖', 'warn'], ['excluded', '环境受限', ''],
      ]
      const entries = []
      const entry = (key, text) => h('button', { key, type: 'button', className: 'fg-hint-btn', 'aria-haspopup': 'dialog',
        'aria-expanded': reportOpen === key, onClick: (event) => { reportTrigger.current = event.currentTarget; setReportOpen(key) } }, text)
      if (view.doc?.html) entries.push(entry('doc', '需求文档'))
      if (view.review) entries.push(entry('review', '评审结果 · ' + (view.review.counts?.blocking ?? blocking.length) + ' 阻塞 / ' + (view.review.counts?.advisories ?? advisories.length) + ' 建议'))
      if (view.test) entries.push(entry('test', '测试结果 · ' + points.filter((point) => point.result === 'fail').length + ' 失败 / ' + points.filter((point) => point.result === 'uncovered').length + ' 未覆盖 / ' + points.filter((point) => point.result === 'excluded').length + ' 受限'))
      const message = actions.filter((node) => node?.props?.className === 'fg-hint-note')
      if (error) message.push(h('span', { key: 'error', className: 'fg-hint-err', role: 'alert' }, error))
      const acIssues = (view.acceptance?.items || []).filter((item) => item.status === 'fail' || item.status === 'uncovered')
      const findingRow = (finding, index) => h('div', { key: 'f-' + index, className: 'fg-item' },
        h(Badge, { tone: SEV_TONE[finding.severity] || '' }, finding.severity || 'MINOR'),
        h('span', null, (finding.file || '') + (finding.line ? ':' + finding.line : '') + ' · ' + (finding.summary || '')),
        finding.ac ? h(Badge, { tone: 'info' }, finding.ac) : null)
      const reportTitle = { doc: '需求文档', review: '评审未通过与建议', test: '测试未通过与未覆盖' }[reportOpen]
      return h(react.Fragment, null,
        h('div', { className: 'fg-hint-actions', role: 'group', 'aria-label': '阶段流转操作' },
          entries.concat(actions.filter((node) => node?.props?.className !== 'fg-hint-note'))),
        message.length ? h('div', { className: 'fg-hint-message' }, message) : null,
        reportOpen && reportTitle ? h('div', { className: 'fg-root fg-quick-shell', ref: styleRoot },
          h(Modal, { labelledBy: reportId.current, onClose: closeReport, topLayer: true },
            h('div', { className: 'fg-modal-head' },
              h('h2', { id: reportId.current, className: 'fg-card-title' }, reportTitle),
              h(Btn, { 'aria-label': '关闭' + reportTitle, onClick: closeReport }, '关闭')),
            h('div', { className: 'fg-quick-report' },
              reportOpen === 'doc' ? h('div', { className: 'fg-doc' },
                h('iframe', { title: '需求文档预览', sandbox: '', srcDoc: view.doc.html })) : null,
              reportOpen === 'review' ? h(react.Fragment, null,
                h('h3', null, '阻塞项 · ' + (view.review.counts?.blocking ?? blocking.length)),
                blocking.length ? blocking.map(findingRow) : h('p', null, '没有阻塞项'),
                h('h3', null, '建议项 · ' + (view.review.counts?.advisories ?? advisories.length)),
                advisories.length ? advisories.map(findingRow) : h('p', null, '没有建议项'),
                view.review.angles?.some((angle) => angle.omittedCounts?.total > 0)
                  ? h('p', { className: 'fg-tiny' }, '还有超出保存上限的发现，请在工作台查看完整统计。') : null) : null,
              reportOpen === 'test' ? h(react.Fragment, null,
                groups.map(([result, label, tone]) => {
                  const selected = points.filter((point) => point.result === result)
                  const ac = result === 'excluded' ? [] : acIssues.filter((item) => item.status === result)
                  return h('section', { key: result }, h('h3', null, label + ' · ' + (selected.length + ac.length)),
                    selected.length || ac.length ? h(react.Fragment, null,
                      selected.map((point, index) => h('div', { key: 'point-' + index, className: 'fg-item' },
                        h(Badge, { tone }, label), h('span', null, (point.direction ? point.direction + ' · ' : '') + (point.point || '')),
                        point.detail ? h('span', null, point.detail) : null,
                        point.excludeReason ? h('span', null, '环境限制：' + point.excludeReason) : null)),
                      ac.map((item, index) => h('div', { key: 'ac-' + index, className: 'fg-item' },
                        h(Badge, { tone }, item.id || '验收标准'), h('span', null, item.reason || item.evidence || item.then || '未提供说明'))))
                      : h('p', null, '没有' + label + '项'))
                })) : null))) : null)
    }

    function StageHint(props) {
      const sessionId = props?.session?.sessionId || props?.sessionId || null
      return sessionId ? h(SessionStageHint, { key: sessionId, sessionId }) : null
    }

    function SessionStageHint({ sessionId }) {
      const entry = useEntry(sessionId)
      const view = entry?.view
      const [open, setOpen] = useState(false)
      const draft = quickDrafts.get(sessionId) || { brief: '', preset: 'fast' }
      const operation = quickStarts.get(sessionId) || { busy: false, completed: 0 }
      const busy = operation.busy
      const completed = useRef(operation.completed)
      const wasOpen = useRef(false)
      const triggerRef = useRef(null)
      const inputRef = useRef(null)
      const titleId = useRef(null)
      if (!titleId.current) titleId.current = 'fg-quick-title-' + (++dialogSeq)
      useEffect(() => {
        if (!open && wasOpen.current) triggerRef.current?.focus()
        wasOpen.current = open
      }, [open])
      useEffect(() => {
        if (completed.current !== operation.completed) {
          completed.current = operation.completed
          setOpen(false)
        }
      }, [operation.completed])
      const close = () => {
        if (quickStarts.get(sessionId)?.busy) return
        setOpen(false)
      }
      const started = () => {
        quickDrafts.delete(sessionId)
        const previous = quickStarts.get(sessionId) || { busy: false, completed: 0 }
        quickStarts.set(sessionId, { ...previous, completed: previous.completed + 1 })
        emit(sessionId)
        setOpen(false)
      }
      // 工作区摘要可能指向本会话；核对归属后才用完整视图渲染操作。
      const hasWorkspace = Object.prototype.hasOwnProperty.call(view || {}, 'workspace')
      const summaryFlow = hasWorkspace ? view.workspace?.flow : null
      const liveFlow = Boolean(view?.active && !view.finished && !view.cancelled) &&
        (!hasWorkspace || (typeof summaryFlow?.sessionId === 'string' && summaryFlow.sessionId === sessionId))
      const flow = liveFlow ? view : summaryFlow
      const blockedReason = flow
        ? '该工作区已有流程在进行，请先结束或放弃它，再启动新流程。你可以先在这里填写需求草稿。'
        : entry?.error ? '暂时无法确认流程状态，请稍后重试：' + entry.error
          : !view ? '正在读取流程状态，请稍后再提交。'
            : hasWorkspace && (!view.workspace || !Object.prototype.hasOwnProperty.call(view.workspace, 'flow'))
              ? '暂时无法确认工作区流程状态，请稍后重试。' : ''
      const progress = liveFlow ? flow?.progress || null : flow
      const raw = progress ? progress.stageIndex : ['S1', 'S2', 'S3', 'S4'].indexOf(flow?.stage)
      const index = Math.max(0, Math.min(3, Number(raw) || 0))
      const label = (progress && progress.label) || (liveFlow && flow?.stages?.[index]?.label) || ''
      const waiting = Boolean(flow?.waiting)
      const activity = flow?.activity?.text
      const todo = waiting
        ? waitingAction(flow.waitingKind, flow.stage, flow)
        : activity ? '正在' + activity : '等待 Agent 下一步'
      return h(react.Fragment, null,
        h('div', {
          className: 'fg-hint' + (waiting ? ' is-waiting' : ''),
          'data-fg-session-id': flow?.sessionId || sessionId,
          ref: styleRoot,
          'aria-label': '流程阶段提示',
        },
          h('div', { className: 'fg-hint-content' },
            h('div', { className: 'fg-hint-head' },
              // 时长随轮询更新，不反复播报。
              flow && Number(flow.elapsedMs) > 0
                ? h('span', { className: 'fg-hint-elapsed', 'aria-hidden': 'true' }, '已用 ' + elapsedText(flow.elapsedMs))
                : null,
              flow ? h('span', { className: 'fg-hint-title', title: flow.title || '未命名需求' }, flow.title || '未命名需求') : null),
            h('div', { className: 'fg-hint-info', role: 'status', 'aria-live': 'polite' },
              flow ? h(react.Fragment, null,
                h('span', { className: 'fg-hint-stage' },
                  h(Icon, { name: ['spark', 'bolt', 'shield', 'check'][index] }),
                  label ? 'S' + (index + 1) + ' ' + label : 'S' + (index + 1)),
                h('span', { className: 'fg-hint-todo' }, todo),
                waiting ? h('span', { className: 'fg-hint-why' }, '在左侧栏「流程工作台」确认后才继续') : null)
                : h('span', { className: 'fg-hint-todo' }, '从需求分析开始新流程'))),
          // 流程已经开跑：启动入口必须消失，dock 上只留这条流程自己的流转按钮。
          // 跨会话摘要（有 workspace 但没有 doc / gate）既开不了新流程、也判不了门禁就绪，那里不给按钮。
          liveFlow
            ? h(HintActions, { sessionId, view })
            : flow
              ? null
              : h('button', { type: 'button', className: 'fg-hint-start', ref: triggerRef, 'aria-haspopup': 'dialog', 'aria-expanded': open,
                onClick: () => setOpen(true) }, '开始需求分析')),
        open ? h('div', { className: 'fg-root fg-quick-shell', ref: styleRoot, 'data-fg-session-id': sessionId },
          h(Modal, { labelledBy: titleId.current, onClose: close, initialFocusRef: inputRef, topLayer: true },
            h('div', { className: 'fg-modal-head' },
              h('div', { className: 'fg-modal-heading' },
                h('h2', { id: titleId.current, className: 'fg-card-title' }, '开始需求分析'),
                h('span', { className: 'fg-tiny' }, '填写本次需求，Ctrl / ⌘ + Enter 快捷提交。关闭后保留草稿。')),
              h(Btn, { disabled: busy, 'aria-label': '关闭需求输入', onClick: close }, '关闭')),
            h('div', { className: 'fg-quick-content' },
              h(StartPanel, { sessionId, presets: view?.presets, compact: true, draft, blockedReason, inputRef, externallyBusy: busy,
                startError: operation.error,
                onStartError: (error) => {
                  const previous = quickStarts.get(sessionId) || { busy: false, completed: 0 }
                  quickStarts.set(sessionId, { ...previous, error }); emit(sessionId)
                },
                onDraftChange: (next) => { quickDrafts.set(sessionId, next); emit(sessionId) },
                onBusyChange: (value) => {
                  const previous = quickStarts.get(sessionId) || { completed: 0 }
                  quickStarts.set(sessionId, { ...previous, busy: value }); emit(sessionId)
                }, onStarted: started })))) : null)
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

      const main = [h(SummaryCard, { key: 'summary', view }), h(RemediationCard, { key: 'remediation', view }), h(AcceptanceCard, { key: 'acceptance', view })]
      if (view.stage === 'S1') {
        if (view.grill?.pending) {
          main.push(h(GrillCard, { key: 'grill', sessionId, pending: view.grill.pending }))
          if (view.grill.answeredCount) {
            main.push(h('div', { key: 'grill-count', className: 'fg-tiny' }, '已回答 ' + view.grill.answeredCount + ' 个决策问题'))
          }
        } else if (view.doc?.html) {
          main.push(h(DocCard, { key: 'doc', sessionId, view }))
          // 批准按钮和这份清单必须同屏：看不到要放行哪些文件就是盲签。
          if (view.doc?.pending) {
            main.push(h(ScopeBlock, {
              key: 'pending-scope',
              scope: { ...(view.doc?.pendingScope || {}), droppedScopeEntries: view.doc?.droppedScopeEntries || [] },
              pending: true,
            }))
          }
        }
        else main.push(h(Card, { key: 'wait', title: ['需求分析', h(Badge, { key: 'w', tone: 'info' }, 'S1')] },
          h(Empty, null, view.doc?.revisedAt
            ? '你点了「修改需求」。补齐未决项后，Agent 会重新提交需求文档供你批准。'
            : 'Agent 正在分析需求…'),
          view.grill?.answeredCount ? h('div', { className: 'fg-tiny' }, '已回答 ' + view.grill.answeredCount + ' 个决策问题') : null))
      } else if (view.stage === 'S2') {
        main.push(h(DevCard, { key: 'dev', sessionId, view }))
        main.push(h(RuleCard, { key: 'rules', view }))
        main.push(h(ScopeBlock, { key: 'scope', scope: view.scope }))
      } else if (view.stage === 'S3') {
        main.push(h(ReviewCard, { key: 'review', view }))
        main.push(h(ScopeBlock, { key: 'scope', scope: view.scope }))
      } else if (view.stage === 'S4') {
        main.push(h(TestCard, { key: 'test', view }))
        // 跑测试命令本身是写盘操作，默认被只读白名单挡住；授权入口要和测试阶段同屏。
        main.push(h(Card, { key: 'grant', title: ['测试命令', h(Badge, { key: 'g', tone: 'info' }, 'S4 测试')] },
          h(ShellGrantToggle, { key: 'grant-toggle', sessionId, view }),
          h('div', { className: 'fg-tiny' }, '测试子代理的写权限单独由每个测试方向的「写权限例外」控制，与这里无关。')))
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
        // 落盘失败会让冷恢复退回旧快照：状态看起来正常、实际没存下来，必须显式提示。
        view.persistError
          ? h('div', { key: 'persist-error', className: 'fg-banner' },
              h('div', { className: 'fg-err', role: 'alert' },
                '状态写盘失败：' + (view.persistError.message || '未知原因') + '。当前进度只存在内存里，重启 DSH 会退回上一次成功保存的状态。'))
          : null,
        h(StageNav, { view }),
        h('main', { className: 'fg-main', 'aria-label': '当前阶段内容' },
          h('div', { className: 'fg-content' },
            h('section', { className: 'fg-flow-requirement', 'aria-label': '流程需求' }, h('h2', null, view.title || '未命名需求'),
              h(RequirementSummary, { brief: view.brief, summary: view.summary })),
            h(StageIntro, { view, stages, currentIndex }), main)),
        h('aside', { className: 'fg-hub-side', 'aria-label': '阶段操作' },
          h(GatePanel, { sessionId, view }),
          h(SettingsPanel, { sessionId, view })))
    }

    // -----------------------------------------------------------------------
    // 左侧栏全局面板：先选工作区，再看这个工作区的流程
    // -----------------------------------------------------------------------

    /** 面板根节点：不复用会话视图的滚动契约（那套只对 conversation 生效）。 */
    const HUB_ROOT_PROPS = { className: 'fg-root fg-hub', ref: styleRoot }

    function HubWorkspaceTab(props) {
      return h('button', {
        type: 'button',
        className: 'fg-ws-row',
        onClick: props.onClick,
        title: props.path,
      },
        h('span', { className: 'fg-ws-symbol' }, h(Icon, { name: 'folder' })),
        h('span', { className: 'fg-ws-arrow' }, h(Icon, { name: 'arrow' })),
        h('span', { className: 'fg-ws-name' }, props.name),
        h('span', { className: 'fg-ws-path' }, props.path),
        h('span', { className: 'fg-tiny' }, props.hint || '进入工作区'))
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
        title: flow.summary || flow.brief || flow.title,
      },
        h('span', { className: 'fg-flow-row-main' },
          h('span', { className: 'fg-flow-title' }, flow.title || '未命名需求'),
          (flow.summary?.trim() || flow.brief) ? h('span', { className: 'fg-flow-summary' }, flow.summary?.trim() ? flow.summary : flow.brief) : null,
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
    const RULE_STAGES = [
      { id: 'S1', label: '需求分析' }, { id: 'S2', label: '开发规则' },
      { id: 'S3', label: '评审角度' }, { id: 'S4', label: '测试方向' },
    ]
    const copyEntries = (entries = []) => entries.map((entry) => ({ ...entry, points: [...(entry.points || [])] }))
    // 老宿主仍可读取 S2；新宿主返回完整的四阶段目录与原始内置项。
    function workspaceStages(rules) {
      return Object.fromEntries(RULE_STAGES.map(({ id, label }) => {
        const legacy = id === 'S2' ? rules : null
        const value = rules?.stages?.[id] || legacy || {}
        const custom = value.custom || []
        const builtin = value.builtin || (value.catalog || []).filter((entry) => !custom.some((item) => item.id === entry.id))
        const ids = value.ids || builtin.map((entry) => entry.id)
        return [id, { label, ...value, builtin, custom, edits: value.edits || [], ids,
          selection: Object.hasOwn(value, 'selection') ? value.selection : value.configured ? ids : null,
          defaults: value.defaults || { fast: builtin.map((entry) => entry.id), strict: builtin.map((entry) => entry.id) } }]
      }))
    }
    function WorkspaceRulesCard({ path, missing, revision, onSaved }) {
      const [rules, setRules] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [draft, setDraft] = useState(null)
      const [group, setGroup] = useState('S1')
      const [previewPreset, setPreviewPreset] = useState('fast')
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
      const stages = workspaceStages(rules)
      const close = () => {
        if (sending.current) return
        setDraft(null); setForm(null); setError(null)
        trigger.current?.focus?.()
      }
      const open = (event) => {
        trigger.current = event?.currentTarget
        setDraft(Object.fromEntries(RULE_STAGES.map(({ id }) => [id, stages[id].configured
          ? { ids: stages[id].selection === null ? null : [...stages[id].selection], custom: copyEntries(stages[id].custom), edits: copyEntries(stages[id].edits) }
          : null])))
        setGroup('S1'); setPreviewPreset('fast'); setForm(null); setError(null)
      }
      const cfg = draft?.[group] || { ids: null, custom: [], edits: [] }
      const builtin = stages[group].builtin
      const selected = cfg.ids === null ? stages[group].defaults[previewPreset] || [] : cfg.ids
      const catalog = builtin.map((entry) => cfg.edits.find((edit) => edit.id === entry.id) || entry).concat(cfg.custom)
      const update = (patch) => setDraft((value) => ({ ...value, [group]: { ...cfg, ...patch } }))
      const addRule = () => {
        if (!form?.name.trim()) return
        const id = form.id || 'workspace-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2))
        const rule = { id, name: form.name.trim(), points: form.points.split('\n').map((point) => point.trim()).filter(Boolean) }
        if (group === 'S4' && form.needsWrite) rule.needsWrite = true
        const field = builtin.some((entry) => entry.id === id) ? 'edits' : 'custom'
        update({ [field]: cfg[field].filter((entry) => entry.id !== id).concat([rule]), ids: form.id ? cfg.ids : [...selected, id] })
        setForm(null)
      }
      const save = async () => {
        if (sending.current || !draft || form) return
        sending.current = true; setBusy(true); setError(null)
        try {
          const data = await postJson('/hub/rules', { path, stages: draft })
          setRules(data.rules); setDraft(null); setForm(null)
          onSaved?.(); trigger.current?.focus?.()
        } catch (err) { setError(err?.message ?? String(err)) }
        finally { sending.current = false; setBusy(false) }
      }
      return h('section', { className: 'fg-hub-section fg-workspace-card fg-workspace-rules', 'aria-label': '工作区规则' },
        h('div', { className: 'fg-section-head' },
          h('div', null, h('h2', null, h(Icon, { name: 'settings' }), '工作区规则'), h('div', { className: 'fg-tiny' }, missing ? '目录不可用' : loading ? '正在读取…' : rules ? '新流程按阶段继承；本次调整优先。' : '规则读取失败')),
          h(Btn, { disabled: missing || loading || !rules, onClick: open }, '编辑规则')),
        rules ? h('div', { className: 'fg-stage-rule-summary' }, RULE_STAGES.map(({ id, label }) => {
          const stage = stages[id]
          const fast = stage.defaults.fast.length, strict = stage.defaults.strict.length
          const count = stage.selection === null ? '随档位 · ' + (fast === strict ? fast + ' 条' : '快速 ' + fast + ' / 严格 ' + strict + ' 条') : stage.ids.length + ' 条'
          return h('div', { className: 'fg-section-head', key: id }, h('span', null, id + ' · ' + label),
            h('span', { className: 'fg-tiny' }, (stage.configured ? '工作区默认' : '内置默认') + ' · ' + count))
        })) : null,
        error && !draft ? h('div', { className: 'fg-err', role: 'alert' }, error) : null,
        draft ? h(Modal, { labelledBy: titleId.current, onClose: close },
          h('div', { className: 'fg-modal-head' },
            h('div', { className: 'fg-modal-heading' }, h('h2', { id: titleId.current, className: 'fg-card-title' }, '工作区规则'),
              h('div', { className: 'fg-tiny' }, '四阶段改动统一保存，取消会丢弃全部未保存改动。')),
            h(Btn, { disabled: busy, onClick: close, title: '关闭工作区规则' }, '关闭')),
          h('div', { className: 'fg-modal-body' },
            h('nav', { className: 'fg-modal-nav', 'aria-label': '工作区规则分组' }, RULE_STAGES.map(({ id, label }) => h('button', {
              key: id, type: 'button', className: 'fg-modal-tab' + (group === id ? ' on' : ''), 'aria-current': group === id ? 'true' : undefined,
              disabled: busy || Boolean(form), onClick: () => setGroup(id),
            }, id + ' · ' + label))),
            h('div', { className: 'fg-modal-pane fg-workspace-rule-body' },
              error ? h('div', { className: 'fg-err', role: 'alert' }, error) : null,
              h('div', { className: 'fg-section-head' }, h('h3', null, group + ' · ' + stages[group].label),
                h('label', { className: 'fg-rule-preset' }, '预览档位 ', h('select', { className: 'fg-input', value: previewPreset, disabled: busy || Boolean(form), onChange: (event) => setPreviewPreset(event.target.value) },
                  h('option', { value: 'fast' }, '快速'), h('option', { value: 'strict' }, '严格')))),
              h('div', { className: 'fg-tiny' }, draft[group] === null ? '内置默认 · 按执行档位启用。' : cfg.ids === null ? '工作区内容自定义 · 启用项跟随执行档位。' : '工作区默认 · 已固定本阶段启用项。'),
              h('div', { className: 'fg-section-head' }, h('span', { className: 'fg-sec-title' }, '已启用 ' + selected.length + ' / ' + catalog.length),
                h(Btn, { disabled: busy || Boolean(form), onClick: () => setForm({ name: '', points: '', needsWrite: false }) }, h(Icon, { name: 'plus' }), '添加规则')),
              form ? h('div', { className: 'fg-list fg-form fg-modal-form' },
                h('label', { className: 'fg-field' }, h('span', { className: 'fg-sec-title' }, '规则名称 ', h('span', { className: 'fg-required', 'aria-hidden': true }, '*')),
                  h('input', { className: 'fg-input', required: true, disabled: busy, placeholder: '规则名称', value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }) })),
                h('label', { className: 'fg-field' }, h('span', { className: 'fg-sec-title' }, '检查要点'),
                  h('textarea', { className: 'fg-textarea', disabled: busy, placeholder: '检查要点，每行一条', value: form.points, onChange: (event) => setForm({ ...form, points: event.target.value }) })),
                group === 'S4' ? h('label', { className: 'fg-check' }, h('input', { type: 'checkbox', disabled: busy, checked: Boolean(form.needsWrite), onChange: (event) => setForm({ ...form, needsWrite: event.target.checked }) }),
                  h('span', null, '此方向需要写权限（仍需在 S4 单独授权）')) : null,
                h('div', { className: 'fg-row' }, h(Btn, { disabled: busy || !form.name.trim(), onClick: addRule }, form.id ? '更新规则' : '加入列表'),
                  h(Btn, { disabled: busy, onClick: () => setForm(null) }, '取消编辑'))) : null,
              h('div', { className: 'fg-modal-list' }, catalog.map((rule) => {
                const original = builtin.find((entry) => entry.id === rule.id)
                const edited = cfg.edits.some((entry) => entry.id === rule.id)
                return h('div', { className: 'fg-workspace-rule-item', key: rule.id },
                  h('div', { className: 'fg-workspace-rule-row' },
                    h('label', { className: 'fg-check' }, h('input', { type: 'checkbox', disabled: busy || Boolean(form), checked: selected.includes(rule.id),
                      onChange: (event) => update({ ids: event.target.checked ? [...selected, rule.id] : selected.filter((id) => id !== rule.id) }) }),
                      h('span', null, h('div', null, rule.name), h(Badge, { tone: edited ? 'info' : undefined }, original ? edited ? '已自定义内置' : '内置' : '新增自定义'),
                        rule.points?.length ? h('div', { className: 'fg-tiny' }, rule.points.join(' · ')) : null,
                        rule.needsWrite ? h('div', { className: 'fg-tiny' }, '需要在 S4 单独授权') : null)),
                    h('div', { className: 'fg-row' },
                      h(Btn, { tone: 'quiet', disabled: busy || Boolean(form), 'aria-label': '编辑规则：' + rule.name, onClick: () => setForm({ ...rule, points: rule.points.join('\n') }) }, '编辑'),
                      original ? edited ? h(Btn, { tone: 'quiet', disabled: busy || Boolean(form), 'aria-label': '恢复内置规则：' + rule.name,
                        onClick: () => update({ edits: cfg.edits.filter((entry) => entry.id !== rule.id) }) }, '恢复内置') : null
                      : h(Btn, { tone: 'quiet', disabled: busy || Boolean(form), 'aria-label': '移除规则：' + rule.name,
                        onClick: () => update({ ids: selected.filter((id) => id !== rule.id), custom: cfg.custom.filter((entry) => entry.id !== rule.id) }) }, '移除'))),
                  original ? h('details', { className: 'fg-rule-original' }, h('summary', null, '查看内置原文'), h('div', null, original.name),
                    h('ul', null, original.points.map((point, index) => h('li', { key: index }, point)))) : null)
              })))),
          h('div', { className: 'fg-workspace-rule-footer' },
            h('div', { className: 'fg-row' }, h(Btn, { disabled: busy || Boolean(form), onClick: () => setDraft((value) => ({ ...value, [group]: null })) }, '恢复本阶段内置默认'),
              h(Btn, { disabled: busy || Boolean(form) || cfg.ids === null, onClick: () => update({ ids: null }) }, '启用项跟随档位')),
            h('div', { className: 'fg-row' }, h(Btn, { disabled: busy, onClick: close }, '取消'),
              h(Btn, { tone: 'primary', disabled: busy || Boolean(form), onClick: () => { void save() } }, busy ? '保存中…' : '保存规则')))) : null)
    }

    // 工作台的页面记忆：切到别的会话再点进来，要回到上次停留的页面而不是首页。
    // 只存界面偏好（哪个工作区、哪条流程、第几页），不跟着流程快照走；存储不可用时静默失效。
    const HUB_MEMORY_KEY = 'dsh-flowgate.hub.memory.v1'

    function hubMemoryStore() {
      try {
        const store = globalThis.localStorage ?? globalThis.window?.localStorage
        return store && typeof store.getItem === 'function' && typeof store.setItem === 'function' ? store : null
      } catch {
        // 隐私模式或被策略禁用时访问 localStorage 会抛：当作没有记忆，不影响工作台。
        return null
      }
    }

    function readHubMemory() {
      const store = hubMemoryStore()
      if (!store) return null
      try {
        const raw = store.getItem(HUB_MEMORY_KEY)
        if (!raw) return null
        const value = JSON.parse(raw)
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null
        return {
          workspace: typeof value.workspace === 'string' && value.workspace ? value.workspace : null,
          sessionId: typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : null,
          page: Number.isSafeInteger(value.page) && value.page > 0 ? value.page : 1,
        }
      } catch {
        // 存的是旧版本或被手改过的内容：当作没有记忆，下一次写回会覆盖掉。
        return null
      }
    }

    function writeHubMemory(next) {
      const store = hubMemoryStore()
      if (!store) return
      try {
        store.setItem(HUB_MEMORY_KEY, JSON.stringify(next))
      } catch {
        // 配额满或被禁用：记忆失效不影响工作台本身。
      }
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
      // 只在挂载时读一次记忆：之后一律以组件状态为准，别的窗口改写时不会来回跳。
      const [memory] = useState(() => readHubMemory())
      // 记目录而不是 workspaceId：目录才是读盘入参，也不怕工作区被删了重建。
      const [selected, setSelected] = useState(() => memory?.workspace ?? null)
      const [opened, setOpened] = useState(null)
      const [page, setPage] = useState({ path: memory?.workspace ?? null, number: memory?.page ?? 1 })
      // 详情要等流程数据到位才能重建：先记住待恢复的 sessionId，命中或放弃后置空。
      const pendingDetail = useRef(memory?.sessionId ?? null)
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

      // 记忆里的工作区可能已经被移除或不在名单里：回退到首页，别一进来就是「目录不可用」。
      useEffect(() => {
        if (loading || !selected) return
        if (members.some((item) => item.path === selected)) return
        setSelected(null)
        setOpened(null)
      }, [loading, members, selected])

      // 记忆里的详情：等这个工作区的流程数据到位后按 sessionId 找回来。
      // 找不到（流程被删或不在当前页）就停在列表页，不报错也不清空工作区。
      useEffect(() => {
        const pending = pendingDetail.current
        if (!pending) return
        if (!selected || missingSelected) {
          pendingDetail.current = null
          return
        }
        if (!pageData || pageData.path !== selected) return
        pendingDetail.current = null
        const pool = [pageData.currentFlow].concat(Array.isArray(pageData.flows) ? pageData.flows : []).filter(Boolean)
        const hit = pool.find((flow) => flow.sessionId === pending)
        if (hit) setOpened({ ...hit, workspace: selected })
      }, [pageData, selected, missingSelected])

      // 停留页面一变就记一次；详情还在等数据时先不写，否则会把要恢复的 sessionId 冲掉。
      useEffect(() => {
        if (pendingDetail.current && selected && !opened) return
        writeHubMemory({
          workspace: selected || null,
          sessionId: opened?.sessionId || null,
          page: selected && page.path === selected ? page.number : 1,
        })
      }, [selected, opened, page])

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
            h('span', { className: 'fg-brand-mark' }, h(Icon, { name: 'workbench' })),
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
                    h(Btn, { tone: 'primary', icon: 'plus', disabled: Boolean(busyPath) || picking || !hubActions, onClick: () => { void pick() } },
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
        h('span', { className: 'fg-brand-mark' }, h(Icon, { name: 'folder' })),
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
          h(Btn, { tone: 'quiet', icon: 'back', onClick: () => { setSelected(null); setOpened(null); setError(null); setNotice(null) } }, '工作区列表'),
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
          h('h2', null, h(Icon, { name: 'history' }), '流程记录'), h(Badge, null, total + ' 条')),
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
        h('div', { className: 'fg-section-head' }, h('h2', null, h(Icon, { name: 'spark' }), '开始新流程')),
        h('p', { className: 'fg-muted' }, '写下这次要完成的需求，从需求分析开始。'),
        h(StartPanel, {
          path: selected,
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
            h('h2', null, h(Icon, { name: 'bolt' }), '当前流程'),
            h(Badge, { tone: currentFlow.waiting ? 'warn' : 'info' }, currentFlow.waiting ? '等你确认' : '进行中')),
          h('h3', null, currentFlow.title || '未命名需求'),
          h('div', { className: 'fg-tiny' }, currentFlow.stage + ' · ' + currentFlow.stageLabel),
          h(RequirementSummary, { brief: currentFlow.brief, summary: currentFlow.summary }),
          h('div', { className: 'fg-row' }, h(Btn, {
            tone: 'primary', icon: 'arrow',
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
          h('h2', null, '流程详情'),
          h('div', { className: 'fg-hub-pick-row' },
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
      return h(Icon, { name: 'workbench', size })
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
      // 会话输入框卡片上方的阶段提示与快捷入口。与任务条(0)、目标条(10)、排队消息(20)
      // 同一个座位，order 30 让提示排在这些条目之后、最靠近输入框。
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: PANEL_ID + '-stage-hint',
        order: 30,
      }, StageHint));
    }

    exports.name = 'dsh-flowgate'
    exports.inject = ['slots']
    exports.apply = apply
    // 面板里的流程详情是被 HubPanel 当普通组件内嵌的，没有独立插槽可供外部取用；
    // 一并导出来，单测才能直接渲染它（面板入口要点两次才到得了）。
    exports.components = { FlowDetail }
    // 单测按生产值设定时钟，而不是在用例里硬写一个魔法毫秒数。
    exports.constants = { prepareTimeoutMs: PREPARE_TIMEOUT_MS }
    return module.exports
}
/* flowgate-factory:end */
window.__ModuleLoader__.load({ id: 'dsh-flowgate', factory: flowgateFactory })
