// Offline analysis of anonymous matched counts. Run from any directory with Node.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clopperPearson, mcnemarExact } from './live-accuracy/stats.mjs';

const data = JSON.parse(readFileSync(new URL('../docs/data/reader-swap-inputs.json', import.meta.url)));
const rows = [], precision = [];
const sum = values => values.reduce((a, b) => a + b, 0);
const family = (name, label, n, detail, p, extra = {}) => rows.push({ family: name, label, n, detail, p, ...extra });
const flags = { 'correct filing': [0], 'wrong filing': [1], 'any filing': [0, 1], review: [2], failure: [3] };

function counts(matrix, yes) {
  let aOnly = 0, bOnly = 0, both = 0;
  matrix.forEach((row, i) => row.forEach((n, j) => {
    if (yes.includes(i) && yes.includes(j)) both += n;
    else if (yes.includes(i)) aOnly += n;
    else if (yes.includes(j)) bOnly += n;
  }));
  return { n: sum(matrix.flat()), both, aOnly, bOnly };
}

function matched(group, label, { n, both, aOnly, bOnly }) {
  assert([n, both, aOnly, bOnly].every(x => Number.isInteger(x) && x >= 0));
  assert(both + aOnly + bOnly <= n);
  if (!n) return;
  const ciA = clopperPearson(aOnly, n, 0.975), ciB = clopperPearson(bOnly, n, 0.975);
  const delta = (bOnly - aOnly) / n;
  const ci = [ciB.lower - ciA.upper, ciB.upper - ciA.lower];
  family(group, label, n, `A only ${aOnly}, B only ${bOnly}`, mcnemarExact(aOnly, bOnly).pValue,
    { a: aOnly + both, b: bOnly + both, aOnly, bOnly, delta, ci });
}

// Exact integer hypergeometric weights avoid underflow during summation or ties in Fisher's test.
function choose(n, k) {
  if (k < 0 || k > n) return 0n;
  let value = 1n;
  for (let i = 1; i <= Math.min(k, n-k); i++) value = value * BigInt(n-i+1) / BigInt(i);
  return value;
}
function ratio(a, b) {
  if (!a) return 0;
  const x = String(a), y = String(b);
  const mantissa = s => Number(s.slice(0, 15)) / 10 ** (Math.min(s.length, 15)-1);
  return mantissa(x) / mantissa(y) * 10 ** (x.length-y.length);
}
function distribution(n, wrong, held) {
  const end = Math.min(wrong, held);
  return Array.from({length:end+1}, (_, k) => choose(wrong,k)*choose(n-wrong,held-k));
}
function exactTable(group, label, n, wrong, held, hit, twoSided=false) {
  assert([n, wrong, held, hit].every(x => Number.isInteger(x) && x >= 0));
  assert(held <= n && wrong <= n && hit <= Math.min(wrong,held) && held-hit <= n-wrong);
  const detail = `${hit}/${held} vs ${wrong-hit}/${n-held}`;
  if (!wrong || wrong===n || !held || held===n) {
    family(group,label,n,detail,null); return;
  }
  const weights = distribution(n,wrong,held);
  const extreme = weights.reduce((s,v,k) => s + ((twoSided ? v<=weights[hit] : k>=hit) ? v : 0n), 0n);
  family(group,label,n,detail,ratio(extreme,choose(n,held)),{expected:held*wrong/n});
}
function stratified(label, strata) {
  let dist = [1], observed = 0, expected = 0;
  for (const {n,wrong,withheld,wrongWithheld} of strata) {
    if (!n) continue;
    const weights = distribution(n, wrong, withheld), denom=choose(n,withheld);
    const next=Array(dist.length+weights.length-1).fill(0);
    weights.forEach((v,i)=>dist.forEach((u,j)=>{next[i+j]+=u*ratio(v,denom);}));
    dist=next; observed+=wrongWithheld; expected+=withheld*wrong/n;
  }
  assert(Math.abs(sum(dist)-1)<1e-8);
  family('Subject-adjusted withholding',label,sum(strata.map(s=>s.n)),
    `caught ${observed}, expected ${expected.toFixed(2)}`,sum(dist.slice(observed)),{expected});
}
// Exact cluster sign-flip randomization, conditional on the observed batch magnitudes.
function cluster(label, batches, yes) {
  const diff=batches.map(({matrix})=>{const c=counts(matrix,yes);return c.bOnly-c.aOnly;});
  const observed=Math.abs(sum(diff));
  let dist=new Map([[0,1]]);
  for (const x of diff.filter(Boolean)) {
    const next=new Map();
    for (const [v,w] of dist) for (const key of [v-x,v+x]) next.set(key,(next.get(key)??0)+w);
    dist=next;
  }
  family('Original-batch sensitivity',label,diff.length,`net B minus A ${sum(diff)}, nonzero groups ${diff.filter(Boolean).length}`,
    sum([...dist].filter(([v])=>Math.abs(v)>=observed).map(([,w])=>w))/sum([...dist.values()]));
}

