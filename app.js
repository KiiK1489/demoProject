/**
 * 経費回収トラッカー — app.js v8
 *
 * 【手数料計算】
 * 手数料(fee) = 元金 × 利益率%  （毎月固定で徴収）
 * 月手数料    = fee（毎月同額）
 * 月元本回収  = 元金 ÷ 月数
 * 月支払額raw = 月元本 + 月手数料 = (元金 + fee) ÷ 月数
 *            = 元金/月数 + 元金×rate/100
 * 月支払額final = ceilTo(raw, roundUnit)
 *
 * 例: 元金10万・20%・10回
 *   fee = 10万×20% = 2万（毎月2万の手数料）
 *   月支払 = 1万 + 2万 = 3万 × 10回 = 30万
 *
 * 追加5万・20%・残5回（月額維持で回数増やす場合）:
 *   追加fee = 5万×20% = 1万
 *   追加月支払 = 1万 + 1万 = 2万 × 5回
 *   現在の月支払 3万 + 追加分 2万 = 5万/月になる
 *   → 月額を5万に変更して残りを再計算
 */
'use strict';

const STORAGE_KEY       = 'projects';
const PLANS_STORAGE_KEY = 'plans';
let projects = [];
let plans    = [];
let deleteTargetId  = null;
let detailProjectId = null;
let shortageContext = null;

const DEFAULT_PLANS = [
  { id:1, name:'Easy',   rate:10,   color:'#3ecf8e' },
  { id:2, name:'Normal', rate:12.5, color:'#6b91c8' },
  { id:3, name:'Hard',   rate:15,   color:'#f5a623' },
];

/* ══════════════════════════════════════
   STORAGE
══════════════════════════════════════ */
function loadData() {
  try {
    const rp=localStorage.getItem(PLANS_STORAGE_KEY);
    plans=rp?JSON.parse(rp):[...DEFAULT_PLANS];
    if(!Array.isArray(plans)||!plans.length) plans=[...DEFAULT_PLANS];
  } catch(e){ plans=[...DEFAULT_PLANS]; }
  try {
    const raw=localStorage.getItem(STORAGE_KEY);
    if(!raw){ projects=[]; return; }
    const parsed=JSON.parse(raw);
    if(!Array.isArray(parsed)) throw new Error();
    projects=parsed.map(migrate);
  } catch(e){ console.error(e); projects=[]; }
}

function migrate(p) {
  if(!p.segments)           p.segments      = [{startElapsed:0,rate:p.rate||0}];
  if(!p.name)               p.name          = p.memo||'';
  if(!p.memo)               p.memo          = '';
  if(p.actualCost==null)    p.actualCost    = p.principal;
  if(!p.startDate)          p.startDate     = todayStr();
  if(!p.deposits)           p.deposits      = [{date:p.startDate,amount:p.principal,actualAmount:p.actualCost,note:'初回入金（移行）'}];
  if(!p.repayments)         p.repayments    = [];
  if(!p.shortageMode)       p.shortageMode  = 'extend';
  if(p.shortageAccum==null) p.shortageAccum = 0;
  if(p.planId===undefined)  p.planId        = null;
  if(!p.roundUnit)          p.roundUnit     = 10000;
  if(p.virtualCost==null)   p.virtualCost   = 0;
  // fee = 元金 × 利益率%（固定値として保存）
  if(p.fee==null) p.fee = p.principal*(p.rate||0)/100;
  return p;
}

function saveData() {
  try{ localStorage.setItem(STORAGE_KEY,JSON.stringify(projects)); }
  catch(e){ showToast('保存に失敗しました','error'); }
}
function savePlans() {
  try{ localStorage.setItem(PLANS_STORAGE_KEY,JSON.stringify(plans)); }
  catch(e){}
}

/* ══════════════════════════════════════
   UTILS
══════════════════════════════════════ */
function genId()     { return projects.length===0?1:Math.max(...projects.map(p=>p.id))+1 }
function genPlanId() { return plans.length===0?1:Math.max(...plans.map(p=>p.id))+1 }

