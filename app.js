/**
 * LoveMachine app.js v10
 * 計算:
 *   fee = 元金×利率%（毎月固定）
 *   月回収額raw = 元金/月数 + fee
 *   月回収額final = ceilTo(raw, 切上単位)
 *   残債 = mrFinal×月数 - 累計回収（最低0）
 *   不足: 元金+不足 → fee=新元金×利率
 *   超過: 元金-超過 → fee変えない
 */
'use strict';

const SK='projects', PK='plans';
let projects=[], plans=[];
let deletingId=null, detailId=null, shortageCtx=null, listFilter='all';

const DEFAULT_PLANS=[
  {id:1,name:'Easy',  rate:10,  color:'#3fb950'},
  {id:2,name:'Normal',rate:12.5,color:'#388bfd'},
  {id:3,name:'Hard',  rate:15,  color:'#d29922'},
];

/* ── Storage ── */
function load(){
  try{const r=localStorage.getItem(PK);plans=r?JSON.parse(r):[...DEFAULT_PLANS];if(!Array.isArray(plans)||!plans.length)plans=[...DEFAULT_PLANS];}catch{plans=[...DEFAULT_PLANS];}
  try{const r=localStorage.getItem(SK);if(!r){projects=[];return;}const p=JSON.parse(r);if(!Array.isArray(p))throw 0;projects=p.map(mg);}catch{projects=[];}
}
function save(){try{localStorage.setItem(SK,JSON.stringify(projects));}catch{toast('保存失敗','err');}}
function saveP(){try{localStorage.setItem(PK,JSON.stringify(plans));}catch{}}

function mg(p){
  if(!p.segments)            p.segments     =[{startElapsed:0,rate:p.rate||0}];
  if(!p.name)                p.name         =p.memo||'';
  if(!p.memo)                p.memo         ='';
  if(p.actualCost==null)     p.actualCost   =p.principal;
  if(!p.startDate)           p.startDate    =today();
  if(!p.deposits)            p.deposits     =[{date:p.startDate,amount:p.principal,virtualAmount:0,actualAmount:p.actualCost,note:'初回入金（移行）'}];
  if(!p.repayments)          p.repayments   =[];
  if(!p.shortageMode)        p.shortageMode ='months';
  if(p.shortageAccum==null)  p.shortageAccum=0;
  if(p.planId===undefined)   p.planId       =null;
  if(!p.roundUnit)           p.roundUnit    =10000;
  if(p.virtualCost==null)    p.virtualCost  =0;
  if(p.fee==null)            p.fee          =p.principal*(p.rate||0)/100;
  if(p.extraProfit==null)    p.extraProfit  =0;
  if(p.settled==null)        p.settled      =false;
  if(p.remPrincipal===undefined) p.remPrincipal=null; // null=自動計算
  if(p.remMonths===undefined)    p.remMonths   =null; // null=自動計算
  if(p.elapsedAtReset===undefined) p.elapsedAtReset=0;
  // segmentsにfeeがなければ追加（既存データ移行）
  if(p.segments&&p.segments.length&&p.segments[0].fee==null){
    p.segments[0].fee=p.principal*(p.segments[0].rate/100);
  }
  if(p.paidBeforeReset===undefined) p.paidBeforeReset=0;
  return p;
}

/* ── Utils ── */
function nextId(){return projects.length?Math.max(...projects.map(p=>p.id))+1:1}
function nextPid(){return plans.length?Math.max(...plans.map(p=>p.id))+1:1}
function pn(v){if(v==null)return null;const n=parseFloat(String(v).replace(/,/g,''));return isNaN(n)?null:n;}
function cv(id){return pn(document.getElementById(id)?.value)}
function fmt(n){return'¥'+Math.round(n).toLocaleString('ja-JP')}
function fmtRate(r){return(r>=1?r/100:r).toFixed(3)}
function today(){const d=new Date();return`${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`}
function z(n){return String(n).padStart(2,'0')}
function ceil(v,u){if(!u||u<=1)return Math.ceil(v);return Math.ceil(v/u)*u}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function ea(s){return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function dlFile(c,n,m){const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([c],{type:m})),download:n});document.body.appendChild(a);a.click();document.body.removeChild(a);}

function ci(el){
  if(!el)return;
  function ap(){const r=el.value.replace(/[^0-9]/g,'');if(!r){el.value='';return;}const n=parseInt(r,10);el.value=isNaN(n)?'':n.toLocaleString('ja-JP');}
  el.addEventListener('input',ap);el.addEventListener('compositionend',ap);el.addEventListener('blur',ap);
  el.addEventListener('focus',()=>setTimeout(()=>el.select(),0));
}
function initCI(){document.querySelectorAll('.ci').forEach(ci);}

/* ── 計算 ── */
function getFee(p){return p.fee!=null?p.fee:p.principal*(p.rate||0)/100}
// 残り元金を返す（remPrincipalが設定されていればそれを使う）
function getRemPrincipal(p){
  if(p.remPrincipal!=null){
    // 変更後に払った回数分の月元本を引く
    const paidAfterCount=p.elapsed-(p.elapsedAtReset||0);
    const initRemMonths=p.remMonths||1;
    const monthlyP=p.remPrincipal/initRemMonths;
    return Math.max(0,p.remPrincipal-monthlyP*paidAfterCount);
  }
  const mp=p.months?p.principal/p.months:0;
  return Math.max(0,p.principal-mp*p.elapsed);
}
// 残り月数を返す（remMonthsが設定されていればそれを使う）
function getRemMonths(p){
  if(p.remMonths!=null){
    const paidAfterCount=p.elapsed-(p.elapsedAtReset||0);
    return Math.max(0,p.remMonths-paidAfterCount);
  }
  return Math.max(0,p.months-p.elapsed);
}
function mrRaw(p){const rm=getRemMonths(p);return rm?getRemPrincipal(p)/rm+getFee(p):0}
function mrFinal(p){
  // 残り元金が0の場合は切り上げしない（手数料のみ）
  const remP=getRemPrincipal(p);
  if(remP<=0) return mrRaw(p); // 切り上げなし
  return ceil(mrRaw(p),p.roundUnit||10000);
}
function totalPay(p){
  // remMonthsが設定されている（返済条件変更後）: 残り分だけの総支払（残債計算用）
  if(p.remMonths!=null) return mrFinal(p)*p.remMonths;
  return mrFinal(p)*p.months;
}
// 表示用の総支払見込み（全体: 既回収 + 残り分）
function totalPayDisplay(p){
  // 完済済みの場合は実際の回収合計を返す
  if(p.settled) return recovered(p);
  const paidBefore = p.paidBeforeReset||0;
  return paidBefore + totalPay(p);
}
function recovered(p){return p.repayments&&p.repayments.length?p.repayments.reduce((s,r)=>s+(r.amount||0),0):p.recovered||0}
function debt(p){
  if(p.settled)return 0;
  if(p.remMonths!=null){
    // 変更後に払った金額
    const paidAfter=recovered(p)-(p.paidBeforeReset||0);
    // 初期remMonths×mrFinalが総支払（固定）
    return Math.max(0,mrFinal(p)*p.remMonths-paidAfter);
  }
  return Math.max(0,totalPay(p)-recovered(p));
}
// 返済条件変更前に回収済みの金額
function getAlreadyPaid(p){
  return p.paidBeforeReset||0;
}
// 現時点での完済額 = 残り元金 + fee1回分
function fullSettlement(p){
  // 残り元金が0の場合は切り上げなし（手数料のみ）
  const remP=getRemPrincipal(p);
  if(remP<=0) return getFee(p);
  // 残り元金がある場合は月回収額（切り上げ後）と同じ基準で切り上げ
  return ceil(remP+getFee(p), p.roundUnit||10000);
}
function capProfit(p){return Math.max(0,p.principal-(p.actualCost||p.principal))}

