const WebSocket = require('ws');
const fetch = require('node-fetch');

// ============= CONFIGURATION =============
const config = {
    // Your Discord token (NOT a bot token, your actual account token)
    discordToken: 'YOUR_DISCORD_TOKEN_HERE',
    
    // Channel IDs to monitor (right-click channel -> Copy ID with dev mode enabled)
    channelIds: [
        'CHANNEL_ID_1',
        'CHANNEL_ID_2',
        'CHANNEL_ID_3'
    ],
    
    // Your Pekora.zip cookie (get from browser DevTools)
    pekoraCookie: 'YOUR_PEKORA_COOKIE_HERE',
    
    // Auto-buy settings
    maxPrice: 10000,        // Maximum price to auto-buy
    buyDelay: 100,          // Delay in ms before buying
    enabled: true           // Set to false to just monitor without buying
};


const processedItems = new Set();
let ws = null;
let heartbeatInterval = null;
let sessionId = null;
let resumeGatewayUrl = null;
let username = 'Unknown';
let stats = { messages: 0, items: 0, purchases: 0 };


function extractItemIds(text) {
    const patterns = [
        /pekora\.zip\/catalog\/(\d+)/gi,
        /pekora\.zip\/item\/(\d+)/gi,
        /pekora\.zip\/.*[?&]id=(\d+)/gi,
        /catalog\/(\d+)/gi,
        /item[s]?\/(\d+)/gi
    ];
    
    const itemIds = new Set();
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            itemIds.add(match[1]);
        }
    }
    return Array.from(itemIds);
}

async function getItemInfo(itemId) {
    console.log(`   [${itemId}] Fetching item info from API...`);
    
    try {
        const apiRes = await fetch('https://www.pekora.zip/apisite/catalog/v1/catalog/items/details', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': `.PEKOSECURITY=${config.pekoraCookie}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Origin': 'https://www.pekora.zip',
                'Referer': 'https://www.pekora.zip/',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin'
            },
            body: JSON.stringify({
                items: [{
                    itemType: "Asset",
                    id: parseInt(itemId)
                }]
            })
        });
        
        if (!apiRes.ok) {
            console.log(`   [${itemId}] API failed with status ${apiRes.status}`);
            const errorText = await apiRes.text();
            console.log(`   [${itemId}] API error: ${errorText.substring(0, 200)}`);
            return null;
        }
        
        const data = await apiRes.json();
        console.log(`   [${itemId}] API response:`, JSON.stringify(data, null, 2));
        
        if (!data.data || !data.data[0]) {
            console.log(`   [${itemId}] No item data in API response`);
            return null;
        }
        
        const item = data.data[0];
        
 
        const itemInfo = {
            id: parseInt(itemId),
            name: item.name || item.Name || 'Unknown Item',
            price: 0,
            currency: 1, // 1 = Robux, 2 = Tix
            sellerId: item.creatorTargetId || item.CreatorTargetId || item.creatorId || item.CreatorId || 1,
            isForSale: item.isForSale || item.IsForSale || false,
            isFree: false
        };
        
 
        console.log(`   [${itemId}] RAW DATA - price: ${item.price}, priceTickets: ${item.priceTickets}, isForSale: ${item.isForSale}`);
        

        if (item.priceTickets !== null && item.priceTickets !== undefined && item.priceTickets > 0) {
            itemInfo.price = item.priceTickets;
            itemInfo.currency = 2; // Tix
            console.log(`   [${itemId}]  FOUND TIX PRICE: ${item.priceTickets}`);
        }
     
        else if (item.price !== null && item.price !== undefined && item.price > 0) {
            itemInfo.price = item.price;
            itemInfo.currency = 1; // Robux
            console.log(`   [${itemId}]  FOUND ROBUX PRICE: ${item.price}`);
        }

        else if (item.price === 0 && (item.priceTickets === null || item.priceTickets === 0)) {
            itemInfo.isFree = true;
            itemInfo.price = 0;
            itemInfo.currency = 1; // Free items use Robux currency
            console.log(`   [${itemId}]  FOUND FREE ITEM`);
        }

        else {
            console.log(`   [${itemId}]  NO VALID PRICE FOUND`);
            console.log(`   [${itemId}]  price=${item.price}, priceTickets=${item.priceTickets}`);
            itemInfo.isForSale = false;
        }
        
        return itemInfo;
        
    } catch (error) {
        console.log(`   [${itemId}] API error: ${error.message}`);
        return null;
    }
}