function parseNum(v) {
  if(v==null) return null;
  const n=parseFloat(String(v).replace(/,/g,''));
  return isNaN(n)?null:n;
}
function ok(v,label,positive=true) {
  const fail=positive?(v===null||v<=0):(v===null||v<0);
  if(fail){showToast(`「${label}」に${positive?'正の':'0以上の'}数を入力してください`,'error');return false;}
  return true;
}
function fmt(n)  { return '¥'+Math.round(n).toLocaleString('ja-JP') }
function pct(n)  { return n.toFixed(1)+'%' }
/** 利率を小数で表示（20→0.200、0.125→0.125） */
function fmtRate(rate) {
  // rate が 1 以上なら %単位なので /100 して小数に
  const r = rate >= 1 ? rate/100 : rate;
  return r.toFixed(3);
}
function todayStr() {
  const d=new Date();
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`;
}
function z(n){ return String(n).padStart(2,'0') }
function dlFile(content,name,mime){
  const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([content],{type:mime})),download:name});
  document.body.appendChild(a);a.click();document.body.removeChild(a);
}
function ceilTo(v,u){ if(!u||u<=1)return Math.ceil(v); return Math.ceil(v/u)*u; }

function initCI(el) {
  function ap(){
    const raw=el.value.replace(/[^0-9]/g,'');
    if(!raw){el.value='';return;}
    const n=parseInt(raw,10);
    el.value=isNaN(n)?'':n.toLocaleString('ja-JP');
    try{const l=el.value.length;el.setSelectionRange(l,l);}catch(e){}
  }
  el.addEventListener('input',ap);
  el.addEventListener('compositionend',ap);
  el.addEventListener('blur',ap);
  el.addEventListener('focus',()=>setTimeout(()=>el.select(),0));
}
function cv(id){ return parseNum(document.getElementById(id)?.value) }

/* ══════════════════════════════════════
   計算
   手数料(fee) = 元金 × 利益率%（毎月固定）
   月支払raw   = 元金/月数 + fee
   月支払final = ceilTo(raw, roundUnit)
   総支払      = final × months
   残債        = 総支払 - 累計回収
══════════════════════════════════════ */
function getFee(p)      { return p.fee!=null ? p.fee : p.principal*(p.rate||0)/100; }
function mrRaw(p)       { return p.months ? p.principal/p.months + getFee(p) : 0; }
function mrFinal(p)     { const u=p.roundUnit>0?p.roundUnit:10000; return ceilTo(mrRaw(p),u); }
function totalPay(p)    { return mrFinal(p)*p.months; }
function calcDebt(p)    { return Math.max(0, totalPay(p)-calcRecovered(p)); }
function calcRecovered(p){
  if(p.repayments&&p.repayments.length>0)
    return p.repayments.reduce((s,r)=>s+(r.amount||0),0);
  return p.recovered||0;
}

/**
 * 累計手数料利益
 * 1回の支払いに含まれる手数料分 = mrFinal - 月元本
 * セグメントごとに fee を再計算して積算
 */
function calcProfit(p){
  if(!p.elapsed) return 0;
  const monthlyPrincipal = p.months ? p.principal/p.months : 0;
  let total=0;
  for(let i=0;i<p.segments.length;i++){
    const seg=p.segments[i];
    const next=i+1<p.segments.length?p.segments[i+1].startElapsed:p.elapsed;
    const segMonths=Math.max(0,next-seg.startElapsed);
    if(!segMonths) continue;
    const segFee   = p.principal*(seg.rate/100);
    const segRaw   = monthlyPrincipal+segFee;
    const segFinal = ceilTo(segRaw, p.roundUnit||10000);
    total += (segFinal-monthlyPrincipal)*segMonths;
  }
  return total;
}

/** 元金差益 = 元金 - 実費（actualCost） */
function capitalProfit(p){ return p.principal-(p.actualCost||p.principal); }

/* ══════════════════════════════════════
   プラン
══════════════════════════════════════ */
function getPlan(id)     { return plans.find(p=>p.id===id)||null }
function getPlanRate(id) { const pl=getPlan(id); return pl?pl.rate:0 }

function planBadgeHtml(planId){
  const plan=getPlan(planId);
  if(!plan) return '<span style="color:var(--text-muted);font-size:.78rem">—</span>';
  const bg=plan.color+'22';
  return `<span class="plan-badge" style="color:${plan.color};background:${bg};border-color:${plan.color}">${escHtml(plan.name)}</span>`;
}

function populatePlanSelects(selectedId=null){
  ['add-plan','detail-plan-select'].forEach(id=>{
    const sel=document.getElementById(id); if(!sel) return;
    const cur=selectedId!==null?selectedId:(parseNum(sel.value)||null);
    sel.innerHTML='<option value="">— プランなし —</option>';
    plans.forEach(plan=>{
      const opt=document.createElement('option');
      opt.value=plan.id; opt.textContent=plan.name;
      if(cur===plan.id) opt.selected=true;
      sel.appendChild(opt);
    });
  });
}

/* ══════════════════════════════════════
   管理者
══════════════════════════════════════ */
function openAdmin(){ renderPlanList(); document.getElementById('modal-admin').classList.remove('hidden'); }
function closeAdmin(){ document.getElementById('modal-admin').classList.add('hidden'); }

function renderPlanList(){
  const container=document.getElementById('plan-list');
  container.innerHTML='';
  if(!plans.length){ container.innerHTML='<p style="color:var(--text-muted);font-size:.85rem;padding:8px">プランがありません。</p>'; return; }
  plans.forEach((plan,i)=>{
    const row=document.createElement('div'); row.className='plan-row';
    row.innerHTML=`
      <input type="text" class="plan-name-input" value="${escAttr(plan.name)}" data-i="${i}"/>
      <input type="number" class="plan-rate-input" value="${fmtRate(plan.rate)}" min="0" max="1" step="0.001" inputmode="decimal" data-i="${i}" title="利率（例:0.125）"/>
      <input type="color" class="color-swatch" value="${plan.color}" data-i="${i}"/>
      <button class="plan-del-btn" data-i="${i}">🗑</button>`;
    container.appendChild(row);
  });
  container.querySelectorAll('.plan-name-input').forEach(el=>{
    el.addEventListener('blur',()=>{
      plans[Number(el.dataset.i)].name=el.value.trim()||plans[Number(el.dataset.i)].name;
      savePlans();populatePlanSelects();renderAll();
    });
    el.addEventListener('keydown',e=>{ if(e.key==='Enter') el.blur(); });
  });
  container.querySelectorAll('.plan-rate-input').forEach(el=>{
    el.addEventListener('blur',()=>{
      const i=Number(el.dataset.i); const rawVal=parseNum(el.value);
      if(rawVal!==null&&rawVal>=0){
        // 小数入力（<=1）なら%に変換（0.125→12.5）、すでに%なら変換なし
        const ratePercent = rawVal <= 1 ? rawVal*100 : rawVal;
        plans[i].rate=ratePercent;
        // プランを使っている案件のfee・rateを更新
        projects.forEach(p=>{
          if(p.planId===plans[i].id){
            p.rate=ratePercent;
            p.fee=p.principal*(ratePercent/100);
            const last=p.segments[p.segments.length-1];
            if(last.startElapsed===p.elapsed) last.rate=ratePercent;
            else p.segments.push({startElapsed:p.elapsed,rate:ratePercent});
          }
        });
        el.value=fmtRate(ratePercent);
        savePlans();saveData();renderAll();
      } else el.value=fmtRate(plans[i].rate);
    });
    el.addEventListener('keydown',e=>{ if(e.key==='Enter') el.blur(); });
  });
  container.querySelectorAll('.color-swatch').forEach(el=>{
    el.addEventListener('input',()=>{ plans[Number(el.dataset.i)].color=el.value; savePlans();renderAll(); });
  });
  container.querySelectorAll('.plan-del-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const i=Number(btn.dataset.i); const planId=plans[i].id;
      if(!confirm(`プラン「${plans[i].name}」を削除しますか？`)) return;
      plans.splice(i,1);
      projects.forEach(p=>{ if(p.planId===planId) p.planId=null; });
      savePlans();saveData();renderPlanList();populatePlanSelects();renderAll();
      showToast('プランを削除しました');
    });
  });
}

/* ══════════════════════════════════════
   プレビュー
══════════════════════════════════════ */
function updatePreview(){
  const principal   = cv('add-principal');
  const roundUnit   = parseNum(document.getElementById('add-round').value)||10000;
  const recovType   = document.getElementById('add-recovery-type').value;
  const planId      = parseNum(document.getElementById('add-plan').value);
  const rate        = planId?getPlanRate(planId):0;
  const preview     = document.getElementById('monthly-preview');
  if(!principal||principal<=0){ preview.classList.add('hidden'); return; }

  const virtualCost  = cv('add-actual')||0;
  const totalPrinc   = principal+(virtualCost>0?virtualCost:0);
  const fee          = totalPrinc*(rate/100);

  let months, rawMonthly;
  if(recovType==='months'){
    months=parseNum(document.getElementById('add-months').value);
    if(!months||months<=0){ preview.classList.add('hidden'); return; }
    rawMonthly = totalPrinc/months + fee;
  } else {
    const mon=cv('add-monthly');
    if(!mon||mon<=0){ preview.classList.add('hidden'); return; }
    // 月支払額から月数を逆算: mon = totalPrinc/months + fee → months = totalPrinc/(mon-fee)
    const monthlyPrincipalPart = mon - fee;
    if(monthlyPrincipalPart<=0){ preview.classList.add('hidden'); return; }
    months = Math.ceil(totalPrinc/monthlyPrincipalPart);
    rawMonthly = mon;
  }

  const finalMonthly = ceilTo(rawMonthly, roundUnit);
  const totalPayAmt  = finalMonthly*months;

  document.getElementById('monthly-preview-val').textContent = fmt(finalMonthly);
  document.getElementById('monthly-preview-detail').innerHTML =
    `月元本: ${fmt(totalPrinc/months)} + 月手数料: ${fmt(fee)} = 切上前: ${fmt(rawMonthly)} → 切上後: ${fmt(finalMonthly)}<br>`+
    `${months}回払い ／ 総支払: ${fmt(finalMonthly*months)} ／ 総手数料: ${fmt(fee*months)}`;
  preview.classList.remove('hidden');
}

/* ══════════════════════════════════════
   新規追加
══════════════════════════════════════ */
function addProject(){
  const name        = document.getElementById('add-name').value.trim();
  const principal   = cv('add-principal');
  const actualInput = cv('add-actual');
  const planId      = parseNum(document.getElementById('add-plan').value);
  const roundUnit   = parseNum(document.getElementById('add-round').value)||10000;
  const recovType   = document.getElementById('add-recovery-type').value;

  if(!ok(principal,'元金')) return;

  const rate         = planId?getPlanRate(planId):0;
  const virtualCost  = (!actualInput||actualInput<=0)?0:actualInput;
  const totalPrinc   = principal+virtualCost;
  const fee          = totalPrinc*(rate/100); // 手数料（固定）

  let months;
  if(recovType==='months'){
    const m=parseNum(document.getElementById('add-months').value);
    if(!ok(m,'回収月数')) return;
    months=m;
  } else {
    const mon=cv('add-monthly');
    if(!ok(mon,'月支払額')) return;
    const monthlyPrincipalPart=mon-fee;
    if(monthlyPrincipalPart<=0){ showToast('月支払額が手数料より少ないです','error'); return; }
    months=Math.ceil(totalPrinc/monthlyPrincipalPart);
  }

  const p={
    id:genId(), name, memo:'',
    principal:totalPrinc, virtualCost, actualCost:principal,
    fee, rate, months, elapsed:0, recovered:0,
    startDate:todayStr(), planId:planId||null, roundUnit,
    segments:[{startElapsed:0,rate}],
    deposits:[{date:todayStr(),amount:totalPrinc,actualAmount:principal,note:'初回入金'}],
    repayments:[], shortageMode:'extend', shortageAccum:0
  };
  projects.push(p);
  saveData(); renderAll();

  ['add-name','add-principal','add-actual','add-months','add-monthly'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  document.getElementById('monthly-preview').classList.add('hidden');
  // 回収設定を月数指定に戻す
  document.getElementById('add-recovery-type').value='months';
  document.getElementById('wrap-months').classList.remove('hidden');
  document.getElementById('wrap-monthly').classList.add('hidden');
  showToast(`案件 #${p.id}「${name||'無題'}」を追加しました`,'success');
}

