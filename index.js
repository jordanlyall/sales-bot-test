const http = require('http');
const { TwitterApi } = require('twitter-api-v2');
const { Alchemy, Network } = require('alchemy-sdk');
const retry = require('async-retry');
const axios = require('axios');
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
  RETRY_DELAY: 60000, // 1 minute (increased from 3 seconds)
  // Cache duration for ETH price in milliseconds
  ETH_PRICE_CACHE_DURATION: 900000, // 15 minutes
  // Minimum time between tweets (15 minutes)
  MIN_TIME_BETWEEN_TWEETS: 15 * 60 * 1000,
  // Whether to actually send tweets or just preview them
  DISABLE_TWEETS: true, // Set to false when ready to enable tweets
  // Initial startup delay before first tweet attempt (5 minutes)
  INITIAL_STARTUP_DELAY: 300000,
  // Cache duration for NFT metadata (1 day)
  NFT_METADATA_CACHE_DURATION: 24 * 60 * 60 * 1000
};

// Tweet queue variables
let tweetQueue = [];
let isTweetProcessing = false;
let lastTweetTime = 0;
const appStartTime = Date.now();

// Twitter rate limit tracking
let tweetFailures = 0;
let lastRateLimitTime = 0;

// Cache for ETH price
let ethPriceCache = {
  price: null,
  timestamp: 0
};

// Cache for NFT metadata
const tokenMetadataCache = {};

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

// Fallback project info (only use when all APIs fail)
const projectInfo = {};

