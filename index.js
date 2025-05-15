const http = require('http');
const { TwitterApi } = require('twitter-api-v2');
const { Alchemy, Network } = require('alchemy-sdk');
const retry = require('async-retry');
require('dotenv').config();

// Configuration
const CONFIG = {
  // Art Blocks contract addresses - add all your contract addresses here
  CONTRACT_ADDRESSES: [
    '0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a', // Art Blocks Flagship V0
    '0xa7d8d9ef8D8Ce8992Df33D8b8CF4Aebabd5bD270', // Art Blocks Flagship V1
    '0x99a9B7c1116f9ceEB1652de04d5969CcE509B069', // Art Blocks Flagship V3
    '0xAB0000000000aa06f89B268D604a9c1C41524Ac6', // Art Blocks Curated V3.2
    '0x145789247973c5d612bf121e9e4eef84b63eb707', // Art Blocks Collaborations
    '0x64780ce53f6e966e18a22af13a2f97369580ec11', // Art Blocks Collaborations
    '0x942bc2d3e7a589fe5bd4a5c6ef9727dfd82f5c8a', // Art Blocks Explorations
    '0xea698596b6009a622c3ed00dd5a8b5d1cae4fc36', // Art Blocks Collaborations
  ],
  // OpenSea contract address
  OPENSEA_ADDRESS: '0x7f268357a8c2552623316e2562d90e642bb538e5',
  // Minimum price in ETH to report
  MIN_PRICE_ETH: 0.001,
  // How often to check if the bot is alive (in milliseconds)
  HEALTH_CHECK_INTERVAL: 3600000, // 1 hour
  // Number of retries for API calls
  MAX_RETRIES: 3,
  // Time between retries (base milliseconds)
  RETRY_DELAY: 3000
};

// Automatically generate OpenSea URLs for all contracts
function updateContractMapping() {
  const mapping = {};
  CONFIG.CONTRACT_ADDRESSES.forEach(address => {
    // Make sure address is consistent (lowercase)
    const normalizedAddress = address.toLowerCase();
    mapping[normalizedAddress] = `https://opensea.io/assets/ethereum/${normalizedAddress}/`;
  });
  return mapping;
}

// Contract name mapping for better descriptive names
const contractNames = {
  '0x059edd72cd353df5106d2b9cc5ab83a52287ac3a': 'Art Blocks Flagship V0',
  '0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270': 'Art Blocks Flagship V1',
  '0x99a9b7c1116f9ceeb1652de04d5969cce509b069': 'Art Blocks Flagship V3',
  '0xab0000000000aa06f89b268d604a9c1c41524ac6': 'Art Blocks Curated V3.2',
  '0x145789247973c5d612bf121e9e4eef84b63eb707': 'Art Blocks Collaborations',
  '0x64780ce53f6e966e18a22af13a2f97369580ec11': 'Art Blocks Collaborations',
  '0x942bc2d3e7a589fe5bd4a5c6ef9727dfd82f5c8a': 'Art Blocks Explorations',
  '0xea698596b6009a622c3ed00dd5a8b5d1cae4fc36': 'Art Blocks Collaborations',
};

// Initialize HTTP server for health checks and manual triggers
const server = http.createServer((req, res) => {
  if (req.url === '/trigger-tweet') {
    console.log('Manual tweet trigger received');
    sendTestTweet()
      .then(() => {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('Tweet triggered - check logs for results');
      })
      .catch(err => {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end('Error: ' + err.message);
      });
  } else if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Bot is healthy. Last checked: ' + new Date().toISOString());
  } else {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Art Blocks Sales Bot is running');
  }
});

// Start the server
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

// Generate OpenSea URLs for all contracts
const contractMapping = updateContractMapping();

// Project name mappings - expand this with project IDs for each contract
// You can customize this further with a nested structure if needed
const projectNameMappings = {
  // Main Art Blocks contract (flagship v1)
  '0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270': {
    0: 'Chromie Squiggle by Snowfro',
    3: 'Fidenza by Tyler Hobbs',
    4: 'Ringers by Dmitri Cherniak',
    // Add more projects here as needed
  },
  // Add mappings for other contracts as needed
};

// Simplified getProjectDetails function
function getProjectDetails(tokenId, contractAddress) {
  const projectId = Math.floor(tokenId / 1000000);
  const tokenNumber = tokenId % 1000000;
  
  // Normalize contract address
  const normalizedAddress = contractAddress.toLowerCase();
  
  // Get the project name mapping for this contract
  const contractProjects = projectNameMappings[normalizedAddress] || {};
  
  // Use mapped name if available, otherwise generate a descriptive one
  const contractType = contractNames[normalizedAddress] || 'Art Blocks';
  const projectName = contractProjects[projectId] || `${contractType} #${projectId}`;
  
  return {
    projectId,
    tokenNumber,
    projectName,
    contractAddress: normalizedAddress
  };
}

