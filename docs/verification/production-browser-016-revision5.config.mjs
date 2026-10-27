import {defineConfig} from '@playwright/test';
import path from 'node:path';
export default defineConfig({
  testDir:path.resolve('tests/e2e'),timeout:30000,workers:1,
  outputDir:path.resolve('test-results-production-016-revision5'),reporter:'list',
  use:{baseURL:'http://127.0.0.1:3000',headless:true,channel:'chrome'},
  projects:[{name:'desktop',use:{viewport:{width:1440,height:1000}}},{name:'mobile',use:{viewport:{width:390,height:844}}}],
  webServer:{command:'npm run start -- --hostname 127.0.0.1',url:'http://127.0.0.1:3000/api/health',reuseExistingServer:false,timeout:120000},
});