/* ══════════════════════════════════════
   追加投資
   追加分の fee = 追加元金 × rate%
   月額維持: 現在の月支払に追加分(追加元本/残回数 + 追加fee)を加算して月数は残回数のまま
   回数維持: 残回数固定で月支払を増やす
══════════════════════════════════════ */
function addFunds(){
  const id      = parseNum(document.getElementById('funds-id').value);
  const amount  = cv('funds-amount');
  const actual  = cv('funds-actual');
  const date    = document.getElementById('funds-date').value||todayStr();
  const mode    = document.querySelector('input[name="funds-mode"]:checked').value;

  if(!ok(id,'案件ID'))     return;
  if(!ok(amount,'追加元金')) return;

  const p=projects.find(x=>x.id===id);
  if(!p){ showToast(`ID ${id} の案件が見つかりません`,'error'); return; }

  const actualAdd = (!actual||actual<=0)?0:actual;
  const addFee    = amount*(p.rate/100); // 追加元金の手数料（固定）
  const remainingCount = p.months-p.elapsed; // 残り回収回数

  if(mode==='extend'){
    // 月額維持: 残回数を増やす
    // 追加分の月支払 = amount/? + addFee → ?を解く
    // 現在の月支払 = mrFinal(p)
    // 追加分をその月支払に乗せるため、追加回数を計算
    // 追加月元本 = mrFinal(p) - (p.principal/p.months) - getFee(p)... 複雑なので別方式
    // 追加元金+追加手数料を月支払額で割って追加回数を算出
    const currentFinal = mrFinal(p);
    const addTotalPay  = amount+addFee;
    const addMonths    = Math.ceil(addTotalPay/currentFinal);
    // 元金・手数料・月数を更新
    p.principal  += amount;
    p.fee        += addFee;
    p.virtualCost = (p.virtualCost||0)+actualAdd;
    p.actualCost  = p.principal-p.virtualCost;
    p.months     += addMonths;
  } else {
    // 回数維持: 残回数は変えず月額を増やす
    // 追加分は残回数で均等割り（月額に追加月元本+追加月手数料を加算）
    p.principal  += amount;
    p.fee        += addFee;
    p.virtualCost = (p.virtualCost||0)+actualAdd;
    p.actualCost  = p.principal-p.virtualCost;
    // months は変えない → mrFinal が自動で増える
  }

  if(!p.deposits) p.deposits=[];
  p.deposits.push({date,amount,actualAmount:amount-actualAdd,note:'追加投資'});
  saveData(); renderAll();

  ['funds-id','funds-amount','funds-actual'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('funds-date').value=todayStr();
  showToast(`案件 #${id} に追加投資を反映しました`,'success');
}

/* ══════════════════════════════════════
   回収記録
══════════════════════════════════════ */
function recordPayment(id){
  const p=projects.find(x=>x.id===id); if(!p) return;
  const dateEl = document.querySelector(`.pay-date-input[data-id="${id}"]`);
  const amtEl  = document.querySelector(`.pay-amount-input[data-id="${id}"]`);
  const date   = dateEl?.value||todayStr();
  const amount = parseNum(amtEl?.value?.replace(/,/g,''));

  if(!ok(amount,'回収金額')) return;
  const debt = calcDebt(p);
  if(amount>debt){ showToast(`回収金額が残債(${fmt(debt)})を超えています`,'error'); return; }

  if(!p.repayments) p.repayments=[];
  p.repayments.push({date,amount});
  p.elapsed++;
  p.recovered=calcRecovered(p);

  const expected=mrFinal(p);
  if(amount<expected && calcDebt(p)>0){
    shortageContext={id,amount,expected,shortage:expected-amount};
    openShortageModal(p);
  } else {
    saveData(); renderAll();
    showToast(`案件 #${id} 回収を記録しました（${fmt(amount)}）`,'success');
  }
  if(amtEl) amtEl.value='';
}

/* ══════════════════════════════════════
   不足モーダル
══════════════════════════════════════ */
function openShortageModal(p){
  const {expected,shortage}=shortageContext;
  document.getElementById('shortage-info').innerHTML=
    `想定支払額: <strong>${fmt(expected)}</strong><br>`+
    `実際の支払額: <strong>${fmt(shortageContext.amount)}</strong><br>`+
    `不足額: <strong>${fmt(shortage)}</strong>`;
  const r=document.querySelector(`input[name="shortage-action"][value="${p.shortageMode||'extend'}"]`);
  if(r) r.checked=true;
  document.getElementById('shortage-rate-wrap').classList.add('hidden');
  document.getElementById('shortage-new-rate').value=p.rate;
  document.getElementById('modal-shortage').classList.remove('hidden');
}

function applyShortage(){
  if(!shortageContext) return;
  const {id,shortage}=shortageContext;
  const p=projects.find(x=>x.id===id); if(!p) return;
  const action=document.querySelector('input[name="shortage-action"]:checked').value;

  // 元金増加前のfee・月支払を保存
  const fixedFinal = mrFinal(p);

  if(action==='extend'){
    // 不足分のうち手数料相当のみ元金・feeに加算
    // 月手数料 = fee（固定）/ 全支払の fee割合
    const feeRatio    = getFee(p)/(p.principal/p.months+getFee(p));
    const feeMissing  = shortage*feeRatio;
    p.fee            += feeMissing;
    p.shortageAccum  += feeMissing;
    // 月額固定 → 月数を再計算
    // monthly = totalPrincipal/months + fee → months = totalPrincipal/(monthly-fee)
    const monthlyPrincipalPart = fixedFinal - p.fee;
    if(monthlyPrincipalPart>0)
      p.months = p.elapsed + Math.ceil((p.principal - (p.principal/p.months)*p.elapsed) / monthlyPrincipalPart);
    p.shortageMode='extend';

  } else if(action==='increase'){
    // 回数固定・月額増やす
    // feeをそのまま増やして月数は変えない
    const feeRatio   = getFee(p)/(p.principal/p.months+getFee(p));
    const feeMissing = shortage*feeRatio;
    p.fee            += feeMissing;
    p.shortageAccum  += feeMissing;
    p.shortageMode='increase';

  } else if(action==='rate'){
    const newRate=parseNum(document.getElementById('shortage-new-rate').value);
    if(newRate===null||newRate<0){ showToast('利益率を入力してください','error'); return; }
    const last=p.segments[p.segments.length-1];
    if(last.startElapsed===p.elapsed) last.rate=newRate;
    else p.segments.push({startElapsed:p.elapsed,rate:newRate});
    p.rate   = newRate;
    p.fee    = p.principal*(newRate/100); // 新利益率で fee を再計算
    p.planId = null;
    // 月額固定で月数再計算
    const newMonthlyPrincipalPart = fixedFinal - p.fee;
    if(newMonthlyPrincipalPart>0)
      p.months = p.elapsed + Math.ceil((p.principal-(p.principal/p.months)*p.elapsed)/newMonthlyPrincipalPart);
  }
  // 'none': 何もしない

  saveData(); renderAll(); closeShortage();
  showToast(`案件 #${id} の調整を適用しました`,'success');
}

function closeShortage(){
  document.getElementById('modal-shortage').classList.add('hidden');
  shortageContext=null;
}

/* ══════════════════════════════════════
   削除
══════════════════════════════════════ */
function requestDelete(id){
  deleteTargetId=id;
  document.getElementById('modal-delete-text').textContent=`案件 #${id} を削除しますか？`;
  document.getElementById('modal-delete').classList.remove('hidden');
}
function confirmDelete(){
  if(deleteTargetId===null) return;
  const id=deleteTargetId;
  projects=projects.filter(p=>p.id!==id);
  saveData();renderAll();closeDelete();
  showToast(`案件 #${id} を削除しました`);
}
function closeDelete(){ document.getElementById('modal-delete').classList.add('hidden'); deleteTargetId=null; }

/* ══════════════════════════════════════
   詳細モーダル
══════════════════════════════════════ */
function openDetail(id){
  const p=projects.find(x=>x.id===id); if(!p) return;
  detailProjectId=id;
  document.getElementById('detail-title').textContent=`案件 #${id}「${p.name||'無題'}」`;
  populatePlanSelects(p.planId);
  document.getElementById('detail-plan-select').value=p.planId||'';
  document.getElementById('detail-memo').value=p.memo||'';
  switchDetailTab('summary');
  renderDetailSummary(p);
  renderDepositTable(p);
  renderRepaymentTable(p);
  document.getElementById('modal-detail').classList.remove('hidden');
}
function closeDetail(){ document.getElementById('modal-detail').classList.add('hidden'); detailProjectId=null; }

function switchDetailTab(name){
  document.querySelectorAll('.detail-tab').forEach(t=>t.classList.toggle('active',t.dataset.dtab===name));
  document.querySelectorAll('.detail-tab-pane').forEach(p=>p.classList.toggle('hidden',p.id!==`dtab-${name}`));
}

function renderDetailSummary(p){
  const rec      = calcRecovered(p);
  const debt     = calcDebt(p);
  const tp       = totalPay(p);
  const recRate  = tp>0?Math.min((rec/tp)*100,100):0;
  const profit   = calcProfit(p);
  const fee      = getFee(p);
  const rawM     = mrRaw(p);
  const finalM   = mrFinal(p);
  const remainM  = Math.max(0,p.months-p.elapsed);
  const capProf  = capitalProfit(p);

  document.getElementById('ds-principal').textContent    = fmt(p.principal);
  document.getElementById('ds-actual').textContent       = fmt(p.actualCost||p.principal);
  document.getElementById('ds-fee').textContent          = fmt(fee);
  document.getElementById('ds-monthly-fee').textContent  = fmt(fee);
  document.getElementById('ds-monthly').textContent      = fmt(rawM);
  document.getElementById('ds-total-months').textContent = `${p.months}回`;
  // 利益率 = 総手数料(fee×月数) ÷ 実費
  const actualCostVal = p.actualCost||p.principal;
  const totalFee      = fee*p.months;
  const profitRate    = actualCostVal>0 ? totalFee/actualCostVal : 0;
  document.getElementById('ds-profit-rate').textContent  = profitRate.toFixed(3);
  // 利益見込み = mrFinal×months - 元金（手数料含む総支払 - 元金回収分）
  const profitExpected = mrFinal(p)*p.months - p.principal;
  document.getElementById('ds-profit-expected').textContent = fmt(Math.max(0,profitExpected));
  document.getElementById('ds-remain-months').textContent= `${remainM}回`;
  document.getElementById('ds-recovered').textContent    = fmt(rec);
  document.getElementById('ds-remaining').textContent    = fmt(debt);
  document.getElementById('ds-profit').textContent       = fmt(profit);
  document.getElementById('ds-cap-profit').textContent   = fmt(capProf);
  document.getElementById('ds-total-pay').textContent    = fmt(tp);
  document.getElementById('ds-rate').textContent         = pct(recRate);

  const bar=document.getElementById('ds-rate-bar');
  bar.style.width=recRate.toFixed(1)+'%';
  bar.className='ds-rate-bar-fill'+(recRate>=70?'':recRate>=30?' mid':' low');

  const shRow=document.getElementById('ds-shortage-row');
  if(p.shortageAccum>0){
    shRow.classList.remove('hidden');
    document.getElementById('ds-shortage').textContent=fmt(p.shortageAccum);
  } else shRow.classList.add('hidden');
}

/* ── 入金履歴 ── */
function renderDepositTable(p){
  const tbody=document.getElementById('deposit-tbody');
  tbody.innerHTML='';
  if(!p.deposits||!p.deposits.length){
    tbody.innerHTML='<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--text-muted)">履歴なし</td></tr>';
    return;
  }
  p.deposits.forEach((d,i)=>{
    const tag=i===0?'<span class="tag-init">初回</span>':'<span class="tag-add">追加</span>';
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td><input type="date" class="h-input dep-date" value="${d.date||''}" data-i="${i}"/></td>
      <td><input type="text" class="h-input amount dep-amount" value="${Math.round(d.amount||0).toLocaleString('ja-JP')}" inputmode="numeric" data-i="${i}"/></td>
      <td><input type="text" class="h-input amount dep-actual" value="${Math.round(d.actualAmount||d.amount||0).toLocaleString('ja-JP')}" inputmode="numeric" data-i="${i}"/></td>
      <td><div style="display:flex;gap:6px;align-items:center">${tag}<input type="text" class="h-input memo-h dep-note" value="${escAttr(d.note||'')}" placeholder="メモ" data-i="${i}"/></div></td>
      <td><button class="h-del-btn dep-del" data-i="${i}">🗑</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.dep-amount,.dep-actual').forEach(el=>initCI(el));
  tbody.querySelectorAll('.dep-date,.dep-amount,.dep-actual,.dep-note').forEach(el=>{
    el.addEventListener('blur',()=>saveDepEdit(p));
    el.addEventListener('change',()=>saveDepEdit(p));
  });
  tbody.querySelectorAll('.dep-del').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const i=Number(btn.dataset.i);
      if(p.deposits.length<=1){showToast('最低1件必要です','error');return;}
      p.deposits.splice(i,1);
      saveData();renderDepositTable(p);renderDetailSummary(p);renderAll();
    });
  });
}
function saveDepEdit(p){
  const tbody=document.getElementById('deposit-tbody');
  tbody.querySelectorAll('tr').forEach((tr,i)=>{
    if(!p.deposits[i]) return;
    const d=tr.querySelector(`.dep-date[data-i="${i}"]`);
    const a=tr.querySelector(`.dep-amount[data-i="${i}"]`);
    const ac=tr.querySelector(`.dep-actual[data-i="${i}"]`);
    const n=tr.querySelector(`.dep-note[data-i="${i}"]`);
    if(d)  p.deposits[i].date         = d.value;
    if(a)  p.deposits[i].amount       = parseNum(a.value)||0;
    if(ac) p.deposits[i].actualAmount = parseNum(ac.value)||0;
    if(n)  p.deposits[i].note         = n.value;
  });
  saveData();renderDetailSummary(p);renderAll();
}

