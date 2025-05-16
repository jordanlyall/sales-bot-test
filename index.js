/**
 * Art Blocks Sales Bot
 * 
 * Monitors OpenSea sales of Art Blocks NFTs and posts updates to Twitter.
 * Uses a hybrid approach with OpenSea for sales events and metadata,
 * and Alchemy as a blockchain monitor and fallback.
 */

// Core modules
const http = require('http');
const { TwitterApi } = require('twitter-api-v2');
const { Alchemy, Network } = require('alchemy-sdk');
const retry = require('async-retry');
const axios = require('axios');
require('dotenv').config();

// =========================================================
// CONFIGURATION
// =========================================================

class Config {
  constructor() {
    this.CONTRACT_ADDRESSES = [
      '0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a', // Art Blocks Flagship V0
      '0xa7d8d9ef8D8Ce8992Df33D8b8CF4Aebabd5bD270', // Art Blocks Flagship V1
      '0x99a9B7c1116f9ceEB1652de04d5969CcE509B069', // Art Blocks Flagship V3
      '0xAB0000000000aa06f89B268D604a9c1C41524Ac6', // Art Blocks Curated V3.2
      '0x145789247973c5d612bf121e9e4eef84b63eb707', // Art Blocks Collaborations
      '0x64780ce53f6e966e18a22af13a2f97369580ec11', // Art Blocks Collaborations
      '0x942bc2d3e7a589fe5bd4a5c6ef9727dfd82f5c8a', // Art Blocks Explorations
      '0xea698596b6009a622c3ed00dd5a8b5d1cae4fc36', // Art Blocks Collaborations
    ];
    
    // OpenSea collection slugs for Art Blocks collections
    this.OPENSEA_COLLECTION_SLUGS = [
      'art-blocks',
      'art-blocks-factory',
      'art-blocks-curated',
      'art-blocks-playground',
      'art-blocks-explorations'
    ];
    
    this.OPENSEA_ADDRESS = '0x7f268357a8c2552623316e2562d90e642bb538e5';
    this.MIN_PRICE_ETH = 0.001;
    this.HEALTH_CHECK_INTERVAL = 3600000; // 1 hour
    this.MAX_RETRIES = 3;
    this.RETRY_DELAY = 60000; // 1 minute
    this.ETH_PRICE_CACHE_DURATION = 900000; // 15 minutes
    this.MIN_TIME_BETWEEN_TWEETS = 15 * 60 * 1000; // 15 minutes
    this.DISABLE_TWEETS = true; // Set to false to enable actual tweets
    this.INITIAL_STARTUP_DELAY = 300000; // 5 minutes
    this.NFT_METADATA_CACHE_DURATION = 24 * 60 * 60 * 1000; // 1 day
    this.OPENSEA_EVENTS_POLL_INTERVAL = 60000; // 1 minute
    this.OPENSEA_RATE_LIMIT_DELAY = 500; // 500ms between API calls (2 req/s)

    // Contract name mapping
    this.CONTRACT_NAMES = {
      '0x059edd72cd353df5106d2b9cc5ab83a52287ac3a': 'Art Blocks Flagship V0',
      '0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270': 'Art Blocks Flagship V1',
      '0x99a9b7c1116f9ceeb1652de04d5969cce509b069': 'Art Blocks Flagship V3',
      '0xab0000000000aa06f89b268d604a9c1c41524ac6': 'Art Blocks Curated V3.2',
      '0x145789247973c5d612bf121e9e4eef84b63eb707': 'Art Blocks Collaborations',
      '0x64780ce53f6e966e18a22af13a2f97369580ec11': 'Art Blocks Collaborations',
      '0x942bc2d3e7a589fe5bd4a5c6ef9727dfd82f5c8a': 'Art Blocks Explorations',
      '0xea698596b6009a622c3ed00dd5a8b5d1cae4fc36': 'Art Blocks Collaborations',
    };

    // OpenSea URL mapping
    this.CONTRACT_URLS = {};
    this.CONTRACT_ADDRESSES.forEach(address => {
      const normalizedAddress = address.toLowerCase();
      this.CONTRACT_URLS[normalizedAddress] = `https://opensea.io/assets/ethereum/${normalizedAddress}/`;
    });
  }
}

// =========================================================
// API SERVICES
// =========================================================

class ApiServices {
  constructor(config) {
    this.config = config;
    this.ethPriceCache = { price: null, timestamp: 0 };
    this.tokenMetadataCache = {};
    this.processedEventIds = new Set(); // Track which OpenSea events we've processed
    this.lastEventTimestamp = Date.now() - (24 * 60 * 60 * 1000); // Start with events from last 24h
  }

  initTwitter() {
    try {
      this.twitter = new TwitterApi({
        appKey: process.env.TWITTER_CONSUMER_KEY,
        appSecret: process.env.TWITTER_CONSUMER_SECRET,
        accessToken: process.env.TWITTER_ACCESS_TOKEN,
        accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
      });
      console.log('Twitter client initialized successfully');
      return true;
    } catch (error) {
      console.error('Error initializing Twitter client:', error);
      return false;
    }
  }

  initAlchemy() {
    try {
      this.alchemy = new Alchemy({
        apiKey: process.env.ALCHEMY_API_KEY,
        network: Network.ETH_MAINNET,
      });
      console.log('Alchemy client initialized successfully');
      return true;
    } catch (error) {
      console.error('Error initializing Alchemy client:', error);
      return false;
    }
  }

  async getEthPrice() {
    // Check cache first
    const now = Date.now();
    if (this.ethPriceCache.price && 
        (now - this.ethPriceCache.timestamp < this.config.ETH_PRICE_CACHE_DURATION)) {
      return this.ethPriceCache.price;
    }

    try {
      // Try multiple price sources in sequence
      
      // First try CoinGecko
      try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
          params: { ids: 'ethereum', vs_currencies: 'usd' }
        });
        
