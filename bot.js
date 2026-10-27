const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs/promises');
const path = require('path');

// Silent logger to suppress noisy Baileys internal logs
const logger = pino({ level: 'silent' });

const CONFIG_FILE = path.join(__dirname, 'config.json');
const GROUP_JID_MAP_FILE = path.join(__dirname, 'group-jid-map.json');

async function loadConfig() {
    let contents;
    try {
        contents = await fs.readFile(CONFIG_FILE, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`Configuration file not found: ${CONFIG_FILE}. Copy config.example.json to config.json and edit it.`);
        }
        throw err;
    }

    const config = JSON.parse(contents);
    if (!config || Array.isArray(config) || typeof config !== 'object') {
        throw new Error(`${CONFIG_FILE} must contain a JSON object`);
    }
    if (!Array.isArray(config.groups) || config.groups.length === 0) {
        throw new Error(`${CONFIG_FILE} must contain a non-empty "groups" array`);
    }

    const inviteCodes = new Set();
    const groups = [];
    config.groups.forEach((group, index) => {
        if (!group || typeof group !== 'object' || Array.isArray(group)) {
            throw new Error(`Group #${index + 1} in ${CONFIG_FILE} must be an object`);
        }
        const codes = Array.isArray(group.inviteCodes)
            ? group.inviteCodes
            : [group.inviteCode];
        if (codes.length === 0 || codes.some(code => typeof code !== 'string' || !code.trim())) {
            throw new Error(`Group #${index + 1} in ${CONFIG_FILE} must have a non-empty "inviteCodes" array or an "inviteCode"`);
        }
        const normalizedCodes = codes.map(code => code.trim());
        for (const inviteCode of normalizedCodes) {
            if (inviteCodes.has(inviteCode)) {
                throw new Error(`Duplicate invite code in ${CONFIG_FILE}: ${inviteCode}`);
            }
            inviteCodes.add(inviteCode);
        }

        if (!Array.isArray(group.sources) || group.sources.length === 0) {
            throw new Error(`Group #${index + 1} in ${CONFIG_FILE} must have a non-empty "sources" array`);
        }
        const sources = group.sources.map((source, sourceIndex) => {
            if (!source || typeof source !== 'object' || Array.isArray(source)) {
                throw new Error(`Source #${sourceIndex + 1} for group #${index + 1} must be an object`);
            }
            if (source.type === 'url' && typeof source.url === 'string' && URL.canParse(source.url)) {
                return { type: 'url', url: source.url };
            }
            if (source.type === 'file' && typeof source.path === 'string' && source.path.trim()) {
                return { type: 'file', path: path.resolve(__dirname, source.path) };
            }
            throw new Error(`Source #${sourceIndex + 1} for group #${index + 1} must have type "url" with a valid URL or type "file" with a path`);
        });
        for (const inviteCode of normalizedCodes) {
            groups.push({ inviteCode, sources });
        }
    });

    return { groups };
}

async function loadGroupJidMap() {
    let contents;
    try {
        contents = await fs.readFile(GROUP_JID_MAP_FILE, 'utf8');
    } catch (err) {
        if (err.code !== 'ENOENT') {
            throw err;
        }
        await fs.writeFile(GROUP_JID_MAP_FILE, '{}\n', 'utf8');
        return {};
    }

    const groupJidMap = JSON.parse(contents);
    if (!groupJidMap || Array.isArray(groupJidMap) || typeof groupJidMap !== 'object') {
        throw new Error(`${GROUP_JID_MAP_FILE} must contain a JSON object mapping invite codes to group JIDs`);
    }
    for (const [code, jid] of Object.entries(groupJidMap)) {
        if (typeof jid !== 'string' || !jid.endsWith('@g.us')) {
            throw new Error(`Invalid group JID for invite code "${code}" in ${GROUP_JID_MAP_FILE}`);
        }
    }
    return groupJidMap;
}