async function purchaseItem(itemId) {
    const startTime = Date.now();
    console.log(`\n💰 [${itemId}] Starting purchase...`);
    stats.purchases++;
    
    try {

        const itemInfo = await getItemInfo(itemId);
        
        if (!itemInfo) {
            console.log(`   [${itemId}]  Could not get item info`);
            return false;
        }
        
        if (!itemInfo.isForSale) {
            console.log(`   [${itemId}]  Item "${itemInfo.name}" is not for sale`);
            return false;
        }
        

        if (itemInfo.currency === 1 && itemInfo.price > config.maxPrice) {
            console.log(`   [${itemId}]  Price ${itemInfo.price} Robux exceeds max ${config.maxPrice} - skipping`);
            return false;
        }
        
        const currencyName = itemInfo.currency === 1 ? 'Robux' : 'Tix';
        const priceText = itemInfo.isFree ? 'FREE' : `${itemInfo.price} ${currencyName}`;
        
        console.log(`   [${itemId}] PURCHASING: "${itemInfo.name}" - ${priceText}`);
        
        return await makePurchase(itemInfo, startTime);
        
    } catch (error) {
        console.log(`   [${itemId}]  Error: ${error.message}`);
        return false;
    }
}

async function makePurchase(itemInfo, startTime) {
    const { id: itemId, name, price, currency, sellerId } = itemInfo;
    
    console.log(`   [${itemId}] Making purchase request...`);
    
    const requestBody = {
        assetId: itemId,
        expectedPrice: price,
        expectedSellerId: sellerId,
        userAssetId: null,
        expectedCurrency: currency
    };
    
    console.log(`   [${itemId}] Request body: ${JSON.stringify(requestBody)}`);
    
    try {
        const purchaseRes = await fetch(`https://www.pekora.zip/apisite/economy/v1/purchases/products/${itemId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                'Cookie': `.PEKOSECURITY=${config.pekoraCookie}`,
                'Origin': 'https://www.pekora.zip',
                'Referer': `https://www.pekora.zip/catalog/${itemId}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin'
            },
            body: JSON.stringify(requestBody)
        });
        
        const elapsed = Date.now() - startTime;
        
        if (purchaseRes.ok) {
            const data = await purchaseRes.json();
            const currencyName = currency === 1 ? 'Robux' : 'Tix';
            const priceText = itemInfo.isFree ? 'FREE' : `${price} ${currencyName}`;
            
            console.log(`   [${itemId}]  SUCCESS! Got "${name}" for ${priceText} in ${elapsed}ms`);
            console.log(`   [${itemId}] Response: ${JSON.stringify(data)}`);
            return true;
        } else {
            const errorText = await purchaseRes.text();
            console.log(`   [${itemId}]  Failed in ${elapsed}ms (Status: ${purchaseRes.status})`);
            
            try {
                const errorData = JSON.parse(errorText);
                if (errorData.errors?.[0]?.message) {
                    console.log(`   [${itemId}] Error: ${errorData.errors[0].message}`);
                } else {
                    console.log(`   [${itemId}] Error data: ${JSON.stringify(errorData)}`);
                }
            } catch (e) {
                console.log(`   [${itemId}] Error response: ${errorText.substring(0, 200)}`);
            }
        }
    } catch (error) {
        const elapsed = Date.now() - startTime;
        console.log(`   [${itemId}]  Network error in ${elapsed}ms: ${error.message}`);
    }
    
    return false;
}


function connect() {
    console.log(' Connecting to Discord...');
    
    const gatewayUrl = resumeGatewayUrl || 'wss://gateway.discord.gg/?v=9&encoding=json';
    ws = new WebSocket(gatewayUrl);
    
    ws.on('open', () => {
        console.log(' Connected to Discord Gateway');
    });
    
    ws.on('message', async (data) => {
        const message = JSON.parse(data);
        const { op, d, t, s } = message;
        
        if (s) sessionId = s;
        
        switch (op) {
            case 10: // Hello
                startHeartbeat(d.heartbeat_interval);
                identify();
                break;
                
            case 11: // Heartbeat ACK
                break;
                
            case 0: // Dispatch
                await handleDispatch(t, d);
                break;
                
            case 7: // Reconnect
                console.log(' Discord requested reconnect');
                reconnect();
                break;
                
            case 9: // Invalid Session
                console.log(' Invalid session - reconnecting...');
                sessionId = null;
                setTimeout(() => reconnect(), 5000);
                break;
        }
    });
    
    ws.on('error', (error) => {
        console.error(' WebSocket error:', error.message);
    });
    
    ws.on('close', (code) => {
        console.log(` Disconnected (code: ${code})`);
        clearInterval(heartbeatInterval);
        
        if (code !== 1000) {
            console.log(' Reconnecting in 5 seconds...');
            setTimeout(() => reconnect(), 5000);
        }
    });
}