function profit(p){
  if(!p.elapsed)return p.extraProfit||0;
  // 累計手数料利益 = 各セグメントのfee × 回収回数
  // seg.feeがあればそれを使う（不足時に記録）
  // なければ p.fee（現在のfee）を使う
  let t=0;
  for(let i=0;i<p.segments.length;i++){
    const seg=p.segments[i];
    const nxt=i+1<p.segments.length?p.segments[i+1].startElapsed:p.elapsed;
    const sm=Math.max(0,nxt-seg.startElapsed);if(!sm)continue;
    // そのセグメントのfee: seg.feeがあればそれ、なければ元金×利率
    const segFee=seg.fee!=null?seg.fee:p.principal*(seg.rate/100);
    t+=segFee*sm;
  }
  return t+(p.extraProfit||0);
}

/* ── プラン ── */
function getPlan(id){return plans.find(p=>p.id===id)||null}
function getRate(id){const p=getPlan(id);return p?p.rate:0}
function badge(planId){
  const pl=getPlan(planId);
  if(!pl)return'<span style="color:var(--m);font-size:.72rem">—</span>';
  return`<span class="pbadge" style="color:${pl.color};border-color:${pl.color};background:${pl.color}18">${esc(pl.name)}</span>`;
}
function fillPlanSelects(sel=null){
  ['add-plan','detail-plan-select'].forEach(id=>{
    const el=document.getElementById(id);if(!el)return;
    const cur=sel!==null?sel:(pn(el.value)||null);
    el.innerHTML='<option value="">— プランなし —</option>';
    plans.forEach(pl=>{const o=document.createElement('option');o.value=pl.id;o.textContent=pl.name;if(cur===pl.id)o.selected=true;el.appendChild(o);});
  });
}

/* ── 管理者 ── */
function openAdmin(){renderPlans();document.getElementById('modal-admin').classList.remove('hidden');}
function closeAdmin(){document.getElementById('modal-admin').classList.add('hidden');}
function renderPlans(){
  const c=document.getElementById('plan-list');c.innerHTML='';
  if(!plans.length){c.innerHTML='<p style="color:var(--m);font-size:.85rem">プランがありません</p>';return;}
  plans.forEach((pl,i)=>{
    const row=document.createElement('div');row.className='plan-row';
    row.innerHTML=`<input class="pi" type="text" value="${ea(pl.name)}" data-i="${i}"/><input class="pr" type="number" value="${fmtRate(pl.rate)}" min="0" max="1" step="0.001" data-i="${i}"/><input type="color" class="cp" value="${pl.color}" data-i="${i}"/><button class="ibtn ibtn-del" data-i="${i}">🗑</button>`;
    c.appendChild(row);
  });
  c.querySelectorAll('.pi').forEach(el=>{
    el.addEventListener('blur',()=>{plans[+el.dataset.i].name=el.value.trim()||plans[+el.dataset.i].name;saveP();fillPlanSelects();renderAll();});
    el.addEventListener('keydown',e=>{if(e.key==='Enter')el.blur();});
  });
  c.querySelectorAll('.pr').forEach(el=>{
    el.addEventListener('blur',()=>{
      const i=+el.dataset.i;const rv=pn(el.value);if(rv===null||rv<0){el.value=fmtRate(plans[i].rate);return;}
      const rp=rv<=1?rv*100:rv;plans[i].rate=rp;
      projects.forEach(p=>{if(p.planId===plans[i].id){p.rate=rp;p.fee=p.principal*(rp/100);const l=p.segments[p.segments.length-1];if(l.startElapsed===p.elapsed){l.rate=rp;l.fee=p.fee;}else p.segments.push({startElapsed:p.elapsed,rate:rp,fee:p.fee});}});
      el.value=fmtRate(rp);saveP();save();renderAll();
    });
    el.addEventListener('keydown',e=>{if(e.key==='Enter')el.blur();});
  });
  c.querySelectorAll('.cp').forEach(el=>{el.addEventListener('input',()=>{plans[+el.dataset.i].color=el.value;saveP();renderAll();});});
  c.querySelectorAll('.ibtn-del').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const i=+btn.dataset.i;const pid=plans[i].id;
      if(!confirm(`プラン「${plans[i].name}」を削除しますか？`))return;
      plans.splice(i,1);projects.forEach(p=>{if(p.planId===pid)p.planId=null;});
      saveP();save();renderPlans();fillPlanSelects();renderAll();toast('プランを削除しました');
    });
  });
}

/* ── プレビュー ── */
function updatePreview(){
  const principal=cv('add-principal');const roundUnit=pn(document.getElementById('add-round').value)||10000;
  const recovType=document.getElementById('add-recovery-type').value;
  const planId=pn(document.getElementById('add-plan').value);
  const rate=planId?getRate(planId):0;
  const prev=document.getElementById('monthly-preview');
  if(!principal||principal<=0){prev.classList.add('hidden');return;}
  const virt=cv('add-actual')||0;
  const totalP=principal+virt;
  const fee=totalP*(rate/100);
  let months,rawM;
  if(recovType==='months'){
    months=pn(document.getElementById('add-months').value);
    if(!months||months<=0){prev.classList.add('hidden');return;}
    rawM=totalP/months+fee;
  } else {
    const mon=cv('add-monthly');
    if(!mon||mon<=0){prev.classList.add('hidden');return;}
    const mpp=mon-fee;if(mpp<=0){prev.classList.add('hidden');return;}
    months=Math.ceil(totalP/mpp);rawM=totalP/months+fee;
  }
  const finalM=ceil(rawM,roundUnit);
  document.getElementById('monthly-preview-val').textContent=fmt(finalM);
  document.getElementById('monthly-preview-detail').innerHTML=
    `月元本 ${fmt(totalP/months)} ＋ 月手数料 ${fmt(fee)} ＝ 切上前 ${fmt(rawM)} → 切上後 ${fmt(finalM)}　／　${months}回払い　総支払 ${fmt(finalM*months)}`;
  prev.classList.remove('hidden');
}

