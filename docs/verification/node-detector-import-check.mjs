import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
console.log(JSON.stringify({stage:'before-import',node:process.version,arch:process.arch}));
try {const api=await import(pathToFileURL(path.resolve('.runtime/vision-js/node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href);console.log(JSON.stringify({stage:'imported',hasDetector:!!api.AutoModelForZeroShotObjectDetection}));}
catch(error){console.error(error.name,String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g,'[URL]').slice(0,250));process.exitCode=1;}
