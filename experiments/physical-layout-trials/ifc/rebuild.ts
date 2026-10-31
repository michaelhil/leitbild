import {deliver} from './delivery.ts';
const [source,output]=process.argv.slice(2);if(!source||!output)throw Error('Usage: bun run rebuild.ts saved-source.ifc output-directory');
console.log(JSON.stringify(await deliver(await Bun.file(source).bytes(),output),null,2));