// Known collections for artist mapping
const knownCollections = {
  'chromie squiggle': 'Snowfro',
  'fidenza': 'Tyler Hobbs',
  'ringers': 'Dmitri Cherniak',
  'archetype': 'Kjetil Golid',
  'gazers': 'Matt Kane',
  'genesis': 'DCA',
  'elevated deconstructions': 'Emon Hassan',
  'subscapes': 'Matt DesLauriers',
  'meridian': 'Matt DesLauriers',
  'sudfeh': 'Monica Rizzolli',
  'moments of computation': 'William Mapan',
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
  } else if (req.url === '/queue-status') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end(`Tweet queue status: ${tweetQueue.length} tweets waiting. Last tweet sent: ${new Date(lastTweetTime).toISOString()}. Failures: ${tweetFailures}. Tweets enabled: ${!CONFIG.DISABLE_TWEETS}`);
  } else if (req.url === '/reset-rate-limit') {
    tweetFailures = 0;
    lastRateLimitTime = 0;
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Rate limit state has been reset.');
  } else if (req.url === '/enable-tweets') {
    CONFIG.DISABLE_TWEETS = false;
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Tweets have been enabled. The bot will now post to Twitter.');
  } else if (req.url === '/disable-tweets') {
    CONFIG.DISABLE_TWEETS = true;
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Tweets have been disabled. The bot will only preview tweets in logs.');
  } else if (req.url === '/test-eth-price') {
    getEthPrice()
      .then(price => {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end(`Current ETH price: $${price}`);
      })
      .catch(err => {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end('Error getting ETH price: ' + err.message);
      });
  } else if (req.url.startsWith('/test-transaction')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const txHash = url.searchParams.get('hash');
    
    if (!txHash) {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('Error: Missing transaction hash. Use ?hash=0x... in the URL');
      return;
    }
    
    console.log(`Manual transaction test received for hash: ${txHash}`);
    
    // First get the transaction to determine which contract is involved
    alchemy.core.getTransactionReceipt(txHash)
      .then(receipt => {
        if (!receipt) {
          throw new Error('Transaction receipt not found');
        }
        
        // Find any Transfer events from our monitored contracts
        let foundContract = null;
        
        // Normalize our contract addresses for comparison
        const monitoredAddresses = CONFIG.CONTRACT_ADDRESSES.map(addr => addr.toLowerCase());
        
        // Check logs for events from our contracts
        for (const log of receipt.logs) {
          const logAddress = log.address.toLowerCase();
          if (monitoredAddresses.includes(logAddress)) {
            foundContract = logAddress;
            console.log(`Detected relevant contract: ${foundContract}`);
            break;
          }
        }
        
        if (!foundContract) {
          throw new Error('No events from monitored Art Blocks contracts found in this transaction');
        }
        
        // Create a minimal tx object with the hash
        const testTx = {
          hash: txHash
        };
        
        // Now process with the detected contract
        return processTransaction(testTx, foundContract)
          .then(() => foundContract); // Return the contract address for the response
      })
      .then((contractAddress) => {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end(`Processing transaction ${txHash} for detected contract ${contractAddress}. Check logs for results.`);
      })
      .catch(err => {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end('Error: ' + err.message);
      });
  } else if (req.url.startsWith('/test-output')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const txHash = url.searchParams.get('hash');
    
    if (!txHash) {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('Error: Missing transaction hash. Use ?hash=0x... in the URL');
      return;
    }
    
    console.log(`Testing output for hash: ${txHash}`);
    
    // First get the transaction to determine which contract is involved
    alchemy.core.getTransactionReceipt(txHash)
      .then(receipt => {
        if (!receipt) {
          throw new Error('Transaction receipt not found');
        }
        
        // Find any Transfer events from our monitored contracts
        let foundContract = null;
        
        // Normalize our contract addresses for comparison
        const monitoredAddresses = CONFIG.CONTRACT_ADDRESSES.map(addr => addr.toLowerCase());
        
        // Check logs for events from our contracts
        for (const log of receipt.logs) {
          const logAddress = log.address.toLowerCase();
          if (monitoredAddresses.includes(logAddress)) {
            foundContract = logAddress;
            console.log(`Detected relevant contract: ${foundContract}`);
            break;
          }
        }
        
        if (!foundContract) {
          throw new Error('No events from monitored Art Blocks contracts found in this transaction');
        }
        
        // Now process with the detected contract
        return testTransactionOutput(txHash, foundContract);
      })
      .then(success => {
        if (success) {
          res.writeHead(200, {'Content-Type': 'text/plain'});
          res.end(`Test completed for ${txHash}. Check logs for the tweet preview.`);
        } else {
          res.writeHead(400, {'Content-Type': 'text/plain'});
          res.end(`Failed to process transaction ${txHash}. Check logs for errors.`);
        }
      })
      .catch(err => {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end('Error: ' + err.message);
      });
  } else if (req.url.startsWith('/test-metadata')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tokenId = url.searchParams.get('tokenId');
    const contractAddress = url.searchParams.get('contract') || CONFIG.CONTRACT_ADDRESSES[0];
    
    if (!tokenId) {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('Error: Missing tokenId. Use ?tokenId=1506 in the URL');
      return;
    }
    
    console.log(`Testing metadata retrieval for token: ${tokenId} on contract: ${contractAddress}`);
    
    getProjectDetails(tokenId, contractAddress)
      .then(details => {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(details, null, 2));
      })
      .catch(err => {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end('Error: ' + err.message);
      });
  } else if (req.url.startsWith('/debug-metadata')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tokenId = url.searchParams.get('tokenId');
    const contractAddress = url.searchParams.get('contract') || CONFIG.CONTRACT_ADDRESSES[0];
    
    if (!tokenId) {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('Error: Missing tokenId. Use ?tokenId=1506 in the URL');
      return;
    }
    
    console.log(`Debugging metadata for token: ${tokenId} on contract: ${contractAddress}`);
    
    // Get Art Blocks API data
    getArtBlocksTokenInfo(tokenId, contractAddress)
      .then(artBlocksData => {
        // Get Alchemy metadata
        return getAlchemyMetadata(contractAddress, tokenId)
          .then(alchemyData => {
            // Get OpenSea collection info
            return getOpenSeaCollectionInfo(contractAddress)
              .then(osCollectionData => {
                // Compile all results
                const result = {
                  artBlocksApi: artBlocksData,
                  alchemyApi: alchemyData,
                  openSeaCollection: osCollectionData,
                  // Get the final combined metadata
                  finalMetadata: null
                };
                
                // Now get the final combined metadata
                return getProjectDetails(tokenId, contractAddress)
                  .then(finalData => {
                    result.finalMetadata = finalData;
                    
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify(result, null, 2));
                  });
              });
          });
      })
      .catch(err => {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end('Error: ' + err.message);
      });
  } else if (req.url === '/clear-cache') {
    // Clear both caches
    for (const key in tokenMetadataCache) {
      delete tokenMetadataCache[key];
    }
    ethPriceCache = { price: null, timestamp: 0 };
    
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('All caches have been cleared.');
  } else if (req.url === '/help') {
    // Create a help page with available endpoints
    const helpText = `
Art Blocks Sales Bot - Available Endpoints:
------------------------------------------

/                   - Home page (bot status)
/health             - Health check status
/queue-status       - Check status of tweet queue
/enable-tweets      - Enable sending real tweets
/disable-tweets     - Disable tweets (preview only)
/test-eth-price     - Test ETH price API
/test-transaction?hash=0x... - Test transaction processing (auto-detects contract)
/test-output?hash=0x...      - Preview tweet for a transaction (auto-detects contract)
/test-metadata?tokenId=1506  - Test metadata retrieval for a specific token
/debug-metadata?tokenId=1506 - Debug all API responses for a specific token
/clear-cache        - Clear metadata and price caches
/reset-rate-limit   - Reset rate limit tracking
/help               - Show this help page

Example usage:
/test-output?hash=0x123456...  - No need to specify contract, it will be auto-detected
/test-metadata?tokenId=1506&contract=0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a - Test metadata for a specific token
`;
    
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end(helpText);
  } else {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Art Blocks Sales Bot is running. Visit /help for available endpoints.');
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

// Function to get ETH to USD conversion rate using CoinGecko API
async function getEthPrice() {
  // Check if we have a cached price that's still valid
  const now = Date.now();
  if (ethPriceCache.price && (now - ethPriceCache.timestamp < CONFIG.ETH_PRICE_CACHE_DURATION)) {
    return ethPriceCache.price;
  }

  try {
    // Try CoinGecko API (doesn't require an API key)
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: 'ethereum',
        vs_currencies: 'usd'
      }
    });
    
    console.log('CoinGecko API response:', JSON.stringify(response.data, null, 2));
    
    // Extract ETH price from response
    const ethPrice = response.data.ethereum?.usd || 3000; // Fallback to 3000 if API fails
    console.log(`Got ETH price from CoinGecko API: $${ethPrice}`);
    
    // Update cache
    ethPriceCache = {
      price: ethPrice,
      timestamp: now
    };
    
    return ethPrice;
  } catch (error) {
    console.error('Error fetching ETH price from CoinGecko:', error.message);
    
    // Return last cached price or fallback
    return ethPriceCache.price || 3000;
  }
}

// Function to get ENS name for an address using Alchemy directly
async function getEnsName(address) {
  try {
    // Using Alchemy to resolve ENS names
    const ensName = await alchemy.core.lookupAddress(address);
    console.log(`ENS lookup for ${address}: ${ensName || 'Not found'}`);
    return ensName;
  } catch (error) {
    console.error('Error getting ENS name:', error);
    return null;
  }
}

// Function to get OpenSea username
async function getOpenseaUserName(address) {
  try {
    // Log the address we're looking up
    console.log(`Looking up OpenSea username for address: ${address}`);
    
    const response = await axios.get(`https://api.opensea.io/api/v2/accounts/${address}`, {
      headers: { 'X-API-KEY': process.env.OPENSEA_API_KEY }
    });
    
    // Log the full response to see its structure
    console.log('OpenSea API response:', JSON.stringify(response.data, null, 2));
    
    // Extract username based on response structure
    // This path may need adjustment based on actual API response
    const username = response.data.username || null;
    console.log(`Found OpenSea username: ${username || 'None'}`);
    
    return username;
  } catch (error) {
    console.error(`Error getting OpenSea username: ${error.message}`);
    // If response contains error data, log it for debugging
    if (error.response && error.response.data) {
      console.error('OpenSea API error response:', JSON.stringify(error.response.data, null, 2));
    }
    return null;
  }
}

