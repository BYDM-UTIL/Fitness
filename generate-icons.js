/**
 * Generate PWA PNG icons from the shared SVG source.
 * Run: node generate-icons.js
 * Requires the optional canvas package.
 */

const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

async function generateIcons() {
  const outDir = path.join(__dirname, 'icons');
  const image = await loadImage(path.join(outDir, 'icon.svg'));

  for (const size of [192, 512]) {
    const canvas = createCanvas(size, size);
    canvas.getContext('2d').drawImage(image, 0, 0, size, size);
    const outPath = path.join(outDir, `icon-${size}.png`);
    fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
    console.log(`Generated ${outPath}`);
  }
}

generateIcons().catch(error => {
  console.error('Icon generation failed:', error);
  process.exitCode = 1;
});
