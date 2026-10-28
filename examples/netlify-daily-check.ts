// Run once a day. Saves the current model catalogues, so a withdrawn or retiring model is replaced
// without anyone editing a list, and says what it found. Reported as a failure (so your monitor
// notices) only when a catalogue cannot be read or a tier is left with fewer than two models.
import { ai } from './netlify-function.js';

export const config = { schedule: '0 4 * * *' };

export const handler = async () => {
  const r = await ai.checkModels();
  console.log(`models: ${r.catalogSize ?? 0} in the catalogue; withdrawn: ${r.withdrawn?.join(', ') || 'none'}; retiring soon: ${r.expiring?.join(', ') || 'none'}`);
  for (const [name, p] of Object.entries(r.providers ?? {})) console.log(`${name}: ${p.error ?? `${p.models} models; withdrawn: ${p.withdrawn.join(', ') || 'none'}; retiring: ${p.expiring.join(', ') || 'none'}`}`);
  return { statusCode: 200, body: JSON.stringify(r) };   // body.ok === false is what a monitor should alert on
};
