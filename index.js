const http = require('http');
require('dotenv').config();

// Simple HTTP server for health checks
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Art Blocks Sales Bot is running');
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});

// Check environment variables
console.log('Environment variables available:', Object.keys(process.env)
  .filter(key => key.includes('TWITTER') || key.includes('ALCHEMY'))
  .length);

console.log('Bot is running in simplified mode');
