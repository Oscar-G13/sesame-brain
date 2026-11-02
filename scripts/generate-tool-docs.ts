import {config} from '../src/config.js';
import {writeFile} from 'node:fs/promises';
import {z} from 'zod/v4';
import {allToolDefinitions} from '../src/brain/lifecycle.js';
const definitions=Object.fromEntries(Object.entries(allToolDefinitions).map(([name,d])=>[name,{description:d.description,inputSchema:z.toJSONSchema(d.inputSchema,{io:"input"})}]));
await writeFile('docs/tool-contracts.v3.json',JSON.stringify({version:config.version,tools:definitions},null,2)+'\n');
process.exit(0);
