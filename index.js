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

// Function to send a test tweet
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

console.log('Bot is running with Twitter client initialized');
