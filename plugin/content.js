// 划词翻译内容脚本：监听 Ctrl+框选，在选中内容下方弹出翻译气泡
// 气泡使用 closed Shadow DOM，隔离页面样式，避免被目标网站 CSS 污染

(() => {
  const HAS_LETTER = /[a-zA-Z]/;
  const URL_LIKE = /^(https?:\/\/|www\.)\S+$/i;
  const INPUT_HOST =
    'input, textarea, [contenteditable=""], [contenteditable="true"]';

  let host = null; // 气泡外层容器（挂在 documentElement 上）
  let ui = null; // { badge, src, dst } 元素引用

  // ---- 设置（由 popup 写入，storage 变更时热更新） ----
  const settings = { triggerMode: 'ctrl' }; // ctrl | auto
  chrome.storage.sync.get({ triggerMode: 'ctrl' }, (s) => {
    settings.triggerMode = s.triggerMode;
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.triggerMode) settings.triggerMode = changes.triggerMode.newValue;
  });

  // ---- 气泡生命周期 ----
  function removeBubble() {
    if (host) host.remove();
    host = null;
    ui = null;
  }

  function createBubble() {
    host = document.createElement('div');
    host.id = 'dict-translate-host';
    host.style.position = 'fixed';
    host.style.zIndex = '2147483647';
    host.style.left = '0';
    host.style.top = '0';

    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .card {
        font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        background: #fff;
        border: 1px solid #d0d7de;
        border-radius: 10px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, .18);
        padding: 10px 12px;
        max-width: 420px;
        min-width: 160px;
        color: #1f2328;
      }
      .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
      .badge {
        font-size: 11px; color: #656d76; background: #f0f2f4;
        border-radius: 4px; padding: 1px 6px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .badge.llm { color: #4c1d95; background: #ede9fe; }
      .close { cursor: pointer; color: #8c959f; font-size: 16px; line-height: 1; padding: 0 4px; user-select: none; }
      .close:hover { color: #1f2328; }
      .src {
        color: #656d76; font-size: 12px; margin-bottom: 4px;
        white-space: pre-wrap; word-break: break-word;
        max-height: 96px; overflow: hidden;
      }
      .dst { white-space: pre-wrap; word-break: break-word; }
      .dst.err { color: #c01c28; }
    `;

    const card = document.createElement('div');
    card.className = 'card';
    card.appendChild(mkEl('div', 'head'));
    const head = card.firstChild;
    const badge = mkEl('span', 'badge', '翻译中…');
    const close = mkEl('span', 'close', '×');
    head.append(badge, close);
    const src = mkEl('div', 'src');
    const dst = mkEl('div', 'dst', '…');
    card.append(src, dst);
    root.append(style, card);
    document.documentElement.appendChild(host);

    close.addEventListener('click', (e) => {
      e.stopPropagation();
      removeBubble();
    });
    // 防止点击气泡内部时选中文字
    card.addEventListener('mousedown', (e) => e.stopPropagation());

    ui = { badge, src, dst };
    return ui;
  }

  function mkEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
  }

  function place(x, y) {
    if (!host) return;
    host.style.left = Math.max(8, Math.min(x, innerWidth - host.offsetWidth - 8)) + 'px';
    host.style.top = Math.max(8, Math.min(y, innerHeight - host.offsetHeight - 8)) + 'px';
  }

  // ---- 触发逻辑 ----
  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return; // 只响应左键
    if (host && e.composedPath().includes(host)) return; // 点在气泡里
    const want =
      settings.triggerMode === 'auto' ? true : e.ctrlKey || e.metaKey;
    if (!want) return;
    // 延迟到选区状态稳定后再取 selection
    setTimeout(() => tryTranslate(e), 10);
  });

  // 点击气泡外部 / 按 Esc 关闭气泡
  document.addEventListener('mousedown', (e) => {
    if (host && !e.composedPath().includes(host)) removeBubble();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') removeBubble();
  }, true);

  async function tryTranslate(e) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const text = sel.toString().trim();
    if (!text || text.length > 5000) return;
    // 无字母（纯数字/符号）、URL、邮箱类内容不弹
    if (!HAS_LETTER.test(text) || URL_LIKE.test(text)) return;
    // 在输入框里选文不打扰
    const node = sel.anchorNode;
    const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
    if (el && el.closest && el.closest(INPUT_HOST)) return;

    let rect = null;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch (_) { /* 忽略取矩形失败 */ }
    const x = rect && rect.width >= 0 ? rect.left : e.clientX;
    const y = rect ? rect.bottom + 8 : e.clientY + 12;

    removeBubble();
    createBubble();
    ui.src.textContent = text;
    place(x, y);

    let resp = null;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'translate', text });
    } catch (err) {
      resp = { error: String(err) };
    }
    if (!ui) return; // 期间气泡已被关闭
    if (!resp || resp.error) {
      ui.badge.textContent = '失败';
      ui.dst.classList.add('err');
      ui.dst.textContent = resp ? resp.error : '无响应';
    } else {
      ui.badge.textContent = resp.engine;
      if (resp.engine === 'DeepSeek' || resp.engine === 'GLM') ui.badge.classList.add('llm');
      ui.dst.textContent = resp.translation;
    }
    place(x, y); // 内容填充后重新校正位置
  }
})();