        if (response.data?.ethereum?.usd) {
          const ethPrice = response.data.ethereum.usd;
          console.log(`Got ETH price from CoinGecko API: ${ethPrice}`);
          
          // Update cache
          this.ethPriceCache = { price: ethPrice, timestamp: now };
          return ethPrice;
        }
      } catch (coinGeckoError) {
        console.error('CoinGecko API error:', coinGeckoError.message);
      }
      
      // If CoinGecko failed, try CryptoCompare as fallback
      try {
        const response = await axios.get('https://min-api.cryptocompare.com/data/price', {
          params: { fsym: 'ETH', tsyms: 'USD' }
        });
        
        if (response.data?.USD) {
          const ethPrice = response.data.USD;
          console.log(`Got ETH price from CryptoCompare API: ${ethPrice}`);
          
          // Update cache
          this.ethPriceCache = { price: ethPrice, timestamp: now };
          return ethPrice;
        }
      } catch (cryptoCompareError) {
        console.error('CryptoCompare API error:', cryptoCompareError.message);
      }
      
      // Last resort - try Binance API
      try {
        const response = await axios.get('https://api.binance.com/api/v3/ticker/price', {
          params: { symbol: 'ETHUSDT' }
        });
        
        if (response.data?.price) {
          const ethPrice = parseFloat(response.data.price);
          console.log(`Got ETH price from Binance API: ${ethPrice}`);
          
          // Update cache
          this.ethPriceCache = { price: ethPrice, timestamp: now };
          return ethPrice;
        }
      } catch (binanceError) {
        console.error('Binance API error:', binanceError.message);
      }
      
      // If all APIs failed, fall back to cached price or default
      console.error('All ETH price APIs failed, using fallback price');
      return this.ethPriceCache.price || 2500; // More reasonable fallback
      
    } catch (error) {
      console.error('Error fetching ETH price:', error.message);
      return this.ethPriceCache.price || 2500;
    }
  }

  async getEnsName(address) {
    try {
      const ensName = await this.alchemy.core.lookupAddress(address);
      console.log(`ENS lookup for ${address}: ${ensName || 'Not found'}`);
      return ensName;
    } catch (error) {
      console.error('Error getting ENS name:', error);
      return null;
    }
  }

  async getOpenseaUserName(address) {
    try {
      console.log(`Looking up OpenSea username for address: ${address}`);
      
      const response = await axios.get(`https://api.opensea.io/api/v2/accounts/${address}`, {
        headers: { 'X-API-KEY': process.env.OPENSEA_API_KEY }
      });
      
      const username = response.data.username || null;
      console.log(`Found OpenSea username: ${username || 'None'}`);
      return username;
    } catch (error) {
      console.error(`Error getting OpenSea username: ${error.message}`);
      return null;
    }
  }

  async getOpenSeaAssetMetadata(contractAddress, tokenId) {
    try {
      console.log(`Fetching OpenSea metadata for ${contractAddress}/${tokenId}`);
      
      const response = await axios.get(
        `https://api.opensea.io/api/v2/chain/ethereum/contract/${contractAddress}/nfts/${tokenId}`,
        { headers: { 'X-API-KEY': process.env.OPENSEA_API_KEY } }
      );
      
      if (!response.data) {
        return { success: false };
      }
      
      const data = response.data;
      
      // Extract project name
      let projectName = data.name || data.collection?.name || '';
      projectName = projectName.replace(/ #\d+$/, ''); // Remove token number
      
      // Extract artist name from traits
      let artistName = null;
      if (data.traits) {
        const artistTrait = data.traits.find(
          trait => 
            trait.trait_type?.toLowerCase() === 'artist' || 
            trait.trait_type?.toLowerCase().includes('artist') ||
            trait.trait_type?.toLowerCase() === 'created by' ||
            trait.trait_type?.toLowerCase().includes('creator')
        );
        
        if (artistTrait?.value) {
          artistName = artistTrait.value;
        } else {
          // Look through all traits for artist info
          for (const trait of data.traits) {
            if (trait.value && typeof trait.value === 'string' && trait.value.toLowerCase().includes('by ')) {
              const byParts = trait.value.split('by ');
              if (byParts.length > 1) {
                artistName = byParts[1].trim();
                break;
              }
            }
          }
        }
      }
      
      // Try to extract artist from description if still missing
      if (!artistName && data.description) {
        const desc = data.description.toLowerCase();
        const byMatch = desc.match(/by\s+([a-z0-9\s]+)/i);
        if (byMatch && byMatch[1]) {
          artistName = byMatch[1].trim();
        }
      }
      
      return {
        success: true,
        projectName,
        artistName,
        description: data.description || '',
        imageUrl: data.image_url || data.image || null,
        collection: data.collection?.name || null,
        tokenId: tokenId,
        fullData: data
      };
    } catch (error) {
      console.error('Error fetching from OpenSea API:', error.message);
      return { success: false };
    }
  }

  async getArtBlocksTokenInfo(tokenId, contractAddress) {
    try {
      console.log(`Fetching from Art Blocks API for token ${tokenId}`);
      const response = await axios.get(
        `https://token.artblocks.io/${contractAddress}/${tokenId}`
      );
      
      if (!response.data || typeof response.data !== 'object') {
        return { success: false };
      }

      const data = response.data;
      
      // Extract project name
      let projectName = null;
      if (data.project?.name) {
        projectName = data.project.name;
      } else if (data.title) {
        projectName = data.title.replace(/ #\d+$/, '');
      } else if (data.collection?.name) {
        projectName = data.collection.name;
      } else if (data.project_id) {
        // Try to extract from features or other fields
        if (data.features && Object.keys(data.features).length > 0) {
          const firstFeatureKey = Object.keys(data.features)[0];
          if (firstFeatureKey && !firstFeatureKey.includes('Color') && !firstFeatureKey.includes('Size')) {
            projectName = firstFeatureKey;
          }
        }
        
        if (!projectName && data.script_type) {
          projectName = data.script_type;
        }
      }
      
      // Extract artist name
      let artistName = data.project?.artist_name || data.project?.artist || data.artist || null;
      
      if (!artistName && data.website && data.website.includes('twitter.com/')) {
        const twitterHandle = data.website.split('twitter.com/').pop().replace(/[\\/\\?#].*$/, '');
        if (twitterHandle && twitterHandle.length > 1) {
          artistName = twitterHandle;
        }
      }
      
      return {
        success: true,
        projectName: projectName || null,
        artistName: artistName || null,
        description: data.description || null,
        projectId: data.project_id || data.project?.projectId || null,
        tokenId: data.tokenId || tokenId,
        imageUrl: data.image || data.imageUrl || data.media?.image || data.primary_asset_url || null,
        fullData: data
      };
    } catch (error) {
      console.error('Error fetching from Art Blocks API:', error.message);
      return { success: false };
    }
  }

  async getAlchemyMetadata(contractAddress, tokenId) {
    try {
      console.log(`Fetching NFT metadata from Alchemy for token ${tokenId}`);
      const nftMetadata = await this.alchemy.nft.getNftMetadata(
        contractAddress,
        tokenId
      );
      
      if (!nftMetadata) {
        return { success: false };
      }
      
      let projectName = nftMetadata.title || nftMetadata.contract?.name || '';
      projectName = projectName.replace(/ #\d+$/, '');
      
      const artistName = this._extractArtistFromAlchemy(nftMetadata);
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

  _extractArtistFromAlchemy(nftMetadata) {
    if (!nftMetadata) return null;
    
    // Method 1: Check for an attribute with trait_type "artist"
    const artistAttribute = nftMetadata.rawMetadata?.attributes?.find(
      attr => attr.trait_type?.toLowerCase() === 'artist' || 
             attr.trait_type?.toLowerCase() === 'created by'
    );
    
    if (artistAttribute?.value) {
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
      return artistLikeAttribute.value;
    }
    
    // Method 3: Check for 'creator' field in the rawMetadata
    if (nftMetadata.rawMetadata?.creator) {
      return nftMetadata.rawMetadata.creator;
    }
    
    // Method 4: Check if the title contains "by [name]" pattern
    if (nftMetadata.title) {
      const titleMatch = nftMetadata.title.match(/by\s+([a-z0-9\s]+)/i);
      if (titleMatch && titleMatch[1]) {
        return titleMatch[1].trim();
      }
    }
    
    return null;
  }

  /**
   * Get OpenSea sales events for Art Blocks collections
   */
  async getOpenSeaSalesEvents() {
    try {
      console.log(`Fetching OpenSea sales events since ${new Date(this.lastEventTimestamp).toISOString()}`);
      
      const newEvents = [];
      
      // Process each collection slug
      for (const collectionSlug of this.config.OPENSEA_COLLECTION_SLUGS) {
        try {
          // Using updated OpenSea API v2 endpoint format and parameters
          const response = await axios.get(
            `https://api.opensea.io/api/v2/events`, {
              headers: { 'X-API-KEY': process.env.OPENSEA_API_KEY },
              params: {
                collection_slug: collectionSlug,
                event_type: 'sale',
                after: Math.floor(this.lastEventTimestamp / 1000), // Unix timestamp in seconds
                limit: 50
              }
            }
          );
          
          if (response.data && response.data.events) {
            const events = response.data.events;
            console.log(`Found ${events.length} events for collection ${collectionSlug}`);
            
            // Filter out events we've already processed
            for (const event of events) {
              if (!this.processedEventIds.has(event.id)) {
                newEvents.push(event);
                this.processedEventIds.add(event.id);
                
                // Update last event timestamp if this is more recent
                const eventTimestamp = new Date(event.created_date || event.timestamp).getTime();
                if (eventTimestamp > this.lastEventTimestamp) {
                  this.lastEventTimestamp = eventTimestamp;
                }
              }
            }
          }
          
          // Respect rate limits
          await new Promise(resolve => setTimeout(resolve, this.config.OPENSEA_RATE_LIMIT_DELAY));
          
        } catch (error) {
          console.error(`Error fetching events for ${collectionSlug}:`, error.message);
          // Log more detailed error info
          if (error.response) {
            console.error(`Response status: ${error.response.status}`);
            console.error(`Response data:`, JSON.stringify(error.response.data, null, 2));
          }
          // Continue with next collection
        }
      }
      
      console.log(`Found ${newEvents.length} new sales events`);
      return newEvents;
      
    } catch (error) {
      console.error('Error fetching OpenSea events:', error.message);
      return [];
    }
  }

  clearCaches() {
    this.tokenMetadataCache = {};
    this.ethPriceCache = { price: null, timestamp: 0 };
    return true;
  }
}

// =========================================================
// METADATA MANAGER
// =========================================================

class MetadataManager {
  constructor(apiServices, config) {
    this.api = apiServices;
    this.config = config;
  }

  async getProjectDetails(tokenId, contractAddress) {
    const normalizedAddress = contractAddress.toLowerCase();
    const cacheKey = `${normalizedAddress}-${tokenId}`;
    
    // Check cache first
    const now = Date.now();
    if (this.api.tokenMetadataCache[cacheKey] && 
        (now - this.api.tokenMetadataCache[cacheKey].timestamp < this.config.NFT_METADATA_CACHE_DURATION)) {
      console.log(`Using cached metadata for ${cacheKey}`);
      return this.api.tokenMetadataCache[cacheKey].data;
    }
    
    // Calculate project ID and token number for fallback
    const projectId = Math.floor(tokenId / 1000000);
    const tokenNumber = tokenId % 1000000;
    
    let projectName = '';
    let artistName = '';
    let description = '';
    
    // Try OpenSea API first (most up-to-date marketplace info)
    const openSeaData = await this.api.getOpenSeaAssetMetadata(normalizedAddress, tokenId);
    
    if (openSeaData && openSeaData.success) {
      projectName = openSeaData.projectName || '';
      artistName = openSeaData.artistName || '';
      description = openSeaData.description || '';
      console.log(`OpenSea API returned - Project: ${projectName}, Artist: ${artistName}`);
    }
    
    // Try Art Blocks API next for artist information if still missing
    if (!artistName || !projectName) {
      const artBlocksData = await this.api.getArtBlocksTokenInfo(tokenId, normalizedAddress);
      
      if (artBlocksData && artBlocksData.success) {
        if (!projectName) projectName = artBlocksData.projectName || '';
        if (!artistName) artistName = artBlocksData.artistName || '';
        if (!description) description = artBlocksData.description || '';
        console.log(`Art Blocks API returned - Project: ${projectName}, Artist: ${artistName}`);
      }
    }
    
    // Try Alchemy as a final fallback
    if (!projectName || !artistName) {
      try {
        const alchemyData = await this.api.getAlchemyMetadata(normalizedAddress, tokenId);
        
        if (alchemyData && alchemyData.success) {
          if (!projectName) projectName = alchemyData.projectName;
          if (!artistName) artistName = alchemyData.artistName;
          if (!description) description = alchemyData.description;
          
          console.log(`Alchemy API returned - Project: ${projectName || 'Not found'}, Artist: ${artistName || 'Not found'}`);
        }
      } catch (alchemyError) {
        console.error('Error fetching from Alchemy:', alchemyError.message);
      }
    }
    
    // Final fallbacks if still missing data
    if (!projectName) {
      const contractType = this.config.CONTRACT_NAMES[normalizedAddress] || 'Art Blocks';
      projectName = `${contractType} Project #${projectId}`;
    }
    
    if (!artistName) {
      // Try to extract from project name
      if (projectName) {
        const nameParts = projectName.match(/(.*) by (.*)/i);
        if (nameParts && nameParts.length > 2) {
          artistName = nameParts[2].trim();
        }
      }
      
      // Try description as last resort
      if (!artistName && description) {
        const descMatch = description.match(/by\s+([a-z0-9\s]+)/i);
        if (descMatch && descMatch[1]) {
          artistName = descMatch[1].trim();
        }
      }
      
      // Ultimate fallback
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
    
    // Cache the result
    this.api.tokenMetadataCache[cacheKey] = {
      data: result,
      timestamp: Date.now()
    };
    
    console.log(`Final metadata - Project: ${result.projectName}, Artist: ${result.artistName}, Token: ${result.tokenNumber}`);
    
    return result;
  }
}

// =========================================================
// TWEET MANAGER
// =========================================================

class TweetManager {
  constructor(apiServices, config) {
    this.api = apiServices;
    this.config = config;
    this.tweetQueue = [];
    this.isTweetProcessing = false;
    this.lastTweetTime = 0;
    this.tweetFailures = 0;
    this.lastRateLimitTime = 0;
    this.appStartTime = Date.now();
  }

  formatAddress(address) {
    if (!address) return 'Unknown';
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
  }

  formatPrice(price) {
    return price.toLocaleString('en-US', { 
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  async checkTwitterStatus() {
    // Check if we're still in a rate limit cooldown
    const now = Date.now();
    const timeSinceLastRateLimit = now - this.lastRateLimitTime;
    
    if (this.lastRateLimitTime > 0 && timeSinceLastRateLimit < 30 * 60 * 1000) {
      const remainingCooldown = 30 * 60 * 1000 - timeSinceLastRateLimit;
      const minutes = Math.ceil(remainingCooldown / 60000);
      console.log(`Twitter appears to be rate limited. Recommended to wait ${minutes} more minutes.`);
      return false;
    }
    
    return true;
  }

  async sendTweet(message) {
    // Preview mode if tweets are disabled
    if (this.config.DISABLE_TWEETS) {
      console.log('\n--- TWEET PREVIEW (DISABLED) ---\n');
      console.log(message);
      console.log('\n---------------------\n');
      
      return { data: { id: 'preview-only-' + Date.now() } };
    }
    
    // Proceed with actual tweeting
    if (!this.api.twitter) {
      console.error('Cannot send tweet - Twitter client not initialized');
      return null;
    }

    return retry(async (bail, attempt) => {
      try {
        console.log(`Attempting to tweet (attempt ${attempt})...`);
        const tweet = await this.api.twitter.v2.tweet(message);
        console.log('Tweet sent successfully:', tweet.data.id);
        return tweet;
      } catch (error) {
        // Don't retry permission issues
        if (error.code === 403) {
          console.error('Permission error when tweeting:', error.message);
          bail(error);
          return null;
        }
        
        // Special handling for rate limits
        if (error.code === 429 || error.message.includes('rate limit') || error.message.includes('429')) {
          const delaySeconds = attempt * 120; // 2, 4, 6 minutes between retries
          console.error(`Rate limit exceeded (attempt ${attempt}). Will retry after ${delaySeconds} seconds.`);
          
          this.lastRateLimitTime = Date.now();
          await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
        }
        
        console.error(`Tweet attempt ${attempt} failed:`, error.message);
        throw error; // Trigger retry
      }
    }, {
      retries: this.config.MAX_RETRIES,
      minTimeout: this.config.RETRY_DELAY,
      maxTimeout: 360000, // 6 minutes max
      factor: 2, // Exponential backoff factor
      onRetry: (error) => {
        const seconds = Math.min(60 * error.attemptNumber, 360);
        console.log(`Retrying tweet after ${seconds} seconds due to error: ${error.message}`);
      }
    });
  }

  queueTweet(message) {
    console.log('Adding tweet to queue:', message);
    this.tweetQueue.push(message);
    
    // Start processing if not already running
    if (!this.isTweetProcessing) {
      this.processTweetQueue();
    }
    
    return true;
  }

  async processTweetQueue() {
    if (this.isTweetProcessing || this.tweetQueue.length === 0) {
      return;
    }
    
    // Don't process queue during initial startup delay
    if (Date.now() - this.appStartTime < this.config.INITIAL_STARTUP_DELAY) {
      console.log("App recently started; waiting before processing tweet queue");
      setTimeout(() => this.processTweetQueue(), 60000);
      return;
    }
    
    this.isTweetProcessing = true;
    
    try {
      // Check Twitter status first
      const twitterReady = await this.checkTwitterStatus();
      if (!twitterReady) {
        console.log("Twitter appears to be rate limited. Delaying queue processing.");
        setTimeout(() => this.processTweetQueue(), 5 * 60 * 1000);
        return;
      }
      
      // Check if we need to wait before sending next tweet
      const now = Date.now();
      const timeSinceLastTweet = now - this.lastTweetTime;
      
      if (timeSinceLastTweet < this.config.MIN_TIME_BETWEEN_TWEETS && this.lastTweetTime > 0) {
        const waitTime = this.config.MIN_TIME_BETWEEN_TWEETS - timeSinceLastTweet;
        const waitMinutes = Math.ceil(waitTime / 60000);
        console.log(`Waiting ${waitMinutes} minutes before sending next tweet due to rate limiting...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      
      // Get next tweet from queue
      const message = this.tweetQueue.shift();
      
      // Add extra delay if we've had failures
      if (this.tweetFailures > 0) {
        const extraDelay = this.tweetFailures * 3 * 60 * 1000; // 3, 6, 9 minutes based on failures
        console.log(`Adding extra ${extraDelay/60000} minutes delay due to previous ${this.tweetFailures} failed attempts`);
        await new Promise(resolve => setTimeout(resolve, extraDelay));
      }
      
      // Send the tweet
      try {
        await this.sendTweet(message);
        this.tweetFailures = 0; // Reset on success
      } catch (error) {
        this.tweetFailures++;
        console.error(`Tweet failed (total failures: ${this.tweetFailures}):`, error);
        // Put message back in queue if not a permanent error
        if (!error.message.includes('403')) {
          this.tweetQueue.unshift(message);
        }
      }
      
      this.lastTweetTime = Date.now();
    } catch (error) {
      console.error('Error processing tweet queue:', error);
    } finally {
      this.isTweetProcessing = false;
      
      // Process next tweet if available
      if (this.tweetQueue.length > 0) {
        const nextDelay = this.tweetFailures > 0 ? 5 * 60 * 1000 : 1000;
        setTimeout(() => this.processTweetQueue(), nextDelay);
      }
    }
  }

  async sendTestTweet() {
    return this.queueTweet(`Art Blocks sales bot is monitoring OpenSea sales for ${this.config.CONTRACT_ADDRESSES.length} contracts! (${new Date().toLocaleTimeString()})`);
  }

  async formatSaleTweet(details, priceEth, usdPrice, buyerDisplay) {
    // Make sure the project name doesn't already contain the token number
    const projectName = details.projectName.replace(/ #\d+$/, '');
    
    let tweetText = `${projectName} #${details.tokenNumber} by ${details.artistName}`;
    tweetText += `\nsold for ${this.formatPrice(priceEth)} ETH`;
    
    if (usdPrice) {
      tweetText += ` ($${this.formatPrice(usdPrice)})`;
    }
    
    tweetText += `\nto ${buyerDisplay}\n\n${details.artBlocksUrl}`;
    
    return tweetText;
  }
}

// =========================================================
// OPENSEA EVENTS PROCESSOR
// =========================================================

class OpenSeaEventProcessor {
  constructor(apiServices, metadataManager, tweetManager, config) {
    this.api = apiServices;
    this.metadata = metadataManager;
    this.tweets = tweetManager;
    this.config = config;
  }
  
  /**
   * Process OpenSea sales events
   */
  async processOpenSeaEvents() {
    try {
      const events = await this.api.getOpenSeaSalesEvents();
      
      if (events.length === 0) {
        return;
      }
      
      console.log(`Processing ${events.length} OpenSea sales events`);
      
      for (const event of events) {
        try {
          await this.processSaleEvent(event);
          // Add a small delay between processing events to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error('Error processing sale event:', error);
          // Continue with next event
        }
      }
    } catch (error) {
      console.error('Error in processOpenSeaEvents:', error);
    }
  }
  
  /**
   * Process a single OpenSea sale event
   */
  async processSaleEvent(event) {
    try {
      // Check if this is a valid sale event
      if (!event.payment || !event.nft) {
        console.log('Invalid sale event - missing payment or NFT data');
        return false;
      }
      
      // Extract sale information
      const contractAddress = event.nft.contract;
      const tokenId = event.nft.identifier;
      const buyerAddress = event.winner?.address;
      
      // Skip if contract address doesn't match our monitored contracts
      if (!this.config.CONTRACT_ADDRESSES.some(addr => 
        addr.toLowerCase() === contractAddress.toLowerCase())) {
        console.log(`Skipping sale for non-monitored contract: ${contractAddress}`);
        return false;
      }
      
      console.log(`Processing OpenSea sale for ${contractAddress}/${tokenId}`);
      
      // Extract price information
      const priceWei = event.payment.quantity;
      const priceEth = Number(priceWei) / 1e18;
      
      console.log(`Sale price: ${priceEth} ETH`);
      
      // Skip if below minimum price
      if (priceEth < this.config.MIN_PRICE_ETH) {
        console.log(`Price ${priceEth} ETH is below minimum threshold, skipping`);
        return false;
      }
      
      // Get project details
      const details = await this.metadata.getProjectDetails(tokenId, contractAddress);
      
      // Get ETH/USD price
      const ethPrice = await this.api.getEthPrice();
      const usdPrice = ethPrice ? (priceEth * ethPrice) : null;
      
      // Get buyer info
      let buyerDisplay = this.tweets.formatAddress(buyerAddress);
      
      // Try to get ENS name
      const ensName = await this.api.getEnsName(buyerAddress);
      if (ensName) {
        buyerDisplay = ensName;
      } else {
        // Try to get OpenSea username
        const osName = await this.api.getOpenseaUserName(buyerAddress);
        if (osName) {
          buyerDisplay = osName;
        }
      }
      
      // Format tweet
      const tweetText = await this.tweets.formatSaleTweet(details, priceEth, usdPrice, buyerDisplay);
      
      console.log('\n--- TWEET PREVIEW ---\n');
      console.log(tweetText);
      console.log('\n---------------------\n');
      
      // Queue the tweet
      this.tweets.queueTweet(tweetText);
      
      return true;
    } catch (error) {
      console.error('Error processing OpenSea sale event:', error);
      return false;
    }
  }
  
  /**
   * Start polling for OpenSea events
   */
  startEventPolling() {
    console.log('Starting OpenSea events polling');
    
    // Process events immediately on startup
    this.processOpenSeaEvents();
    
    // Set up interval to poll for new events
    setInterval(() => {
      this.processOpenSeaEvents();
    }, this.config.OPENSEA_EVENTS_POLL_INTERVAL);
  }
}

// =========================================================
// TRANSACTION PROCESSOR
// =========================================================

class TransactionProcessor {
  constructor(apiServices, metadataManager, tweetManager, config) {
    this.api = apiServices;
    this.metadata = metadataManager;
    this.tweets = tweetManager;
    this.config = config;
  }

  async processTransaction(tx, contractAddress) {
    console.log(`Processing transaction for ${contractAddress}: ${tx.hash}`);
    
    try {
      // Get transaction details
      const transaction = await this.api.alchemy.core.getTransaction(tx.hash);
      if (!transaction || !transaction.to) {
        console.log('Transaction not found or invalid');
        return false;
      }
      
      // Get transaction receipt with logs
      const receipt = await this.api.alchemy.core.getTransactionReceipt(tx.hash);
      if (!receipt) {
        console.log('Receipt not found');
        return false;
      }
      
      // Look for ERC-721 Transfer event in the logs
      const transferEvents = receipt.logs.filter(log => {
        const isFromMonitoredContract = log.address.toLowerCase() === contractAddress.toLowerCase();
        const isTransferEvent = log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
        return isFromMonitoredContract && isTransferEvent;
      });
      
      if (transferEvents.length === 0) {
        console.log('No Transfer events found in transaction');
        return false;
      }
      
      // Get the last Transfer event (usually the most relevant one for sales)
      const transferEvent = transferEvents[transferEvents.length - 1];
      
      // Parse the event data
      const fromAddress = '0x' + transferEvent.topics[1].slice(26);
      const toAddress = '0x' + transferEvent.topics[2].slice(26);
      
      // Parse tokenId
      let tokenId;
      if (transferEvent.topics.length > 3) {
        tokenId = parseInt(transferEvent.topics[3], 16);
      } else {
        tokenId = parseInt(transferEvent.data, 16);
      }
      
      console.log(`Extracted from event - From: ${fromAddress}, To: ${toAddress}, TokenId: ${tokenId}`);
      
      // Extract price information
      const priceEth = await this.extractSalePrice(transaction, receipt);
      console.log(`Final sale price: ${priceEth} ETH`);
      
      // Skip if below minimum price or zero
      if (priceEth < this.config.MIN_PRICE_ETH || priceEth === 0) {
        console.log(`Price ${priceEth} ETH is below minimum threshold or zero, skipping`);
        return false;
      }
      
      // Get project details
      const details = await this.metadata.getProjectDetails(tokenId, contractAddress);
      
      // Get ETH/USD price
      const ethPrice = await this.api.getEthPrice();
      const usdPrice = ethPrice ? (priceEth * ethPrice) : null;
      
      // Get buyer info
      let buyerDisplay = this.tweets.formatAddress(toAddress);
      
      // Try to get ENS name
      const ensName = await this.api.getEnsName(toAddress);
      if (ensName) {
        buyerDisplay = ensName;
      } else {
        // Try to get OpenSea username
        const osName = await this.api.getOpenseaUserName(toAddress);
        if (osName) {
          buyerDisplay = osName;
        }
      }
      
      // Format tweet
      const tweetText = await this.tweets.formatSaleTweet(details, priceEth, usdPrice, buyerDisplay);
      
      console.log('\n--- TWEET PREVIEW ---\n');
      console.log(tweetText);
      console.log('\n---------------------\n');
      
      // Queue the tweet
      this.tweets.queueTweet(tweetText);
      
      return true;
    } catch (error) {
      console.error('Error processing transaction:', error);
      return false;
    }
  }

  async extractSalePrice(transaction, receipt) {
    let priceEth = 0;
    
    // Method 1: Look for OrderFulfilled events (OpenSea Seaport)
    const orderFulfilledEvents = receipt.logs.filter(log => {
      // OrderFulfilled event signature
      return log.topics[0] === '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31';
    });
    
    if (orderFulfilledEvents.length > 0) {
      console.log('Found OrderFulfilled event - parsing price data');
      const orderFulfilledEvent = orderFulfilledEvents[0];
      
      // Use transaction value if significant
      if (BigInt(transaction.value) > BigInt(1e16)) { // More than 0.01 ETH
        priceEth = Number(BigInt(transaction.value)) / 1e18;
        console.log(`Using transaction value as price: ${priceEth} ETH`);
      } else {
        // Try to extract payment from event data
        if (orderFulfilledEvent.data.includes('0000000000000000000000000000000000000000')) {
          const ethPositionHint = orderFulfilledEvent.data.indexOf('0000000000000000000000000000000000000000');
          if (ethPositionHint > 0) {
            const potentialAmountHex = '0x' + orderFulfilledEvent.data.substring(ethPositionHint + 64, ethPositionHint + 64 + 64);
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
      // Check for WETH transfers
      const wethAddress = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
      
      const wethTransfers = receipt.logs.filter(log => {
        return log.address.toLowerCase() === wethAddress.toLowerCase() && 
               log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      });
      
      if (wethTransfers.length > 0) {
        console.log('Found WETH transfer event');
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
    
    return priceEth;
  }

  async testTransactionOutput(txHash, contractAddress) {
    try {
      console.log(`Testing output for transaction: ${txHash}`);
      
      // Get transaction details
      const transaction = await this.api.alchemy.core.getTransaction(txHash);
      if (!transaction || !transaction.to) {
        console.log('Transaction not found or invalid');
        return false;
      }
      
      // Get transaction receipt with logs
      const receipt = await this.api.alchemy.core.getTransactionReceipt(txHash);
      if (!receipt) {
        console.log('Receipt not found');
        return false;
      }
      
      // Look for ERC-721 Transfer event in the logs
      const transferEvents = receipt.logs.filter(log => {
        const isFromMonitoredContract = log.address.toLowerCase() === contractAddress.toLowerCase();
        const isTransferEvent = log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
        return isFromMonitoredContract && isTransferEvent;
      });
      
      if (transferEvents.length === 0) {
        console.log('No Transfer events found in transaction');
        return false;
      }
      
      // Get the last Transfer event
      const transferEvent = transferEvents[transferEvents.length - 1];
      
      // Parse the event data
      const fromAddress = '0x' + transferEvent.topics[1].slice(26);
      const toAddress = '0x' + transferEvent.topics[2].slice(26);
      
      // Parse tokenId
      let tokenId;
      if (transferEvent.topics.length > 3) {
        tokenId = parseInt(transferEvent.topics[3], 16);
      } else {
        tokenId = parseInt(transferEvent.data, 16);
      }
      
      console.log(`Extracted from event - From: ${fromAddress}, To: ${toAddress}, TokenId: ${tokenId}`);
      
      // Extract price information
      const priceEth = await this.extractSalePrice(transaction, receipt);
      console.log(`Final sale price: ${priceEth} ETH`);
      
      // Skip if below minimum price or zero
      if (priceEth < this.config.MIN_PRICE_ETH || priceEth === 0) {
        console.log(`Price ${priceEth} ETH is below minimum threshold or zero, skipping`);
        return false;
      }
      
      // Get project details
      const details = await this.metadata.getProjectDetails(tokenId, contractAddress);
      
      // Get ETH/USD price
      const ethPrice = await this.api.getEthPrice();
      const usdPrice = ethPrice ? (priceEth * ethPrice) : null;
      
      // Get buyer info
      let buyerDisplay = this.tweets.formatAddress(toAddress);
      
      // Try to get ENS name
      const ensName = await this.api.getEnsName(toAddress);
      if (ensName) {
        buyerDisplay = ensName;
      } else {
        // Try to get OpenSea username
        const osName = await this.api.getOpenseaUserName(toAddress);
        if (osName) {
          buyerDisplay = osName;
        }
      }
      
      // Format tweet
      const tweetText = await this.tweets.formatSaleTweet(details, priceEth, usdPrice, buyerDisplay);
      
      console.log('\n--- TWEET PREVIEW ---\n');
      console.log(tweetText);
      console.log('\n---------------------\n');
      
      return true;
    } catch (error) {
      console.error('Error in test transaction:', error);
      return false;
    }
  }
}

// =========================================================
// HTTP SERVER & ROUTES
// =========================================================

class ServerManager {
  constructor(apiServices, metadataManager, tweetManager, transactionProcessor, config) {
    this.api = apiServices;
    this.metadata = metadataManager;
    this.tweets = tweetManager;
    this.txProcessor = transactionProcessor;
    this.config = config;
  }

  setupServer() {
    const server = http.createServer((req, res) => {
      if (req.url === '/trigger-tweet') {
        this.handleTriggerTweet(req, res);
      } else if (req.url === '/health') {
        this.handleHealth(req, res);
      } else if (req.url === '/queue-status') {
        this.handleQueueStatus(req, res);
      } else if (req.url === '/reset-rate-limit') {
        this.handleResetRateLimit(req, res);
      } else if (req.url === '/enable-tweets') {
        this.handleEnableTweets(req, res);
      } else if (req.url === '/disable-tweets') {
        this.handleDisableTweets(req, res);
      } else if (req.url === '/test-eth-price') {
        this.handleTestEthPrice(req, res);
      } else if (req.url.startsWith('/test-transaction')) {
        this.handleTestTransaction(req, res);
      } else if (req.url.startsWith('/test-output')) {
        this.handleTestOutput(req, res);
      } else if (req.url.startsWith('/test-metadata')) {
        this.handleTestMetadata(req, res);
      } else if (req.url.startsWith('/debug-metadata')) {
        this.handleDebugMetadata(req, res);
      } else if (req.url === '/clear-cache') {
        this.handleClearCache(req, res);
      } else if (req.url === '/trigger-opensea-events') {
        this.handleTriggerOpenSeaEvents(req, res);
      } else if (req.url === '/help') {
        this.handleHelp(req, res);
      } else {
        this.handleRoot(req, res);
      }
    });

    // Start the server
    const port = process.env.PORT || 3000;
    server.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });

    return server;
  }

  handleTriggerTweet(req, res) {
    console.log('Manual tweet trigger received');
    this.tweets.sendTestTweet()
      .then(() => {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('Tweet triggered - check logs for results');
      })
      .catch(err => {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end('Error: ' + err.message);
      });
  }

  handleHealth(req, res) {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Bot is healthy. Last checked: ' + new Date().toISOString());
  }

  handleQueueStatus(req, res) {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end(`Tweet queue status: ${this.tweets.tweetQueue.length} tweets waiting. Last tweet sent: ${new Date(this.tweets.lastTweetTime).toISOString()}. Failures: ${this.tweets.tweetFailures}. Tweets enabled: ${!this.config.DISABLE_TWEETS}`);
  }

  handleResetRateLimit(req, res) {
    this.tweets.tweetFailures = 0;
    this.tweets.lastRateLimitTime = 0;
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Rate limit state has been reset.');
  }

  handleEnableTweets(req, res) {
    this.config.DISABLE_TWEETS = false;
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Tweets have been enabled. The bot will now post to Twitter.');
  }

  handleDisableTweets(req, res) {
    this.config.DISABLE_TWEETS = true;
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Tweets have been disabled. The bot will only preview tweets in logs.');
  }

  handleTestEthPrice(req, res) {
    this.api.getEthPrice()
      .then(price => {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end(`Current ETH price: $${price}`);
      })
      .catch(err => {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end('Error getting ETH price: ' + err.message);
      });
  }

  handleTestTransaction(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const txHash = url.searchParams.get('hash');
    
    if (!txHash) {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('Error: Missing transaction hash. Use ?hash=0x... in the URL');
      return;
    }
    
    console.log(`Manual transaction test received for hash: ${txHash}`);
    
    // First get the transaction to determine which contract is involved
    this.api.alchemy.core.getTransactionReceipt(txHash)
      .then(receipt => {
        if (!receipt) {
          throw new Error('Transaction receipt not found');
        }
        
        // Find any Transfer events from our monitored contracts
        let foundContract = null;
        
        // Normalize our contract addresses for comparison
        const monitoredAddresses = this.config.CONTRACT_ADDRESSES.map(addr => addr.toLowerCase());
        
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
        return this.txProcessor.processTransaction(testTx, foundContract)
          .then(() => foundContract);
      })
      .then((contractAddress) => {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end(`Processing transaction ${txHash} for detected contract ${contractAddress}. Check logs for results.`);
      })
      .catch(err => {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end('Error: ' + err.message);
      });
  }

  handleTestOutput(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const txHash = url.searchParams.get('hash');
    
    if (!txHash) {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('Error: Missing transaction hash. Use ?hash=0x... in the URL');
      return;
    }
    
    console.log(`Testing output for hash: ${txHash}`);
    
    // First get the transaction to determine which contract is involved
    this.api.alchemy.core.getTransactionReceipt(txHash)
      .then(receipt => {
        if (!receipt) {
          throw new Error('Transaction receipt not found');
        }
        
        // Find any Transfer events from our monitored contracts
        let foundContract = null;
        
        // Normalize our contract addresses for comparison
        const monitoredAddresses = this.config.CONTRACT_ADDRESSES.map(addr => addr.toLowerCase());
        
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
        return this.txProcessor.testTransactionOutput(txHash, foundContract);
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
  }

  handleTestMetadata(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tokenId = url.searchParams.get('tokenId');
    const contractAddress = url.searchParams.get('contract') || this.config.CONTRACT_ADDRESSES[0];
    
    if (!tokenId) {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('Error: Missing tokenId. Use ?tokenId=1506 in the URL');
      return;
    }
    
    console.log(`Testing metadata retrieval for token: ${tokenId} on contract: ${contractAddress}`);
    
    this.metadata.getProjectDetails(tokenId, contractAddress)
      .then(details => {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(details, null, 2));
      })
      .catch(err => {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end('Error: ' + err.message);
      });
  }

  handleDebugMetadata(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tokenId = url.searchParams.get('tokenId');
    const contractAddress = url.searchParams.get('contract') || this.config.CONTRACT_ADDRESSES[0];
    
    if (!tokenId) {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('Error: Missing tokenId. Use ?tokenId=1506 in the URL');
      return;
    }
    
    console.log(`Debugging metadata for token: ${tokenId} on contract: ${contractAddress}`);
    
    // Get OpenSea metadata
    this.api.getOpenSeaAssetMetadata(contractAddress, tokenId)
      .then(openSeaData => {
        // Get Art Blocks API data
        return this.api.getArtBlocksTokenInfo(tokenId, contractAddress)
          .then(artBlocksData => {
            // Get Alchemy metadata
            return this.api.getAlchemyMetadata(contractAddress, tokenId)
              .then(alchemyData => {
                // Compile all results
                const result = {
                  openSeaApi: openSeaData,
                  artBlocksApi: artBlocksData,
                  alchemyApi: alchemyData,
                  finalMetadata: null
                };
                
                // Now get the final combined metadata
                return this.metadata.getProjectDetails(tokenId, contractAddress)
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
  }
  
  handleTriggerOpenSeaEvents(req, res) {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Manually triggering OpenSea events check. Check logs for results.');
    
    // This will be executed after the response is sent
    if (global.openSeaProcessor) {
      global.openSeaProcessor.processOpenSeaEvents()
        .then(() => {
          console.log('Manual OpenSea events check completed');
        })
        .catch(err => {
          console.error('Error in manual OpenSea events check:', err);
        });
    } else {
      console.error('OpenSea processor not initialized');
    }
  }

  handleClearCache(req, res) {
    this.api.clearCaches();
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('All caches have been cleared.');
  }

  handleHelp(req, res) {
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
/trigger-opensea-events      - Manually trigger OpenSea events check
/clear-cache        - Clear metadata and price caches
/reset-rate-limit   - Reset rate limit tracking
/help               - Show this help page

Example usage:
/test-output?hash=0x123456...  - No need to specify contract, it will be auto-detected
/test-metadata?tokenId=1506&contract=0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a - Test metadata for a specific token
`;
    
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end(helpText);
  }

  handleRoot(req, res) {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('Art Blocks Sales Bot is running. Visit /help for available endpoints.');
  }
}

// =========================================================
// MAIN APPLICATION CLASS
// =========================================================

class ArtBlocksSalesBot {
  constructor() {
    this.config = new Config();
    this.apiServices = new ApiServices(this.config);
    this.metadata = new MetadataManager(this.apiServices, this.config);
    this.tweets = new TweetManager(this.apiServices, this.config);
    this.txProcessor = new TransactionProcessor(this.apiServices, this.metadata, this.tweets, this.config);
    this.openSeaProcessor = new OpenSeaEventProcessor(this.apiServices, this.metadata, this.tweets, this.config);
    this.server = new ServerManager(this.apiServices, this.metadata, this.tweets, this.txProcessor, this.config);
    
    // Make the OpenSea processor globally accessible for manual triggers
    global.openSeaProcessor = this.openSeaProcessor;
  }

  async initialize() {
    console.log('Starting with environment check...');
    this.checkEnvironment();
    
    // Initialize API services
    this.apiServices.initTwitter();
    this.apiServices.initAlchemy();
    
    // Start the HTTP server
    this.server.setupServer();
    
    // Start OpenSea event polling (primary method)
    this.openSeaProcessor.startEventPolling();
    
    // Start blockchain monitoring (backup method)
    await this.monitorSales();
    
    // Setup health checks
    this.setupHealthChecks();
    
    console.log('Art Blocks Sales Bot is now running with hybrid monitoring approach');
  }

  checkEnvironment() {
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
  }

  async monitorSales() {
    console.log('Starting blockchain monitoring of Art Blocks sales as backup...');
    
    try {
      if (this.apiServices.alchemy) {
        console.log('Setting up Alchemy websocket listener...');
        
        this.config.CONTRACT_ADDRESSES.forEach(contractAddress => {
          console.log(`Setting up listener for contract: ${contractAddress}`);
          
          this.apiServices.alchemy.ws.on(
            {
              method: 'alchemy_pendingTransactions',
              fromAddress: this.config.OPENSEA_ADDRESS,
              toAddress: contractAddress,
            },
            (tx) => this.txProcessor.processTransaction(tx, contractAddress)
          );
        });
        
        console.log('Alchemy listeners set up successfully');
      } else {
        console.error('Alchemy client not initialized, blockchain monitoring disabled');
      }
      
      console.log('Blockchain monitoring setup complete...');
      
      // Send initial test tweet after a delay
      if (!this.config.DISABLE_TWEETS) {
        console.log(`Waiting ${this.config.INITIAL_STARTUP_DELAY/60000} minutes before sending first tweet...`);
        setTimeout(async () => {
          await this.tweets.sendTestTweet();
        }, this.config.INITIAL_STARTUP_DELAY);
      } else {
        console.log('Tweets are disabled. The bot will only preview tweets in the console.');
        console.log('To enable tweets, use the /enable-tweets endpoint.');
      }
    } catch (error) {
      console.error('Error in monitorSales function:', error);
    }
  }

  setupHealthChecks() {
    // Send a health check tweet once a day to verify the bot is still running
    setInterval(async () => {
      try {
        console.log('Running health check...');
        console.log(`Health check passed at ${new Date().toISOString()}`);
      } catch (error) {
        console.error('Health check failed:', error);
      }
    }, this.config.HEALTH_CHECK_INTERVAL);
  }
}

// Start the bot
(async () => {
  try {
    const bot = new ArtBlocksSalesBot();
    await bot.initialize();
  } catch (error) {
    console.error('Error starting bot:', error);
  }
})();
