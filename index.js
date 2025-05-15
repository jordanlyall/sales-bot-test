const http = require('http');
const { TwitterApi } = require('twitter-api-v2');
require('dotenv').config();

// HTTP server for health checks
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Art Blocks Sales Bot is running');
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});

// Check environment variables
console.log('Starting with environment check...');
const requiredVars = [
  'TWITTER_CONSUMER_KEY', 
  'TWITTER_CONSUMER_SECRET',
  'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_TOKEN_SECRET',
  'ALCHEMY_API_KEY'
];

const missingVars = requiredVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
  console.log('Continuing without some variables for debugging purposes');
}

// Initialize Twitter client
let twitterClient;
try {
  twitterClient = new TwitterApi({
    appKey: process.env.TWITTER_CONSUMER_KEY,
    appSecret: process.env.TWITTER_CONSUMER_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  });
  console.log('Twitter client initialized successfully');
} catch (error) {
  console.error('Error initializing Twitter client:', error);
}


console.log('Bot is running with Twitter client initialized');

// Add after Twitter client initialization
async function sendTestTweet() {
  if (!twitterClient) {
    console.error('Cannot send test tweet - Twitter client not initialized');
    return;
  }
  
  try {
    const tweet = await twitterClient.v2.tweet('Art Blocks sales bot is now live! Test tweet from Railway.');
    console.log('Test tweet sent successfully:', tweet.data.id);
    return tweet;
  } catch (error) {
    console.error('Error sending test tweet:', error);
    return null;
  }
}

// Call the function
sendTestTweet().then(result => {
  if (result) {
    console.log('Test tweet function completed successfully');
  } else {
    console.log('Test tweet function completed with errors');
  }
});


// Add after imports
const { Alchemy, Network } = require('alchemy-sdk');

// Add after Twitter initialization
// Initialize Alchemy client
let alchemy;
try {
  alchemy = new Alchemy({
    apiKey: process.env.ALCHEMY_API_KEY,
    network: Network.ETH_MAINNET,
  });
  console.log('Alchemy client initialized successfully');
} catch (error) {
  console.error('Error initializing Alchemy client:', error);
}


// Add after Alchemy initialization
// Art Blocks contract address
const CONTRACT_ADDRESS = '0xa7d8d9ef8D8Ce8992Df33D8b8CF4Aebabd5bD270';
const MIN_PRICE_ETH = 0.5;

// Set up marketplace mapping
const marketplaces = {
  '0x7f268357a8c2552623316e2562d90e642bb538e5': { name: 'OpenSea', url: 'https://opensea.io/assets/ethereum/0xa7d8d9ef8D8Ce8992Df33D8b8CF4Aebabd5bD270/' },
  '0x59728544b08ab483533076417fbbb2fd0b17ce3a': { name: 'LooksRare', url: 'https://looksrare.org/collections/0xa7d8d9ef8D8Ce8992Df33D8b8CF4Aebabd5bD270/' },
};

// Simple function to get project details from token ID
function getProjectDetails(tokenId) {
  const projectId = Math.floor(tokenId / 1000000);
  const tokenNumber = tokenId % 1000000;
  return {
    projectId,
    tokenNumber,
    projectName: `Art Blocks #${projectId}`,
    isCurated: true // We'll assume curated for now
  };
}

// Function to monitor sales
async function monitorSales() {
  console.log('Starting to monitor Art Blocks Curated sales...');
  
  try {
    // Set up Alchemy monitor if available
    if (alchemy) {
      console.log('Setting up Alchemy websocket listener...');
      alchemy.ws.on(
        {
          method: 'alchemy_pendingTransactions',
          fromAddress: Object.keys(marketplaces),
          toAddress: CONTRACT_ADDRESS,
        },
        async (tx) => {
          try {
            console.log(`Processing transaction: ${tx.hash}`);
            
            // Get transaction details
            const transaction = await alchemy.core.getTransaction(tx.hash);
            if (!transaction || !transaction.to) return;
            
            // Extract token ID
            const tokenId = parseInt(transaction.data.slice(74, 138), 16);
            const details = getProjectDetails(tokenId);
            
            // Skip if not curated (you can add logic here later)
            if (!details.isCurated) return;
            
            // Get price in ETH
            const priceWei = parseInt(transaction.value, 16);
            const priceEth = priceWei / 1e18;
            
            // Skip if below minimum price
            if (priceEth < MIN_PRICE_ETH) return;
            
            // Get marketplace info
            const marketplace = marketplaces[transaction.from.toLowerCase()];
            if (!marketplace) return;
            
            // Format and send tweet
            const tweetText = `🔄 Art Blocks Curated Sale 🔄\n\n${details.projectName} #${details.tokenNumber} sold for ${priceEth.toFixed(2)} ETH\n\n${marketplace.url}${tokenId}`;
            
            await twitterClient.v2.tweet(tweetText);
            console.log(`Tweeted about sale: ${tweetText}`);
          } catch (error) {
            console.error('Error processing transaction:', error);
          }
        }
      );
      console.log('Alchemy listener set up successfully');
    }
    
    console.log('Bot setup complete and running...');
  } catch (error) {
    console.error('Error in monitorSales function:', error);
  }
}

// Call at the end of the file
// Start monitoring with error handling
try {
  monitorSales();
  console.log('Monitor sales function called');
} catch (error) {
  console.error('Error starting monitor:', error);
}