async function saveGroupJidMap(groupJidMap) {
    await fs.writeFile(GROUP_JID_MAP_FILE, `${JSON.stringify(groupJidMap, null, 2)}\n`, 'utf8');
}

function extractWhatsAppMessage(html) {
    const openingTag = /<div\b[^>]*\bid\s*=\s*(?:"wamsg"|'wamsg'|wamsg(?=\s|>))[^>]*>/i.exec(html);
    if (!openingTag) {
        throw new Error('Response does not contain a div with id="wamsg"');
    }

    const contentStart = openingTag.index + openingTag[0].length;
    const divTags = /<\/?div\b[^>]*>/gi;
    divTags.lastIndex = contentStart;
    let depth = 1;
    let closingTag;
    let match;

    while ((match = divTags.exec(html))) {
        if (/^<\/div/i.test(match[0])) {
            depth--;
            if (depth === 0) {
                closingTag = match;
                break;
            }
        } else {
            depth++;
        }
    }

    if (!closingTag) {
        throw new Error('Response contains an unclosed div with id="wamsg"');
    }

    const text = html.slice(contentStart, closingTag.index)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p\s*>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (entity, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (entity, code) => String.fromCodePoint(parseInt(code, 16)));

    const lines = text.split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    const formattedLines = [];
    let hasCourse = false;

    for (const line of lines) {
        if (/^\*#\d+\*/.test(line)) {
            if (hasCourse) {
                formattedLines.push('');
            }
            hasCourse = true;
        }
        formattedLines.push(line);
    }

    return formattedLines.join('\n');
}

