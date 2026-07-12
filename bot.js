// instant-alpha-bot.js
// Complete Telegram Bot for Pump.fun Instant Alerts
// Uses JSON file storage


const  {TelegramBot}  = require('node-telegram-bot-api');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const Database= require("./database.js");
const logger= require("./logger.js");
require("dotenv").config();

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    WS_URL: process.env.WS_URL || 'wss://pumpportal.fun/api/data',
    ADMIN_UNIQUE_ID: process.env.ADMIN_UNIQUE_ID,
    ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)),
    SOL_PRICE_USD: 81,
    MAX_ALERTS_PER_MINUTE: 60,
    DATA_PATH: path.join(__dirname, 'data'),
    LOG_PATH: path.join(__dirname, 'logs', 'bot.log'),
    MAX_STORED_TOKENS: 10000,
    MAX_STORED_ALERTS: 5000,
    FREE_ALERT_DELAY_MS: 3 * 60 * 1000 // 3 minute delay before free/group alerts go out
};

// ============================================
// MESSAGING — fill in your own upgrade copy here.
// This is the ONE place free-tier messages pull their
// upgrade call-to-action from, so you can edit/localize
// it without touching the alert logic.
// ============================================
const MESSAGING = {
    UPGRADE_CTA: "Upgrade with @YourPaymentBot to remove the delay"
};



// ============================================
// TOKEN ANALYZER
// ============================================
class TokenAnalyzer {
    constructor() {
        this.trendingWords = ['ai', 'cat', 'dog', 'pepe', 'moon', 'rocket', 'gem', 'pump', 'mega', 'super', 'meme'];
        this.highRiskPatterns = ['test', 'xyz', 'xxx', 'rug', 'scam', 'baby', 'safu'];
    }

    analyze(data) {
        if (data.txType !== 'create') return null;

        let score = 0;
        const reasons = [];
        const warnings = [];

        const initialBuySol = data.initialBuy / 1e6;

        // 1. Initial Buy Score (0-35)
        if (initialBuySol > 5) {
            score += 35;
            reasons.push(`💰 ${initialBuySol.toFixed(1)} SOL buy`);
        } else if (initialBuySol > 2) {
            score += 25;
            reasons.push(`💵 ${initialBuySol.toFixed(1)} SOL buy`);
        } else if (initialBuySol > 1) {
            score += 15;
            reasons.push(`💳 ${initialBuySol.toFixed(1)} SOL buy`);
        } else if (initialBuySol < 0.01) {
            warnings.push('⚠️ Very low initial buy');
        }

        // 2. Market Cap Score (0-30)
        const marketCapSol = data.marketCapSol || 27.958;
        if (marketCapSol < 50) {
            score += 30;
            reasons.push('🚀 Very early (<50 MC)');
        } else if (marketCapSol < 100) {
            score += 20;
            reasons.push('📈 Early (<100 MC)');
        } else if (marketCapSol < 200) {
            score += 10;
            reasons.push('⏰ Reasonable entry');
        } else {
            warnings.push('⚠️ Late entry (high MC)');
        }

        // 3. Symbol Quality (0-15)
        const symbol = (data.symbol || '').toUpperCase();
        if (symbol.length >= 2 && symbol.length <= 5) {
            score += 15;
            reasons.push(`🎯 Clean symbol: $${symbol}`);
        } else if (symbol.length <= 8) {
            score += 5;
        } else {
            warnings.push('⚠️ Long symbol');
        }

        // 4. Name Quality (0-10)
        const name = (data.name || '').toLowerCase();
        let nameBonus = 0;
        for (const word of this.trendingWords) {
            if (name.includes(word) || symbol.toLowerCase().includes(word)) {
                nameBonus = 10;
                reasons.push(`🔥 ${word} trending`);
                break;
            }
        }
        score += nameBonus;

        // 5. Risk Flags (-20 to 0)
        if (data.isMayhemMode) {
            score -= 20;
            warnings.push('⚠️ Mayhem mode (high risk)');
        }

        if (data.isCashbackEnabled) {
            score += 5;
        }

        for (const pattern of this.highRiskPatterns) {
            if (name.includes(pattern) || symbol.toLowerCase().includes(pattern)) {
                score -= 10;
                warnings.push(`⚠️ Suspicious pattern: ${pattern}`);
                break;
            }
        }

        // Normalize score
        score = Math.max(0, Math.min(100, score));

        return {
            score,
            reasons,
            warnings,
            initialBuySol,
            marketCapSol,
            symbol: symbol || 'UNKNOWN',
            name: data.name || 'Unknown',
            isHighQuality: score >= 60,
            isPremiumQuality: score >= 75,
            data
        };
    }
}

