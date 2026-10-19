// S8b: goto по серии — время goto на прогон, «goal was changed» (не тактика / тактика), перестройки «путь не отсюда». cwd = farm/results: node ../route-scan/s8b-goto.js <префикс>
import * as fs from 'fs'; const p=process.argv[2]; const ds=fs.readdirSync(".").filter(d=>new RegExp("^"+p+"-[0-9]+$").test(d));
let tot=0, gc={n:0,s:0}, tac={n:0,s:0}, runs=0, rep=0;
for (const d of ds) { runs++; for (const f of fs.readdirSync(d).filter(f=>f.endsWith(".skills.jsonl"))) for (const l of fs.readFileSync(d+"/"+f,"utf8").split("\n")) { if(!l) continue; let j; try{j=JSON.parse(l)}catch{continue}; if (j.level!=="act"||j.skill!=="goto") continue; tot+=j.sec; if(/goal was changed/.test(String(j.why))) { if (j.code==="TACTICAL") {tac.n++;tac.s+=j.sec} else {gc.n++;gc.s+=j.sec} } }
 try { rep += (fs.readFileSync(d+"/daemon-8.out.log","utf8").match(/путь не отсюда/g)||[]).length } catch {} }
console.log(p, "runs", runs, "goto sec/run", Math.round(tot/runs), "GoalChanged non-tactical", gc.n, Math.round(gc.s)+"s", "tactical", tac.n, Math.round(tac.s)+"s", "replans", rep)
