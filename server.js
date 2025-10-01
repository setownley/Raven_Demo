const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Resolve Python executable (cross-platform safe)
const pythonCmd = os.platform() === 'win32' ? 'python' : 'python3';

// ✅ Spawn Stanza worker
const stanza = spawn(
  pythonCmd,
  [path.join(__dirname, 'stanza_worker.py')],
  {
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8', // ✅ Ensures UTF-8 for stdin/stdout in Python
    },
  }
);

stanza.stdout.setEncoding('utf8');
stanza.stderr.setEncoding('utf8');

stanza.stdout.on('data', (data) => {
  console.log(`[STANZA] ${data}`);
});

stanza.stderr.on('data', (data) => {
  console.error(`[STANZA ERROR] ${data}`);
});

stanza.on('exit', (code) => {
  console.log(`[STANZA] exited with code ${code}`);
});


let pendingResolvers = [];
stanza.stdout.on('data', (data) => {
  data.trim().split('\n').forEach(line => {
    try {
      const result = JSON.parse(line);
      const resolver = pendingResolvers.shift();
      if (resolver) resolver(result);
    } catch (e) {
      console.log("⚠️ Non-JSON message:", line);
    }
  });
});
stanza.stderr.on('data', (err) => {
  console.error("🚨 Python error:", err.trim());
});
function splitIntoSentences(text) {
  return new Promise((resolve) => {
    pendingResolvers.push(resolve);
    stanza.stdin.write(text + ' <<end>>\n');
  });
}
// ✅ END NEW BLOCK

const PORT = process.env.PORT || 3000;

const mLatency = true;

const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
const HEYGEN_BASE_URL = 'https://api.heygen.com/v1';
const RETELL_API_KEY = process.env.RETELL_API_KEY;
const RETELL_AGENT_ID = process.env.RETELL_AGENT_ID;
const RETELL_BASE_URL = 'https://api.retellai.com';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let sessionCache = {};
let retellSessionCache = {};

function logSection(title) {
  console.log('\n==============================');
  console.log(`📢 ${title}`);
  console.log('==============================\n');
}
function logLatency(task, ms) {
  if (mLatency) console.log(`📊 Latency (${task}): ${ms} ms`);
}

app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];
  const timestamp = new Date().toISOString();
  console.log(`📅 [${timestamp}] ${req.method} ${req.originalUrl}`);
  console.log(`🕵️ IP: ${ip}`);
  console.log(`🧭 Agent: ${userAgent}`);
  next();
});

app.post('/api/video-agent/start', async (req, res) => {
  logSection('POST /api/video-agent/start');
  try {
    const avatarName = process.env.HEYGEN_AVATAR_NAME;
    const voiceId = process.env.HEYGEN_VOICE_ID;

    const t1 = Date.now();
    const tokenRes = await axios.post(`${HEYGEN_BASE_URL}/streaming.create_token`, {}, {
      headers: { "Content-Type": "application/json", "X-Api-Key": HEYGEN_API_KEY }
    });
    logLatency('HeyGen - streaming.create_token', Date.now() - t1);

    const token = tokenRes.data.data.token;

    const t2 = Date.now();
    const sessionRes = await axios.post(`${HEYGEN_BASE_URL}/streaming.new`, {
      avatar_name: avatarName,
      voice: voiceId ? { voice_id: voiceId, rate: 1.0 } : undefined,
      version: "v2",
      video_encoding: "VP8"
    }, {
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }
    });
    logLatency('HeyGen - streaming.new', Date.now() - t2);

    const sessionData = sessionRes.data.data;
    sessionCache = { token, sessionId: sessionData.session_id };

    res.json({
      success: true,
      session: {
        session_id: sessionData.session_id,
        url: sessionData.url,
        access_token: sessionData.access_token
      }
    });
  } catch (err) {
    console.error('❌ Error in /api/video-agent/start', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to initialize video agent session' });
  }
});


app.post('/api/video-agent/start-stream', async (req, res) => {
  logSection('POST /api/video-agent/start-stream');
  try {
    const t1 = Date.now();
    await axios.post(`${HEYGEN_BASE_URL}/streaming.start`, {
      session_id: sessionCache.sessionId
    }, {
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sessionCache.token}` }
    });
    logLatency('HeyGen - streaming.start', Date.now() - t1);

    console.log('✅ HeyGen streaming started');
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error in /api/video-agent/start-stream', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to start HeyGen stream' });
  }
});

app.post('/api/video-agent/talk', async (req, res) => {
  logSection('/api/video-agent/talk');
  const { text } = req.body;
  try {
    const t1 = Date.now();
    await axios.post(`${HEYGEN_BASE_URL}/streaming.task`, {
      session_id: sessionCache.sessionId,
      text,
      task_type: "repeat"
    }, {
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sessionCache.token}` }
    });
    logLatency('HeyGen - streaming.task', Date.now() - t1);

    console.log('✅ Text sent to HeyGen avatar');
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error in /api/video-agent/talk', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to send text to HeyGen avatar' });
  }
});