for (const c of data.pairs) {
  assert.equal(sum(c.matrix.flat()),c.n);
  const group='Paired outcomes · '+c.scope;
  for (const [endpoint,indices] of Object.entries(flags)) matched(group,c.label+' / '+endpoint,counts(c.matrix,indices));
  matched(group,c.label+' / reader exact on common answers',c.reader);
  const aWrong=sum(c.matrix[1]), aFiled=aWrong+sum(c.matrix[0]);
  const bWrong=sum(c.matrix.map(r=>r[1])), bFiled=bWrong+sum(c.matrix.map(r=>r[0]));
  if (aFiled && bFiled) {
    const aCI=clopperPearson(aWrong,aFiled), bCI=clopperPearson(bWrong,bFiled);
    const aSim=clopperPearson(aWrong,aFiled,.975), bSim=clopperPearson(bWrong,bFiled,.975);
    precision.push({label:c.label,scope:c.scope,n:c.n,aWrong,aFiled,bWrong,bFiled,aCI,bCI,
      difference:bWrong/bFiled-aWrong/aFiled,ci:[bSim.lower-aSim.upper,bSim.upper-aSim.lower]});
  }
}
for (const c of data.otherPaired) matched(c.group,c.label,c);
for (const g of data.tables) exactTable(g.group,g.label,g.n,g.wrong,g.withheld,g.hit,g.twoSided);
for (const [label,strata] of Object.entries(data.vetoStrata)) stratified(label,strata);
for (const [label,batches] of Object.entries(data.batches)) {
  for (const [end,yes] of Object.entries(flags)) cluster(label+' / '+end,batches,yes);
}
for (const op of data.operations??[]) family('Operational batch comparisons',op.label,op.n,
  `increased ${op.positive}, decreased ${op.negative}, ties ${op.ties}; median change ${op.medianDelta} ${op.unit}`,
  mcnemarExact(op.positive,op.negative).pValue);

// Within each document, permute the arm labels of its event indicators. With row totals
// fixed, sum of squared column totals is monotone in Cochran's Q. Constant rows cancel.
function omnibus(scope,names,patterns,predicate,label) {
  const k=names.length, cols=Array(k).fill(0), blocks=[];
  let total=0;
  for (const [pattern,count] of Object.entries(patterns)) {
    const events=[...pattern].map(v=>predicate(Number(v))), m=events.filter(Boolean).length;
    total+=count;
    if (!m || m===k) continue;
    for(let i=0;i<k;i++) if(events[i]) cols[i]+=count;
    const options=[];
    for(let mask=0;mask<2**k;mask++) {
      const indices=Array.from({length:k},(_,i)=>i).filter(i=>(mask>>i)&1);
      if(indices.length===m) options.push(indices);
    }
    blocks.push({count,options,m});
  }
  const ss=x=>sum(x.map(v=>v*v)), observed=ss(cols);
  const denom=sum(blocks.map(b=>b.count*b.m*(k-b.m)));
  if(!denom){family('Multi-reader omnibus',scope+' / '+label,total,'all event indicators agree',null);return;}
  const q=(k-1)*(k*observed-sum(cols)**2)/denom;
  let seed=20261118;
  function uniform() {
    seed=(Math.imul(1664525,seed)+1013904223)>>>0;
    return seed/4294967296;
  }
  const reps=19999;
  let extreme=0;
  for(let rep=0;rep<reps;rep++) {
    const simulated=Array(k).fill(0);
    for(const {count,options} of blocks) for(let doc=0;doc<count;doc++) {
      for(const i of options[Math.floor(uniform()*options.length)]) simulated[i]++;
    }
    if(ss(simulated)>=observed) extreme++;
  }
  family('Multi-reader omnibus',scope+' / '+label,total,`Q=${q.toFixed(3)}, ${k} arms`,(1+extreme)/(1+reps),{q,reps});
}
for(const g of data.omnibus) {
  for(const [end,yes] of Object.entries(flags)) omnibus(g.scope,g.names,g.outcomePatterns,x=>yes.includes(x),end);
  omnibus(g.scope,g.names,g.readerPatterns,x=>x===1,'reader exact on common answers');
}
function holm(selected,key) {
  const active=selected.filter(r=>r.p!==null).sort((a,b)=>a.p-b.p);
  let last=0;
  active.forEach((r,i)=>{last=Math.max(last,Math.min(1,(active.length-i)*r.p));r[key]=last;});
}
for (const name of new Set(rows.map(r=>r.family))) holm(rows.filter(r=>r.family===name),'holmFamily');
holm(rows,'holmAll');
for(const r of rows) assert(r.p===null || (r.p>=0 && r.p<=1+1e-12));
if (process.argv.includes('--json')) console.log(JSON.stringify({precision,tests:rows},null,2));
else {
  const fmt=p=>p==null?'—':p<.001?p.toExponential(2):p.toFixed(4);
  const pp=x=>(100*x).toFixed(2);
  console.log('# Statistical tables for the reader and confidence-model studies\n');
  console.log('Read the [study interpretation and methods](reader-swap-evidence.md) for populations, tests and limits. A and B follow the order printed. Differences are B minus A, in percentage points. A dash denotes an uninformative or unavailable test.\n');
  console.log('## Errors among automatic filings\n\n| Cohort · A / B | Wrong / filed A | Wrong / filed B | Difference, pp | Conservative 95% interval, pp |\n| --- | ---: | ---: | ---: | ---: |');
  for(const r of precision) console.log(`| ${r.scope} · ${r.label} | ${r.aWrong}/${r.aFiled} | ${r.bWrong}/${r.bFiled} | ${pp(r.difference)} | ${r.ci.map(pp).join(' to ')} |`);
  for(const group of new Set(rows.map(r=>r.family))) {
    console.log(`\n## ${group}\n\n| Comparison | N | Counts or statistic | Difference, pp (95% interval) | Raw p | Family Holm | All tests Holm |\n| --- | ---: | --- | --- | ---: | ---: | ---: |`);
    for(const r of rows.filter(r=>r.family===group)) console.log(`| ${r.label} | ${r.n} | ${r.detail} | ${r.ci ? pp(r.delta)+' ('+r.ci.map(pp).join(' to ')+')':'—'} | ${fmt(r.p)} | ${fmt(r.holmFamily)} | ${fmt(r.holmAll)} |`);
  }
}
