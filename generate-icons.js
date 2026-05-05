/**
 * generate-icons.js
 * הרץ עם Node.js (>=18) כדי ליצור קבצי PNG לאייקוני PWA:
 *   node generate-icons.js
 *
 * דורש: npm install canvas
 */

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const SIZES = [192, 512];
const OUT_DIR = path.join(__dirname, 'icons');

function drawIcon(ctx, size) {
  const s = size / 100;

  // רקע כחול
  ctx.fillStyle = '#007AFF';
  const r = size * 0.22;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  // דמבל לבן
  ctx.fillStyle = 'white';
  const fill = (x, y, w, h, rx) => {
    ctx.beginPath();
    ctx.moveTo(x + rx, y);
    ctx.lineTo(x + w - rx, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rx);
    ctx.lineTo(x + w, y + h - rx);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rx, y + h);
    ctx.lineTo(x + rx, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rx);
    ctx.lineTo(x, y + rx);
    ctx.quadraticCurveTo(x, y, x + rx, y);
    ctx.closePath();
    ctx.fill();
  };

  fill(4*s,  38*s, 6*s,  24*s, 3*s);
  fill(10*s, 33*s, 14*s, 34*s, 4*s);
  fill(24*s, 44*s, 52*s, 12*s, 3*s);
  fill(76*s, 33*s, 14*s, 34*s, 4*s);
  fill(90*s, 38*s, 6*s,  24*s, 3*s);
}

SIZES.forEach(size => {
  const canvas = createCanvas(size, size);
  const ctx    = canvas.getContext('2d');
  drawIcon(ctx, size);

  const outPath = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  console.log(`✓ נוצר: ${outPath}`);
});

console.log('\nהאייקונים נוצרו בהצלחה!');
