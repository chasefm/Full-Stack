// 设置页逻辑：读取/保存配置（LLM 服务商 + 双方 Key），并提供一次连通性测试

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  deepseekKey: '',
  glmKey: '',
  llmProvider: 'deepseek',
  engineMode: 'auto',
  triggerMode: 'ctrl',
};

chrome.storage.sync.get(DEFAULTS, (s) => {
  $('provider').value = s.llmProvider;
  $('deepseekKey').value = s.deepseekKey;
  $('glmKey').value = s.glmKey;
  $('engine').value = s.engineMode;
  $('trigger').value = s.triggerMode;
  syncKeyVisibility();
});

// 切换服务商时只显示对应的 Key 输入框
$('provider').addEventListener('change', syncKeyVisibility);
function syncKeyVisibility() {
  const isGlm = $('provider').value === 'glm';
  $('deepseekKeyLabel').classList.toggle('hidden', isGlm);
  $('deepseekKey').classList.toggle('hidden', isGlm);
  $('glmKeyLabel').classList.toggle('hidden', !isGlm);
  $('glmKey').classList.toggle('hidden', !isGlm);
}

$('save').addEventListener('click', () => {
  chrome.storage.sync.set(
    {
      llmProvider: $('provider').value,
      deepseekKey: $('deepseekKey').value.trim(),
      glmKey: $('glmKey').value.trim(),
      engineMode: $('engine').value,
      triggerMode: $('trigger').value,
    },
    () => showStatus('已保存，立即生效')
  );
});

$('test').addEventListener('click', async () => {
  const result = $('result');
  result.className = '';
  result.textContent = '测试中…';
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'translate',
      text: 'The quick brown fox jumps over the lazy dog.',
    });
    if (resp && resp.error) {
      result.className = 'err';
      result.textContent = '❌ ' + resp.error;
    } else if (resp) {
      result.textContent = '✅ [' + resp.engine + '] ' + resp.translation;
    } else {
      result.className = 'err';
      result.textContent = '❌ 无响应（后台服务未启动？）';
    }
  } catch (e) {
    result.className = 'err';
    result.textContent = '❌ ' + String(e);
  }
});

function showStatus(msg) {
  const el = $('status');
  el.textContent = msg;
  setTimeout(() => (el.textContent = ''), 2000);
}
