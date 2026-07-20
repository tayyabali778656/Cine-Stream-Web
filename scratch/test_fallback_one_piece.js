const { getPlayServerFromFallback } = require('../services/toonstreamLive');

async function main() {
  console.log("Directly testing fallback for One Piece S2E62...");
  const sources = await getPlayServerFromFallback('one-piece', 2, 62);
  console.log("Fallback returned sources:", sources);
  process.exit(0);
}

main();