/* ── 回収履歴 ── */
function renderRepaymentTable(p){
  const tbody=document.getElementById('repayment-tbody');
  tbody.innerHTML='';
  if(!p.repayments||!p.repayments.length){
    tbody.innerHTML='<tr><td colspan="6" style="text-align:center;padding:16px;color:var(--text-muted)">履歴なし</td></tr>';
    return;
  }
  const expected=mrFinal(p);
  p.repayments.forEach((r,i)=>{
    const diff=(r.amount||0)-expected;
    const dc=diff>=0?'surplus':'deficit';
    const ds=diff>=0?`+${fmt(diff)}`:fmt(diff);
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td style="color:var(--text-muted);font-size:.8rem;font-family:var(--font-body)">${i+1}</td>
      <td><input type="date" class="h-input rep-date" value="${r.date||''}" data-i="${i}"/></td>
      <td><input type="text" class="h-input amount rep-amount" value="${Math.round(r.amount||0).toLocaleString('ja-JP')}" inputmode="numeric" data-i="${i}"/></td>
      <td style="font-size:.82rem">${fmt(expected)}</td>
      <td class="${dc}" style="font-size:.82rem">${ds}</td>
      <td><button class="h-del-btn rep-del" data-i="${i}">🗑</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.rep-amount').forEach(el=>initCI(el));
  tbody.querySelectorAll('.rep-date,.rep-amount').forEach(el=>{
    el.addEventListener('blur',()=>saveRepEdit(p));
    el.addEventListener('change',()=>saveRepEdit(p));
  });
  tbody.querySelectorAll('.rep-del').forEach(btn=>{
    btn.addEventListener('click',()=>{
      p.repayments.splice(Number(btn.dataset.i),1);
      p.elapsed=p.repayments.length;
      p.recovered=calcRecovered(p);
      saveData();renderRepaymentTable(p);renderDetailSummary(p);renderAll();
    });
  });
}
function saveRepEdit(p){
  const tbody=document.getElementById('repayment-tbody');
  tbody.querySelectorAll('tr').forEach((tr,i)=>{
    if(!p.repayments[i]) return;
    const d=tr.querySelector(`.rep-date[data-i="${i}"]`);
    const a=tr.querySelector(`.rep-amount[data-i="${i}"]`);
    if(d) p.repayments[i].date   = d.value;
    if(a) p.repayments[i].amount = parseNum(a.value)||0;
  });
  p.elapsed=p.repayments.length;
  p.recovered=calcRecovered(p);
  saveData();renderRepaymentTable(p);renderDetailSummary(p);renderAll();
}

/* ══════════════════════════════════════
   RENDER: テーブル
══════════════════════════════════════ */
function renderTable(){
  const tbody=document.getElementById('table-body');
  tbody.innerHTML='';
  if(!projects.length){
    tbody.innerHTML='<tr class="empty-row"><td colspan="8">案件がありません。上のフォームから追加してください。</td></tr>';
    return;
  }
  projects.forEach(p=>{
    const debt      = calcDebt(p);
    const mf        = mrFinal(p);
    const remainMths= Math.max(0,p.months-p.elapsed);
    const isComplete= debt<=0;

    const tr=document.createElement('tr');
    tr.dataset.id=p.id;
    tr.innerHTML=`
      <td class="td-id col-id">#${p.id}</td>
      <td class="td-name col-name">${escHtml(p.name||'—')}</td>
      <td class="td-debt col-debt">
        <span class="debt-val${isComplete?' zero':''}">${isComplete?'完済':fmt(debt)}</span>
      </td>
      <td class="col-monthly" style="text-align:right">${fmt(mf)}<span style="font-size:.7rem;color:var(--text-muted)">/月</span></td>
      <td class="col-count" style="text-align:center;font-size:.82rem">
        <span style="color:var(--text-primary)">${p.elapsed}</span>/${p.months}回
        <span style="display:block;font-size:.72rem;color:${isComplete?'var(--green)':remainMths<=2?'var(--red)':'var(--amber)'}">残${remainMths}回</span>
      </td>
      <td class="col-date">
        <input type="date" class="date-input pay-date-input" data-id="${p.id}" value="${todayStr()}" ${isComplete?'disabled':''}/>
      </td>
      <td class="col-pay">
        <input type="text" class="pay-input pay-amount-input" data-id="${p.id}"
          placeholder="${fmt(mf).replace('¥','')}" inputmode="numeric" ${isComplete?'disabled':''}/>
      </td>
      <td class="td-action col-action">
        <div class="row-actions">
          ${isComplete?'':'<button class="btn-record rec-btn" data-id="'+p.id+'">記録</button>'}
          <button class="btn-row btn-row-detail" data-id="${p.id}" title="詳細">📋</button>
          <button class="btn-row btn-row-del"    data-id="${p.id}" title="削除">🗑</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.pay-amount-input').forEach(el=>{
    initCI(el);
    el.addEventListener('keydown',e=>{ if(e.key==='Enter') recordPayment(Number(el.dataset.id)); });
  });
  tbody.querySelectorAll('.rec-btn').forEach(btn=>{
    btn.addEventListener('click',()=>recordPayment(Number(btn.dataset.id)));
  });
  tbody.querySelectorAll('.btn-row-detail').forEach(btn=>btn.addEventListener('click',()=>openDetail(Number(btn.dataset.id))));
  tbody.querySelectorAll('.btn-row-del').forEach(btn    =>btn.addEventListener('click',()=>requestDelete(Number(btn.dataset.id))));
}

/* ══════════════════════════════════════
   RENDER: サマリー
══════════════════════════════════════ */
function renderSummary(){
  const ids=['sum-principal','sum-actual','sum-remaining','sum-recovered','sum-fee-profit','sum-cap-profit','sum-avg-rate','sum-recovery-rate'];
  if(!projects.length){
    ids.forEach(id=>document.getElementById(id).textContent=id.includes('rate')?'0%':'¥0');
    return;
  }
  const totalPrincipal = projects.reduce((a,p)=>a+p.principal,0);
  const totalActual    = projects.reduce((a,p)=>a+(p.actualCost||p.principal),0);
  const totalDebt      = projects.reduce((a,p)=>a+calcDebt(p),0);
  const totalRecovered = projects.reduce((a,p)=>a+calcRecovered(p),0);
  const totalFeeProfit = projects.reduce((a,p)=>a+calcProfit(p),0);
  const totalCapProfit = projects.reduce((a,p)=>a+capitalProfit(p),0);
  const avgRate        = projects.length>0
    ? projects.reduce((a,p)=>a+(p.rate||0),0)/projects.length : 0;
  const sumTotalPay    = projects.reduce((a,p)=>a+totalPay(p),0);
  const avgRecovery    = sumTotalPay>0?Math.min((totalRecovered/sumTotalPay)*100,100):0;

  document.getElementById('sum-principal').textContent    = fmt(totalPrincipal);
  document.getElementById('sum-actual').textContent       = fmt(totalActual);
  document.getElementById('sum-remaining').textContent    = fmt(totalDebt);
  document.getElementById('sum-recovered').textContent    = fmt(totalRecovered);
  document.getElementById('sum-fee-profit').textContent   = fmt(totalFeeProfit);
  document.getElementById('sum-cap-profit').textContent   = fmt(totalCapProfit);
  document.getElementById('sum-avg-rate').textContent     = fmtRate(avgRate);
  document.getElementById('sum-recovery-rate').textContent= pct(avgRecovery);
}

function renderAll(){ renderTable(); renderSummary(); }

/* ══════════════════════════════════════
   JSON / CSV
══════════════════════════════════════ */
function exportJSON(){
  if(!projects.length){showToast('データがありません','error');return;}
  dlFile(JSON.stringify({projects,plans},null,2),`backup_${todayStr()}.json`,'application/json');
  showToast('JSONをダウンロードしました','success');
}
function importJSON(file){
  if(!file) return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const parsed=JSON.parse(e.target.result);
      let np,nl;
      if(Array.isArray(parsed)){np=parsed;nl=plans;}
      else{np=parsed.projects||[];nl=parsed.plans||plans;}
      if(!Array.isArray(np)) throw new Error('案件データが不正です');
      if(!confirm(`${np.length}件を読み込みます。現在のデータを上書きしますか？`)) return;
      projects=np.map(migrate);
      if(Array.isArray(nl)&&nl.length) plans=nl;
      saveData();savePlans();populatePlanSelects();renderAll();
      showToast(`${projects.length}件を復元しました`,'success');
    }catch(err){showToast('読み込みエラー: '+err.message,'error');}
  };
  reader.onerror=()=>showToast('ファイルの読み込みに失敗しました','error');
  reader.readAsText(file);
  document.getElementById('input-import-json').value='';
}
function exportCSV(){
  if(!projects.length){showToast('データがありません','error');return;}
  const heads=['ID','件名','元金','実費','手数料','月支払額','利益率(%)','回収月数','回収済','累計回収','残債','累計利益','元金差益'];
  const rows=projects.map(p=>{
    const plan=getPlan(p.planId);
    return[p.id,`"${(p.name||'').replace(/"/g,'""')}"`,p.principal,p.actualCost||p.principal,
      Math.round(getFee(p)),Math.round(mrFinal(p)),p.rate,p.months,p.elapsed,
      Math.round(calcRecovered(p)),Math.round(calcDebt(p)),Math.round(calcProfit(p)),Math.round(capitalProfit(p))];
  });
  const csv=[heads.join(','),...rows.map(r=>r.join(','))].join('\r\n');
  dlFile('\uFEFF'+csv,`projects_${todayStr()}.csv`,'text/csv;charset=utf-8;');
  showToast('CSVをダウンロードしました','success');
}

