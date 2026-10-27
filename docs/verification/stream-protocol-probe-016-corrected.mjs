// Independent diagnostic; synthetic photo and mock loopback model only.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { analyzePhoto } from '../../src/server/vision.ts';
const content = JSON.stringify({items: [], warning: ''});
let responseText = '';
const server = createServer((req,res) => {req.resume(); req.on('end',()=>{res.writeHead(200,{'content-type':'application/x-ndjson'});res.end(responseText);});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
const photo = await sharp({create:{width:32,height:32,channels:3,background:'#888'}}).jpeg().toBuffer();
const results=[];
try {
  for (const [name,text] of [
    ['valid terminal', JSON.stringify({message:{content},done:true,done_reason:'stop'})+'\n'],
    ['missing terminal marker', JSON.stringify({message:{content},done:false})+'\n'],
    ['malformed trailing line', JSON.stringify({message:{content},done:true,done_reason:'stop'})+'\nBROKEN JSON\n'],
    ['malformed leading line', 'BROKEN JSON\n'+JSON.stringify({message:{content},done:true,done_reason:'stop'})+'\n'],
  ]) {
    responseText=text;
    try {const result=await analyzePhoto(photo);results.push({name,accepted:true,itemCount:result.analysis.items.length});}
    catch(error){results.push({name,accepted:false,kind:error.kind,message:error.message});}
  }
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
writeFileSync(new URL('./stream-protocol-probe-016-corrected.json',import.meta.url),JSON.stringify({scope:'Synthetic mock only; no real model or user image',results},null,2));
console.log(JSON.stringify(results));