app.post('/api/video-agent/end', async (req, res) => {
  logSection('/api/video-agent/end');
  try {
    const t1 = Date.now();
    await axios.post(`${HEYGEN_BASE_URL}/streaming.stop`, {
      session_id: sessionCache.sessionId
    }, {
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sessionCache.token}` }
    });
    logLatency('HeyGen - streaming.stop', Date.now() - t1);

    console.log('✅ HeyGen session ended');
    sessionCache = {};
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error in /api/video-agent/end', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to end HeyGen session' });
  }
});

app.post('/api/chat-agent/start', async (req, res) => {
  logSection('POST /api/chat-agent/start');
  try {
    const t1 = Date.now();
    const chatRes = await axios.post(`${RETELL_BASE_URL}/create-chat`, {
      agent_id: RETELL_AGENT_ID,
      agent_version: 1,
      metadata: {},
      retell_llm_dynamic_variables: { customer_name: "User" }
    }, {
      headers: {
        'Authorization': `Bearer ${RETELL_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    logLatency('Retell - create-chat', Date.now() - t1);

    const chatId = chatRes.data.data?.chat_id || chatRes.data.chat_id;
    if (!chatId) throw new Error('chat_id not found in Retell API response');

    console.log('✅ Retell chat session created:', chatId);
    retellSessionCache = { chatId };
    res.json({ success: true, chatId });
  } catch (err) {
    console.error('❌ Error creating Retell chat:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create Retell chat' });
  }
});

app.post('/api/chat-agent/talk', async (req, res) => {
  logSection('POST /api/chat-agent/talk');
  const { text } = req.body;
  try {
    if (mLatency) {
      console.log(`📝 Sending to Retell (chat_id=${retellSessionCache.chatId}): "${text}"`);
    }

    const t1 = Date.now();
	
	// 🚀 Send warm-up utterance immediately to HeyGen
	if (sessionCache?.sessionId && sessionCache?.token) {
	  console.log('🧊 Pre-warming HeyGen with ". . ."');
	  try {
		await axios.post(`${HEYGEN_BASE_URL}/streaming.task`, {
		  session_id: sessionCache.sessionId,
		  text: ". . .",
		  task_type: "repeat"
		}, {
		  headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${sessionCache.token}`
		  }
		});
		console.log('✅ Warm-up sent to HeyGen');
	  } catch (err) {
		console.warn('⚠️ Failed to pre-warm HeyGen:', err.response?.data || err.message);
	  }
	}
	
    const response = await axios.post(`${RETELL_BASE_URL}/create-chat-completion`, {
      chat_id: retellSessionCache.chatId,
      content: text
    }, {
      headers: {
        'Authorization': `Bearer ${RETELL_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    logLatency('Retell - create-chat-completion', Date.now() - t1);

    const agentReply = response.data.messages?.[0]?.content || '[No response]';
    console.log('✅ Retell agent replied:', agentReply);

    const sentences = await splitIntoSentences(agentReply); // ✅ NEW
    console.log(`📤 Splitting reply into ${sentences.length} sentence(s)`);

    let totalDuration = 0;
    if (sessionCache?.sessionId && sessionCache?.token) {
      for (const sentence of sentences) {
        console.log('🗣️ sending to Heygen:', sentence);
        const t2 = Date.now();
        const heygenResponse = await axios.post(`${HEYGEN_BASE_URL}/streaming.task`, {
          session_id: sessionCache.sessionId,
          text: sentence.trim(),
          task_type: "repeat"
        }, {
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${sessionCache.token}`
          }
        });
        logLatency('HeyGen - streaming.task (sentence)', Date.now() - t2);

        const duration = heygenResponse.data?.data?.duration_ms || 3000;
        totalDuration += duration;
        console.log(`🗣️ Sentence duration: ${duration} ms → Total so far: ${totalDuration} ms`);
      }
    }
	totalDuration -= 1500;
    res.json({ success: true, agentReply, duration_ms: totalDuration });
  } catch (err) {
    console.error('❌ Error sending message to Retell:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to send message to Retell' });
  }
});

app.post('/api/retell/end', (req, res) => {
  logSection('POST /api/chat-agent/end');
  retellSessionCache = {};
  res.json({ success: true, message: 'Retell chat session cleared' });
});

app.listen(PORT, () => {
  logSection(`🚀 Server running at http://localhost:${PORT}`);
});
