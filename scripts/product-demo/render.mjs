import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
import {mkdir, copyFile, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {homedir} from 'node:os';

const root = dirname(fileURLToPath(import.meta.url));
const proof = resolve(root, '../../docs/research/assets/product-pilot-take2-2026-09-11/receipt.json');
const receipt = JSON.parse(await readFile(proof, 'utf8'));
if (receipt.status !== 'complete' || receipt.generation_submissions !== 0 || receipt.result?.object?.roof_material !== 'teal') throw new Error('Verified teal-roof pilot required');
const source = process.env.PILOT_SOURCE || resolve(homedir(), 'Desktop/openflipbook-product-pilot-SOURCE-2026-09-11.mp4');
const output = process.env.PILOT_OUTPUT || resolve(homedir(), 'Desktop/openflipbook-product-pilot-v2-2026-09-11.mp4');
await mkdir(resolve(root, 'public'), {recursive: true});
await copyFile(source, resolve(root, 'public/source.mp4'));
const serveUrl = await bundle({entryPoint: resolve(root, 'src/index.tsx'), outDir: resolve(root, 'build')});
const composition = await selectComposition({serveUrl, id: 'ProductPilot'});
let last = -1;
await renderMedia({
  composition, serveUrl, outputLocation: output, codec: 'h264', crf: 16,
  pixelFormat: 'yuv420p', muted: true, concurrency: 2,
  onProgress: ({progress}) => {const bucket = Math.floor(progress * 10); if (bucket !== last) {last = bucket; console.log(`Render ${bucket * 10}%`);}},
});
const result = {output, source, proof, editor: 'Remotion 4.0.523', width: composition.width, height: composition.height, fps: composition.fps, frames: composition.durationInFrames, audio: 'none', human_approved: false, notes: 'Real chronological UI footage. Setup, pauses and save/reload wait omitted; no speed-up, generated UI or model submissions.'};
await writeFile(resolve(root, 'public/render-receipt.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
