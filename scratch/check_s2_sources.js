async function main() {
  console.log("Fetching Season 2 Episode 1 for One Piece...");
  const eps = await fetch('http://localhost:3000/api/v1/episodes?animeId=toon_one-piece&season=2&episode=1').then(r => r.json());
  console.log("Returned episodes count:", eps.length);
  console.log("Seasons available in returned list:", [...new Set(eps.map(e => e.season))]);
  const s2eps = eps.filter(e => e.season === 2);
  console.log("Season 2 episodes count:", s2eps.length);
  if (s2eps.length > 0) {
    console.log("First Season 2 episode:", s2eps[0]);
  }
  process.exit(0);
}

main();
