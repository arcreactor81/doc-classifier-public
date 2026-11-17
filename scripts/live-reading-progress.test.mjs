import test from 'node:test';
import assert from 'node:assert/strict';
import {readingCount} from './live-accuracy/reading.mjs';
import {readingProgress} from './live-accuracy/plan.mjs';

test('file reading uses the semantic progress value while animated text contains old and new digits',()=>{
  const snapshot={value:'42',maximum:'60',visualText:'2012129090'};
  assert.equal(readingCount(snapshot,60),42);
  let state=readingProgress({read:0,now:0,stallMs:600000});
  state=readingProgress({read:readingCount(snapshot,60),now:480000,stallMs:600000,previous:state});
  assert.equal(readingProgress({read:42,now:600001,stallMs:600000,previous:state}).stalled,false);
  assert.equal(readingProgress({read:42,now:1080000,stallMs:600000,previous:state}).stalled,true);
});

test('an absent progress bar is explicit while scanning; malformed or out-of-batch values are refused',()=>{
  assert.equal(readingCount(null,60),null);
  assert.equal(readingCount({value:'0',maximum:'60'},60),0);
  assert.equal(readingCount({value:'60',maximum:'60'},60),60);
  for(const snapshot of [{value:null,maximum:'60'},{value:'',maximum:'60'},{value:'1x',maximum:'60'},
    {value:'1.5',maximum:'60'},{value:'-1',maximum:'60'},{value:'61',maximum:'60'},
    {value:'2012129090',maximum:'60'},{value:'42',maximum:'59'},{value:'42',maximum:null}])
    assert.throws(()=>readingCount(snapshot,60),/reading progress/);
});
