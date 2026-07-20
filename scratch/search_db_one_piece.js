const { connectDB, getCollection } = require('../db');

async function main() {
  await connectDB();
  const animeCol = getCollection('anime');
  const items = await animeCol.find({
    $or: [
      { title: /one piece/i },
      { id: /one-piece/i },
      { slug: /one-piece/i }
    ]
  }).toArray();
  
  console.log("=== One Piece entries in MongoDB ===");
  items.forEach(item => {
    console.log(`ID: ${item.id} | Slug: ${item.slug} | Title: ${item.title}`);
  });
  process.exit(0);
}

main();
