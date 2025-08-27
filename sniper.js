const WebSocket = require('ws');
const fetch = require('node-fetch');

// Config
const SniperConfig = {
    // Discord Account token, not bot token
    AccountToken: 'DISCORD_TOKEN_HERE',
    // optional just will send a chat message saying "took xMS", to turn on turn DoChatChecks: false, to true on line 25 (default)
    ChatCheckChannelId: 'CHAT_CHECK_CHANNEL_ID',
    // to remove a channel remove the line (eg line 13) and the comma on line 12
    // to add a channel create a new line inside the brakets, 'CHANNEL_ID' (make sure to add a comma at the end on the line above)
    channelIds: [
         'CHANNEL_ID_1',
         'CHANNEL_ID_2',
         'CHANNEL_ID_3'
    ],
    

    // Your Pekora cookie (get from browser DevTools use f12 then go to "Privacy and Security" and find ".PEKOSECURITY")
    pekoraCookie:  'Pekora Cookie',
    
    MaxPrice: 100,
    PurchaseDelay: 100, // Delay in ms
    IsEnabled: true, // Set to false to just monitor without buying
    DoChatChecks: false // Want you to say stuff in chat (use a priv disc server for this)
};


const ProcessedItems = new Set();
let ws = null;
let HeartbeatInterval = null;
let SessionId = null;
let ResumeGatewayUrl = null;
let username = 'Unknown';
let CurrentStats = { messages: 0, items: 0, purchases: 0 };


function GetItemIds(Id) {
    const patterns = [
        /pekora\.zip\/catalog\/(\d+)/gi,
        /pekora\.zip\/Item\/(\d+)/gi,
        /pekora\.zip\/.*[?&]id=(\d+)/gi,
        /catalog\/(\d+)/gi,
        /Item[s]?\/(\d+)/gi
    ];
    
    const itemIds = new Set();
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(Id)) !== null) {
            itemIds.add(match[1]);
        }
    }
    return Array.from(itemIds);
}
async function GetItemInfo(ItemId) {
    console.log(`   [${ItemId}] Fetching Item info from API...`);
    
    try {
        const PekoraApi = await fetch('https://www.pekora.zip/apisite/catalog/v1/catalog/items/details', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': `.PEKOSECURITY=${SniperConfig.pekoraCookie}`,
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
                    id: parseInt(ItemId)
                }]
            })
        });
        
        if (!PekoraApi.ok) {
            console.log(`   [${ItemId}] API failed with status ${PekoraApi.status}`);
            const errorText = await PekoraApi.text();
            console.log(`   [${ItemId}] API error: ${errorText.substring(0, 200)}`);
            return null;
        }
        
        const data = await PekoraApi.json();
        console.log(`   [${ItemId}] API response:`, JSON.stringify(data, null, 2));
        
        if (!data.data || !data.data[0]) {
            console.log(`   [${ItemId}] No Item data in API response`);
            return null;
        }
        
        const Item = data.data[0];
        
 
        const ItemInfo = {
            id: parseInt(ItemId),
            name: Item.name || Item.Name || 'Unknown Item',
            price: 0,
            currency: 1, // 1 = Robux, 2 = Tix
            sellerId: Item.creatorTargetId || Item.CreatorTargetId || Item.creatorId || Item.CreatorId || 1,
            isForSale: Item.isForSale || Item.IsForSale || false,
            isFree: false
        };
        
 
        console.log(`   [${ItemId}] RAW DATA - price: ${Item.price}, priceTickets: ${Item.priceTickets}, isForSale: ${Item.isForSale}`);
        

        if (Item.priceTickets !== null && Item.priceTickets !== undefined && Item.priceTickets > 0) {
            ItemInfo.price = Item.priceTickets;
            ItemInfo.currency = 2; // Tix
            console.log(`   [${ItemId}]  FOUND TIX PRICE: ${Item.priceTickets}`);
        }
     
        else if (Item.price !== null && Item.price !== undefined && Item.price > 0) {
            ItemInfo.price = Item.price;
            ItemInfo.currency = 1; // Robux
            console.log(`   [${ItemId}]  FOUND ROBUX PRICE: ${Item.price}`);
        }

        else if (Item.price === 0 && (Item.priceTickets === null || Item.priceTickets === 0)) {
            ItemInfo.isFree = true;
            ItemInfo.price = 0;
            ItemInfo.currency = 1;
            console.log(`   [${ItemId}]  FOUND FREE ITEM`);
        }

        else {
            console.log(`   [${ItemId}]  NO VALID PRICE FOUND`);
            console.log(`   [${ItemId}]  price=${Item.price}, priceTickets=${Item.priceTickets}`);
            ItemInfo.isForSale = false;
        }
        
        return ItemInfo;
        
    } catch (error) {
        console.log(`   [${ItemId}] API error: ${error.message}`);
        return null;
    }
}


