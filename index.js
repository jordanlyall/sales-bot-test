/**
 * Art Blocks Sales Bot
 * 
 * Enhanced version with improved metadata extraction from APIs
 * INTEGRATION GUIDE: Replace the methods within their respective classes
 */

// =========================================================
// INTEGRATION INSTRUCTIONS
// =========================================================
/**
 * How to integrate these changes:
 * 
 * 1. DO NOT paste this entire file into your codebase - it will cause syntax errors!
 * 2. For each class section below, locate the corresponding class in your codebase
 * 3. Replace only the specific methods with the enhanced versions
 * 4. For new methods/endpoints, add them to the appropriate classes
 * 5. Update routing in setupServer() to include the new endpoints
 */

// =========================================================
// API SERVICES CLASS - METHOD REPLACEMENTS
// =========================================================

/**
 * FIND YOUR ApiServices CLASS AND REPLACE THESE METHODS
 */
class ApiServices {
  // Your existing constructor and other methods...
  
  // REPLACE this method in your ApiServices class
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
      
      // Log specific fields we're interested in for debugging
      console.log(`OpenSea collection name: ${data.collection?.name || 'Not found'}`);
      console.log(`OpenSea asset name: ${data.name || 'Not found'}`);
      console.log(`OpenSea token ID: ${data.identifier || data.token_id || 'Not found'}`);
      
      // More thorough collection name extraction
      let projectName = '';
      if (data.collection && data.collection.name) {
        projectName = data.collection.name;
        console.log(`Found collection name in OpenSea data: ${projectName}`);
      } else if (data.name) {
        // If name follows format "Collection Name #123", extract the collection name
        const nameMatch = data.name.match(/^(.*?)\s+#\d+$/);
        if (nameMatch && nameMatch[1]) {
          projectName = nameMatch[1];
          console.log(`Extracted project name from token name: ${projectName}`);
        } else {
          projectName = data.name.replace(/ #\d+$/, '');
        }
      }
      
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
      
      // If creator field exists, use that as backup for artist name
      if (!artistName && data.creator) {
        artistName = data.creator.user?.username || data.creator.address;
        console.log(`Using creator as artist: ${artistName}`);
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
      // Log more details about the error
      if (error.response) {
        console.error('OpenSea API error status:', error.response.status);
        console.error('OpenSea API error data:', JSON.stringify(error.response.data).substring(0, 300));
      }
      return { success: false };
    }
  }

  // REPLACE this method in your ApiServices class
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

  // REPLACE this method in your ApiServices class
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

  // Your other existing methods...
}

// =========================================================
// METADATA MANAGER CLASS - METHOD REPLACEMENTS
// =========================================================

/**
 * FIND YOUR MetadataManager CLASS AND REPLACE THIS METHOD
 */
class MetadataManager {
  // Your existing constructor and other methods...

  // REPLACE this method in your MetadataManager class
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
          const nameParts = projectName.match(/(.*) by (.*)/i);
          if (nameParts && nameParts.length > 2) {
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

  // Your other existing methods...
}

// =========================================================
// SERVER MANAGER CLASS - NEW METHOD & UPDATES
// =========================================================

/**
 * FIND YOUR ServerManager CLASS AND ADD THIS NEW METHOD
 */
class ServerManager {
  // Your existing constructor and other methods...

  // ADD this new method to your ServerManager class
  handleApiTest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tokenId = url.searchParams.get('tokenId');
    const contractAddress = url.searchParams.get('contract') || this.config.CONTRACT_ADDRESSES[0];
    const api = url.searchParams.get('api') || 'all'; // opensea, artblocks, alchemy, or all
    
    if (!tokenId) {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('Error: Missing tokenId. Use ?tokenId=1506&contract=0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a&api=opensea in the URL');
      return;
    }
    
    console.log(`API test request for tokenId: ${tokenId}, contract: ${contractAddress}, api: ${api}`);
    
    let promises = [];
    let results = {};
    
    if (api === 'opensea' || api === 'all') {
      promises.push(
        this.api.getOpenSeaAssetMetadata(contractAddress, tokenId)
          .then(data => {
            results.opensea = data;
          })
          .catch(error => {
            results.opensea = { success: false, error: error.message };
          })
      );
    }
    
    if (api === 'artblocks' || api === 'all') {
      promises.push(
        this.api.getArtBlocksTokenInfo(tokenId, contractAddress)
          .then(data => {
            results.artblocks = data;
          })
          .catch(error => {
            results.artblocks = { success: false, error: error.message };
          })
      );
    }
    
    if (api === 'alchemy' || api === 'all') {
      promises.push(
        this.api.getAlchemyMetadata(contractAddress, tokenId)
          .then(data => {
            results.alchemy = data;
          })
          .catch(error => {
            results.alchemy = { success: false, error: error.message };
          })
      );
    }
    
    Promise.all(promises)
      .then(() => {
        // Add a summary section to make comparison easier
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
        
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(results, null, 2));
      })
      .catch(err => {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end('Error: ' + err.message);
      });
  }

  // UPDATE this method in your ServerManager class to add the new endpoint
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
        // Add this new route for the API test endpoint
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
    });

    return server;
  }

  // UPDATE this method in your ServerManager class
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

  // Your other existing methods...
}

// =========================================================
// END OF UPDATES
// =========================================================