// ============================================
// ALERT FORMATTER
// ============================================
class AlertFormatter {
    static formatInstantAlert(analysis, isPremium = false) {
        const data = analysis.data;
        const solPrice = CONFIG.SOL_PRICE_USD;
        const marketCapUsd = (analysis.marketCapSol * solPrice).toFixed(0);
        const initialBuyUsd = (analysis.initialBuySol * solPrice).toFixed(0);

        let message = '';
        
        if (isPremium) {
            message += `⚡ *INSTANT ALERT* ⚡\n\n`;
        } else {
            message += `📢 *FREE ALERT*\n\n`;
        }

        message += `🚀 *${data.name || 'Unknown'}* ($${analysis.symbol})\n`;
        message += `🔗 \`${data.mint}\`\n\n`;

        message += `📊 *Analysis:*\n`;
        analysis.reasons.forEach(r => {
            message += `  ${r}\n`;
        });
        
        if (analysis.warnings.length > 0) {
            message += `\n⚠️ *Warnings:*\n`;
            analysis.warnings.forEach(w => {
                message += `  ${w}\n`;
            });
        }

        message += `\n📈 *Market Data:*\n`;
        message += `  • Score: ${analysis.score}/100\n`;
        message += `  • Initial Buy: ${analysis.initialBuySol.toFixed(2)} SOL ($${initialBuyUsd})\n`;
        message += `  • Market Cap: ${analysis.marketCapSol.toFixed(1)} SOL ($${marketCapUsd})\n`;

        if (data.isCashbackEnabled) {
            message += `  • 💰 Cashback Enabled\n`;
        }

        message += `\n🔗 *Buy:* https://pump.fun/${data.mint}`;

        if (isPremium) {
            message += `\n\n💎 *This is a premium alert!*`;
        } else {
            message += `\n\n🔓 *Upgrade to Premium for INSTANT alerts!*`;
            message += `\n💳 /premium`;
            if (MESSAGING.UPGRADE_CTA) {
                message += `\n${MESSAGING.UPGRADE_CTA}`;
            }
        }

        return message;
    }
}

// ============================================
// TELEGRAM BOT
// ============================================
class PumpFunAlertBot {
    constructor() {
        this.db = new Database();
        this.analyzer = new TokenAnalyzer();
        this.bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, {
            polling: true,
            request: {
                timeout: 30000
            },
            allowed_updates: ['message', 'my_chat_member', 'callback_query']
        });
        this.ws = null;
        this.alertQueue = [];
        this.isProcessingQueue = false;
        this.isShuttingDown = false;
        
        this.initBotCommands();
        this.initWebSocket();
        this.startQueueProcessor();
        this.startCleanupJob();
        
