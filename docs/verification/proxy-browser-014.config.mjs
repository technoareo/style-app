import {defineConfig} from '@playwright/test';
import path from 'node:path';
export default defineConfig({
 testDir:path.resolve('tests/e2e'),timeout:30000,workers:1,
 outputDir:path.resolve('test-results-proxy-014'),reporter:'list',
 use:{baseURL:'http://127.0.0.1:3001',headless:true,channel:'chrome'},
 projects:[{name:'desktop',use:{viewport:{width:1440,height:1000}}},{name:'mobile',use:{viewport:{width:390,height:844}}}],
 // An already-running verified compiled app/proxy is required. Never start dev.
});
