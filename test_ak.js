fetch('https://animekai.be/watch/attack-on-titan-season-2/ep-1').then(r=>r.text()).then(h=>{
  const matches = h.match(/href="[^"]*\/watch\/attack-on-titan-season-2\/ep-\d+"/gi);
  console.log(matches ? matches.length : 0);
  console.log(matches ? matches.slice(-5) : []);
});