async function PurchaseItem(ItemId) {
    const StartingTime = Date.now();
    console.log(`\n💰 [${ItemId}] Starting purchase...`);
    CurrentStats.purchases++;
    
    try {

        const ItemInfo = await GetItemInfo(ItemId);
        
        if (!ItemInfo) {
            console.log(`   [${ItemId}]  Could not get Item info`);
            return false;
        }
        
        if (!ItemInfo.isForSale) {
            console.log(`   [${ItemId}]  Item "${ItemInfo.name}" is not for sale`);
            return false;
        }
        

        if (ItemInfo.currency === 1 && ItemInfo.price > SniperConfig.MaxPrice) {
            console.log(`   [${ItemId}]  Price ${ItemInfo.price} Robux exceeds max ${SniperConfig.MaxPrice} - skipping`);
            return false;
        }
        
        const currencyName = ItemInfo.currency === 1 ? 'Robux' : 'Tix';
        const priceText = ItemInfo.isFree ? 'FREE' : `${ItemInfo.price} ${currencyName}`;
        
        console.log(`   [${ItemId}] PURCHASING: "${ItemInfo.name}" - ${priceText}`);
        
        return await ConfirmPurchase(ItemInfo, StartingTime);
        
    } catch (error) {
        console.log(`   [${ItemId}]  Error: ${error.message}`);
        return false;
    }
}

// Check

const SendMessage = async (Delay) => {
    if (SniperConfig.DoChatChecks) {
        if (SniperConfig.ChatCheckChannelId) {
        const url = `https://discord.com/api/v9/channels/${SniperConfig.ChatCheckChannelId}/messages`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
            'Authorization': SniperConfig.AccountToken,
            'Content-Type': 'application/json',
            'User-Agent': 'DiscordBot (https://discord.com, v9)'
            },
            body: JSON.stringify({
            content: `Took: ${Delay}ms`
            })
        });

        const Data = await response.json();

        if (response.ok) {
            // console.log(Data);
        } else {
            console.error('Cant Send ', Data);
        }
    }
  }
};


function LoopMessageChecks() {
  let Delay = Math.floor(Math.random() * (2050 - 1000 + 1)) + 1000;

  setTimeout(() => {
    SendMessage(Delay);
    LoopMessageChecks();
  }, Delay);
}

LoopMessageChecks();

async function ConfirmPurchase(ItemInfo, StartingTime) {
    const { id: ItemId, name, price, currency, sellerId } = ItemInfo;
    
    console.log(`   [${ItemId}] Making purchase request...`);
    
    const requestBody = {
        assetId: ItemId,
        expectedPrice: price,
        expectedSellerId: sellerId,
        userAssetId: null,
        expectedCurrency: currency
    };
    
    console.log(`   [${ItemId}] Request body: ${JSON.stringify(requestBody)}`);
    
    try {
        const PekoraApi = await fetch(`https://www.pekora.zip/apisite/economy/v1/purchases/products/${ItemId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                'Cookie': `.PEKOSECURITY=${SniperConfig.pekoraCookie}`,
                'Origin': 'https://www.pekora.zip',
                'Referer': `https://www.pekora.zip/catalog/${ItemId}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin'
            },
            body: JSON.stringify(requestBody)
        });
        
        const elapsed = Date.now() - StartingTime;
        
        if (PekoraApi.ok) {
            const Data = await PekoraApi.json();
            const currencyName = currency === 1 ? 'Robux' : 'Tix';
            const priceText = ItemInfo.isFree ? 'FREE' : `${price} ${currencyName}`;
            
            console.log(`   [${ItemId}]  SUCCESS! Got "${name}" for ${priceText} in ${elapsed}ms`);
            console.log(`   [${ItemId}] Response: ${JSON.stringify(Data)}`);
            return true;
        } else {
            const errorText = await PekoraApi.text();
            console.log(`   [${ItemId}]  Failed in ${elapsed}ms (Status: ${PekoraApi.status})`);
            
            try {
                const errorData = JSON.parse(errorText);
                if (errorData.errors?.[0]?.message) {
                    console.log(`   [${ItemId}] Error: ${errorData.errors[0].message}`);
                } else {
                    console.log(`   [${ItemId}] Error Data: ${JSON.stringify(errorData)}`);
                }
            } catch (e) {
                console.log(`   [${ItemId}] Error response: ${errorText.substring(0, 200)}`);
            }
        }
    } catch (error) {
        const elapsed = Date.now() - StartingTime;
        console.log(`   [${ItemId}]  Network error in ${elapsed}ms: ${error.message}`);
    }
    
    return false;
}


