// Build-time: pull the FastEmbed model into the image so the container starts
// warm. Best-effort — the Dockerfile tolerates failure and the model then
// downloads lazily on first use.
import { warm } from '../src/embed.js';

await warm();
console.log('fastembed: model prefetched into image');