/* ══════════════════════════════════════
   TOAST / HELPERS
══════════════════════════════════════ */
let _tt=null;
function showToast(msg,type=''){
  document.querySelector('.toast')?.remove(); clearTimeout(_tt);
  const el=Object.assign(document.createElement('div'),{className:`toast${type?' '+type:''}`,textContent:msg});
  document.body.appendChild(el);
  _tt=setTimeout(()=>{ el.style.cssText='opacity:0;transition:opacity .3s ease'; setTimeout(()=>el.remove(),300); },2800);
}
function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function escAttr(s){ return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;') }

/* ══════════════════════════════════════
   TABS / BIND / INIT
══════════════════════════════════════ */
function initTabs(){
  document.querySelectorAll('.panel-tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      document.querySelectorAll('.panel-tab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('.panel-body').forEach(b=>b.classList.add('hidden'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.remove('hidden');
    });
  });
}

function bindEvents(){
  // 管理者
  document.getElementById('btn-admin').addEventListener('click',openAdmin);
  document.getElementById('admin-close').addEventListener('click',closeAdmin);
  document.getElementById('admin-close-btn').addEventListener('click',closeAdmin);
  document.getElementById('modal-admin').addEventListener('click',e=>{ if(e.target===document.getElementById('modal-admin')) closeAdmin(); });
  document.getElementById('btn-add-plan').addEventListener('click',()=>{
    const colors=['#6b91c8','#3ecf8e','#f5a623','#f06060','#a78bfa','#38bdf8','#fb7185','#34d399'];
    plans.push({id:genPlanId(),name:`プラン${String.fromCharCode(65+plans.length)}`,rate:20,color:colors[plans.length%colors.length]});
    savePlans();renderPlanList();populatePlanSelects();
  });

  // 新規追加
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

  // 追加投資
  document.getElementById('btn-funds').addEventListener('click',addFunds);

  // JSON/CSV
  document.getElementById('btn-export-json').addEventListener('click',exportJSON);
  document.getElementById('btn-export-csv').addEventListener('click',exportCSV);
  document.getElementById('input-import-json').addEventListener('change',e=>importJSON(e.target.files[0]));

  // 削除
  document.getElementById('modal-delete-confirm').addEventListener('click',confirmDelete);
  document.getElementById('modal-delete-cancel').addEventListener('click',closeDelete);
  document.getElementById('modal-delete').addEventListener('click',e=>{ if(e.target===document.getElementById('modal-delete')) closeDelete(); });

  // 不足
  document.getElementById('shortage-confirm').addEventListener('click',applyShortage);
  document.getElementById('shortage-cancel').addEventListener('click',()=>{ closeShortage(); saveData(); renderAll(); showToast('記録しました（調整なし）','success'); });
  document.getElementById('modal-shortage').addEventListener('click',e=>{ if(e.target===document.getElementById('modal-shortage')){ closeShortage(); saveData(); renderAll(); } });
  document.querySelectorAll('input[name="shortage-action"]').forEach(r=>{
    r.addEventListener('change',()=>{
      document.getElementById('shortage-rate-wrap').classList.toggle('hidden',r.value!=='rate');
    });
  });

  // 詳細
  document.getElementById('detail-close').addEventListener('click',closeDetail);
  document.getElementById('detail-close-btn').addEventListener('click',closeDetail);
  document.getElementById('modal-detail').addEventListener('click',e=>{ if(e.target===document.getElementById('modal-detail')) closeDetail(); });
  document.querySelectorAll('.detail-tab').forEach(tab=>{
    tab.addEventListener('click',()=>switchDetailTab(tab.dataset.dtab));
  });
  document.getElementById('detail-plan-select').addEventListener('change',()=>{
    const p=projects.find(x=>x.id===detailProjectId); if(!p) return;
    const newPlanId=parseNum(document.getElementById('detail-plan-select').value);
    p.planId=newPlanId||null;
    if(newPlanId){
      const newRate=getPlanRate(newPlanId);
      p.rate=newRate;
      p.fee=p.principal*(newRate/100);
      const last=p.segments[p.segments.length-1];
      if(last.startElapsed===p.elapsed) last.rate=newRate;
      else p.segments.push({startElapsed:p.elapsed,rate:newRate});
    }
    saveData();renderDetailSummary(p);renderAll();showToast('プランを変更しました','success');
  });
  document.getElementById('detail-memo').addEventListener('blur',()=>{
    const p=projects.find(x=>x.id===detailProjectId); if(!p) return;
    p.memo=document.getElementById('detail-memo').value;
    saveData();
  });
  document.getElementById('btn-add-deposit').addEventListener('click',()=>{
    const p=projects.find(x=>x.id===detailProjectId); if(!p) return;
    if(!p.deposits) p.deposits=[];
    p.deposits.push({date:todayStr(),amount:0,actualAmount:0,note:''});
    saveData();renderDepositTable(p);renderDetailSummary(p);
  });
  document.getElementById('btn-add-repayment').addEventListener('click',()=>{
    const p=projects.find(x=>x.id===detailProjectId); if(!p) return;
    if(!p.repayments) p.repayments=[];
    p.repayments.push({date:todayStr(),amount:Math.round(mrFinal(p))});
    p.elapsed=p.repayments.length; p.recovered=calcRecovered(p);
    saveData();renderRepaymentTable(p);renderDetailSummary(p);renderAll();
  });

  // Enterキー
  ['add-name','add-principal','add-actual','add-months','add-monthly'].forEach(id=>{
    document.getElementById(id)?.addEventListener('keydown',e=>{ if(e.key==='Enter') addProject(); });
  });
  ['funds-id','funds-amount','funds-actual'].forEach(id=>{
    document.getElementById(id)?.addEventListener('keydown',e=>{ if(e.key==='Enter') addFunds(); });
  });

  // カンマ入力
  ['add-principal','add-actual','add-monthly','funds-amount','funds-actual'].forEach(id=>{
    const el=document.getElementById(id); if(el) initCI(el);
  });
}

function init(){
  loadData();
  if(projects.length>0) saveData();
  // デフォルトでNormal（id:2）を選択
  const normalPlan = plans.find(p=>p.name==='Normal');
  populatePlanSelects(normalPlan?normalPlan.id:null);
  renderAll();
  initTabs();
  bindEvents();
  document.getElementById('funds-date').value=todayStr();
}

document.addEventListener('DOMContentLoaded',init);
