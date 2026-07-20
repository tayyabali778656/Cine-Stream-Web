const { connectDB, getCollection } = require('../db');

async function main() {
  await connectDB();
  const animeCol = getCollection('anime');
  const items = await animeCol.find({
    title: /naruto/i
  }).toArray();
  
  console.log("=== Naruto entries in MongoDB ===");
  items.forEach(item => {
    console.log(`ID: ${item.id} | Slug: ${item.slug} | Title: ${item.title}`);
  });
  process.exit(0);
}

main();
