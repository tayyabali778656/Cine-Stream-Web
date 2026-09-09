const fs = require('fs');
const glob = require('glob');
const path = require('path');

const dir = path.join(__dirname, '..');
const files = ['toon_series.html', 'wano.html', 'toon_user_url.html', 'toon_21x892.html', 'temp_ep.html'];

const targetStr = `  /* Restore selected season after refresh */

  const savedSeason = localStorage.getItem("selectedSeason");
  const savedIndex = localStorage.getItem("selectedSeasonIndex");

  if (savedSeason) {

    const savedBtn = document.querySelector(
      \`.season-btn[data-season="\${savedSeason}"]\`
    );

    if (savedBtn) {

      loadSeason(savedBtn);

      setTimeout(() => {
        if (savedIndex !== null) {
          swiper.slideTo(Number(savedIndex), 0);
        }
      }, 100);

    }

  }`;

const replacementStr = `  /* Restore selected season after refresh */

  const savedSeason = localStorage.getItem("selectedSeason");
  const savedIndex = localStorage.getItem("selectedSeasonIndex");

  if (savedSeason) {

    const savedBtn = document.querySelector(
      \`.season-btn[data-season="\${savedSeason}"]\`
    );

    if (savedBtn) {

      loadSeason(savedBtn);

      setTimeout(() => {
        if (savedIndex !== null) {
          swiper.slideTo(Number(savedIndex), 0);
        }
      }, 100);

    } else {
      const firstBtn = document.querySelector(".season-btn");
      if (firstBtn) {
        loadSeason(firstBtn);
      }
    }

  } else {
    const firstBtn = document.querySelector(".season-btn");
    if (firstBtn) {
      loadSeason(firstBtn);
    }
  }`;

let replacedCount = 0;

for (let i = 0; i < files.length; i++) {
  const filePath = path.join(dir, files[i]);
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Check for target
    if (content.includes(targetStr)) {
      content = content.replace(targetStr, replacementStr);
      fs.writeFileSync(filePath, content, 'utf8');
      console.log('Fixed ' + files[i]);
      replacedCount++;
    } else {
      console.log('Target not found in ' + files[i]);
      // Let's try to match it with regex to handle whitespace differences
      const targetRegex = /\/\* Restore selected season after refresh \*\/[\s\S]*?if \(savedIndex !== null\) \{[\s\S]*?swiper\.slideTo\(Number\(savedIndex\), 0\);[\s\S]*?\}[\s\S]*?\}, 100\);[\s\S]*?\}[\s\S]*?\}/;
      if (targetRegex.test(content)) {
          content = content.replace(targetRegex, replacementStr);
          fs.writeFileSync(filePath, content, 'utf8');
          console.log('Fixed using regex ' + files[i]);
          replacedCount++;
      } else {
          console.log('Still not found in ' + files[i]);
      }
    }
  }
}
console.log('Total fixed: ' + replacedCount);
