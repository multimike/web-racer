// Write the base64 WAV a music-lab report carries (`&wav=music|mix`) to a file.
//   node tools/node/report-wav.mjs out.json out.wav
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: node tools/node/report-wav.mjs <report.json> <out.wav>');
  process.exit(2);
}
const report = JSON.parse(readFileSync(input, 'utf8'));
if (typeof report.wav !== 'string') {
  console.error(`${input} has no wav (run the music lab with &wav=music or &wav=mix)`);
  process.exit(1);
}
const bytes = Buffer.from(report.wav, 'base64');
writeFileSync(output, bytes);
console.log(`${output}: ${(bytes.length / 1e6).toFixed(1)} MB (${report.wavKind})`);