// Function to send a tweet with retry logic
async function sendTweet(message) {
  if (!twitterClient) {
    console.error('Cannot send tweet - Twitter client not initialized');
    return null;
  }

  return retry(async (bail, attempt) => {
    try {
      console.log(`Attempting to tweet (attempt ${attempt})...`);
      const tweet = await twitterClient.v2.tweet(message);
      console.log('Tweet sent successfully:', tweet.data.id);
      return tweet;
    } catch (error) {
      // Don't retry if it's a permission issue
      if (error.code === 403) {
        console.error('Permission error when tweeting:', error.message);
        bail(error);
        return null;
      }
      
      console.error(`Tweet attempt ${attempt} failed:`, error.message);
      throw error; // This will trigger a retry
    }
  }, {
    retries: CONFIG.MAX_RETRIES,
    minTimeout: CONFIG.RETRY_DELAY,
    onRetry: (error) => {
      console.log(`Retrying tweet due to error: ${error.message}`);
    }
  });
}

// Function to send a test tweet
async function sendTestTweet() {
  return sendTweet(`Art Blocks sales bot is monitoring OpenSea sales for ${CONFIG.CONTRACT_ADDRESSES.length} contracts! (${new Date().toLocaleTimeString()})`);
}

// Function to format price with commas for thousands
function formatPrice(price) {
  return price.toLocaleString('en-US', { 
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// Function to monitor sales
async function monitorSales() {
  console.log('Starting to monitor Art Blocks sales on OpenSea...');
  
  try {
    // Set up Alchemy monitor for each contract
    if (alchemy) {
      console.log('Setting up Alchemy websocket listener...');
      
      CONFIG.CONTRACT_ADDRESSES.forEach(contractAddress => {
        console.log(`Setting up listener for contract: ${contractAddress}`);
        
        alchemy.ws.on(
          {
            method: 'alchemy_pendingTransactions',
            fromAddress: CONFIG.OPENSEA_ADDRESS, // Only monitor OpenSea
            toAddress: contractAddress,
          },
          async (tx) => {
            try {
              console.log(`Processing transaction for ${contractAddress}: ${tx.hash}`);
              
              // Get transaction details
              const transaction = await alchemy.core.getTransaction(tx.hash);
              if (!transaction || !transaction.to) return;
              
              // Extract token ID from transaction data
              const tokenId = parseInt(transaction.data.slice(74, 138), 16);
              const details = getProjectDetails(tokenId, contractAddress);
              
              // Get price in ETH
              const priceWei = parseInt(transaction.value, 16);
              const priceEth = priceWei / 1e18;
              
              // Skip if below minimum price
              if (priceEth < CONFIG.MIN_PRICE_ETH) return;
              
              // Format tweet
              const tweetText = `🔄 Art Blocks Sale Alert 🔄

${details.projectName}
Token #${details.tokenNumber}

💰 ${formatPrice(priceEth)} ETH

🛒 Via OpenSea
🔗 ${contractMapping[details.contractAddress]}${tokenId}

#ArtBlocks #NFT #GenerativeArt`;
              
              // Send the tweet
              await sendTweet(tweetText);
            } catch (error) {
              console.error('Error processing transaction:', error);
            }
          }
        );
      });
      
      console.log('Alchemy listeners set up successfully');
    } else {
      console.error('Alchemy client not initialized, sales monitoring disabled');
    }
    
    console.log('Bot setup complete and running...');
    
    // Send initial test tweet
    await sendTestTweet();
  } catch (error) {
    console.error('Error in monitorSales function:', error);
  }
}

// Health check function
function setupHealthChecks() {
  // Send a health check tweet once a day to verify the bot is still running
  setInterval(async () => {
    try {
      console.log('Running health check...');
      // We won't tweet, just log that we're still alive
      console.log(`Health check passed at ${new Date().toISOString()}`);
    } catch (error) {
      console.error('Health check failed:', error);
    }
  }, CONFIG.HEALTH_CHECK_INTERVAL);
}

// Start monitoring with error handling
try {
  monitorSales();
  setupHealthChecks();
  console.log('Monitor sales function and health checks started');
} catch (error) {
  console.error('Error starting bot:', error);
}

console.log('Art Blocks Sales Bot is now running and monitoring for OpenSea sales');