// Function to format address for display
function formatAddress(address) {
  if (!address) return 'Unknown';
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

// Function to get Art Blocks token information
async function getArtBlocksTokenInfo(tokenId, contractAddress) {
  try {
    console.log(`Fetching from Art Blocks API for token ${tokenId}`);
    const response = await axios.get(
      `https://token.artblocks.io/${contractAddress}/${tokenId}`
    );
    
    console.log('Art Blocks API response:', JSON.stringify(response.data, null, 2));
    
    // Determine if this response has the data we need
    if (response.data && typeof response.data === 'object') {
      // Look for the artist information in various possible locations
      // Different versions of the API might structure data differently
      const data = response.data;
      
      // Return a structured object with the fields we need
      return {
        success: true,
        projectName: data.project?.name || data.title || null,
        artistName: data.project?.artist_name || data.project?.artist || data.artist || null,
        description: data.description || null,
        projectId: data.project?.projectId || null,
        tokenId: data.tokenId || tokenId,
        imageUrl: data.image || data.imageUrl || data.media?.image || null,
        // Include the full data for additional parsing if needed
        fullData: data
      };
    }
    
    return { success: false };
  } catch (error) {
    console.error('Error fetching from Art Blocks API:', error.message);
    return { success: false };
  }
}

// Function to extract artist from Alchemy metadata with improved logic
function extractArtistFromAlchemy(nftMetadata) {
  if (!nftMetadata) return null;
  
  // Log all attributes for debugging
  if (nftMetadata.rawMetadata?.attributes) {
    console.log('All attributes:', JSON.stringify(nftMetadata.rawMetadata.attributes, null, 2));
  }
  
  // Try different approaches to find the artist
  
  // Method 1: Check for an attribute with trait_type "artist"
  const artistAttribute = nftMetadata.rawMetadata?.attributes?.find(
    attr => attr.trait_type?.toLowerCase() === 'artist' || 
           attr.trait_type?.toLowerCase() === 'created by'
  );
  
  if (artistAttribute?.value) {
    console.log(`Found artist in 'artist' trait: ${artistAttribute.value}`);
    return artistAttribute.value;
  }
  
  // Method 2: Look for any attribute containing the word "artist" or "creator"
  const artistLikeAttribute = nftMetadata.rawMetadata?.attributes?.find(
    attr => 
      (attr.trait_type && (
        attr.trait_type.toLowerCase().includes('artist') || 
        attr.trait_type.toLowerCase().includes('creator') ||
        attr.trait_type.toLowerCase().includes('author')
      )) ||
      (attr.key && (
        attr.key.toLowerCase().includes('artist') ||
        attr.key.toLowerCase().includes('creator') ||
        attr.key.toLowerCase().includes('author')
      ))
  );
  
  if (artistLikeAttribute?.value) {
    console.log(`Found artist in artist-like trait: ${artistLikeAttribute.value}`);
    return artistLikeAttribute.value;
  }
  
  // Method 3: Check for 'creator' field in the rawMetadata
  if (nftMetadata.rawMetadata?.creator) {
    console.log(`Found creator field: ${nftMetadata.rawMetadata.creator}`);
    return nftMetadata.rawMetadata.creator;
  }
  
  // Method 4: Check for contract-level metadata about the creator
  if (nftMetadata.contract?.openSea?.collectionName) {
    // This is a bit of a stretch, but sometimes collection name includes creator
    const collectionName = nftMetadata.contract.openSea.collectionName;
    console.log(`Collection name from contract data: ${collectionName}`);
    
    if (nftMetadata.contract.openSea.safelistRequestStatus === 'verified') {
      // If this is a verified collection, the description might contain artist info
      console.log('Collection is verified, checking description');
      if (nftMetadata.contract.openSea?.description) {
        const desc = nftMetadata.contract.openSea.description.toLowerCase();
        // Look for "by [name]" pattern in description
        const byMatch = desc.match(/by\s+([a-z0-9\s]+)/i);
        if (byMatch && byMatch[1]) {
          console.log(`Found potential artist in description: ${byMatch[1]}`);
          return byMatch[1].trim();
        }
      }
    }
  }
  
  // Method 5: Check if the title contains "by [name]" pattern
  if (nftMetadata.title) {
    const titleMatch = nftMetadata.title.match(/by\s+([a-z0-9\s]+)/i);
    if (titleMatch && titleMatch[1]) {
      console.log(`Found potential artist in title: ${titleMatch[1]}`);
      return titleMatch[1].trim();
    }
  }
  
  // Method 6: Check for specific Art Blocks format in attributes
  // Art Blocks often has specific naming patterns in attributes
  const projectAttribute = nftMetadata.rawMetadata?.attributes?.find(
    attr => attr.trait_type?.includes('Squiggle') || 
           attr.trait_type?.includes('Fidenza') ||
           attr.trait_type?.includes('Ringers')
  );
  
  if (projectAttribute) {
    console.log(`Found potential project-specific attribute: ${JSON.stringify(projectAttribute)}`);
    // Since we're not using hardcoded mapping anymore, we can't directly map from this
  }
  
  console.log('Could not find artist information in Alchemy metadata');
  return null;
}

// Function to get metadata from Alchemy NFT API
async function getAlchemyMetadata(contractAddress, tokenId) {
  try {
    console.log(`Fetching NFT metadata from Alchemy for token ${tokenId}`);
    const nftMetadata = await alchemy.nft.getNftMetadata(
      contractAddress,
      tokenId
    );
    
    console.log('Alchemy NFT metadata:', JSON.stringify(nftMetadata, null, 2));
    
    if (!nftMetadata) {
      return { success: false };
    }
    
    // Extract the project name (removing any token number suffix)
    let projectName = nftMetadata.title || nftMetadata.contract?.name || '';
    projectName = projectName.replace(/ #\d+$/, '');
    
    // Extract artist name using our helper function
    const artistName = extractArtistFromAlchemy(nftMetadata);
    
    // Get the token number
    const tokenNumber = nftMetadata.tokenId || tokenId;
    
    return {
      success: true,
      projectName,
      artistName,
      tokenNumber,
      description: nftMetadata.description,
      imageUrl: nftMetadata.media?.[0]?.gateway || null,
      fullData: nftMetadata
    };
  } catch (error) {
    console.error('Error fetching from Alchemy:', error.message);
    return { success: false };
  }
}

// Function to get OpenSea collection info (as backup)
async function getOpenSeaCollectionInfo(contractAddress) {
  try {
    console.log(`Looking up collection info for contract: ${contractAddress}`);
    
    const response = await axios.get(
      `https://api.opensea.io/api/v2/chain/ethereum/contract/${contractAddress}`,
      { headers: { 'X-API-KEY': process.env.OPENSEA_API_KEY } }
    );
    
    console.log('OpenSea collection info:', JSON.stringify(response.data, null, 2));
    
    if (response.data) {
      return {
        success: true,
        name: response.data.name,
        description: response.data.description,
        // Extract other useful fields
        fullData: response.data
      };
    }
    
    return { success: false };
  } catch (error) {
    console.error('Error getting OpenSea collection info:', error.message);
    return { success: false };
  }
}

// Enhanced getProjectDetails function with dynamic API fetching
async function getProjectDetails(tokenId, contractAddress) {
  const normalizedAddress = contractAddress.toLowerCase();
  const cacheKey = `${normalizedAddress}-${tokenId}`;
  
  // Check if we have cached metadata that's still valid
  const now = Date.now();
  if (tokenMetadataCache[cacheKey] && 
      (now - tokenMetadataCache[cacheKey].timestamp < CONFIG.NFT_METADATA_CACHE_DURATION)) {
    console.log(`Using cached metadata for ${cacheKey}`);
    return tokenMetadataCache[cacheKey].data;
  }
  
  // Calculate project ID and token number for fallback
  const projectId = Math.floor(tokenId / 1000000);
  const tokenNumber = tokenId % 1000000;
  
  let projectName = '';
  let artistName = '';
  let description = '';
  
  // 1. Try Art Blocks API first (most authoritative source)
  const artBlocksData = await getArtBlocksTokenInfo(tokenId, normalizedAddress);
  
  if (artBlocksData && artBlocksData.success) {
    console.log('Successfully fetched data from Art Blocks API');
    
    projectName = artBlocksData.projectName || '';
    artistName = artBlocksData.artistName || '';
    description = artBlocksData.description || '';
    
    console.log(`Art Blocks API returned - Project: ${projectName}, Artist: ${artistName}`);
  } 
  
  // 2. If Art Blocks API didn't provide complete info, try Alchemy
  if (!projectName || !artistName) {
    const alchemyData = await getAlchemyMetadata(normalizedAddress, tokenId);
    
    if (alchemyData && alchemyData.success) {
      console.log('Successfully fetched data from Alchemy API');
      
      // Only use Alchemy data if the Art Blocks API didn't provide it
      if (!projectName) projectName = alchemyData.projectName || '';
      if (!artistName) artistName = alchemyData.artistName || '';
      if (!description) description = alchemyData.description || '';
      
      console.log(`Alchemy API returned - Project: ${projectName}, Artist: ${artistName}`);
    }
  }
  
  // 3. If we still don't have complete info, try OpenSea token information
  if (!projectName || !artistName) {
    try {
      // Try to get token data from OpenSea
      console.log(`Trying OpenSea API for token ${tokenId}`);
      const osTokenResponse = await axios.get(
        `https://api.opensea.io/api/v2/chain/ethereum/contract/${normalizedAddress}/nfts/${tokenId}`,
        { headers: { 'X-API-KEY': process.env.OPENSEA_API_KEY } }
      );
      
      console.log('OpenSea token API response:', JSON.stringify(osTokenResponse.data, null, 2));
      
      if (osTokenResponse.data) {
        const osData = osTokenResponse.data;
        
        // Only use OpenSea data if we don't already have it
        if (!projectName) {
          projectName = osData.name || osData.collection?.name || '';
          // Remove token number if present
          projectName = projectName.replace(/ #\d+$/, '');
        }
        
        // Try to extract artist from traits
        if (!artistName && osData.traits) {
          const artistTrait = osData.traits.find(
            trait => 
              trait.trait_type?.toLowerCase() === 'artist' || 
              trait.trait_type?.toLowerCase().includes('artist') ||
              trait.trait_type?.toLowerCase() === 'created by' ||
              trait.trait_type?.toLowerCase().includes('creator')
          );
          
          if (artistTrait?.value) {
            artistName = artistTrait.value;
          }
          
          // Look for specific Art Blocks traits that might have artist info
          if (!artistName) {
            // Sometimes the trait has project name in it like "Chromie Squiggle"
            // We'll check all traits for ones with values that might have artist info
            for (const trait of osData.traits) {
              if (trait.value && typeof trait.value === 'string') {
                if (trait.value.toLowerCase().includes('by ')) {
                  const byParts = trait.value.split('by ');
                  if (byParts.length > 1) {
                    artistName = byParts[1].trim();
                    console.log(`Found artist in trait value: ${artistName}`);
                    break;
                  }
                }
              }
            }
          }
        }
        
        // Try to find artist in description
        if (!artistName && osData.description) {
          const desc = osData.description.toLowerCase();
          const byMatch = desc.match(/by\s+([a-z0-9\s]+)/i);
          if (byMatch && byMatch[1]) {
            artistName = byMatch[1].trim();
            console.log(`Found artist in description: ${artistName}`);
          }
        }
        
        if (!description) {
          description = osData.description || '';
        }
        
        console.log(`OpenSea token API returned - Project: ${projectName}, Artist: ${artistName}`);
      }
    } catch (osTokenError) {
      console.error('Error fetching from OpenSea token API:', osTokenError.message);
      
      // 4. If token-level data fails, try collection-level data
      if (!projectName || !artistName) {
        const osCollectionData = await getOpenSeaCollectionInfo(normalizedAddress);
        
        if (osCollectionData && osCollectionData.success) {
          if (!projectName) projectName = osCollectionData.name || '';
          
          // Try to find artist in collection description
          if (!artistName && osCollectionData.description) {
            const desc = osCollectionData.description.toLowerCase();
            const byMatch = desc.match(/by\s+([a-z0-9\s]+)/i);
            if (byMatch && byMatch[1]) {
              artistName = byMatch[1].trim();
              console.log(`Found artist in collection description: ${artistName}`);
            }
          }
          
          console.log(`OpenSea collection API returned - Project: ${projectName}, Artist: ${artistName}`);
        }
      }
    }
  }
  
  // 5. Final fallback to contract name if we still don't have a project name
  if (!projectName) {
    const contractType = contractNames[normalizedAddress] || 'Art Blocks';
    projectName = `${contractType} Project #${projectId}`;
  }
  
  // 6. Final fallback for artist name - extract from name or description 
  if (!artistName) {
    // Try to extract from project name if it follows "Name by Artist" pattern
    if (projectName) {
      const nameParts = projectName.match(/(.*) by (.*)/i);
      if (nameParts && nameParts.length > 2) {
        artistName = nameParts[2].trim();
        console.log(`Found artist in project name: ${artistName}`);
      }
    }
    
    // Try to extract from description
    if (!artistName && description) {
      const descMatch = description.match(/by\s+([a-z0-9\s]+)/i);
      if (descMatch && descMatch[1]) {
        artistName = descMatch[1].trim();
        console.log(`Found artist in description: ${artistName}`);
      }
    }
    
    // If still no artist, label as unknown
    if (!artistName) {
      artistName = 'Unknown Artist';
    }
  }
  
  // Create result object
  const result = {
    projectId,
    tokenNumber,
    projectName: projectName.trim(),
    artistName: artistName.trim(),
    contractAddress: normalizedAddress,
    artBlocksUrl: `https://www.artblocks.io/token/${normalizedAddress}/${tokenId}`
  };
  
  // Cache the result with timestamp
  tokenMetadataCache[cacheKey] = {
    data: result,
    timestamp: Date.now()
  };
  
  console.log(`Final metadata - Project: ${result.projectName}, Artist: ${result.artistName}, Token: ${result.tokenNumber}`);
  
  return result;
}

// Function to check Twitter's status before tweeting
async function checkTwitterStatus() {
  // If we've hit rate limits recently, we should wait longer
  const now = Date.now();
  const timeSinceLastRateLimit = now - lastRateLimitTime;
  
  if (lastRateLimitTime > 0 && timeSinceLastRateLimit < 30 * 60 * 1000) {
    // Less than 30 minutes since last rate limit
    const remainingCooldown = 30 * 60 * 1000 - timeSinceLastRateLimit;
    const minutes = Math.ceil(remainingCooldown / 60000);
    console.log(`Twitter appears to be rate limited. Recommended to wait ${minutes} more minutes before tweeting.`);
    return false;
  }
  
  return true;
}

// Modified to either send tweet or just preview based on configuration
async function sendTweet(message) {
  // If tweets are disabled, just log a preview
  if (CONFIG.DISABLE_TWEETS) {
    console.log('\n--- TWEET PREVIEW (DISABLED) ---\n');
    console.log(message);
    console.log('\n---------------------\n');
    
    // Return fake successful tweet object
    return { data: { id: 'preview-only-' + Date.now() } };
  }
  
  // Otherwise, proceed with actual tweeting
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
      
      // Special handling for rate limits
      if (error.code === 429 || error.message.includes('rate limit') || error.message.includes('429')) {
        const delaySeconds = attempt * 120; // 2, 4, 6 minutes between retries
        console.error(`Rate limit exceeded (attempt ${attempt}). Will retry after ${delaySeconds} seconds.`);
        
        // Record rate limit time
        lastRateLimitTime = Date.now();
        
        // Add fixed increasing delay for rate limits
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
      }
      
      console.error(`Tweet attempt ${attempt} failed:`, error.message);
      throw error; // This will trigger a retry
    }
  }, {
    retries: CONFIG.MAX_RETRIES,
    minTimeout: CONFIG.RETRY_DELAY,
    maxTimeout: 360000, // 6 minutes max
    factor: 2, // Exponential backoff factor
    onRetry: (error) => {
      // Use a simpler, fixed calculation to avoid NaN
      const seconds = Math.min(60 * error.attemptNumber, 360); // 1, 2, 3, 4, 5, 6 minutes
      console.log(`Retrying tweet after ${seconds} seconds due to error: ${error.message}`);
    }
  });
}