function startHeartbeat(interval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: 1, d: sessionId }));
        }
    }, interval);
}

function identify() {
    const payload = {
        op: sessionId ? 6 : 2, 
        d: sessionId ? {
            token: config.discordToken,
            session_id: sessionId,
            seq: sessionId
        } : {
            token: config.discordToken,
            intents: 33281, 
            properties: {
                $os: 'windows',
                $browser: 'chrome',
                $device: 'pc'
            }
        }
    };
    
    ws.send(JSON.stringify(payload));
}

async function handleDispatch(event, data) {
    switch (event) {
        case 'READY':
            resumeGatewayUrl = data.resume_gateway_url;
            username = data.user.username;
            console.clear();
            console.log(`
╔════════════════════════════════════════╗
║   🎯 PEKORA.ZIP DISCORD SNIPER BOT     ║
║           TIX FIXED VERSION            ║
╠════════════════════════════════════════╣
║   Status: ONLINE ✅                    ║
║   User: ${username.padEnd(28)}║
║   Monitoring: ${config.channelIds.length} channels            ║
║   Auto-Buy: ${config.enabled ? 'ENABLED ✅' : 'DISABLED ❌'}             ║
╚════════════════════════════════════════╝

📊 Monitoring Channels:
${config.channelIds.map(id => `   • ${id}`).join('\n')}

   LIVE - Watching for item links...
════════════════════════════════════════
`);
            break;
            
        case 'MESSAGE_CREATE':
            if (!config.channelIds.includes(data.channel_id)) return;
            
            stats.messages++;
            
            const itemIds = extractItemIds(data.content);
            if (itemIds.length === 0) return;
            

            const newItemIds = itemIds.filter(id => !processedItems.has(id));
            if (newItemIds.length === 0) {
                console.log(` All items already processed`);
                return;
            }
            

            newItemIds.forEach(id => processedItems.add(id));
            stats.items += newItemIds.length;
            
            console.log(`
${'═'.repeat(40)}
  NEW ITEMS DETECTED! (${newItemIds.length} items)
${'═'.repeat(40)}
  Channel: ${data.channel_id}
  Author: ${data.author?.username || 'Unknown'}
  Item IDs: ${newItemIds.join(', ')}
  Message: "${data.content.substring(0, 80)}..."
  Time: ${new Date().toLocaleTimeString()}
  Stats: ${stats.messages} msgs | ${stats.items} items | ${stats.purchases} purchases`);
            
            if (!config.enabled) {
                console.log('Auto-buy DISABLED\n');
                return;
            }
            
            // Process all items in parallel for maximum speed
            console.log(`\nProcessing ${newItemIds.length} items in parallel...`);
            
            if (config.buyDelay > 0) {
                await new Promise(r => setTimeout(r, config.buyDelay));
            }
            
            // Purchase all items simultaneously
            const purchasePromises = newItemIds.map(itemId => 
                purchaseItem(itemId).catch(err => {
                    console.log(`   Error processing ${itemId}: ${err.message}`);
                    return false;
                })
            );
            
            const results = await Promise.all(purchasePromises);
            const successCount = results.filter(r => r).length;
            
            console.log(`\n📊 Batch complete: ${successCount}/${newItemIds.length} successful purchases`);
            console.log('═'.repeat(40));
            break;
    }
}

function reconnect() {
    if (ws) {
        ws.terminate();
    }
    connect();
}

// ============= STARTUP =============
console.log(`
 PEKORA.ZIP DISCORD SNIPER
════════════════════════════

`);

// Start connection
connect();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    console.log(`Final stats: ${stats.messages} messages | ${stats.items} items | ${stats.purchases} purchases`);
    
    if (ws) ws.close(1000);
    clearInterval(heartbeatInterval);
    process.exit(0);
});

// Handle errors
process.on('uncaughtException', (error) => {
    console.error('Error:', error.message);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled:', error);
});