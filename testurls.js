const https = require('https');
https.get('https://toon-stream.site/tv/one-piece-dub-sub/', res => {
  let d = '';
  res.on('data', c => d+=c);
  res.on('end', () => {
    const s21 = d.match(/\/episode\/[^"']*21x\d+[^"']*/g);
    const s22 = d.match(/\/episode\/[^"']*22x\d+[^"']*/g);
    console.log('S21:', s21 ? s21.slice(0, 2) : 'none');
    console.log('S22:', s22 ? s22.slice(0, 2) : 'none');
  });
});
