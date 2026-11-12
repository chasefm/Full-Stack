// 划词翻译后台 Service Worker
// 翻译链路：LLM（DeepSeek 或 GLM，二选一）→ Bing（免费）→ MyMemory（免费兜底）
// 引擎策略（用户可设）：
//   auto：有 Key 走所选 LLM，失败自动降级；无 Key 直接走免费引擎
//   llm ：仅所选 LLM
//   free：仅免费引擎

const DEFAULTS = { deepseekKey: '', glmKey: '', llmProvider: 'deepseek', engineMode: 'auto' };
const cache = new Map(); // 原文 -> { translation, engine }

function getSettings() {
  return new Promise((resolve) =>
    chrome.storage.sync.get(DEFAULTS, (s) => resolve({ ...DEFAULTS, ...s }))
  );
}

// 超时控制器，避免某个引擎挂起导致气泡永远"翻译中"
function withTimeout(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/* ---------------- LLM（DeepSeek / 智谱 GLM，均为 OpenAI 兼容接口） ---------------- */

const LLM_CONFIG = {
  deepseek: {
    name: 'DeepSeek',
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    temperature: 1.3, // DeepSeek 官方推荐翻译场景温度
  },
  glm: {
    name: 'GLM',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4.7',
    temperature: 0.9,
  },
};

async function translateByLLM(text, provider, key) {
  const cfg = LLM_CONFIG[provider] || LLM_CONFIG.deepseek;
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        {
          role: 'system',
          content:
            '你是专业的英译中翻译。将用户发来的英文准确、自然地翻译成简体中文。' +
            '只输出译文本身，不要任何解释、前缀、引号或多余的标点。' +
            '如果输入是单个单词，给出该词最常见的一两个中文释义。',
        },
        { role: 'user', content: text },
      ],
      temperature: cfg.temperature,
      max_tokens: 1024,
    }),
    signal: withTimeout(20000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status); // 401=key错误 402/1113=余额不足 429=限流
  const data = await res.json();
  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('空响应');
  return out;
}

/* ---------------- Bing（免费非官方接口） ---------------- */

let bingIg = null;
let bingIid = null;
let bingTokenAt = 0;

async function fetchBingToken(force = false) {
  if (!force && bingIg && Date.now() - bingTokenAt < 10 * 60 * 1000) return;
  const res = await fetch('https://www.bing.com/translator', { signal: withTimeout(8000) });
  const html = await res.text();
  bingIg =
    html.match(/"ig":"([^"]+)"/)?.[1] ||
    html.match(/IG:"([^"]+)"/)?.[1];
  bingIid =
    html.match(/"IID":"([^"]+)"/)?.[1] ||
    html.match(/IID:"([^"]+)"/)?.[1] ||
    'TTC.vs.ipp_vid.' + Date.now(); // IID 可用时间戳构造
  if (!bingIg) throw new Error('无法解析令牌');
  bingTokenAt = Date.now();
}

async function translateByBing(text) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    // 首次失败后强制刷新令牌重试一次（令牌可能过期）
    await fetchBingToken(i > 0);
    try {
      const body = new URLSearchParams({ from: 'en', to: 'zh-CHS', text }).toString();
      const res = await fetch(
        'https://www.bing.com/ttranslatev3?isVertical=1&&IG=' +
          bingIg +
          '&IID=' +
          encodeURIComponent(bingIid),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body,
          signal: withTimeout(8000),
        }
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const out = Array.isArray(data) ? data[0]?.translations?.[0]?.text : null;
      if (out) return out;
      throw new Error('返回异常');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/* ---------------- MyMemory（免费兜底） ---------------- */

async function translateByMyMemory(text) {
  // MyMemory 单次查询有长度限制，截断保护
  const q = text.slice(0, 480);
  const res = await fetch(
    'https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=' + encodeURIComponent(q),
    { signal: withTimeout(8000) }
  );
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const out = data.matches?.[0]?.translation;
  if (!out) throw new Error('空响应');
  return out;
}

/* ---------------- 主流程 ---------------- */

function remember(text, r) {
  if (cache.size > 200) cache.clear();
  cache.set(text, r);
}

async function translate(text) {
  const hit = cache.get(text);
  if (hit) return hit;

  const { deepseekKey, glmKey, llmProvider, engineMode } = await getSettings();
  const llmKey = llmProvider === 'glm' ? glmKey : deepseekKey;
  const llmName = llmProvider === 'glm' ? 'GLM' : 'DeepSeek';
  const errors = [];

  if (engineMode === 'llm' && !llmKey) {
    return { error: '尚未配置 ' + llmName + ' API Key，请点击浏览器右上角插件图标填写。' };
  }

  if (engineMode !== 'free' && llmKey) {
    try {
      const t = await translateByLLM(text, llmProvider, llmKey);
      const r = { translation: t, engine: llmName };
      remember(text, r);
      return r;
    } catch (e) {
      // 余额不足 / key 无效 / 限流 / 网络失败 —— 自动降级
      errors.push('DeepSeek(' + e.message + ')');
    }
  }

  if (engineMode !== 'llm') {
    try {
      const t = await translateByBing(text);
      const r = { translation: t, engine: 'Bing' };
      remember(text, r);
      return r;
    } catch (e) {
      errors.push('Bing(' + e.message + ')');
    }
    try {
      const t = await translateByMyMemory(text);
      const r = { translation: t, engine: 'MyMemory' };
      remember(text, r);
      return r;
    } catch (e) {
      errors.push('MyMemory(' + e.message + ')');
    }
  }

  return { error: '翻译失败：' + errors.join('；') };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'translate') {
    translate(msg.text)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true; // 异步响应
  }
});