function ConnectToDiscord() {
    console.log(' Connecting to Discord...');
    
    const gatewayUrl = ResumeGatewayUrl || 'wss://gateway.discord.gg/?v=9&encoding=json';
    ws = new WebSocket(gatewayUrl);
    
    ws.on('open', () => {
        console.log(' Connected to Discord Gateway');
    });
    
    ws.on('message', async (Data) => {
        const message = JSON.parse(Data);
        const { op, d, t, s } = message;
        
        if (s) SessionId = s;
        
        switch (op) {
            case 10:
                StartHeartbeat(d.heartbeat_interval);
                DiscordPayload();
                break;
                
            case 11:
                break;
                
            case 0:
                await ConsoleLog(t, d);
                break;
                
            case 7:
                console.log(' Discord requested Reconnect');
                Reconnect();
                break;
                
            case 9:
                console.log(' Invalid session - reconnecting...');
                SessionId = null;
                setTimeout(() => Reconnect(), 5000);
                break;
        }
    });
    
    ws.on('error', (error) => {
        console.error(' WebSocket error:', error.message);
    });
    
    ws.on('close', (code) => {
        console.log(` Disconnected (code: ${code})`);
        clearInterval(HeartbeatInterval);
        
        if (code !== 1000) {
            console.log(' Reconnecting in 5 seconds...');
            setTimeout(() => Reconnect(), 5000);
        }
    });
}

function StartHeartbeat(interval) {
    clearInterval(HeartbeatInterval);
    HeartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: 1, d: SessionId }));
        }
    }, interval);
}

// "VERY HARD" STUFF 2025 I BREAK MONITOR

function DiscordPayload() {
    const payload = {
        op: SessionId ? 6 : 2, 
        d: SessionId ? {
            token: SniperConfig.AccountToken,
            session_id: SessionId,
            seq: SessionId
        } : {
            token: SniperConfig.AccountToken,
            intents: 33281, 
            properties: {
                $os: 'Windows',
                $browser: 'Chrome',
                $device: 'Pc'
            }
        }
    };
    
    ws.send(JSON.stringify(payload));
}

async function ConsoleLog(Events, Data) {
    switch (Events) {
        case 'READY':
            ResumeGatewayUrl = Data.resume_gateway_url;
            username = Data.user.username;
            console.clear();
            console.log(`
╔════════════════════════════════════════╗
║        PEKORA.ZIP ITEM SNIPER          ║
║         DISCORD FIXED VERSION          ║
║       (first public item sniper?)      ║
╠════════════════════════════════════════╣
║   Status: ONLINE                       ║
║   User: ${username.padEnd(28)}║
║   Monitoring: ${SniperConfig.channelIds.length} channel(s)            ║
║   Auto-Buy: ${SniperConfig.IsEnabled ? 'ENABLED' : 'DISABLED'}                   ║
╚════════════════════════════════════════╝

Monitoring Channels:
${SniperConfig.channelIds.map(id => `   • ${id}`).join('\n')}

   LIVE - Watching for Item links...
════════════════════════════════════════
`);
            break;
            
        case 'MESSAGE_CREATE':
            if (!SniperConfig.channelIds.includes(Data.channel_id)) return;
            
            CurrentStats.messages++;
            
            const itemIds = GetItemIds(Data.content);
            if (itemIds.length === 0) return;
            

            const ItemIds = itemIds.filter(id => !ProcessedItems.has(id));
            if (ItemIds.length === 0) {
                console.log(` All items already processed`);
                return;
            }
            

            ItemIds.forEach(id => ProcessedItems.add(id));
            CurrentStats.items += ItemIds.length;
            
            console.log(`
${'═'.repeat(40)}
  NEW ITEMS DETECTED! (${ItemIds.length} items)
${'═'.repeat(40)}
  Channel: ${Data.channel_id}
  Author: ${Data.author?.username || 'Unknown'}
  Item IDs: ${ItemIds.join(', ')}
  Message: "${Data.content.substring(0, 80)}..."
  Time: ${new Date().toLocaleTimeString()}
  Stats: ${CurrentStats.messages} msgs | ${CurrentStats.items} items | ${CurrentStats.purchases} purchases`);
            
            if (!SniperConfig.IsEnabled) {
                console.log('Auto-buy DISABLED\n');
                return;
            }
            
            console.log(`\nProcessing ${ItemIds.length} items in parallel...`);
            
            if (SniperConfig.PurchaseDelay > 0) {
                await new Promise(r => setTimeout(r, SniperConfig.PurchaseDelay));
            }
            
            const PurchasePromises = ItemIds.map(ItemId => 
                PurchaseItem(ItemId).catch(err => {
                    console.log(`   Error processing ${ItemId}: ${err.message}`);
                    return false;
                })
            );
            
            const FinalResult = await Promise.all(PurchasePromises);
            const Completed = FinalResult.filter(r => r).length;
            
            console.log(`\n📊 Batch complete: ${Completed}/${ItemIds.length} successful purchases`);
            console.log('═'.repeat(40));
            break;
    }
}

function Reconnect() {
    if (ws) {
        ws.terminate();
    }
    ConnectToDiscord();
}

// Hello to Console
console.log(`
 PEKORA.ZIP ITEM SNIPER
════════════════════════════

`);

// Hello to Discord

ConnectToDiscord();

// Bye bye

process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    console.log(`Final CurrentStats: ${CurrentStats.messages} messages | ${CurrentStats.items} items | ${CurrentStats.purchases} purchases`);
    
    if (ws) ws.close(1000);
    clearInterval(HeartbeatInterval);
    process.exit(0);
});

// Fuck you errors

process.on('uncaughtException', (error) => {
    console.error('Error:', error.message);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled:', error);
});

//