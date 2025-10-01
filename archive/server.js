const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
const HEYGEN_BASE_URL = 'https://api.heygen.com/v1';

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const RETELL_AGENT_ID = process.env.RETELL_AGENT_ID;
const RETELL_BASE_URL = 'https://api.retellai.com';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let sessionCache = {};       // HeyGen session cache
let retellSessionCache = {}; // Retell session cache

function logSection(title) {
    console.log('\n==============================');
    console.log(`📢 ${title}`);
    console.log('==============================\n');
}

/* -------------------- HeyGen Routes (untouched) -------------------- */
app.post('/api/avatar/start', async (req, res) => {
    logSection('POST /api/avatar/start');
    console.log('📥 Request body:', req.body);

    try {
        const { avatarName, voiceId } = req.body;

        console.log('➡️ Requesting token from HeyGen...');
        const tokenRes = await axios.post(`${HEYGEN_BASE_URL}/streaming.create_token`, {}, {
            headers: { "Content-Type": "application/json", "X-Api-Key": HEYGEN_API_KEY }
        });
        const token = tokenRes.data.data.token;
        console.log('✅ Token received:', token);

        console.log(`➡️ Creating session for avatar: ${avatarName}, voice: ${voiceId}`);
        const sessionRes = await axios.post(`${HEYGEN_BASE_URL}/streaming.new`, {
            avatar_name: avatarName,
            voice: voiceId ? { voice_id: voiceId, rate: 1.0 } : undefined,
            version: "v2",
            video_encoding: "H264"
        }, {
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }
        });
        const sessionData = sessionRes.data.data;
        console.log('✅ Session created:', sessionData.session_id);

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
        console.error('❌ Error in /api/avatar/start', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to initialize HeyGen session' });
    }
});

app.post('/api/avatar/start-stream', async (req, res) => {
    logSection('POST /api/avatar/start-stream');
    try {
        await axios.post(`${HEYGEN_BASE_URL}/streaming.start`, {
            session_id: sessionCache.sessionId
        }, {
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sessionCache.token}` }
        });
        console.log('✅ HeyGen streaming started');
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error in /api/avatar/start-stream', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to start HeyGen stream' });
    }
});

app.post('/api/avatar/talk', async (req, res) => {
    logSection('POST /api/avatar/talk');
    const { text } = req.body;
    try {
        await axios.post(`${HEYGEN_BASE_URL}/streaming.task`, {
            session_id: sessionCache.sessionId,
            text,
            task_type: "repeat"
        }, {
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sessionCache.token}` }
        });
        console.log('✅ Text sent to HeyGen avatar');
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error in /api/avatar/talk', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to send text to HeyGen avatar' });
    }
});

app.post('/api/avatar/end', async (req, res) => {
    logSection('POST /api/avatar/end');
    try {
        await axios.post(`${HEYGEN_BASE_URL}/streaming.stop`, {
            session_id: sessionCache.sessionId
        }, {
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sessionCache.token}` }
        });
        console.log('✅ HeyGen session ended');
        sessionCache = {};
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error in /api/avatar/end', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to end HeyGen session' });
    }
});

/* -------------------- Retell Routes -------------------- */
app.post('/api/retell/start', async (req, res) => {
    logSection('POST /api/retell/start');
    console.log(`🎯 Using Agent ID: ${RETELL_AGENT_ID}`);
    console.log(`🔑 API Key starts with: ${RETELL_API_KEY.slice(0, 8)}...`);

    try {
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

        console.log('📥 Full Retell API Response:', JSON.stringify(chatRes.data, null, 2));

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

app.post('/api/retell/talk', async (req, res) => {
    logSection('POST /api/retell/talk');
    const { text } = req.body;

    try {
        // Send user message to Retell
        const response = await axios.post(`${RETELL_BASE_URL}/create-chat-completion`, {
            chat_id: retellSessionCache.chatId,
            content: text
        }, {
            headers: {
                'Authorization': `Bearer ${RETELL_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const agentReply = response.data.messages?.[0]?.content || '[No response]';
        console.log('✅ Retell agent replied:', agentReply);
		let heygenResponse;
        // 🚀 Optional: Send Retell’s reply to HeyGen if session active
        if (sessionCache?.sessionId && sessionCache?.token) {
            console.log('🎯 Sending Retell reply to HeyGen avatar...');
			
            try {
				heygenResponse = await axios.post(`${HEYGEN_BASE_URL}/streaming.task`, {
					session_id: sessionCache.sessionId,
					text: agentReply,
					task_type: "repeat"
				}, {
					headers: {
						"Content-Type": "application/json",
						"Authorization": `Bearer ${sessionCache.token}`
					}
				});
				console.log('✅ Retell reply sent to Heygen avatar');
				console.log('✅ Retell agent replied:', agentReply);
			} catch (heygenErr) {
				console.error('❌ Failed to send text to Heygen:', heygenErr.response?.data || heygenErr.message);
			}
        } else {
            console.log('ℹ️ HeyGen session not active—skipping avatar talk');
        }
		//duration_ms = 20000;
		const duration_ms = heygenResponse?.data?.data?.duration_ms || 20000;
		console.log(`🕑 Avatar will speak for ${duration_ms} ms`);
        res.json({ success: true, agentReply,duration_ms});
    } catch (err) {
        console.error('❌ Error sending message to Retell:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to send message to Retell' });
    }
});

app.post('/api/retell/end', (req, res) => {
    logSection('POST /api/retell/end');
    retellSessionCache = {};
    res.json({ success: true, message: 'Retell chat session cleared' });
});

/* -------------------- Start Server -------------------- */
app.listen(PORT, () => {
    logSection(`🚀 Server running at http://localhost:${PORT}`);
});
