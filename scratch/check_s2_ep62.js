async function main() {
  console.log("Fetching Season 2 Episode 62 for One Piece...");
  const eps = await fetch('http://localhost:3000/api/v1/episodes?animeId=toon_one-piece&season=2&episode=62').then(r => r.json());
  const ep = eps.find(e => e.season === 2 && e.episode === 62);
  console.log("Episode S2E62 details:", ep);
  process.exit(0);
}

main();