/* ── 新規追加 ── */
function addProject(){
  const name=document.getElementById('add-name').value.trim();
  const principal=cv('add-principal');
  if(!principal||principal<=0){toast('元金を入力してください','err');return;}
  const virt=cv('add-actual')||0;
  const totalP=principal+virt;
  const planId=pn(document.getElementById('add-plan').value)||null;
  const rate=planId?getRate(planId):0;
  const roundUnit=pn(document.getElementById('add-round').value)||10000;
  const recovType=document.getElementById('add-recovery-type').value;
  const fee=totalP*(rate/100);
  let months;
  if(recovType==='months'){
    months=pn(document.getElementById('add-months').value);
    if(!months||months<1){toast('回収月数を入力してください','err');return;}
  } else {
    const mon=cv('add-monthly');
    if(!mon||mon<=0){toast('月回収額を入力してください','err');return;}
    const mpp=mon-fee;
    if(mpp<=0){toast('月回収額が手数料より少ないです','err');return;}
    months=Math.ceil(totalP/mpp);
  }
  const p={
    id:nextId(),name,memo:'',
    principal:totalP,virtualCost:virt,actualCost:principal,
    fee,rate,months,elapsed:0,recovered:0,extraProfit:0,
    startDate:today(),planId,roundUnit,
    segments:[{startElapsed:0,rate,fee}],
    deposits:[{date:today(),amount:totalP,virtualAmount:virt,actualAmount:principal,note:'初回入金'}],
    repayments:[],shortageMode:'months',shortageAccum:0
  };
  projects.push(p);save();renderAll();
  ['add-name','add-principal','add-actual','add-months','add-monthly'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('monthly-preview').classList.add('hidden');
  document.getElementById('add-recovery-type').value='months';
  document.getElementById('wrap-months').classList.remove('hidden');
  document.getElementById('wrap-monthly').classList.add('hidden');
  document.getElementById('body-add').classList.add('hidden');
  toast(`案件 #${p.id}「${name||'無題'}」を追加しました`,'ok');
}

/* ── 追加投資 ── */
function addFunds(){
  const id=pn(document.getElementById('funds-id').value);
  const amount=cv('funds-amount')||0;
  const virt=cv('funds-actual')||0;
  const date=document.getElementById('funds-date').value||today();
  const mode=document.querySelector('input[name="funds-mode"]:checked').value;
  if(!id||id<=0){toast('案件IDを入力してください','err');return;}
  if(amount<=0&&virt<=0){toast('追加元金または上乗せ分を入力してください','err');return;}
  const p=projects.find(x=>x.id===id);
  if(!p){toast(`ID ${id} の案件が見つかりません`,'err');return;}
  const fixedFinal=mrFinal(p);
  if(!p.deposits)p.deposits=[];
  p.deposits.push({date,amount,virtualAmount:virt,actualAmount:amount,note:'追加投資'});
  recalcDeposits(p);

  // 追加投資後は残り分で再計算
  // 残り元金 = 新元金 - 切り上げ前月元本×elapsed
  const origMonthlyPre = (p.principal-(amount+virt)) / p.months; // 追加前の月元本
  const remPAfterFunds = Math.max(0, p.principal - origMonthlyPre*p.elapsed);

  if(mode==='extend'){
    // 月額維持・回数を増やす
    const newMPP=fixedFinal-p.fee;
    if(newMPP>0)p.months=p.elapsed+Math.max(1,Math.ceil(remPAfterFunds/newMPP));
    // 残り分をremPrincipal/remMonthsにセット（通常計算ではなく残り分で計算）
    p.remPrincipal=remPAfterFunds;
    p.remMonths=p.months-p.elapsed;
    p.paidBeforeReset=recovered(p);
    p.elapsedAtReset=p.elapsed;
  } else {
    // 回数維持・月額を増やす
    p.remPrincipal=remPAfterFunds;
    p.remMonths=p.months-p.elapsed;
    p.paidBeforeReset=recovered(p);
    p.elapsedAtReset=p.elapsed;
  }
  save();renderAll();
  if(detailId===id)renderDetailSummary(p);
  ['funds-id','funds-amount','funds-actual'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('funds-date').value=today();
  document.getElementById('body-funds').classList.add('hidden');
  toast(`案件 #${id} に追加投資を反映しました`,'ok');
}

function recalcDeposits(p){
  if(!p.deposits||!p.deposits.length)return;
  const newP=p.deposits.reduce((s,d,i)=>s+(d.amount||0)+(i===0?0:(d.virtualAmount||0)),0);
  const newA=p.deposits.reduce((s,d)=>s+(d.actualAmount||0),0);
  const newV=p.deposits.reduce((s,d)=>s+(d.virtualAmount||0),0);
  p.principal=newP;p.actualCost=newA;p.virtualCost=newV;
  p.fee=newP*(p.rate/100);
}

/* ── 回収記録 ── */
function recordPayment(){
  const p=projects.find(x=>x.id===detailId);if(!p)return;
  const date=document.getElementById('record-date').value||today();
  const amount=pn(document.getElementById('record-amount').value?.replace(/,/g,''));
  if(!amount||amount<=0){toast('回収金額を入力してください','err');return;}
  const expected=mrFinal(p);
  const settle=fullSettlement(p);
  const diff=amount-expected;

  if(amount>=settle){
    // 完済額以上 → 即完済
    commitRecord(p,date,amount);
  } else if(diff<-1&&debt(p)>0){
    // 月回収額より不足 → 調整モーダル
    shortageCtx={id:detailId,date,amount,expected,shortage:expected-amount,type:'shortage'};
    openAdjust(p);
  } else if(diff>1){
    // 月回収額より超過だが完済額未満 → 調整モーダル
    shortageCtx={id:detailId,date,amount,expected,surplus:amount-expected,type:'surplus'};
    openAdjust(p);
  } else {
    commitRecord(p,date,amount);
  }
  document.getElementById('record-amount').value='';
}

function commitRecord(p,date,amount){
  const settle=fullSettlement(p);
  if(!p.repayments)p.repayments=[];
  p.repayments.push({date,amount});
  p.elapsed++;p.recovered=recovered(p);

  if(amount>=settle){
    p.settled=true;
    p.extraProfit=(p.extraProfit||0)+Math.max(0,amount-settle);
  }
  // remMonths/remPrincipalはそのまま（debt計算はpaidAfterで追跡）

  save();renderAll();
  if(detailId===p.id){renderDetailSummary(p);renderRepaymentTable(p);}
  updateRecordHint(p);
  toast(`案件 #${p.id} 回収記録（${fmt(amount)}）`,'ok');
}

/* ── 調整モーダル ── */
function openAdjust(p){
  const ctx=shortageCtx;
  const isSh=ctx.type==='shortage';
  const diff=isSh?ctx.shortage:ctx.surplus;
  const diffColor=isSh?'var(--r)':'var(--g)';
  document.getElementById('adjust-modal-title').textContent=isSh?'⚠ 不足 — 返済条件の変更':'✚ 超過 — 返済条件の変更';
  const infoEl=document.getElementById('shortage-info');
  infoEl.innerHTML=`<span style="color:${diffColor}">${isSh?'不足':'超過'}: <strong>${fmt(diff)}</strong></span>　想定: <strong>${fmt(ctx.expected)}</strong> → 実際: <strong>${fmt(ctx.amount)}</strong>`;
  infoEl.style.cssText=`background:${isSh?'var(--rb)':'var(--gb)'};border:1px solid ${diffColor};border-radius:6px;padding:10px 12px;font-size:.82rem;line-height:1.6;margin-bottom:8px`;

  const newP   = isSh ? p.principal+ctx.shortage : Math.max(0,p.principal-ctx.surplus);
  const newFee = isSh ? newP*(p.rate/100) : p.fee;

  // 残り元金の計算（切り上げ前の月元本を使う）
  // 切り上げ前月元本 = 元金 ÷ 総月数
  const origMonthlyP = p.principal / p.months; // 切り上げ前の月元本
  // 確定済みelapsed回分は切り上げ前月元本で引く
  // 今回払った分の元金部分 = 今回払った額 - 手数料（切り上げ前）
  const paidPrincipalNow = Math.max(0, ctx.amount - origMonthlyP - newFee + origMonthlyP);
  // シンプルに: 今回払った元金部分 = 払った額 - 手数料
  // 今回払った元金部分 = 払った額 - 手数料（切り上げ前月元本を上限）
  const thisPaidPrincipal = Math.min(
    Math.max(0, ctx.amount - p.fee), // 払った額 - 手数料
    origMonthlyP // 切り上げ前月元本が上限
  );
  // 残り元金 = 新元金 - 切上前月元本×elapsed回 - 今回の元金部分
  const remP   = Math.max(0, newP - origMonthlyP*p.elapsed - thisPaidPrincipal);
  const rem    = Math.max(1, p.months-p.elapsed-1);
  const remFee = newFee * rem;
  // 残債: 残り元金がある場合は切り上げ後、ない場合は手数料のみ（切り上げなし）
  let remDebt;
  if(rem<=0){
    remDebt=0;
  } else if(remP<=0){
    // 残り元金なし → 手数料のみ（切り上げしない）
    remDebt=newFee*rem;
  } else {
    const remMrFinal=ceil(remP/rem+newFee,p.roundUnit||10000);
    remDebt=remMrFinal*rem;
  }
  document.getElementById('shortage-remain-info').innerHTML=
    `残り元金: <strong>${fmt(remP)}</strong>　残り手数料: <strong>${fmt(remFee)}</strong>　残債合計: <strong>${fmt(remDebt)}</strong>`;
  document.getElementById('shortage-new-months').value=rem;
  document.getElementById('shortage-new-monthly').value='';
  const r=document.querySelector('input[name="shortage-action"][value="months"]');
  if(r)r.checked=true;
  document.getElementById('shortage-months-wrap').classList.remove('hidden');
  document.getElementById('shortage-monthly-wrap').classList.add('hidden');
  document.getElementById('shortage-preview').classList.add('hidden');
  document.getElementById('modal-shortage').classList.remove('hidden');
}

function applyShortage(){
  if(!shortageCtx)return;
  const ctx=shortageCtx;
  const p=projects.find(x=>x.id===ctx.id);if(!p)return;
  const action=document.querySelector('input[name="shortage-action"]:checked').value;
  const isSh=ctx.type==='shortage';

  // 回収記録
  const settle=fullSettlement(p);
  if(!p.repayments)p.repayments=[];
  p.repayments.push({date:ctx.date,amount:ctx.amount});
  p.elapsed++;p.recovered=recovered(p);
  if(ctx.amount>=settle){
    p.settled=true;
    p.extraProfit=(p.extraProfit||0)+Math.max(0,ctx.amount-settle);
  }

  // 元金・fee調整
  if(isSh){
    p.principal+=ctx.shortage;
    p.shortageAccum=(p.shortageAccum||0)+ctx.shortage;
    p.fee=p.principal*(p.rate/100);
    // feeが変わったのでsegmentsに新セグメントを追加（累計手数料利益の計算用）
    const lastSeg2=p.segments[p.segments.length-1];
    if(lastSeg2.fee==null) lastSeg2.fee=p.fee/(1+ctx.shortage/p.principal*0)||p.fee; // 不足前のfeeを保存
    // 不足前のfeeを正しく計算
    const prevPrincipal=p.principal-ctx.shortage;
    lastSeg2.fee=prevPrincipal*(p.rate/100);
    if(lastSeg2.startElapsed!==p.elapsed) p.segments.push({startElapsed:p.elapsed,rate:p.rate,fee:p.fee});
  } else {
    // 超過: 元金を超えないよう差し引く。超えた分はextraProfitへ
    const deduct=Math.min(ctx.surplus,p.principal);
    p.extraProfit=(p.extraProfit||0)+(ctx.surplus-deduct);
    p.principal=Math.max(0,p.principal-deduct);
    // feeは変えない
  }

  // ── 返済条件の再計算 ──
  // fee       = 変更後元金 × 利率%（不足・超過で既に更新済み）
  // 月回収額  = 元金/月数 + fee（月数を変えると自動で変わる）
  // 残り元金  = 元金 - (元金/月数) × elapsed
  // 月元本部分 = 月回収額(or指定額) - fee
  // 残り月数  = ceil(残り元金 ÷ 月元本部分)
  // 総月数    = elapsed + 残り月数

  // 残り元金（ポップアップと同じ計算）
  // 切り上げ前月元本（不足前の元金÷月数）× elapsed前の回数 + 今回の元金部分
  const origMonthlyP = (p.principal - (isSh ? ctx.shortage : -ctx.surplus)) / p.months;
  const thisPaidPrincipal2 = Math.max(0, ctx.amount - origMonthlyP*(p.months/p.months));
  // 今回払った元金部分 = 払った額 - 不足前の手数料
  const prevFee2 = isSh ? (p.principal - ctx.shortage)*(p.rate/100) : p.fee;
  // 今回払った元金部分（切り上げ前月元本を上限）
  const thisPaid2 = Math.min(
    Math.max(0, ctx.amount - prevFee2),
    origMonthlyP
  );
  // 残り元金 = 新元金 - 切上前月元本×(elapsed-1)回 - 今回の元金部分
  const remPrincipal = Math.max(0, p.principal - origMonthlyP*(p.elapsed-1) - thisPaid2);

  if(action==='months'){
    const nm=pn(document.getElementById('shortage-new-months').value);
    if(!nm||nm<1){toast('残り月数を入力してください','err');return;}
    // 残り元金・残り月数を保存して計算に使う
    p.remPrincipal   = remPrincipal;
    p.remMonths      = nm;
    p.paidBeforeReset= recovered(p);
    p.elapsedAtReset = p.elapsed;
    p.months         = p.elapsed + nm; // 表示用の総月数

  } else if(action==='monthly'){
    const mf=pn(document.getElementById('shortage-new-monthly').value?.replace(/,/g,''));
    if(!mf||mf<=0){toast('月回収額を入力してください','err');return;}
    const mpp = mf - p.fee;
    if(mpp<=0){toast('月回収額が手数料より少ないです','err');return;}
    const nm = Math.max(1, Math.ceil(remPrincipal / mpp));
    p.remPrincipal   = remPrincipal;
    p.remMonths      = nm;
    p.paidBeforeReset= recovered(p);
    p.elapsedAtReset = p.elapsed;
    p.months         = p.elapsed + nm;
  }

  if(detailId===ctx.id){renderDetailSummary(p);renderRepaymentTable(p);updateRecordHint(p);}
  save();renderAll();closeShortage();
  toast(`案件 #${ctx.id} の調整を適用しました`,'ok');
}

function closeShortage(){
  document.getElementById('modal-shortage').classList.add('hidden');
  shortageCtx=null;
}

function updateShortagePreview(){
  if(!shortageCtx)return;
  const p=projects.find(x=>x.id===shortageCtx.id);if(!p)return;
  const action=document.querySelector('input[name="shortage-action"]:checked')?.value;
  const isSh=shortageCtx.type==='shortage';
  const newP   =isSh?p.principal+shortageCtx.shortage:Math.max(0,p.principal-shortageCtx.surplus);
  const newFee =isSh?newP*(p.rate/100):p.fee;
  // 残り元金（計算用）= 新元金 - 月元本 × 回収済み回数
  const origMP = p.principal/p.months;
  const thisPaidPrincipal = Math.min(
    Math.max(0, shortageCtx.amount - p.fee),
    origMP
  );
  const remP   = Math.max(0, newP - origMP*p.elapsed - thisPaidPrincipal);
  const pv=document.getElementById('shortage-preview');
  const pt=document.getElementById('shortage-preview-text');
  if(action==='months'){
    const nm=pn(document.getElementById('shortage-new-months').value);
    if(!nm||nm<1){pv.classList.add('hidden');return;}
    // 月回収額 = 残り元金/残り月数 + fee
    const rawM=remP/nm+newFee;
    const finalM=ceil(rawM,p.roundUnit||10000);
    pt.textContent=`月回収額: ${fmt(finalM)}　×　${nm}回　総支払: ${fmt(finalM*nm)}`;
    pv.classList.remove('hidden');
  } else if(action==='monthly'){
    const mf=pn(document.getElementById('shortage-new-monthly').value?.replace(/,/g,''));
    if(!mf||mf<=0){pv.classList.add('hidden');return;}
    const mpp=mf-newFee;if(mpp<=0){pt.textContent=`⚠ 月手数料（${fmt(newFee)}）を下回っています`;pv.classList.remove('hidden');return;}
    // 残り月数 = ceil(残り元金 ÷ 月元本部分)
    const nm=Math.max(1,Math.ceil(remP/mpp));
    pt.textContent=`月回収額: ${fmt(mf)}　×　${nm}回　総支払: ${fmt(mf*nm)}`;
    pv.classList.remove('hidden');
  } else pv.classList.add('hidden');
}

/* ── 削除 ── */
function askDelete(id){
  deletingId=id;
  document.getElementById('modal-delete-text').textContent=`案件 #${id} を削除しますか？`;
  document.getElementById('modal-delete').classList.remove('hidden');
}
function doDelete(){
  if(deletingId===null)return;
  projects=projects.filter(p=>p.id!==deletingId);
  save();renderAll();closeDelete();toast(`案件 #${deletingId} を削除しました`);
}
function closeDelete(){document.getElementById('modal-delete').classList.add('hidden');deletingId=null;}

/* ── 詳細 ── */
function openDetail(id){
  const p=projects.find(x=>x.id===id);if(!p)return;
  detailId=id;
  document.getElementById('detail-title').textContent=`案件 #${id}「${p.name||'無題'}」`;
  fillPlanSelects(p.planId);
  document.getElementById('detail-plan-select').value=p.planId||'';
  document.getElementById('detail-memo').value=p.memo||'';
  document.getElementById('detail-months').value=p.months||'';
  document.getElementById('record-date').value=today();
  document.getElementById('record-amount').value='';
  switchTab('main');
  renderDetailSummary(p);renderDepositTable(p);renderRepaymentTable(p);
  document.getElementById('modal-detail').classList.remove('hidden');
}
function closeDetail(){document.getElementById('modal-detail').classList.add('hidden');detailId=null;}

function switchTab(name){
  document.querySelectorAll('.dtab').forEach(t=>t.classList.toggle('active',t.dataset.dtab===name));
  document.querySelectorAll('.dpane').forEach(p=>p.classList.toggle('hidden',p.id!==`dtab-${name}`));
}

function updateRecordHint(p){
  const el=document.getElementById('record-hint');if(!el)return;
  const mf=mrFinal(p);const d=debt(p);
  if(d<=0){
    el.textContent='完済済み';
    return;
  }
  const s=fullSettlement(p);
  el.innerHTML=`月回収額: <strong>${fmt(mf)}</strong>　現時点での完済額: <strong>${fmt(s)}</strong>`;
}

function renderDetailSummary(p){
  const rec=recovered(p),d=debt(p);
  const tpDisp=totalPayDisplay(p); // 表示用（全体）完済後は実回収合計
  const pr=profit(p),fee=getFee(p),cap=capProfit(p);
  const remainM=Math.max(0,p.months-p.elapsed);
  const feeTotal=Math.max(0,tpDisp-p.principal);
  const feeProfit=Math.max(0,tpDisp-p.principal);
  const profitRatePct=tpDisp>0?(feeProfit/tpDisp)*100:0;
  const profitExpected=feeProfit+Math.max(0,cap);
  const actualCostV=p.actualCost||p.principal;
  const actualRecRate=actualCostV>0?Math.min((rec/actualCostV)*100,100):0;
  // 完済後は回収率100%・棒グラフも100%
  const recRate=p.settled?100:tpDisp>0?Math.min((rec/tpDisp)*100,100):0;

  const set=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
  set('ds-remaining',   fmt(d));
  // 完済後は最後に払った金額を表示
  const lastPaid=p.repayments&&p.repayments.length?p.repayments[p.repayments.length-1].amount:0;
  set('ds-monthly-final',fmt(p.settled?lastPaid:mrFinal(p)));
  set('ds-profit-expected',fmt(profitExpected));
  set('ds-principal',   fmt(p.principal));
  set('ds-actual',      fmt(actualCostV));
  set('ds-cap-profit',  fmt(cap));
  set('ds-fee',         fmt(feeTotal));
  set('ds-monthly-fee', fmt(fee));
  set('ds-monthly',     fmt(p.settled?0:mrRaw(p))); // 完済後は0
  set('ds-total-months',`${p.months}回`);
  set('ds-remain-months',`${remainM}回`);
  set('ds-recovered',   fmt(rec));
  set('ds-profit',      fmt(pr));
  set('ds-profit-rate', profitRatePct.toFixed(1)+'%');
  set('ds-actual-recovery-rate',actualRecRate.toFixed(1)+'%');
  set('ds-rate',        p.settled?'100.0%':d<=0?'100.0%':(rec/tpDisp*100).toFixed(1)+'%');
  set('ds-total-pay',   fmt(tpDisp));

  const bar=document.getElementById('ds-rate-bar');
  if(bar){
    const pct=Math.min(recRate,100);
    bar.style.width=pct.toFixed(1)+'%';
    bar.className='bar-f'; // 完済後は常に緑
  }
  const shr=document.getElementById('ds-shortage-row');if(shr)shr.classList.toggle('hidden',!(p.shortageAccum>0));
  const dss=document.getElementById('ds-shortage');if(dss&&p.shortageAccum>0)dss.textContent=fmt(p.shortageAccum);
  updateRecordHint(p);
}

/* ── 投資履歴 ── */
function renderDepositTable(p){
  const tb=document.getElementById('deposit-tbody');if(!tb)return;
  tb.innerHTML='';
  if(!p.deposits||!p.deposits.length){tb.innerHTML='<tr><td colspan="6" style="text-align:center;padding:16px;color:var(--m)">履歴なし</td></tr>';return;}
  p.deposits.forEach((d,i)=>{
    const tag=i===0?'<span class="tag tag-i">初回</span>':'<span class="tag tag-a">追加</span>';
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${tag}</td><td><input type="date" class="hi hi-date dep-date" value="${d.date||''}" data-i="${i}"/></td><td><input type="text" class="hi hi-amt dep-amt" value="${Math.round((d.amount||0)+(i===0?0:(d.virtualAmount||0))).toLocaleString('ja-JP')}" inputmode="numeric" data-i="${i}"/></td><td><input type="text" class="hi hi-amt dep-actual" value="${Math.round(d.actualAmount||d.amount||0).toLocaleString('ja-JP')}" inputmode="numeric" data-i="${i}"/></td><td><input type="text" class="hi hi-note dep-note" value="${ea(d.note||'')}" placeholder="メモ" data-i="${i}"/></td><td>${i===0?'<span style="font-size:.68rem;color:var(--m)">削除不可</span>':`<button class="hdel dep-del" data-i="${i}">🗑</button>`}</td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.dep-amt,.dep-actual').forEach(el=>ci(el));
  tb.querySelectorAll('.dep-date,.dep-amt,.dep-actual,.dep-note').forEach(el=>{
    el.addEventListener('blur',()=>saveDepEdit(p));el.addEventListener('change',()=>saveDepEdit(p));
  });
  tb.querySelectorAll('.dep-del').forEach(btn=>{
    btn.addEventListener('click',()=>{
      if(!confirm('削除して再計算しますか？'))return;
      p.deposits.splice(+btn.dataset.i,1);recalcDeposits(p);
      save();renderDepositTable(p);renderDetailSummary(p);renderAll();toast('削除・再計算しました');
    });
  });
}
function saveDepEdit(p){
  const tb=document.getElementById('deposit-tbody');if(!tb)return;
  let changed=false;
  tb.querySelectorAll('tr').forEach((tr,i)=>{
    if(!p.deposits[i])return;
    const d=tr.querySelector(`.dep-date[data-i="${i}"]`);
    const a=tr.querySelector(`.dep-amt[data-i="${i}"]`);
    const ac=tr.querySelector(`.dep-actual[data-i="${i}"]`);
    const n=tr.querySelector(`.dep-note[data-i="${i}"]`);
    if(d&&d.value!==p.deposits[i].date){p.deposits[i].date=d.value;changed=true;}
    const nv=pn(a?.value)||0;if(a&&nv!==p.deposits[i].amount){p.deposits[i].amount=nv;p.deposits[i].actualAmount=nv;changed=true;}
    const nav=pn(ac?.value)||0;if(ac&&nav!==p.deposits[i].actualAmount){p.deposits[i].actualAmount=nav;changed=true;}
    if(n&&n.value!==p.deposits[i].note){p.deposits[i].note=n.value;changed=true;}
  });
  if(!changed)return;
  recalcDeposits(p);save();renderDetailSummary(p);renderAll();toast('投資履歴を更新しました','ok');
}

/* ── 回収履歴 ── */
function renderRepaymentTable(p){
  const tb=document.getElementById('repayment-tbody');if(!tb)return;
  tb.innerHTML='';
  if(!p.repayments||!p.repayments.length){tb.innerHTML='<tr><td colspan="6" style="text-align:center;padding:16px;color:var(--m)">履歴なし</td></tr>';return;}
  const exp=mrFinal(p);
  p.repayments.forEach((r,i)=>{
    const diff=(r.amount||0)-exp;
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${i+1}</td><td><input type="date" class="hi hi-date rep-date" value="${r.date||''}" data-i="${i}"/></td><td><input type="text" class="hi hi-amt rep-amt" value="${Math.round(r.amount||0).toLocaleString('ja-JP')}" inputmode="numeric" data-i="${i}"/></td><td>${fmt(exp)}</td><td class="${diff>=0?'sur':'def'}">${diff>=0?'+'+fmt(diff):fmt(diff)}</td><td><button class="hdel rep-del" data-i="${i}">🗑</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.rep-amt').forEach(el=>ci(el));
  tb.querySelectorAll('.rep-date,.rep-amt').forEach(el=>{
    el.addEventListener('blur',()=>saveRepEdit(p));el.addEventListener('change',()=>saveRepEdit(p));
  });
  tb.querySelectorAll('.rep-del').forEach(btn=>{
    btn.addEventListener('click',()=>{
      p.repayments.splice(+btn.dataset.i,1);p.elapsed=p.repayments.length;p.recovered=recovered(p);
      save();renderRepaymentTable(p);renderDetailSummary(p);renderAll();
    });
  });
}
function saveRepEdit(p){
  const tb=document.getElementById('repayment-tbody');if(!tb)return;
  tb.querySelectorAll('tr').forEach((tr,i)=>{
    if(!p.repayments[i])return;
    const d=tr.querySelector(`.rep-date[data-i="${i}"]`);
    const a=tr.querySelector(`.rep-amt[data-i="${i}"]`);
    if(d)p.repayments[i].date=d.value;if(a)p.repayments[i].amount=pn(a.value)||0;
  });
  p.elapsed=p.repayments.length;p.recovered=recovered(p);
  save();renderRepaymentTable(p);renderDetailSummary(p);renderAll();
}

/* ── Render ── */
function renderTable(){
  const tb=document.getElementById('table-body');tb.innerHTML='';
  const list=projects.filter(p=>listFilter==='active'?debt(p)>0:listFilter==='done'?debt(p)<=0:true);
  if(!list.length){tb.innerHTML=`<tr class="empty-row"><td colspan="7">${projects.length?'該当案件なし':'案件がありません'}</td></tr>`;return;}
  list.forEach(p=>{
    const d=debt(p),mf=mrFinal(p),rem=Math.max(0,p.months-p.elapsed),done=d<=0;
    const rc=done?'rem-ok':rem<=2?'rem-urg':'rem-warn';
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td style="color:var(--m);font-size:.75rem;font-family:var(--mono)">#${p.id}</td>
      <td style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${ea(p.name||'')}">${esc(p.name||'—')}</td>
      <td style="text-align:right"><span class="debt${done?' debt-done':''}">${done?'完済':fmt(d)}</span></td>
      <td style="text-align:right;font-family:var(--mono);font-feature-settings:'zero'1,'tnum'1">${fmt(mf)}<span style="font-size:.68rem;color:var(--m)">/月</span></td>
      <td class="cnt">${p.elapsed}/${p.months}回<br><span class="rem ${rc}">${done?'完済':'残'+rem+'回'}</span></td>
      <td><div class="row-btns">
        <button class="ibtn" title="詳細" onclick="openDetail(${p.id})">📋</button>
        <button class="ibtn ibtn-del" title="削除" onclick="askDelete(${p.id})">🗑</button>
      </div></td>`;
    tb.appendChild(tr);
  });
}

function renderSummary(){
  const s=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
  if(!projects.length){
    ['sum-principal','sum-actual','sum-remaining','sum-recovered','sum-fee-profit','sum-cap-profit'].forEach(id=>s(id,'¥0'));
    s('sum-avg-rate','—');s('sum-recovery-rate','0%');return;
  }
  const tP=projects.reduce((a,p)=>a+p.principal,0);
  const tA=projects.reduce((a,p)=>a+(p.actualCost||p.principal),0);
  const tD=projects.reduce((a,p)=>a+debt(p),0);
  const tR=projects.reduce((a,p)=>a+recovered(p),0);
  const tFP=projects.reduce((a,p)=>a+profit(p),0);
  const tCP=projects.reduce((a,p)=>a+capProfit(p),0);
  const avgRate=projects.reduce((a,p)=>a+(p.rate||0),0)/projects.length;
  const sumTP=projects.reduce((a,p)=>a+totalPayDisplay(p),0);
  const avgRec=sumTP>0?Math.min((tR/sumTP)*100,100):0;
  s('sum-principal',fmt(tP));s('sum-actual',fmt(tA));
  s('sum-remaining',fmt(tD));s('sum-recovered',fmt(tR));
  s('sum-fee-profit',fmt(tFP));s('sum-cap-profit',fmt(tCP));
  s('sum-avg-rate',fmtRate(avgRate));s('sum-recovery-rate',avgRec.toFixed(1)+'%');
}

function renderAll(){renderTable();renderSummary();}

/* ── JSON/CSV ── */
function exportJSON(){
  if(!projects.length){toast('データがありません','err');return;}
  dlFile(JSON.stringify({projects,plans},null,2),`backup_${today()}.json`,'application/json');
  toast('JSONをダウンロードしました','ok');
}
function importJSON(file){
  if(!file)return;
  const r=new FileReader();
  r.onload=e=>{
    try{
      const d=JSON.parse(e.target.result);
      let np,nl;
      if(Array.isArray(d)){np=d;nl=plans;}else{np=d.projects||[];nl=d.plans||plans;}
      if(!Array.isArray(np))throw new Error('不正なデータ');
      if(!confirm(`${np.length}件を読み込みます。現在のデータを上書きしますか？`))return;
      projects=np.map(mg);if(Array.isArray(nl)&&nl.length)plans=nl;
      save();saveP();fillPlanSelects();renderAll();toast(`${projects.length}件を復元しました`,'ok');
    }catch(err){toast('読込エラー: '+err.message,'err');}
  };
  r.onerror=()=>toast('ファイル読込失敗','err');
  r.readAsText(file);
  document.getElementById('input-import-json').value='';
}
function exportCSV(){
  if(!projects.length){toast('データがありません','err');return;}
  const h=['ID','件名','元金','実費','手数料合計','月回収額','利率(%)','回収月数','回収済','累計回収','残債'];
  const rows=projects.map(p=>[p.id,`"${(p.name||'').replace(/"/g,'""')}"`,p.principal,p.actualCost||p.principal,Math.round(Math.max(0,totalPay(p)-p.principal)),Math.round(mrFinal(p)),p.rate,p.months,p.elapsed,Math.round(recovered(p)),Math.round(debt(p))]);
  dlFile('\uFEFF'+[h.join(','),...rows.map(r=>r.join(','))].join('\r\n'),`projects_${today()}.csv`,'text/csv;charset=utf-8;');
  toast('CSVをダウンロードしました','ok');
}

/* ── Toast ── */
let _tt=null;
function toast(msg,type=''){
  document.querySelector('.toast')?.remove();clearTimeout(_tt);
  const el=Object.assign(document.createElement('div'),{className:`toast${type?' '+type:''}`,textContent:msg});
  document.body.appendChild(el);
  _tt=setTimeout(()=>{el.style.opacity='0';el.style.transition='opacity .3s';setTimeout(()=>el.remove(),300);},2600);
}

/* ── Bind ── */
function bind(){
  document.getElementById('btn-admin').addEventListener('click',openAdmin);
  document.getElementById('btn-export-json').addEventListener('click',exportJSON);
  document.getElementById('btn-export-csv').addEventListener('click',exportCSV);
  document.getElementById('input-import-json').addEventListener('change',e=>importJSON(e.target.files[0]));

  document.getElementById('admin-close').addEventListener('click',closeAdmin);
  document.getElementById('modal-admin').addEventListener('click',e=>{if(e.target===document.getElementById('modal-admin'))closeAdmin();});
  document.getElementById('btn-add-plan').addEventListener('click',()=>{
    const colors=['#3fb950','#388bfd','#d29922','#f85149','#bc8cff'];
    plans.push({id:nextPid(),name:`プラン${String.fromCharCode(65+plans.length)}`,rate:20,color:colors[plans.length%colors.length]});
    saveP();renderPlans();fillPlanSelects();
  });

  // パネルタブ（クリックで開閉）
  document.querySelectorAll('.ptab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      const bodyId=`body-${tab.dataset.ptab}`;
      const body=document.getElementById(bodyId);
      const isActive=tab.classList.contains('active');
      const isOpen=!body.classList.contains('hidden');
      document.querySelectorAll('.ptab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('.pbody').forEach(b=>b.classList.add('hidden'));
      if(!isActive||!isOpen){
        tab.classList.add('active');
        body.classList.remove('hidden');
      }
    });
  });

  document.getElementById('btn-add').addEventListener('click',addProject);
  document.getElementById('add-recovery-type').addEventListener('change',()=>{
    const t=document.getElementById('add-recovery-type').value;
    document.getElementById('wrap-months').classList.toggle('hidden',t!=='months');
    document.getElementById('wrap-monthly').classList.toggle('hidden',t!=='monthly');
    updatePreview();
  });
  ['add-principal','add-actual','add-months','add-monthly','add-round','add-plan'].forEach(id=>{
    document.getElementById(id)?.addEventListener('input',updatePreview);
    document.getElementById(id)?.addEventListener('change',updatePreview);
  });
  ['add-name','add-principal','add-actual','add-months','add-monthly'].forEach(id=>{
    document.getElementById(id)?.addEventListener('keydown',e=>{if(e.key==='Enter')addProject();});
  });

  document.getElementById('btn-funds').addEventListener('click',addFunds);
  ['funds-id','funds-amount','funds-actual'].forEach(id=>{
    document.getElementById(id)?.addEventListener('keydown',e=>{if(e.key==='Enter')addFunds();});
  });

  document.querySelectorAll('.ftab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      document.querySelectorAll('.ftab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');listFilter=tab.dataset.filter;renderTable();
    });
  });

  document.getElementById('modal-delete-confirm').addEventListener('click',doDelete);
  document.getElementById('modal-delete-cancel').addEventListener('click',closeDelete);
  document.getElementById('modal-delete').addEventListener('click',e=>{if(e.target===document.getElementById('modal-delete'))closeDelete();});

  document.getElementById('shortage-confirm').addEventListener('click',applyShortage);
  document.getElementById('shortage-cancel').addEventListener('click',()=>{closeShortage();toast('キャンセルしました');});
  document.getElementById('shortage-close').addEventListener('click',()=>{closeShortage();toast('キャンセルしました');});
  document.getElementById('modal-shortage').addEventListener('click',e=>{if(e.target===document.getElementById('modal-shortage')){closeShortage();toast('キャンセルしました');}});

  function updateWrap(){
    const v=document.querySelector('input[name="shortage-action"]:checked')?.value;
    document.getElementById('shortage-months-wrap').classList.toggle('hidden',v!=='months');
    document.getElementById('shortage-monthly-wrap').classList.toggle('hidden',v!=='monthly');
    updateShortagePreview();
  }
  document.querySelectorAll('input[name="shortage-action"]').forEach(r=>{r.addEventListener('change',updateWrap);r.addEventListener('click',updateWrap);});
  document.querySelectorAll('.rcol .ropt').forEach(lbl=>{lbl.addEventListener('click',()=>setTimeout(updateWrap,0));});
  ['shortage-new-months','shortage-new-monthly'].forEach(id=>{document.getElementById(id)?.addEventListener('input',updateShortagePreview);});
  ci(document.getElementById('shortage-new-monthly'));

  document.getElementById('detail-close').addEventListener('click',closeDetail);
  document.getElementById('detail-close-btn').addEventListener('click',closeDetail);
  document.getElementById('modal-detail').addEventListener('click',e=>{if(e.target===document.getElementById('modal-detail'))closeDetail();});
  document.querySelectorAll('.dtab').forEach(t=>t.addEventListener('click',()=>switchTab(t.dataset.dtab)));

  document.getElementById('btn-record').addEventListener('click',recordPayment);
  document.getElementById('record-amount').addEventListener('keydown',e=>{if(e.key==='Enter')recordPayment();});
  ci(document.getElementById('record-amount'));

  document.getElementById('detail-plan-select').addEventListener('change',()=>{
    const p=projects.find(x=>x.id===detailId);if(!p)return;
    const pid=pn(document.getElementById('detail-plan-select').value);
    p.planId=pid||null;
    if(pid){const nr=getRate(pid);p.rate=nr;p.fee=p.principal*(nr/100);const l=p.segments[p.segments.length-1];if(l.startElapsed===p.elapsed){l.rate=nr;l.fee=p.fee;}else p.segments.push({startElapsed:p.elapsed,rate:nr,fee:p.fee});}
    save();renderDetailSummary(p);renderAll();toast('プランを変更しました','ok');
  });
  document.getElementById('detail-memo').addEventListener('blur',()=>{
    const p=projects.find(x=>x.id===detailId);if(!p)return;
    p.memo=document.getElementById('detail-memo').value;save();
  });
  document.getElementById('btn-apply-months').addEventListener('click',()=>{
    const p=projects.find(x=>x.id===detailId);if(!p)return;
    const nm=pn(document.getElementById('detail-months').value);
    if(!nm||nm<1){toast('回数を入力してください','err');return;}
    if(nm<=p.elapsed){toast(`すでに${p.elapsed}回回収済みです`,'err');return;}
    p.months=nm;p.fee=p.principal*(p.rate/100);
    p.remMonths=nm-p.elapsed;
    p.paidBeforeReset=recovered(p);
    p.elapsedAtReset=p.elapsed;
    save();renderDetailSummary(p);renderAll();toast(`回収回数を${nm}回に変更しました`,'ok');
  });
  document.getElementById('btn-add-repayment').addEventListener('click',()=>{
    const p=projects.find(x=>x.id===detailId);if(!p)return;
    if(!p.repayments)p.repayments=[];
    p.repayments.push({date:today(),amount:Math.round(mrFinal(p))});
    p.elapsed=p.repayments.length;p.recovered=recovered(p);
    save();renderRepaymentTable(p);renderDetailSummary(p);renderAll();
  });
}

/* ── Init ── */
function init(){
  load();if(projects.length)save();
  const normal=plans.find(p=>p.name==='Normal');
  fillPlanSelects(normal?normal.id:null);
  renderAll();bind();initCI();
  document.getElementById('funds-date').value=today();
}

document.addEventListener('DOMContentLoaded',init);