        logger.info('🚀 Bot initialized successfully');
    }

    // ==========================================
    // WEB SOCKET
    // ==========================================
    initWebSocket() {
        this.connectWebSocket();
    }

    connectWebSocket() {
        if (this.ws) {
            this.ws.terminate();
        }

        logger.info('Connecting to WebSocket...');
        this.ws = new WebSocket(CONFIG.WS_URL);

        this.ws.on('open', () => {
            logger.info('✅ WebSocket connected');
            this.ws.send(JSON.stringify({
                method: 'subscribeNewToken'
            }));
            logger.info('📡 Subscribed to new tokens');
        });

        this.ws.on('message', async (data) => {
            try {
                const message = data.toString();
                const parsed = JSON.parse(message);
                
                // Skip non-create events
                if (parsed.txType !== 'create') return;
                
                // Analyze token
                const analysis = this.analyzer.analyze(parsed);
                if (!analysis) return;
                
                // Save token to database
                this.db.saveToken({
                    ...analysis,
                    mint: parsed.mint,
                    symbol: parsed.symbol || 'UNKNOWN',
                    name: parsed.name || 'Unknown',
                    detectedAt: Date.now()
                });
                
                // Check if already alerted
                if (this.db.isTokenAlerted(parsed.mint)) return;
                
                // Queue alert for processing
                this.queueAlert(parsed, analysis);
                
                logger.info(`📊 New token: ${parsed.symbol} (${parsed.mint.slice(0, 8)}) - Score: ${analysis.score}`);
                
            } catch (error) {
                logger.error(`WebSocket message error: ${error.message}`);
            }
        });

        this.ws.on('error', (error) => {
            logger.error(`WebSocket error: ${error.message}`);
        });

        this.ws.on('close', () => {
            if (!this.isShuttingDown) {
                logger.warn('WebSocket closed, reconnecting in 5 seconds...');
                setTimeout(() => this.connectWebSocket(), 5000);
            }
        });
    }

    // ==========================================
    // ALERT QUEUE
    // ==========================================
    queueAlert(data, analysis) {
        this.alertQueue.push({
            data,
            analysis,
            timestamp: Date.now()
        });
        
        if (this.alertQueue.length > 1000) {
            this.alertQueue = this.alertQueue.slice(-1000);
        }
    }

    startQueueProcessor() {
        setInterval(() => {
            if (this.isProcessingQueue || this.alertQueue.length === 0) return;
            this.processQueue();
        }, 1000);
    }

    async processQueue() {
        this.isProcessingQueue = true;
        
        try {
            const itemsToProcess = this.alertQueue.splice(0, 5);
            for (const item of itemsToProcess) {
                await this.sendAlert(item.data, item.analysis);
                await this.sleep(1000);
            }
        } catch (error) {
            logger.error(`Queue processing error: ${error.message}`);
        } finally {
            this.isProcessingQueue = false;
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ==========================================
    // CLEANUP JOB
    // ==========================================
    startCleanupJob() {
        setInterval(() => {
            this.db.cleanup();
        }, 60 * 60 * 1000); // Run every hour
    }

    // ==========================================
    // SEND ALERTS
    // ==========================================
    async sendAlert(data, analysis) {
        try {
            // Mark as alerted
            this.db.markTokenAlerted(data.mint);
            
            // Get all premium users and groups
            const premiumUsers = this.db.getPremiumUsers();
            const activeGroups = this.db.getActiveGroups();
            
            // Format messages
            const premiumMessage = AlertFormatter.formatInstantAlert(analysis, true);
            const freeMessage = AlertFormatter.formatInstantAlert(analysis, false);
            
            // Send to premium users
            let sentCount = 0;
            for (const userId of premiumUsers) {
                try {
                    await this.bot.sendMessage(userId, premiumMessage, {
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true
                    });
                    this.db.saveAlert(data.mint, data.symbol || 'UNKNOWN', premiumMessage, `user_${userId}`);
                    sentCount++;
                } catch (error) {
                    logger.error(`Failed to send to user ${userId}: ${error.message}`);
                }
            }
            
            logger.info(`✅ Instant alert sent: ${data.symbol} to ${sentCount} premium recipients`);

            // Send to active groups (free alerts) after the configured delay
            if (activeGroups.length > 0) {
                setTimeout(async () => {
                    let freeSentCount = 0;
                    for (const groupId of activeGroups) {
                        try {
                            await this.bot.sendMessage(groupId, freeMessage, {
                                parse_mode: 'Markdown',
                                disable_web_page_preview: true
                            });
                            this.db.saveAlert(data.mint, data.symbol || 'UNKNOWN', freeMessage, `group_${groupId}`);
                            freeSentCount++;
                        } catch (error) {
                            logger.error(`Failed to send to group ${groupId}: ${error.message}`);
                        }
                    }
                    logger.info(`✅ Delayed free alert sent: ${data.symbol} to ${freeSentCount} groups (after ${CONFIG.FREE_ALERT_DELAY_MS / 1000}s delay)`);
                }, CONFIG.FREE_ALERT_DELAY_MS);
            }
            
        } catch (error) {
            logger.error(`Error sending alert: ${error.message}`);
        }
    }

    // ==========================================
    // BOT COMMANDS
    // ==========================================
    initBotCommands() {
        // ===== START =====
        this.bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
            const chatId = msg.chat.id;
            const userId = msg.from.id;
            
            try {
                this.db.createOrUpdateUser(
                    userId,
                    msg.from.username || null,
                    msg.from.first_name || null,
                    msg.from.last_name || null
                );
                
                this.db.updateUserActivity(userId);
                
                // Check if it's a group
                if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
                    this.db.addGroup(chatId, msg.chat.title || 'Unknown Group');
                    
                    this.bot.sendMessage(chatId, `
🎉 *Group Activated!*

I'll send free token alerts to this group.

📊 *Features:*
• Free alerts
• Token analysis and scoring
• Market cap tracking

⭐ *Premium features for group:*
• Instant alerts (0 delay)
• Higher quality signals
Our live coin is at [SignalKing](https://pump.fun/coin/EycsbqtKYmdjdPtoGK9DhvTWQHdECwC6t8wgWgaepump)
Contact admin to upgrade!
                    `, { parse_mode: 'Markdown' });
                    return;
                }
                
                // Private chat welcome
                const isPremium = this.db.isPremium(userId);
                const user = this.db.getUser(userId);
                
                let welcomeMessage = `
🚀 *Welcome to Pump.fun Alpha Bot!*

I monitor every new token launch in real-time and alert you to the best opportunities.

📊 *Your Status:* ${isPremium ? '⭐ PREMIUM' : '🔓 FREE'}
${isPremium ? `📅 Premium expires: ${new Date(user.premiumExpiry).toLocaleDateString()}` : ''}

📈 *Features:*
${isPremium ? '✅' : '🔓'} Instant token alerts
${isPremium ? '✅' : '🔓'} Smart scoring system
${isPremium ? '✅' : '🔓'} Whale tracking
${isPremium ? '✅' : '🔓'} Custom filters

⚡ *Commands:*
/start - This message
/premium - Upgrade to premium
/trial - 7-day free trial
/stats - Bot statistics
/recent - Recent alerts
/help - Help menu

${isPremium ? '' : '\n💳 *Upgrade to PREMIUM for instant alerts!* /premium'}
                `;
                
                this.bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
                
            } catch (error) {
                logger.error(`Start command error: ${error.message}`);
                this.bot.sendMessage(chatId, '❌ Error processing command. Please try again.');
            }
        });

        // ===== PREMIUM =====
        this.bot.onText(/\/premium/, async (msg) => {
            const chatId = msg.chat.id;
            const userId = msg.from.id;
            
            try {
                const isPremium = this.db.isPremium(userId);
                
                if (isPremium) {
                    const user = this.db.getUser(userId);
                    const expiry = new Date(user.premiumExpiry);
                    
                    this.bot.sendMessage(chatId, `
⭐ *Premium Status: ACTIVE*

📅 Expires: ${expiry.toLocaleDateString()} ${expiry.toLocaleTimeString()}

💰💳 Contact @ElitePremiumPayBot to upgrade
                    `, { parse_mode: 'Markdown' });
                } else {
                    this.bot.sendMessage(chatId, `
⭐ *Premium Features:*

⚡ *Instant alerts* - No delay
🎯 *High quality only* - Top 10% of tokens
🐋 *Whale tracking* - See smart money
🎨 *Custom filters* - Set your rules
💰💳 Contact @ElitePremiumPayBot to upgrade
                    `, { parse_mode: 'Markdown' });
                }
            } catch (error) {
                logger.error(`Premium command error: ${error.message}`);
                this.bot.sendMessage(chatId, '❌ Error processing command.');
            }
        });

        // ===== TRIAL =====
        this.bot.onText(/\/trial/, async (msg) => {
            const chatId = msg.chat.id;
            const userId = msg.from.id;
            
            try {
                if (this.db.isPremium(userId)) {
                    this.bot.sendMessage(chatId, '✅ You already have premium!');
                    return;
                }
                
                const user = this.db.getUser(userId);
                if (user && user.trialUsed) {
                    this.bot.sendMessage(chatId, '❌ You already used your free trial. /premium');
                    return;
                }
                
                this.db.setPremium(userId, 7);
                this.db.setTrialUsed(userId);
                
                this.bot.sendMessage(chatId, `
🎉 *FREE 7-DAY PREMIUM ACTIVATED!*

You now have:
✅ Instant alerts
✅ Premium signals
✅ All features unlocked

Enjoy! 🚀
                `, { parse_mode: 'Markdown' });
                
            } catch (error) {
                logger.error(`Trial command error: ${error.message}`);
                this.bot.sendMessage(chatId, '❌ Error processing trial.');
            }
        });

        // ===== STATS =====
        this.bot.onText(/\/stats/, async (msg) => {
            const chatId = msg.chat.id;
            const userId = msg.from.id;
            if(userId==CONFIG.ADMIN_UNIQUE_ID){ 
            try {
                const stats = this.db.getStats();
                const isPremium = this.db.isPremium(userId);
                const uptime = Math.floor((Date.now() - startTime) / 1000 / 60);
                
                this.bot.sendMessage(chatId, `
📊 *Bot Statistics*

👥 *Users:*
• Total: ${stats.totalUsers}
• Premium: ${stats.premiumUsers}
• Conversion: ${stats.totalUsers > 0 ? ((stats.premiumUsers / stats.totalUsers) * 100).toFixed(1) : 0}%

📡 *Tokens:*
• Last 24h: ${stats.tokens24h}
• Total alerts: ${stats.totalAlerts}
• Stored: ${stats.storedTokens}

🕒 *Uptime:* ${uptime} minutes

⭐ *Your Status:* ${isPremium ? 'PREMIUM ✅' : 'FREE 🔓'}
                `, { parse_mode: 'Markdown' });
                
            } catch (error) {
                logger.error(`Stats command error: ${error.message}`);
                this.bot.sendMessage(chatId, '❌ Error getting stats.');
            }

        }
        else{
            this.bot.sendMessage(chatId,'❌ This command is reserved for Admin only...')
        }
        });

        // ===== RECENT =====
        this.bot.onText(/\/recent/, async (msg) => {
            const chatId = msg.chat.id;
            
            try {
                const alerts = this.db.getRecentAlerts(10);
                
                if (alerts.length === 0) {
                    this.bot.sendMessage(chatId, '📭 No recent alerts.');
                    return;
                }
                
                let message = '📋 *Recent Alerts:*\n\n';
                alerts.forEach((alert, i) => {
                    const date = new Date(alert.sentAt);
                    const timeStr = date.toLocaleTimeString();
                    message += `${i+1}. $${alert.symbol} - ${timeStr}\n`;
                });
                message += `\n🔗 Total: ${alerts.length} alerts`;
                
                this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                
            } catch (error) {
                logger.error(`Recent command error: ${error.message}`);
                this.bot.sendMessage(chatId, '❌ Error fetching recent alerts.');
            }
        });

        // ===== HELP =====
        this.bot.onText(/\/help/, (msg) => {
            const chatId = msg.chat.id;
            
            this.bot.sendMessage(chatId, `
🔧 *Available Commands*

/start - Welcome and setup
/premium - Upgrade to premium
/trial - 7-day free trial
/stats - Bot statistics
/recent - Recent alerts
/test - Test bot (group only)
/help - This help menu

💡 *Tips:*
• Premium = INSTANT alerts
• Free = Standard alerts
• Add bot to group for free alerts

📞 Support: @ElitePremiumpayBot
            `, { parse_mode: 'Markdown' });
        });

        // ===== TEST COMMAND (for groups) =====
        this.bot.onText(/\/test/, async (msg) => {
            const chatId = msg.chat.id;
            const chatType = msg.chat.type;
            
            try {
                logger.info(`Test command received in ${chatType} - Chat ID: ${chatId}`);
                
                const testMsg = `
✅ *Bot is working!*

Chat Type: ${chatType}
 Chat ID: \`${chatId}\`

The bot is active and can send messages to this group. Alerts will appear here! 🚀
                `;
                
                await this.bot.sendMessage(chatId, testMsg, { parse_mode: 'Markdown' });
                logger.info(`✅ Test message sent to ${chatType} ${chatId}`);
            } catch (error) {
                logger.error(`Test command error: ${error.message}`);
            }
        });

        // ===== BOT ADDED TO GROUP/CHANNEL =====
        this.bot.on('my_chat_member', async (msg) => {
            try {
                logger.info(`my_chat_member event received - Chat: ${msg.chat.id}, Type: ${msg.chat.type}, Status: ${msg.new_chat_member.status}`);
                
                // Check if bot was added to a group or channel
                if (msg.new_chat_member.status === 'member' || msg.new_chat_member.status === 'administrator') {
                    const chatId = msg.chat.id;
                    const chatTitle = msg.chat.title || 'Unknown Chat';
                    const chatType = msg.chat.type;
                    
                    // Process both groups and channels
                    if (chatType === 'group' || chatType === 'supergroup' || chatType === 'channel') {
                        // Add to database
                        this.db.addGroup(chatId, chatTitle);
                        
                        logger.info(`✅ Bot added to ${chatType}: ${chatTitle} (${chatId})`);
                        
                        // Send welcome message
                        const welcomeMsg = `
🎉 *Alert Bot Activated!*

I'm now monitoring for premium token launches and will send you real-time alerts.

📊 *Features:*
• Real-time token alerts
• Token analysis and scoring
• Market cap tracking
• Instant notifications

📈 *Alert Types:*
🔥 High-quality tokens (Score 60+)
💎 Premium quality (Score 75+)
⚠️ Warning signals

Use /start in PM for more options!
                        `;
                        
                        await this.bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' }).catch(err => {
                            logger.error(`Failed to send welcome message to ${chatType} ${chatId}: ${err.message}`);
                        });
                        logger.info(`✅ Welcome message sent to ${chatType} ${chatId}`);
                    }
                }
                
                // Handle bot removal from group/channel
                if (msg.new_chat_member.status === 'left' || msg.new_chat_member.status === 'kicked') {
                    const chatId = msg.chat.id;
                    const chatType = msg.chat.type;
                    logger.info(`❌ Bot removed from ${chatType}: ${chatId}`);
                    // Optionally remove from database
                    if (this.db.removeGroup) {
                        this.db.removeGroup(chatId);
                    }
                }
                
            } catch (error) {
                logger.error(`Bot chat member event error: ${error.message}`);
                logger.error(error.stack);
            }
        });

        // ===== UPDATE USER ACTIVITY =====
        this.bot.on('message', async (msg) => {
            if (msg.from && msg.from.id) {
                this.db.updateUserActivity(msg.from.id);
            }
        });

        // ===== ERROR HANDLING =====
        this.bot.on('polling_error', (error) => {
            logger.error(`Polling error: ${error.message}`);
        });

        this.bot.on('webhook_error', (error) => {
            logger.error(`Webhook error: ${error.message}`);
        });
    }

    // ==========================================
    // SHUTDOWN
    // ==========================================
    async shutdown() {
        this.isShuttingDown = true;
        logger.info('Shutting down...');
        
        if (this.ws) {
            this.ws.terminate();
        }
        
        this.db.close();
        this.bot.stopPolling();
        
        logger.info('Shutdown complete');
        process.exit(0);
    }
}

// ============================================
// START BOT
// ============================================
const startTime = Date.now();

// Handle process signals
process.on('SIGINT', async () => {
    if (global.bot) {
        await global.bot.shutdown();
    }
});

process.on('SIGTERM', async () => {
    if (global.bot) {
        await global.bot.shutdown();
    }
});

// Unhandled error handlers
process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`);
    logger.error(error.stack);
});

process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
});

// Initialize bot
try {
    global.bot = new PumpFunAlertBot();
    logger.info('✅ Bot is running!');
} catch (error) {
    logger.error(`Failed to start bot: ${error.message}`);
    process.exit(1);
}
