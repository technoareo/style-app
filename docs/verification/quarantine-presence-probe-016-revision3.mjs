// Independent synthetic failure-injection probe. Never touches the live data directory.
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
process.env.STYLE_DATA_DIR=path.join(process.cwd(),'.data','probes','quarantine-presence-016-'+randomUUID());
mkdirSync(process.env.STYLE_DATA_DIR,{recursive:true});
const database=await import('../../src/server/database.ts');
const {runWriteTransaction}=await import('../../src/server/writeTransaction.ts');
const {claimExclusiveAccess}=await import('../../src/server/processPresence.ts');
const db=database.getDatabase();database.getAuthDatabase();
db.exec('CREATE TABLE probe(v INTEGER)');
const nativeExec=db.exec.bind(db);
db.exec=(sql)=>{if(sql==='ROLLBACK')throw new Error('injected rollback failure');return nativeExec(sql);};
db.close=()=>{throw new Error('injected close failure');};
const results=[];
function check(stage){let claim;try{claim=claimExclusiveAccess(process.env.STYLE_DATA_DIR);results.push({stage,exclusiveGranted:true,stuckIsOpen:db.isOpen,stuckIsTransaction:db.isTransaction});}catch(error){results.push({stage,exclusiveGranted:false,errorName:error.name,stuckIsOpen:db.isOpen,stuckIsTransaction:db.isTransaction});}finally{claim?.release();}}
try {
  try{await runWriteTransaction(d=>{d.exec('INSERT INTO probe VALUES(1)');throw new Error('injected body failure');});}catch{}
  check('quarantined before auth close');
  database.closeAuthDatabase();
  check('after auth close');
  try { database.closeDatabases(); } catch (error) { results.push({stage: "shutdown error", errorName: error.name, message: error.message}); }
  check('after failed main close during shutdown');
}finally{delete db.exec;delete db.close;database.closeDatabases();}
writeFileSync(new URL('./quarantine-presence-probe-016-revision3.json',import.meta.url),JSON.stringify({synthetic:true,results},null,2));
console.log(JSON.stringify(results));

