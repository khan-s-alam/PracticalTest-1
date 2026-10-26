const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

// URLs where your website generates the plain text updates
const CATEGORY_URLS = [
    "https://jobs.e-next.in/public/meta_info/utxt.php?category=Development",
    "https://jobs.e-next.in/public/meta_info/utxt.php?category=IT+%26+Software"
];


// Add all your 30 WhatsApp group invite codes here
const GROUP_INVITE_CODES = [
    "FbuCm7KFKG3DiY12kQ7p4p",
    // "CODE_2",
    // "CODE_3",
    // ... up to 30 codes
];

// Helper function to fetch clean text messages from your URLs
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

async function fetchMessages() {
    const messages = [];
    for (const url of CATEGORY_URLS) {
        try {
            console.log(`Fetching latest content from: ${url}`);
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }
            const text = extractWhatsAppMessage(await response.text());
            messages.push(text);
        } catch (err) {
            console.error(`Failed to fetch text from ${url}:`, err.message);
        }
    }
    return messages;
}


async function main() {
    const MESSAGES = await fetchMessages();

    console.log("MESSAGES:", MESSAGES);

    if (MESSAGES.length === 0) {
        console.log("No messages found. Stopping execution.");
        return;
    }

    // Continue your existing code here
}


// process.exit(0); // Success

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed (error ${statusCode}). Reconnecting...`);
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(startBot, 3000);
            }
        } 
        else if (connection === 'open') {
            console.log('\n========================================');
            console.log('Successfully connected to WhatsApp!');
            console.log('========================================\n');
            
            // 1. Fetch latest messages live from your website
            const MESSAGES = await fetchMessages();
            if (MESSAGES.length === 0) {
                console.log("❌ No messages fetched. Exiting.");
                return;
            }

            // 2. Loop through all your 30 groups and post updates sequentially
            for (let i = 0; i < GROUP_INVITE_CODES.length; i++) {
                const code = GROUP_INVITE_CODES[i];
                try {
                    console.log(`\n[Group ${i + 1}/${GROUP_INVITE_CODES.length}] Fetching JID for code: ${code}...`);
                    const groupInfo = await sock.groupGetInviteInfo(code);
                    console.log(`Target: ${groupInfo.subject} (${groupInfo.id})`);

                    // Post each category block sequentially
                    for (let mIndex = 0; mIndex < MESSAGES.length; mIndex++) {
                        console.log(` -> Sending Category Update #${mIndex + 1}...`);
                        await sock.sendMessage(groupInfo.id, { text: MESSAGES[mIndex] });
                        
                        // Short 4-second delay between message blocks in the same group
                        if (mIndex < MESSAGES.length - 1) {
                            await new Promise(res => setTimeout(res, 4000));
                        }
                    }
                    console.log(`✔ Completed posting to group: ${groupInfo.subject}`);

                    // Anti-spam safety throttle: 20 to 45 second random delay between groups
                    if (i < GROUP_INVITE_CODES.length - 1) {
                        const delay = Math.floor(Math.random() * 25000) + 20000;
                        console.log(`⏳ Sleeping ${delay / 1000}s to maintain safe posting rate...`);
                        await new Promise(res => setTimeout(res, delay));
                    }

                } catch (err) {
                    console.error(`❌ Failed processing invite code ${code}:`, err.message);
                }
            }

            console.log('\n========================================');
            console.log('All automated broadcasts delivered across groups!');
            console.log('========================================\n');
        }
    });
}

startBot();
//main().catch(console.error);