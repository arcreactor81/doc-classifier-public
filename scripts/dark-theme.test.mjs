import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const boot=readFileSync(new URL('../ui/app/public/theme-boot.js',import.meta.url),'utf8');
for(const saved of ['light','dark',null])test('first paint stays dark with retired saved preference '+String(saved),()=>{
 const root={dataset:{}};
 let reads=0;
 const storage={getItem(){reads++;return saved;}};
 vm.runInNewContext(boot,{document:{documentElement:root},window:{localStorage:storage,matchMedia:()=>({matches:false})}});
 assert.equal(root.dataset.theme,'dark');assert.equal(reads,0,'retired preference is ignored, not rewritten or treated as a current mode');
});
test('dark boot does not depend on storage or system preference access',()=>{
 const root={dataset:{}},window={};
 Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked storage');}});
 Object.defineProperty(window,'matchMedia',{get(){throw new Error('unavailable preference');}});
 assert.doesNotThrow(()=>vm.runInNewContext(boot,{document:{documentElement:root},window}));
 assert.equal(root.dataset.theme,'dark');
});
