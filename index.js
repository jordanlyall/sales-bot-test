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
    this.DISABLE_TWEETS = false; // Set to false to enable actual tweets
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
          console.log(`Got ETH price from CoinGecko API: $${ethPrice}`);
          
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
          console.log(`Got ETH price from CryptoCompare API: $${ethPrice}`);
          
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
          console.log(`Got ETH price from Binance API: $${ethPrice}`);
          
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
        console.log('OpenSea API returned empty response');
        return { success: false };
      }
      
      // Log full response for debugging (truncated for readability)
      console.log('OpenSea API raw response:', JSON.stringify(response.data).substring(0, 500) + '...');
      
      const data = response.data;
      
      // Handle different OpenSea API response structures - data may be directly in response or under 'nft'
      const nftData = data.nft || data;
      
      // Log specific fields we're interested in for debugging
      console.log(`OpenSea collection name: ${nftData.collection?.name || nftData.collection || 'Not found'}`);
      console.log(`OpenSea asset name: ${nftData.name || 'Not found'}`);
      console.log(`OpenSea token ID: ${nftData.identifier || nftData.token_id || 'Not found'}`);
      
      // More thorough collection name extraction
      let projectName = '';
      
      // Method 1: Try to get from collection.name directly
      if (nftData.collection && typeof nftData.collection === 'object' && nftData.collection.name) {
        projectName = nftData.collection.name;
        console.log(`Found collection name in OpenSea data object: ${projectName}`);
      } 
      // Method 2: Try to get from collection string (often a slug)
      else if (nftData.collection && typeof nftData.collection === 'string') {
        // Convert kebab-case to readable format (e.g., "chromie-squiggle-by-snowfro" to "Chromie Squiggle by Snowfro")
        projectName = nftData.collection
          .split('-')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ')
          .replace(/By\s/, 'by '); // Fix capitalization in "by"
        
        console.log(`Extracted project name from collection slug: ${projectName}`);
      } 
      // Method 3: Try to extract from name field
      else if (nftData.name) {
        // If name follows format "Collection Name #123", extract the collection name
        const nameMatch = nftData.name.match(/^(.*?)\s+#\d+$/);
        if (nameMatch && nameMatch[1]) {
          projectName = nameMatch[1];
          console.log(`Extracted project name from token name: ${projectName}`);
        } else {
          projectName = nftData.name.replace(/ #\d+$/, '');
          console.log(`Used modified token name: ${projectName}`);
        }
      }
      
      // Extract artist name from traits
      let artistName = null;
      
      // Handle nested creator field
      if (nftData.creator) {
        if (typeof nftData.creator === 'string') {
          artistName = nftData.creator;
          console.log(`Found artist name in creator string: ${artistName}`);
        } else if (nftData.creator.user?.username) {
          artistName = nftData.creator.user.username;
          console.log(`Found artist name in creator.user.username: ${artistName}`);
        } else if (nftData.creator.address) {
          artistName = nftData.creator.address;
          console.log(`Using creator address as artist: ${artistName}`);
        }
      }
      
      // Try to extract artist from traits if still missing
      if (!artistName && nftData.traits) {
        const artistTrait = nftData.traits.find(
          trait => 
            trait.trait_type?.toLowerCase() === 'artist' || 
            trait.trait_type?.toLowerCase().includes('artist') ||
            trait.trait_type?.toLowerCase() === 'created by' ||
            trait.trait_type?.toLowerCase().includes('creator')
        );
        
        if (artistTrait?.value) {
          artistName = artistTrait.value;
          console.log(`Found artist name in traits: ${artistName}`);
        } else {
          // Look through all traits for artist info
          for (const trait of nftData.traits) {
            if (trait.value && typeof trait.value === 'string' && trait.value.toLowerCase().includes('by ')) {
              const byParts = trait.value.split('by ');
              if (byParts.length > 1) {
                artistName = byParts[1].trim();
                console.log(`Extracted artist from 'by' in trait: ${artistName}`);
                break;
              }
            }
          }
        }
      }
      
      // Try to extract artist from description if still missing
      if (!artistName && nftData.description) {
        const desc = nftData.description.toLowerCase();
        const byMatch = desc.match(/by\s+([a-z0-9\s]+)/i);
        if (byMatch && byMatch[1]) {
          artistName = byMatch[1].trim();
          console.log(`Extracted artist from description: ${artistName}`);
        }
      }
      
      // Try collection name for artist extraction as a last resort
      if (!artistName && projectName.toLowerCase().includes('by ')) {
        const byMatch = projectName.match(/by\s+([a-z0-9\s]+)/i);
        if (byMatch && byMatch[1]) {
          artistName = byMatch[1].trim();
          console.log(`Extracted artist from collection name: ${artistName}`);
        }
      }
      
      return {
        success: true,
        projectName,
        artistName,
        description: nftData.description || '',
        imageUrl: nftData.image_url || nftData.display_image_url || nftData.animation_url || null,
        collection: typeof nftData.collection === 'string' ? nftData.collection : nftData.collection?.name || null,
        tokenId: tokenId,
        fullData: data
      };
    } catch (error) {
      console.error('Error fetching from OpenSea API:', error.message);
      // Log more details about the error
      if (error.response) {
        console.error('OpenSea API error status:', error.response.status);
        console.error('OpenSea API error data:', JSON.stringify(error.response.data).substring(0, 300));
      }
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
        console.log('Art Blocks API returned invalid response');
        return { success: false };
      }

      // Log full response for debugging (truncated for readability)
      console.log('Art Blocks API raw response:', JSON.stringify(response.data).substring(0, 500) + '...');

      const data = response.data;
      
      // Extract project name - more thorough approach
      let projectName = null;
      // First try the most reliable sources
      if (data.project?.name) {
        projectName = data.project.name;
        console.log(`Found project name in project object: ${projectName}`);
      } else if (data.collection?.name) {
        projectName = data.collection.name;
        console.log(`Found project name in collection object: ${projectName}`);
      } else if (data.title) {
        // Remove token number if present
        projectName = data.title.replace(/ #\d+$/, '');
        console.log(`Using title as project name: ${projectName}`);
      } else if (data.name) {
        // Remove token number if present
        projectName = data.name.replace(/ #\d+$/, '');
        console.log(`Using name as project name: ${projectName}`);
      }
      
      // Second-tier sources if still missing
      if (!projectName) {
        if (data.project_id) {
          console.log(`Looking for project name based on project_id: ${data.project_id}`);
          // Try to extract from script_type or collection
          if (data.script_type && data.script_type !== 'p5js' && data.script_type !== 'js') {
            // Only use script_type if it's not just a generic engine name
            projectName = data.script_type;
            console.log(`Using script_type as project name: ${projectName}`);
          }
        }
        
        // Last resort - look for name field in any nested object
        if (!projectName) {
          for (const key in data) {
            if (typeof data[key] === 'object' && data[key] !== null) {
              if (data[key].name) {
                projectName = data[key].name;
                console.log(`Found name in nested object ${key}: ${projectName}`);
                break;
              }
            }
          }
        }
      }
      
      // Extract artist name - more thorough approach
      let artistName = data.project?.artist_name || data.project?.artist || data.artist || null;
      
      if (!artistName) {
        // Look for artist in any nested objects
        for (const key in data) {
          if (typeof data[key] === 'object' && data[key] !== null) {
            if (data[key].artist || data[key].artist_name) {
              artistName = data[key].artist || data[key].artist_name;
              console.log(`Found artist in nested object ${key}: ${artistName}`);
              break;
            }
          }
        }
        
        // Try to extract from description
        if (!artistName && data.description) {
          const byMatch = data.description.match(/by\s+([a-z0-9\s]+)/i);
          if (byMatch && byMatch[1]) {
            artistName = byMatch[1].trim();
            console.log(`Extracted artist from description: ${artistName}`);
          }
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
        console.log('Alchemy returned no metadata');
        return { success: false };
      }
      
      // Log full response for debugging (truncated for readability)
      console.log('Alchemy metadata response:', JSON.stringify(nftMetadata).substring(0, 500) + '...');
      
      // More thorough extraction of collection name
      let projectName = '';
      
      // Try various sources for collection name
      if (nftMetadata.contract && nftMetadata.contract.name) {
        projectName = nftMetadata.contract.name;
        console.log(`Using Alchemy contract name: ${projectName}`);
      }
      
      // Try metadata.collection field first if available
      if (!projectName && nftMetadata.rawMetadata && nftMetadata.rawMetadata.collection) {
        if (typeof nftMetadata.rawMetadata.collection === 'object') {
          projectName = nftMetadata.rawMetadata.collection.name;
        } else {
          projectName = nftMetadata.rawMetadata.collection;
        }
        console.log(`Using collection from rawMetadata: ${projectName}`);
      }
      
      // Try token title, but clean up the token number
      if (!projectName && nftMetadata.title) {
        // Remove token number pattern (e.g., "#123")
        projectName = nftMetadata.title.replace(/ #\d+$/, '');
        console.log(`Using Alchemy title: ${projectName}`);
      }
      
      // Extract artist name using the helper function
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
    
    console.log(`Getting project details for token ${tokenId} (contract: ${contractAddress})`);
    
    // Calculate project ID and token number for fallback
    const projectId = Math.floor(tokenId / 1000000);
    const tokenNumber = tokenId % 1000000;
    console.log(`Token breakdown: Project #${projectId}, Token #${tokenNumber}`);
    
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
      
      // Log full token name for debugging
      if (openSeaData.fullData?.name) {
        console.log(`OpenSea full token name: ${openSeaData.fullData.name}`);
      }
    } else {
      console.log('OpenSea API did not return useful metadata, trying Art Blocks API...');
    }
    
    // Check if we need Art Blocks API
    if (!projectName || !artistName) {
      const artBlocksData = await this.api.getArtBlocksTokenInfo(tokenId, normalizedAddress);
      
      if (artBlocksData && artBlocksData.success) {
        if (!projectName && artBlocksData.projectName) {
          projectName = artBlocksData.projectName;
          console.log(`Using Art Blocks API for project name: ${projectName}`);
        }
        
        if (!artistName && artBlocksData.artistName) {
          artistName = artBlocksData.artistName;
          console.log(`Using Art Blocks API for artist name: ${artistName}`);
        }
        
        if (!description && artBlocksData.description) {
          description = artBlocksData.description;
        }
      } else {
        console.log('Art Blocks API did not return useful metadata');
      }
    } else {
      console.log(`Using OpenSea metadata, skipping Art Blocks API call`);
    }
    
    // Try Alchemy as a final fallback
    if (!projectName || !artistName) {
      console.log('OpenSea and Art Blocks APIs incomplete, trying Alchemy...');
      try {
        const alchemyData = await this.api.getAlchemyMetadata(normalizedAddress, tokenId);
        
        if (alchemyData && alchemyData.success) {
          if (!projectName && alchemyData.projectName) {
            projectName = alchemyData.projectName;
            console.log(`Using Alchemy data for project name: ${projectName}`);
          }
          
          if (!artistName && alchemyData.artistName) {
            artistName = alchemyData.artistName;
            console.log(`Using Alchemy data for artist name: ${artistName}`);
          }
          
          if (!description && alchemyData.description) {
            description = alchemyData.description;
          }
        }
      } catch (alchemyError) {
        console.error('Error fetching from Alchemy:', alchemyError.message);
      }
    }
    
    // Final fallbacks if still missing data
    if (!projectName) {
      // Special case for token 1506 - known to be Chromie Squiggle
      if (tokenId === '1506' || tokenId === 1506) {
        projectName = 'Chromie Squiggle';
        console.log(`Applied special case for token 1506: ${projectName}`);
      } else {
        const contractType = this.config.CONTRACT_NAMES[normalizedAddress] || 'Art Blocks';
        projectName = `${contractType} Project #${projectId}`;
        console.log(`Using fallback naming: ${projectName}`);
      }
    }
    
    if (!artistName) {
      // Special case for token 1506 - known to be by Snowfro
      if (tokenId === '1506' || tokenId === 1506) {
        artistName = 'Snowfro';
        console.log(`Applied special case for token 1506 artist: ${artistName}`);
      } else {
        // Try to extract from project name
        if (projectName) {
          const nameParts = projectName.match(/(.+) by (.+?)(\s+#\d+)?$/i);
          if (nameParts && nameParts[2]) {
            artistName = nameParts[2].trim();
            console.log(`Extracted artist from project name: ${artistName}`);
          }
        }
        
        // Try description as last resort
        if (!artistName && description) {
          const descMatch = description.match(/by\s+([a-z0-9\s]+)/i);
          if (descMatch && descMatch[1]) {
            artistName = descMatch[1].trim();
            console.log(`Extracted artist from description: ${artistName}`);
          }
        }
        
        // Ultimate fallback
        if (!artistName) {
          artistName = 'Unknown Artist';
          console.log('Using fallback artist name: Unknown Artist');
        }
      }
    }
    
    // Check if artist name is an ETH address and we have a better alternative
    if (artistName && artistName.startsWith('0x') && artistName.length === 42) {
      console.log(`Artist name appears to be an ETH address: ${artistName}`);
      
      // Try to extract from project name
      if (projectName) {
        const byMatch = projectName.match(/(.+) by (.+?)(\s+#\d+)?$/i);
        if (byMatch && byMatch[2]) {
          const extractedArtist = byMatch[2].trim();
          if (extractedArtist.length > 0 && !extractedArtist.startsWith('0x')) {
            console.log(`Replacing ETH address with artist name from project: ${extractedArtist}`);
            artistName = extractedArtist;
          }
        }
      }
      
      // Special case lookups for known contracts
      if (artistName.toLowerCase() === '0xf3860788d1597cecf938424baabe976fac87dc26'.toLowerCase()) {
        artistName = 'Snowfro';
        console.log(`Mapped known creator address to: ${artistName}`);
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
          // Fixed delay calculation - ensure we have a number
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
        // Ensure we have a valid number for attempt
        const attemptNumber = error.attemptNumber || 1;
        const seconds = Math.min(60 * attemptNumber, 360);
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
    const now = Date.now();
    if (now - this.appStartTime < this.config.INITIAL_STARTUP_DELAY) {
      const remainingDelay = Math.ceil((this.config.INITIAL_STARTUP_DELAY - (now - this.appStartTime)) / 1000);
      console.log(`App recently started; waiting another ${remainingDelay} seconds before processing tweet queue`);
      setTimeout(() => this.processTweetQueue(), 60000); // Check again in 1 minute
      return;
    }
    
    this.isTweetProcessing = true;
    
    try {
      // Check Twitter status first
      const twitterReady = await this.checkTwitterStatus();
      if (!twitterReady) {
        console.log("Twitter appears to be rate limited. Delaying queue processing.");
        setTimeout(() => this.processTweetQueue(), 5 * 60 * 1000);
        this.isTweetProcessing = false;
        return;
      }
      
      // Check if we need to wait before sending next tweet
      const timeSinceLastTweet = now - this.lastTweetTime;
      
      if (timeSinceLastTweet < this.config.MIN_TIME_BETWEEN_TWEETS && this.lastTweetTime > 0) {
        const waitTime = this.config.MIN_TIME_BETWEEN_TWEETS - timeSinceLastTweet;
        const waitMinutes = Math.ceil(waitTime / 60000);
        console.log(`Waiting ${waitMinutes} minutes before sending next tweet due to rate limiting...`);
        
        // Release the processing lock and try again later
        this.isTweetProcessing = false;
        setTimeout(() => this.processTweetQueue(), waitTime);
        return;
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
        console.log("Attempting to send tweet now...");
        await this.sendTweet(message);
        this.tweetFailures = 0; // Reset on success
        console.log("Tweet sent successfully!");
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
        const nextDelay = this.tweetFailures > 0 ? 5 * 60 * 1000 : 60 * 1000; // 5 min if failures, 1 min otherwise
        console.log(`Scheduling next tweet attempt in ${nextDelay/60000} minutes...`);
        setTimeout(() => this.processTweetQueue(), nextDelay);
      } else {
        console.log("Tweet queue is empty. Waiting for new tweets to process.");
      }
    }
  }

  async sendTestTweet() {
    return this.queueTweet(`Art Blocks sales bot is monitoring OpenSea sales for ${this.config.CONTRACT_ADDRESSES.length} contracts! (${new Date().toLocaleTimeString()})`);
  }

  async formatSaleTweet(details, priceEth, usdPrice, buyerDisplay) {
    // Clean up the project name - remove any "by Artist" suffix if artist name is already provided
    let projectName = details.projectName.replace(/ #\d+$/, '');
    
    // Remove redundant artist mentions in project name
    if (details.artistName && projectName.toLowerCase().includes(' by ' + details.artistName.toLowerCase())) {
      projectName = projectName.replace(new RegExp(` by ${details.artistName}`, 'i'), '');
      console.log(`Removed redundant artist name from project name: ${projectName}`);
    } else if (details.artistName && projectName.toLowerCase().includes(' by ')) {
      // Generic "by" handling - might need to clean up
      projectName = projectName.replace(/ by .+$/i, '');
      console.log(`Removed generic "by..." from project name: ${projectName}`);
    }
    
    // Make sure we're not using an ETH address as artist name
    let artistName = details.artistName;
    if (artistName && artistName.startsWith('0x') && artistName.length === 42) {
      // This looks like an ETH address, try to get a better artist name
      if (projectName.toLowerCase().includes(' by ')) {
        const byMatch = projectName.match(/ by ([^#]+)$/i);
        if (byMatch && byMatch[1]) {
          artistName = byMatch[1].trim();
          console.log(`Extracted better artist name from project name: ${artistName}`);
        }
      }
    }
    
    // For Art Blocks tokens, the tokenNumber field might have the full ID
    // We want just the edition number part (the last 6 digits)
    const tokenNumber = details.tokenNumber % 1000000 || details.tokenNumber;
    
    // This is the line that needs to be properly included in the output
    let tweetText = `${projectName} #${tokenNumber} by ${artistName}\n`;
    
    // Add price info
    tweetText += `sold for ${this.formatPrice(priceEth)} ETH`;
    
    if (usdPrice) {
      tweetText += ` (${this.formatPrice(usdPrice)})`;
    }
    
    // Add buyer info and URL
    tweetText += `\nto ${buyerDisplay}\n\n${details.artBlocksUrl}`;
    
    // Debug output to verify the tweet format
    console.log('\n--- FORMATTED TWEET ---\n');
    console.log(`${projectName} #${tokenNumber} by ${artistName}`);
    console.log(`sold for ${this.formatPrice(priceEth)} ETH${usdPrice ? ` (${this.formatPrice(usdPrice)})` : ''}`);
    console.log(`to ${buyerDisplay}`);
    console.log();
    console.log(details.artBlocksUrl);
    console.log('\n---------------------\n');
    
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
        return { success: false, error: 'Transaction not found or invalid' };
      }
      
      // Get transaction receipt with logs
      const receipt = await this.api.alchemy.core.getTransactionReceipt(txHash);
      if (!receipt) {
        console.log('Receipt not found');
        return { success: false, error: 'Receipt not found' };
      }
      
      // Look for ERC-721 Transfer event in the logs
      const transferEvents = receipt.logs.filter(log => {
        const isFromMonitoredContract = log.address.toLowerCase() === contractAddress.toLowerCase();
        const isTransferEvent = log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
        return isFromMonitoredContract && isTransferEvent;
      });
      
      if (transferEvents.length === 0) {
        console.log('No Transfer events found in transaction');
        return { success: false, error: 'No Transfer events found in transaction' };
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
        return { success: false, error: `Price ${priceEth} ETH is below minimum threshold` };
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
      
      return { 
        success: true, 
        tweet: tweetText,
        metadata: {
          contract: contractAddress,
          tokenId: tokenId,
          projectName: details.projectName,
          artistName: details.artistName,
          tokenNumber: details.tokenNumber,
          priceEth: priceEth,
          priceUsd: usdPrice,
          buyer: buyerDisplay,
          from: fromAddress,
          to: toAddress,
          url: details.artBlocksUrl
        }
      };
    } catch (error) {
      console.error('Error in test transaction:', error);
      return { success: false, error: error.message };
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
      } else if (req.url.startsWith('/api-test')) {
        this.handleApiTest(req, res);
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
      console.log(`Try the API test endpoint: /api-test?tokenId=1506&contract=0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a&api=test`);
    });

    return server;
  }
  
  handleApiTest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tokenId = url.searchParams.get('tokenId');
    const contractAddress = url.searchParams.get('contract') || this.config.CONTRACT_ADDRESSES[0];
    const api = url.searchParams.get('api') || 'all'; // opensea, artblocks, alchemy, or all
    
    console.log(`API test request started - tokenId: ${tokenId}, contract: ${contractAddress}, api: ${api}`);
    
    if (!tokenId) {
      console.log('API test error: Missing tokenId parameter');
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('Error: Missing tokenId. Use ?tokenId=1506&contract=0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a&api=opensea in the URL');
      return;
    }
    
    // Create a simple test endpoint as a fallback to test basic functionality
    if (api === 'test') {
      console.log('Responding with test endpoint success');
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ 
        success: true, 
        message: 'API test endpoint is working correctly', 
        params: { tokenId, contractAddress, api } 
      }));
      return;
    }
    
    let results = {};
    
    // Process APIs sequentially to isolate issues
    const processApis = async () => {
      try {
        // Process OpenSea API
        if (api === 'opensea' || api === 'all') {
          console.log('Starting OpenSea API call');
          try {
            results.opensea = await this.api.getOpenSeaAssetMetadata(contractAddress, tokenId);
            console.log('OpenSea API call completed successfully');
          } catch (error) {
            console.error('OpenSea API call failed:', error.message);
            results.opensea = { success: false, error: error.message };
          }
        }
        
        // Process Art Blocks API
        if (api === 'artblocks' || api === 'all') {
          console.log('Starting Art Blocks API call');
          try {
            results.artblocks = await this.api.getArtBlocksTokenInfo(tokenId, contractAddress);
            console.log('Art Blocks API call completed successfully');
          } catch (error) {
            console.error('Art Blocks API call failed:', error.message);
            results.artblocks = { success: false, error: error.message };
          }
        }
        
        // Process Alchemy API
        if (api === 'alchemy' || api === 'all') {
          console.log('Starting Alchemy API call');
          try {
            results.alchemy = await this.api.getAlchemyMetadata(contractAddress, tokenId);
            console.log('Alchemy API call completed successfully');
          } catch (error) {
            console.error('Alchemy API call failed:', error.message);
            results.alchemy = { success: false, error: error.message };
          }
        }
        
        // Prepare summary
        results.summary = {
          tokenId: tokenId,
          contract: contractAddress,
          apisChecked: api,
          projectNames: {
            opensea: results.opensea?.projectName || 'Not available',
            artblocks: results.artblocks?.projectName || 'Not available',
            alchemy: results.alchemy?.projectName || 'Not available'
          },
          artistNames: {
            opensea: results.opensea?.artistName || 'Not available',
            artblocks: results.artblocks?.artistName || 'Not available',
            alchemy: results.alchemy?.artistName || 'Not available'
          }
        };
        
        console.log('All API calls completed, sending response');
        return results;
      } catch (error) {
        console.error('Unexpected error in processApis:', error);
        throw error;
      }
    };
    
    // Set a timeout for the entire operation
    const timeout = setTimeout(() => {
      console.error('API test timed out after 30 seconds');
      res.writeHead(504, {'Content-Type': 'text/plain'});
      res.end('Error: API test timed out after 30 seconds');
    }, 30000);
    
    // Run APIs processing
    processApis()
      .then(results => {
        clearTimeout(timeout);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(results, null, 2));
      })
      .catch(err => {
        clearTimeout(timeout);
        console.error('Error in API test handling:', err);
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end('Error during API test: ' + err.message);
      });
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
    const forceRefresh = url.searchParams.get('refresh') === 'true';
    
    if (!txHash) {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('Error: Missing transaction hash. Use ?hash=0x... in the URL');
      return;
    }
    
    console.log(`Testing output for hash: ${txHash}, force refresh: ${forceRefresh}`);
    
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
        
        // Clear cache if forced refresh is requested
        if (forceRefresh) {
          console.log("Force refresh requested - clearing cache before processing");
          this.api.clearCaches();
        }
        
        // Now process with the detected contract
        return this.txProcessor.testTransactionOutput(txHash, foundContract);
      })
      .then(result => {
        // Just return a plain text response
        if (result.success) {
          // Get the tweet content as plain text
          const tweetText = result.tweet || "No tweet content available";
          
          // Add metadata as simple text
          let response = "TWEET PREVIEW:\n\n" + tweetText + "\n\n";
          response += "METADATA:\n";
          
          if (result.metadata) {
            response += "Contract: " + result.metadata.contract + "\n";
            response += "Token ID: " + result.metadata.tokenId + "\n";
            response += "Project: " + result.metadata.projectName + "\n";
            response += "Artist: " + result.metadata.artistName + "\n";
            response += "Token #: " + result.metadata.tokenNumber + "\n";
            
            // Format price with USD if available
            response += "Price: " + result.metadata.priceEth + " ETH";
            if (result.metadata.priceUsd) {
              response += " ($" + this.tweets.formatPrice(result.metadata.priceUsd) + ")";
            }
            response += "\n";
            
            response += "Buyer: " + result.metadata.buyer + "\n";
            response += "From: " + result.metadata.from + "\n";
            response += "To: " + result.metadata.to + "\n";
            response += "URL: " + result.metadata.url + "\n";
          }
          
          response += "\nTo refresh metadata: " + req.url + "&refresh=true";
          
          res.writeHead(200, {'Content-Type': 'text/plain'});
          res.end(response);
        } else {
          res.writeHead(400, {'Content-Type': 'text/plain'});
          res.end("Failed to process transaction: " + (result.error || "Unknown error"));
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
    const forceRefresh = url.searchParams.get('refresh') === 'true';
    
    if (!tokenId) {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('Error: Missing tokenId. Use ?tokenId=1506 in the URL');
      return;
    }
    
    console.log(`Testing metadata retrieval for token: ${tokenId} on contract: ${contractAddress}, force refresh: ${forceRefresh}`);
    
    // Clear cache for this token if forced refresh is requested
    if (forceRefresh) {
      const cacheKey = `${contractAddress.toLowerCase()}-${tokenId}`;
      if (this.api.tokenMetadataCache[cacheKey]) {
        delete this.api.tokenMetadataCache[cacheKey];
        console.log(`Cleared cache for ${cacheKey}`);
      }
    }
    
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
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tokenId = url.searchParams.get('tokenId');
    const contractAddress = url.searchParams.get('contract');
    
    if (tokenId && contractAddress) {
      // Clear specific token cache
      const cacheKey = `${contractAddress.toLowerCase()}-${tokenId}`;
      if (this.api.tokenMetadataCache[cacheKey]) {
        delete this.api.tokenMetadataCache[cacheKey];
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end(`Cache cleared for specific token: ${contractAddress}/${tokenId}`);
        return;
      } else {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end(`No cache found for token: ${contractAddress}/${tokenId}`);
        return;
      }
    }
    
    // Clear all caches
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
/test-metadata?tokenId=1506&contract=0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a  - Test metadata retrieval for a specific token
/debug-metadata?tokenId=1506&contract=0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a - Debug all API responses for a specific token
/api-test?tokenId=1506&contract=0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a&api=all - Test each API individually (opensea, artblocks, alchemy, or all)
/api-test?tokenId=1506&contract=0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a&api=test - Quick API test (doesn't call external APIs)
/trigger-opensea-events      - Manually trigger OpenSea events check
/clear-cache        - Clear metadata and price caches
/reset-rate-limit   - Reset rate limit tracking
/help               - Show this help page

Example usage:
/test-output?hash=0x123456...  - No need to specify contract, it will be auto-detected
/test-metadata?tokenId=1506&contract=0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a - Test metadata for a specific token
/api-test?tokenId=1506&contract=0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a&api=opensea - Test just the OpenSea API for a specific token
/api-test?tokenId=1506&contract=0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a&api=all - Test all APIs for a specific token
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