async function fetchMessages(sources) {
    const messages = [];
    for (const source of sources) {
        try {
            if (source.type === 'file') {
                console.log(`Reading message from file: ${source.path}`);
                const text = (await fs.readFile(source.path, 'utf8')).trim();
                if (!text) {
                    throw new Error('Message file is empty');
                }
                messages.push(text);
            } else {
                console.log(`Fetching latest content from: ${source.url}`);
                const response = await fetch(source.url);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} ${response.statusText}`);
                }
                messages.push(extractWhatsAppMessage(await response.text()));
            }
        } catch (err) {
            const sourceName = source.type === 'file' ? source.path : source.url;
            console.error(`Failed to load message from ${sourceName}:`, err.message);
        }
    }
    return messages;
}

// Integrated anti-ban network logic runner with human chat presence updates
async function sendMessageWithRetry(sock, jid, content, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Mimic human workflow: send typing indicators
            await sock.sendPresenceUpdate('composing', jid);
            const typingDelay = Math.floor(Math.random() * 3000) + 3000; // 3-6s natural delay
            await new Promise(resolve => setTimeout(resolve, typingDelay));
            await sock.sendPresenceUpdate('paused', jid);

            const result = await sock.sendMessage(jid, content);
            if (result?.status === 1 || result?.key?.id) {
                return result;
            }
            console.warn(`⚠️ sendMessage returned unexpected result (attempt ${attempt}):`, JSON.stringify(result));
        } catch (err) {
            console.error(`❌ sendMessage failed (attempt ${attempt}/${maxRetries}):`, err.message);
            if (attempt === maxRetries) throw err;
        }
        const backoff = 2000 * attempt;
        console.log(`⏳ Retrying in ${backoff / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
    }
}

async function startBot() {
    const config = await loadConfig();
    const groupJidMap = await loadGroupJidMap();
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: true
    });
    let broadcastStarted = false;
    let stopping = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            if (stopping) {
                return;
            }
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed (error ${statusCode}). Reconnecting...`);
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(startBot, 3000);
            }
        } 
        else if (connection === 'open') {
            if (broadcastStarted) {
                return;
            }
            broadcastStarted = true;
            console.log('\n========================================');
            console.log('Successfully connected to WhatsApp!');
            console.log('========================================\n');
            
            for (let i = 0; i < config.groups.length; i++) {
                const { inviteCode: code, sources } = config.groups[i];
                try {
                    const messages = await fetchMessages(sources);
                    if (messages.length === 0) {
                        console.error(`No messages loaded for group #${i + 1}; skipping.`);
                        continue;
                    }

                    let groupJid = groupJidMap[code];
                    if (groupJid) {
                        console.log(`\n[Group ${i + 1}/${config.groups.length}] Using cached JID: ${groupJid}`);
                    } else {
                        console.log(`\n[Group ${i + 1}/${config.groups.length}] Resolving JID for invite code: ${code}...`);
                        const groupInfo = await sock.groupGetInviteInfo(code);
                        groupJid = groupInfo.id;
                        groupJidMap[code] = groupJid;
                        await saveGroupJidMap(groupJidMap);
                        console.log(`Target: ${groupInfo.subject} (${groupJid}); saved to JID map.`);
                    }

                    for (let mIndex = 0; mIndex < messages.length; mIndex++) {
                        let finalizedMessage = applySpintax(messages[mIndex]);
                        console.log(` -> Sending message #${mIndex + 1}/${messages.length}...`);
                        
                        // Robust sending routine handling retries and typing behavior representation
                        await sendMessageWithRetry(sock, groupJid, { text: finalizedMessage });
                        
                        if (mIndex < messages.length - 1) {
                            const internalSpacing = Math.floor(Math.random() * 4000) + 6000; // 6-10s human gap between separate text boxes
                            await new Promise(res => setTimeout(res, internalSpacing));
                        }
                    }
                    console.log(`✔ Completed posting to group: ${groupJid}`);

                    if (i < config.groups.length - 1) {
                        const delay = Math.floor(Math.random() * 25000) + 20000; // 20-45s cooldown
                        console.log(`⏳ Sleeping ${delay / 1000}s to maintain safe posting rate...`);
                        await new Promise(res => setTimeout(res, delay));
                    }

                } catch (err) {
                    console.error(`❌ Failed processing invite code ${code}:`, err.message);
                }
            }

            console.log('\n========================================');
            console.log('All configured groups have been processed.');
            console.log('========================================\n');
            stopping = true;
            await sock.end(undefined);
            console.log('WhatsApp connection closed. The process will now exit.');
        }
    });
}

function applySpintax(text) {
    const hasSpintax = /\{([^{}]+)\}/.test(text);
    
    // Core variation strings
    const randomSuffixes = [' ', ' .', '..', ' ✔️', ' 🙌', ' 🚀', ' ✨', ' 📌',' 🔔',' 📢',' 📈',' 🔥',' 🎯',' ✅',' 👍', ' 💡'];
    const chosenSuffix = randomSuffixes[Math.floor(Math.random() * randomSuffixes.length)];
    
    // Dynamically append between 1 to 4 invisible trailing spaces for extra uniqueness
    const invisiblePadding = ' '.repeat(Math.floor(Math.random() * 4) + 1);

    if (!hasSpintax) {
        return text + chosenSuffix + invisiblePadding;
    }
    
    const processedText = text.replace(/\{([^{}]+)\}/g, (match, options) => {
        const choices = options.split('|');
        return choices[Math.floor(Math.random() * choices.length)];
    });

    return processedText + invisiblePadding;
}
// function applySpintax(text) {
//     const hasSpintax = /\{([^\{}]+)\}/.test(text);
//     if (!hasSpintax) {
//         const randomSuffixes = [' ', ' .', '..', ' ✔️', ' 🙌'];
//         return text + randomSuffixes[Math.floor(Math.random() * randomSuffixes.length)];
//     }
//     return text.replace(/\{([^\{}]+)\}/g, (match, options) => {
//         const choices = options.split('|');
//         return choices[Math.floor(Math.random() * choices.length)];
//     });
// }

startBot().catch(console.error);