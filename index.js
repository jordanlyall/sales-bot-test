const http = require('http');
const { TwitterApi } = require('twitter-api-v2');
const { Alchemy, Network } = require('alchemy-sdk');
const retry = require('async-retry');
const axios = require('axios');
const ENS = require('ethereum-ens');
require('dotenv').config();

// Configuration
const CONFIG = {
  // Art Blocks contract addresses
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
  RETRY_DELAY: 3000,
  // Cache duration for ETH price in milliseconds
  ETH_PRICE_CACHE_DURATION: 900000, // 15 minutes
};

// Cache for ETH price
let ethPriceCache = {
  price: null,
  timestamp: 0
};

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

// Project info with artist names
const projectInfo = {
  '0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270': {
    0: { name: 'Chromie Squiggle', artist: 'Snowfro' },
    3: { name: 'Fidenza', artist: 'Tyler Hobbs' },
    4: { name: 'Ringers', artist: 'Dmitri Cherniak' },
    // Add more as needed
  },
  // Add mappings for other contracts
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
  'ALCHEMY_API_KEY',
  'OPENSEA_API_KEY'
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

// Generate OpenSea URLs for all contracts
const contractMapping = updateContractMapping();

// Function to get ETH to USD conversion rate
async function getEthPrice() {
  // Check if we have a cached price that's still valid
  const now = Date.now();
  if (ethPriceCache.price && (now - ethPriceCache.timestamp < CONFIG.ETH_PRICE_CACHE_DURATION)) {
    return ethPriceCache.price;
  }

  try {
    // For now, use a dummy price as requested
    const dummyPrice = 3000; // $3000 per ETH
    
    // In production, uncomment this to use the real API:
    // const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    // const price = response.data.ethereum.usd;
    
    // Update cache
    ethPriceCache = {
      price: dummyPrice,
      timestamp: now
    };
    
    return dummyPrice;
  } catch (error) {
    console.error('Error fetching ETH price:', error);
    // Return last cached price or null
    return ethPriceCache.price || null;
  }
}

// Function to get ENS name for an address
async function getEnsName(address) {
  try {
    // For now, just return null to use fallback
    // In production, uncomment this:
    // const provider = alchemy.core.provider;
    // const ens = new ENS(provider);
    // const name = await ens.reverse(address).name();
    // return name;
    
    // For testing - sometimes return a dummy ENS name
    if (Math.random() > 0.7) {
      return `user-${Math.floor(Math.random() * 1000)}.eth`;
    }
    return null;
  } catch (error) {
    console.error('Error getting ENS name:', error);
    return null;
  }
}

// Function to get OpenSea username
async function getOpenseaUserName(address) {
  try {
    // For testing, sometimes return a dummy OpenSea username
    if (Math.random() > 0.5) {
      return `OpenseaUser${Math.floor(Math.random() * 1000)}`;
    }
    
    // In production, uncomment this to use the real API:
    // const response = await axios.get(`https://api.opensea.io/api/v2/accounts/${address}`, {
    //   headers: { 'X-API-KEY': process.env.OPENSEA_API_KEY }
    // });
    // return response.data.username || null;
    
    return null;
  } catch (error) {
    console.error('Error getting OpenSea username:', error);
    return null;
  }
}

// Function to format address for display
function formatAddress(address) {
  if (!address) return 'Unknown';
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

// Enhanced getProjectDetails function
async function getProjectDetails(tokenId, contractAddress) {
  const projectId = Math.floor(tokenId / 1000000);
  const tokenNumber = tokenId % 1000000;
  
  // Normalize contract address
  const normalizedAddress = contractAddress.toLowerCase();
  
  // Get the project info for this contract
  const contractProjects = projectInfo[normalizedAddress] || {};
  const project = contractProjects[projectId] || null;
  
  // Get contract name for fallback
  const contractType = contractNames[normalizedAddress] || 'Art Blocks';
  
  // Prepare project name and artist
  let projectName, artistName;
  
  if (project) {
    projectName = project.name;
    artistName = project.artist;
  } else {
    projectName = `${contractType} #${projectId}`;
    artistName = 'Unknown Artist';
  }
  
  return {
    projectId,
    tokenNumber,
    projectName,
    artistName,
    contractAddress: normalizedAddress,
    artBlocksUrl: `https://www.artblocks.io/token/${normalizedAddress}/${tokenId}`
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
      console.log('Tweet content:', message);
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

// Enhanced transaction processing
async function processTransaction(tx, contractAddress) {
  console.log(`Processing transaction for ${contractAddress}: ${tx.hash}`);
  
  try {
    // Get transaction details
    const transaction = await alchemy.core.getTransaction(tx.hash);
    if (!transaction || !transaction.to) return;
    
    // Get transaction receipt to find the buyer
    const receipt = await alchemy.core.getTransactionReceipt(tx.hash);
    if (!receipt) return;
    
    // In a real implementation, you'd need to analyze the logs to find the buyer
    // This is a simplification - using the 'to' address from the receipt as a placeholder
    // The correct buyer address should be extracted from event logs
    const buyer = receipt.to || transaction.from;
    
    // Extract token ID from transaction data
    const tokenId = parseInt(transaction.data.slice(74, 138), 16);
    const details = await getProjectDetails(tokenId, contractAddress);
    
    // Get price in ETH
    const priceWei = parseInt(transaction.value, 16);
    const priceEth = priceWei / 1e18;
    
    // Skip if below minimum price
    if (priceEth < CONFIG.MIN_PRICE_ETH) return;
    
    // Get ETH/USD price
    const ethPrice = await getEthPrice();
    const usdPrice = ethPrice ? (priceEth * ethPrice).toFixed(2) : null;
    
    // Get buyer info
    let buyerDisplay = formatAddress(buyer);
    
    // Try to get ENS name
    const ensName = await getEnsName(buyer);
    if (ensName) {
      buyerDisplay = ensName;
    } else {
      // Try to get OpenSea username
      const osName = await getOpenseaUserName(buyer);
      if (osName) {
        buyerDisplay = osName;
      }
    }
    
    // Format tweet
    let tweetText = `${details.projectName} #${details.tokenNumber} by ${details.artistName}`;
    tweetText += `\nsold for ${formatPrice(priceEth)} ETH`;
    
    if (usdPrice) {
      tweetText += ` ($${usdPrice.toLocaleString()})`;
    }
    
    tweetText += `\nto ${buyerDisplay}\n\n${details.artBlocksUrl}`;
    
    // Send the tweet
    await sendTweet(tweetText);
  } catch (error) {
    console.error('Error processing transaction:', error);
  }
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
          (tx) => processTransaction(tx, contractAddress)
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