// Function to process the tweet queue with rate limiting
async function processTweetQueue() {
  if (isTweetProcessing || tweetQueue.length === 0) {
    return;
  }
  
  // Don't process queue for first 5 minutes after startup
  if (Date.now() - appStartTime < CONFIG.INITIAL_STARTUP_DELAY) {
    console.log("App recently started; waiting before processing tweet queue");
    setTimeout(processTweetQueue, 60000);
    return;
  }
  
  isTweetProcessing = true;
  
  try {
    // Check Twitter status first
    const twitterReady = await checkTwitterStatus();
    if (!twitterReady) {
      console.log("Twitter appears to be rate limited. Delaying queue processing.");
      isTweetProcessing = false;
      // Try again after 5 minutes
      setTimeout(processTweetQueue, 5 * 60 * 1000);
      return;
    }
    
    // Check if we need to wait before sending next tweet
    const now = Date.now();
    const timeSinceLastTweet = now - lastTweetTime;
    
    if (timeSinceLastTweet < CONFIG.MIN_TIME_BETWEEN_TWEETS && lastTweetTime > 0) {
      const waitTime = CONFIG.MIN_TIME_BETWEEN_TWEETS - timeSinceLastTweet;
      const waitMinutes = Math.ceil(waitTime / 60000);
      console.log(`Waiting ${waitMinutes} minutes before sending next tweet due to rate limiting...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Get next tweet from queue
    const message = tweetQueue.shift();
    
    // Check if Twitter might be rate limited
    if (tweetFailures > 0) {
      const extraDelay = tweetFailures * 3 * 60 * 1000; // 3, 6, 9 minutes based on previous failures
      console.log(`Adding extra ${extraDelay/60000} minutes delay due to previous ${tweetFailures} failed attempts`);
      await new Promise(resolve => setTimeout(resolve, extraDelay));
    }
    
    // Send the tweet (or preview if disabled)
    try {
      await sendTweet(message);
      // Reset failure count on success
      tweetFailures = 0;
    } catch (error) {
      // Increment failure count
      tweetFailures++;
      console.error(`Tweet failed (total failures: ${tweetFailures}):`, error);
      // Put message back in queue if it's not a permanent error
      if (!error.message.includes('403')) {
        tweetQueue.unshift(message);
      }
    }
    
    // Update last tweet time
    lastTweetTime = Date.now();
  } catch (error) {
    console.error('Error processing tweet queue:', error);
  } finally {
    isTweetProcessing = false;
    
    // Process next tweet in queue if any, with a delay if there have been failures
    if (tweetQueue.length > 0) {
      const nextDelay = tweetFailures > 0 ? 5 * 60 * 1000 : 1000; // 5 minutes if failures, 1 second otherwise
      setTimeout(processTweetQueue, nextDelay);
    }
  }
}

// Function to add tweets to queue instead of sending immediately
function queueTweet(message) {
  console.log('Adding tweet to queue:', message);
  tweetQueue.push(message);
  
  // Start processing if not already running
  if (!isTweetProcessing) {
    processTweetQueue();
  }
  
  return true; // Immediate response for non-blocking operation
}

// Function to send a test tweet
async function sendTestTweet() {
  return queueTweet(`Art Blocks sales bot is monitoring OpenSea sales for ${CONFIG.CONTRACT_ADDRESSES.length} contracts! (${new Date().toLocaleTimeString()})`);
}

// Function to format price with commas for thousands
function formatPrice(price) {
  return price.toLocaleString('en-US', { 
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// Enhanced transaction processing with proper OpenSea price detection
async function processTransaction(tx, contractAddress) {
  console.log(`Processing transaction for ${contractAddress}: ${tx.hash}`);
  
  try {
    // Get transaction details
    const transaction = await alchemy.core.getTransaction(tx.hash);
    if (!transaction || !transaction.to) {
      console.log('Transaction not found or invalid');
      return false;
    }
    
    // Get transaction receipt with logs
    const receipt = await alchemy.core.getTransactionReceipt(tx.hash);
    if (!receipt) {
      console.log('Receipt not found');
      return false;
    }
    
    // For debugging, log transaction details
    console.log('Transaction value:', transaction.value);
    if (transaction.data && transaction.data.length > 66) {
      console.log('Transaction data (first 66 chars):', transaction.data.substring(0, 66) + '...');
    } else {
      console.log('Transaction data:', transaction.data);
    }
    
    // Look for ERC-721 Transfer event in the logs
    const transferEvents = receipt.logs.filter(log => {
      // Check if it's from the contract we're monitoring
      const isFromMonitoredContract = log.address.toLowerCase() === contractAddress.toLowerCase();
      
      // Check if it's a Transfer event (keccak256 hash of Transfer(address,address,uint256))
      const isTransferEvent = log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      
      return isFromMonitoredContract && isTransferEvent;
    });
    
    if (transferEvents.length === 0) {
      console.log('No Transfer events found in transaction');
      return false;
    }
    
    // Get the last Transfer event (usually the most relevant one for sales)
    const transferEvent = transferEvents[transferEvents.length - 1];
    console.log('Transfer event topics:', JSON.stringify(transferEvent.topics, null, 2));
    
    // Parse the event data
    const fromAddress = '0x' + transferEvent.topics[1].slice(26);
    const toAddress = '0x' + transferEvent.topics[2].slice(26);
    
    // Parse tokenId - if it's in topics[3], it's indexed
    let tokenId;
    if (transferEvent.topics.length > 3) {
      tokenId = parseInt(transferEvent.topics[3], 16);
    } else {
      tokenId = parseInt(transferEvent.data, 16);
    }
    
    console.log(`Extracted from event - From: ${fromAddress}, To: ${toAddress}, TokenId: ${tokenId}`);
    
    // PRICE EXTRACTION - MULTIPLE METHODS
    
    // Method 1: Look for OrderFulfilled events (OpenSea Seaport)
    let priceEth = 0;
    
    // The OpenSea Seaport contract event for a sale
    const orderFulfilledEvents = receipt.logs.filter(log => {
      // OrderFulfilled event signature: 0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31
      return log.topics[0] === '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31';
    });
    
    if (orderFulfilledEvents.length > 0) {
      console.log('Found OrderFulfilled event - parsing price data');
      
      // OrderFulfilled events contain offer and consideration arrays in the data
      // We need to look through consideration items for ETH/WETH payments
      const orderFulfilledEvent = orderFulfilledEvents[0];
      
      // For debugging
      console.log('OrderFulfilled data:', orderFulfilledEvent.data);
      
      // Decode OrderFulfilled event data - This is a simplified approach
      // In a full implementation, you'd need to parse the consideration items
      // Extract consideration items that are ETH/WETH to get the total payment
      
      // For now, we can try to use the original Ethereum value from the transaction
      // if it's not too small (indicating it might be the actual payment)
      if (BigInt(transaction.value) > BigInt(1e16)) { // More than 0.01 ETH
        priceEth = Number(BigInt(transaction.value)) / 1e18;
        console.log(`Using transaction value as price: ${priceEth} ETH`);
      } else {
        // Look for payment parameters in the event data
        // This is a simplified approach - a full implementation would
        // require properly decoding the complex OrderFulfilled event
        
        // The data field contains consideration items that include payments
        // Example consideration structure from data (simplified hexadecimal view):
        // ...00000000000020000000000000000000000000000000000000000003a352944295e40000...
        //                                                          ^^^^^^^^^^^^^^ ETH payment amount (in wei)
        
        // For debugging 
        if (orderFulfilledEvent.data.includes('0000000000000000000000000000000000000000')) {
          // Try to find native ETH payment (address 0x0000...)
          const ethPositionHint = orderFulfilledEvent.data.indexOf('0000000000000000000000000000000000000000');
          if (ethPositionHint > 0) {
            // Look for value 64 chars after this position
            const potentialAmountHex = '0x' + orderFulfilledEvent.data.substring(ethPositionHint + 64, ethPositionHint + 64 + 64);
            console.log('Potential ETH amount hex:', potentialAmountHex);
            
            try {
              const amountWei = BigInt(potentialAmountHex);
              if (amountWei > 0) {
                priceEth = Number(amountWei) / 1e18;
                console.log(`Extracted payment amount from OrderFulfilled data: ${priceEth} ETH`);
              }
            } catch (error) {
              console.error('Error parsing potential ETH amount:', error);
            }
          }
        }
      }
    }
    
    // Method 2: Look for direct ETH/WETH transfers
    if (priceEth === 0) {
      // Check for ETH/WETH transfers
      const wethAddress = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
      
      const wethTransfers = receipt.logs.filter(log => {
        return log.address.toLowerCase() === wethAddress.toLowerCase() && 
               log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      });
      
      if (wethTransfers.length > 0) {
        console.log('Found WETH transfer event');
        // WETH Transfer contains amount in data field
        const wethTransfer = wethTransfers[0];
        const amountWei = BigInt(wethTransfer.data);
        priceEth = Number(amountWei) / 1e18;
        console.log(`Extracted WETH payment: ${priceEth} ETH`);
      } else if (BigInt(transaction.value) > BigInt(1e16)) {
        // Use direct ETH value as fallback if significant
        priceEth = Number(BigInt(transaction.value)) / 1e18;
        console.log(`Using direct transaction value as price: ${priceEth} ETH`);
      }
    }
    
    console.log(`Final sale price: ${priceEth} ETH`);
    
    // Skip if below minimum price or zero
    if (priceEth < CONFIG.MIN_PRICE_ETH || priceEth === 0) {
      console.log(`Price ${priceEth} ETH is below minimum threshold or zero, skipping`);
      return false;
    }
    
    // Get project details
    const details = await getProjectDetails(tokenId, contractAddress);
    console.log('Project details:', JSON.stringify(details, null, 2));
    
    // Get ETH/USD price
    const ethPrice = await getEthPrice();
    const usdPrice = ethPrice ? (priceEth * ethPrice) : null;
    
    // Get buyer info (using toAddress from Transfer event)
    let buyerDisplay = formatAddress(toAddress);
    
    // Try to get ENS name
    const ensName = await getEnsName(toAddress);
    if (ensName) {
      buyerDisplay = ensName;
    } else {
      // Try to get OpenSea username
      const osName = await getOpenseaUserName(toAddress);
      if (osName) {
        buyerDisplay = osName;
      }
    }
    
    // Format tweet
    // Make sure the project name doesn't already contain the token number
    const projectName = details.projectName.replace(/ #\d+$/, '');
    
    let tweetText = `${projectName} #${details.tokenNumber} by ${details.artistName}`;
    tweetText += `\nsold for ${formatPrice(priceEth)} ETH`;
    
    if (usdPrice) {
      tweetText += ` ($${formatPrice(usdPrice)})`;
    }
    
    tweetText += `\nto ${buyerDisplay}\n\n${details.artBlocksUrl}`;
    
    console.log('\n--- TWEET PREVIEW ---\n');
    console.log(tweetText);
    console.log('\n---------------------\n');
    
    // Add tweet to queue instead of sending immediately
    queueTweet(tweetText);
    
    // Return success
    return true;
  } catch (error) {
    console.error('Error processing transaction:', error);
    return false;
  }
}

// Updated test function with the same price detection logic
async function testTransactionOutput(txHash, contractAddress) {
  try {
    console.log(`Testing output for transaction: ${txHash}`);
    
    // Get transaction details
    const transaction = await alchemy.core.getTransaction(txHash);
    if (!transaction || !transaction.to) {
      console.log('Transaction not found or invalid');
      return false;
    }
    
    // Get transaction receipt with logs
    const receipt = await alchemy.core.getTransactionReceipt(txHash);
    if (!receipt) {
      console.log('Receipt not found');
      return false;
    }
    
    // For debugging, log transaction details
    console.log('Transaction value:', transaction.value);
    if (transaction.data && transaction.data.length > 66) {
      console.log('Transaction data (first 66 chars):', transaction.data.substring(0, 66) + '...');
    } else {
      console.log('Transaction data:', transaction.data);
    }
    
    // Look for ERC-721 Transfer event in the logs
    const transferEvents = receipt.logs.filter(log => {
      // Check if it's from the contract we're monitoring
      const isFromMonitoredContract = log.address.toLowerCase() === contractAddress.toLowerCase();
      
      // Check if it's a Transfer event (keccak256 hash of Transfer(address,address,uint256))
      const isTransferEvent = log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      
      return isFromMonitoredContract && isTransferEvent;
    });
    
    if (transferEvents.length === 0) {
      console.log('No Transfer events found in transaction');
      return false;
    }
    
    // Get the last Transfer event (usually the most relevant one for sales)
    const transferEvent = transferEvents[transferEvents.length - 1];
    console.log('Transfer event topics:', JSON.stringify(transferEvent.topics, null, 2));
    
    // Parse the event data
    const fromAddress = '0x' + transferEvent.topics[1].slice(26);
    const toAddress = '0x' + transferEvent.topics[2].slice(26);
    
    // Parse tokenId - if it's in topics[3], it's indexed
    let tokenId;
    if (transferEvent.topics.length > 3) {
      tokenId = parseInt(transferEvent.topics[3], 16);
    } else {
      tokenId = parseInt(transferEvent.data, 16);
    }
    
    console.log(`Extracted from event - From: ${fromAddress}, To: ${toAddress}, TokenId: ${tokenId}`);
    
    // PRICE EXTRACTION - MULTIPLE METHODS
    
    // Method 1: Look for OrderFulfilled events (OpenSea Seaport)
    let priceEth = 0;
    
    // The OpenSea Seaport contract event for a sale
    const orderFulfilledEvents = receipt.logs.filter(log => {
      // OrderFulfilled event signature: 0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31
      return log.topics[0] === '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31';
    });
    
    if (orderFulfilledEvents.length > 0) {
      console.log('Found OrderFulfilled event - parsing price data');
      
      // OrderFulfilled events contain offer and consideration arrays in the data
      // We need to look through consideration items for ETH/WETH payments
      const orderFulfilledEvent = orderFulfilledEvents[0];
      
      // For debugging
      console.log('OrderFulfilled data:', orderFulfilledEvent.data);
      
      // Decode OrderFulfilled event data - This is a simplified approach
      // In a full implementation, you'd need to parse the consideration items
      // Extract consideration items that are ETH/WETH to get the total payment
      
      // For now, we can try to use the original Ethereum value from the transaction
      // if it's not too small (indicating it might be the actual payment)
      if (BigInt(transaction.value) > BigInt(1e16)) { // More than 0.01 ETH
        priceEth = Number(BigInt(transaction.value)) / 1e18;
        console.log(`Using transaction value as price: ${priceEth} ETH`);
      } else {
        // Look for payment parameters in the event data
        // This is a simplified approach - a full implementation would
        // require properly decoding the complex OrderFulfilled event
        
        // The data field contains consideration items that include payments
        // Example consideration structure from data (simplified hexadecimal view):
        // ...00000000000020000000000000000000000000000000000000000003a352944295e40000...
        //                                                          ^^^^^^^^^^^^^^ ETH payment amount (in wei)
        
        // For debugging 
        if (orderFulfilledEvent.data.includes('0000000000000000000000000000000000000000')) {
          // Try to find native ETH payment (address 0x0000...)
          const ethPositionHint = orderFulfilledEvent.data.indexOf('0000000000000000000000000000000000000000');
          if (ethPositionHint > 0) {
            // Look for value 64 chars after this position
            const potentialAmountHex = '0x' + orderFulfilledEvent.data.substring(ethPositionHint + 64, ethPositionHint + 64 + 64);
            console.log('Potential ETH amount hex:', potentialAmountHex);
            
            try {
              const amountWei = BigInt(potentialAmountHex);
              if (amountWei > 0) {
                priceEth = Number(amountWei) / 1e18;
                console.log(`Extracted payment amount from OrderFulfilled data: ${priceEth} ETH`);
              }
            } catch (error) {
              console.error('Error parsing potential ETH amount:', error);
            }
          }
        }
      }
    }
    
    // Method 2: Look for direct ETH/WETH transfers
    if (priceEth === 0) {
      // Check for ETH/WETH transfers
      const wethAddress = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
      
      const wethTransfers = receipt.logs.filter(log => {
        return log.address.toLowerCase() === wethAddress.toLowerCase() && 
               log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      });
      
      if (wethTransfers.length > 0) {
        console.log('Found WETH transfer event');
        // WETH Transfer contains amount in data field
        const wethTransfer = wethTransfers[0];
        const amountWei = BigInt(wethTransfer.data);
        priceEth = Number(amountWei) / 1e18;
        console.log(`Extracted WETH payment: ${priceEth} ETH`);
      } else if (BigInt(transaction.value) > BigInt(1e16)) {
        // Use direct ETH value as fallback if significant
        priceEth = Number(BigInt(transaction.value)) / 1e18;
        console.log(`Using direct transaction value as price: ${priceEth} ETH`);
      }
    }
    
    console.log(`Final sale price: ${priceEth} ETH`);
    
    // Skip if below minimum price or zero
    if (priceEth < CONFIG.MIN_PRICE_ETH || priceEth === 0) {
      console.log(`Price ${priceEth} ETH is below minimum threshold or zero, skipping`);
      return false;
    }
    
    // Get project details
    const details = await getProjectDetails(tokenId, contractAddress);
    console.log('Project details:', JSON.stringify(details, null, 2));
    
    // Get ETH/USD price
    const ethPrice = await getEthPrice();
    const usdPrice = ethPrice ? (priceEth * ethPrice) : null;
    
    // Get buyer info (using toAddress from Transfer event)
    let buyerDisplay = formatAddress(toAddress);
    
    // Try to get ENS name
    const ensName = await getEnsName(toAddress);
    if (ensName) {
      buyerDisplay = ensName;
    } else {
      // Try to get OpenSea username
      const osName = await getOpenseaUserName(toAddress);
      if (osName) {
        buyerDisplay = osName;
      }
    }
    
    // Format tweet
    // Make sure the project name doesn't already contain the token number
    const projectName = details.projectName.replace(/ #\d+$/, '');
    
    let tweetText = `${projectName} #${details.tokenNumber} by ${details.artistName}`;
    tweetText += `\nsold for ${formatPrice(priceEth)} ETH`;
    
    if (usdPrice) {
      tweetText += ` ($${formatPrice(usdPrice)})`;
    }
    
    tweetText += `\nto ${buyerDisplay}\n\n${details.artBlocksUrl}`;
    
    console.log('\n--- TWEET PREVIEW ---\n');
    console.log(tweetText);
    console.log('\n---------------------\n');
    
    return true;
  } catch (error) {
    console.error('Error in test transaction:', error);
    return false;
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
    
    // Send initial test tweet after a delay
    if (!CONFIG.DISABLE_TWEETS) {
      console.log(`Waiting ${CONFIG.INITIAL_STARTUP_DELAY/60000} minutes before sending first tweet...`);
      setTimeout(async () => {
        await sendTestTweet();
      }, CONFIG.INITIAL_STARTUP_DELAY);
    } else {
      console.log('Tweets are disabled. The bot will only preview tweets in the console.');
      console.log('To enable tweets, use the /enable-tweets endpoint.');
    }
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
