require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data.json');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ── 데이터 헬퍼 ────────────────────────────────── */
function readData() {
  try {
    if (fs.existsSync(DATA)) return JSON.parse(fs.readFileSync(DATA, 'utf8'));
  } catch {}
  return { styles: [], count: 0 };
}
function writeData(d) {
  try { fs.writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8'); }
  catch (e) { console.error('데이터 저장 실패:', e.message); }
}

/* ── Anthropic API 프록시 ──────────────────────── */
app.post('/api/anthropic', async (req, res) => {
  // 요청 body의 apiKey 우선 사용, 없으면 서버 환경변수 폴백
  const { apiKey, ...body } = req.body;
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'API 키가 없습니다. 상단 입력란에 Anthropic API 키를 입력해주세요.' });
  if (!apiKey && !process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API 키가 없습니다.' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      timeout: 60000,
    });
    const data = await r.json();
    if (r.status === 401) return res.status(401).json({ error: 'API 키가 올바르지 않습니다. 키를 확인해주세요.' });
    if (r.status === 402) return res.status(402).json({ error: 'API 크레딧이 부족합니다. console.anthropic.com에서 충전해주세요.' });
    res.status(r.status).json(data);
  } catch (e) {
    console.error('Anthropic 오류:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── Pollinations 이미지 프록시 ────────────────── */
app.get('/api/image', async (req, res) => {
  const { prompt, width = 1024, height = 1024, seed = 0 } = req.query;
  if (!prompt) return res.status(400).json({ error: 'prompt 파라미터 필요' });

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${width}&height=${height}&nologo=true&seed=${seed}&model=flux&private=true`;

  try {
    const r = await fetch(url, { timeout: 60000 });
    if (!r.ok) throw new Error(`Pollinations 오류: ${r.status}`);
    const buf = await r.buffer();
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'no-cache');
    res.send(buf);
  } catch (e) {
    console.error('이미지 생성 오류:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── Gemini 이미지 생성 API (나노바나나2) ────────── */
app.post('/api/gemini-image', async (req, res) => {
  const { geminiKey, imageBase64, imageMimeType, prompt, imageSize = '1K' } = req.body;
  const key = geminiKey || process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'Google API 키가 없습니다. 상단 입력란에 Google API 키를 입력해주세요.' });
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: imageMimeType || 'image/png', data: imageBase64 } }
          ]}],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: { imageSize }
          }
        }),
        timeout: 90000,
      }
    );
    const data = await r.json();
    if (r.status === 401 || r.status === 403)
      return res.status(401).json({ error: 'Google API 키가 올바르지 않습니다.' });
    if (r.status === 429)
      return res.status(429).json({ error: 'API 요청 한도 초과. 잠시 후 다시 시도해주세요.' });
    if (!r.ok)
      return res.status(r.status).json({ error: data.error?.message || 'Gemini API 오류' });
    const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!imagePart) return res.status(500).json({ error: '이미지 생성 실패. 다시 시도해주세요.' });
    res.json({ imageData: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType });
  } catch (e) {
    console.error('Gemini 오류:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/styles', (req, res) => res.json(readData().styles));

app.post('/api/styles', (req, res) => {
  const { name, prompt } = req.body;
  if (!name?.trim() || !prompt?.trim())
    return res.status(400).json({ error: '이름과 프롬프트를 입력해주세요' });
  const d = readData();
  if (d.styles.length >= 30)
    return res.status(400).json({ error: '최대 30개까지 저장 가능합니다' });
  const style = { id: Date.now(), name: name.trim(), prompt: prompt.trim(), createdAt: new Date().toISOString() };
  d.styles.unshift(style);
  writeData(d);
  res.json(style);
});

app.delete('/api/styles/:id', (req, res) => {
  const d = readData();
  d.styles = d.styles.filter(s => s.id !== Number(req.params.id));
  writeData(d);
  res.json({ ok: true });
});

/* ── 생성 카운터 ────────────────────────────────── */
app.get('/api/count',  (req, res) => res.json({ count: readData().count }));
app.post('/api/count', (req, res) => {
  const d = readData();
  d.count = (d.count || 0) + 1;
  writeData(d);
  res.json({ count: d.count });
});

/* ── 서버 시작 ──────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n🚀  썸네일 에이전트 서버 실행 중`);
  console.log(`    http://localhost:${PORT}\n`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️   경고: ANTHROPIC_API_KEY 미설정 — AI 기능이 작동하지 않습니다.');
    console.warn('    .env 파일에 ANTHROPIC_API_KEY=sk-ant-... 를 추가하세요.\n');
  } else {
    console.log('✅  Anthropic API 키 확인됨\n');
  }
});
