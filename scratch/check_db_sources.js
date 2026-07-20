const { connectDB, getCollection } = require('../db');

async function main() {
  await connectDB();
  const episodesCol = getCollection('episodes');
  const ep = await episodesCol.findOne({ animeSlug: 'fairy-tail', season: 1, episode: 6 });
  console.log("Fairy Tail S1E6 sources:", ep ? ep.sources : "Not found");
  process.exit(0);
}

main();
