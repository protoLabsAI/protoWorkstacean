import{d as h,y as C}from"./hooks.module.JM0_Ku3s.js";import{u as a}from"./jsxRuntime.module.BbxW1e5M.js";const L={critical:"var(--text-danger)",high:"var(--text-warning)",medium:"var(--accent-fg)",low:"var(--text-secondary)"},M={Threshold:"Threshold",Invariant:"Invariant",Distribution:"Distribution"};function A({goal:e,result:o}){const t=o.status==="pass",s=o.status==="unknown",n=e.severity??"medium",i=L[n]??"var(--text-secondary)",l=s?"var(--border-default)":t?"rgba(63, 185, 80, 0.4)":"rgba(248, 81, 73, 0.4)",c=s?"var(--text-secondary)":t?"var(--text-success)":"var(--text-danger)",p=s?"?":t?"✓":"✗",f=s?"badge badge-blue":t?"badge badge-green":"badge badge-red",x=s?"unknown":t?"pass":"fail";let u=null;if(e.type==="Threshold"){const r="min"in e?e.min:void 0,d="max"in e?e.max:void 0;r!==void 0&&d!==void 0?u=`${r} ≤ x ≤ ${d}`:r!==void 0?u=`≥ ${r}`:d!==void 0&&(u=`≤ ${d}`)}return a("div",{class:"goal-card card",style:{borderColor:l},children:[a("div",{class:"goal-card__header",children:[a("div",{class:"goal-card__left",children:[a("span",{class:"goal-card__indicator",style:{color:c,borderColor:c},children:p}),a("div",{class:"goal-card__title-group",children:[a("span",{class:"goal-card__id",children:e.id}),a("span",{class:"goal-card__desc",children:e.description})]})]}),a("div",{class:"goal-card__badges",children:[a("span",{class:"badge badge-blue",children:M[e.type]??e.type}),a("span",{class:"badge",style:{background:`${i}22`,color:i},children:n}),a("span",{class:f,children:x})]})]}),a("div",{class:"goal-card__detail",children:["selector"in e&&a("span",{class:"goal-card__selector",children:e.selector}),o.actual!==void 0&&o.actual!==null&&a("span",{class:"goal-card__value",children:["value: ",a("code",{children:JSON.stringify(o.actual)})]}),u&&a("span",{class:"goal-card__threshold",children:["range: ",u]}),!t&&o.message&&a("span",{class:"goal-card__message",children:o.message})]}),a("style",{children:`
        .goal-card {
          display: flex;
          flex-direction: column;
          gap: 10px;
          transition: border-color 0.2s;
        }
        .goal-card__header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .goal-card__left {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          min-width: 0;
        }
        .goal-card__indicator {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          border: 2px solid;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          font-weight: 700;
          flex-shrink: 0;
        }
        .goal-card__title-group {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .goal-card__id {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .goal-card__desc {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .goal-card__badges {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
        }
        .goal-card__detail {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
          padding-top: 4px;
          border-top: 1px solid var(--border-muted);
        }
        .goal-card__selector {
          font-size: 11px;
          color: var(--text-secondary);
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
          background: var(--bg-inset);
          padding: 2px 6px;
          border-radius: 4px;
        }
        .goal-card__value {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .goal-card__value code {
          color: var(--accent-fg);
        }
        .goal-card__threshold {
          font-size: 12px;
          color: var(--text-secondary);
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        }
        .goal-card__message {
          font-size: 11px;
          color: var(--text-danger);
          background: rgba(248, 81, 73, 0.08);
          border: 1px solid rgba(248, 81, 73, 0.2);
          border-radius: 4px;
          padding: 3px 8px;
          flex: 1 1 100%;
        }
      `})]})}function v(e,o){const t=o.split(".");let s=e;for(const n of t){if(s==null||typeof s!="object")return;s=s[n]}return s}function S(e,o){const t=v(o,e.selector),s=e.operator??"truthy";let n;switch(s){case"truthy":n=!!t;break;case"falsy":n=!t;break;case"eq":n=t===e.expected;break;case"neq":n=t!==e.expected;break;case"in":n=Array.isArray(e.expected)&&e.expected.includes(t);break;case"not_in":n=Array.isArray(e.expected)&&!e.expected.includes(t);break;default:n=!1}return{status:t===void 0?"unknown":n?"pass":"fail",actual:t,message:n?`${e.selector} satisfies ${s}`:`${e.selector} = ${JSON.stringify(t)} does not satisfy ${s}`}}function z(e,o){const t=v(o,e.selector);if(t==null)return{status:"unknown",actual:t,message:`${e.selector} not found in world state`};const s=Number(t);if(isNaN(s))return{status:"unknown",actual:t,message:`${e.selector} = ${JSON.stringify(t)} is not a number`};const n=e.min===void 0||s>=e.min,i=e.max===void 0||s<=e.max,l=n&&i;let c=`${e.selector} = ${s}`;return n||(c+=` (min: ${e.min})`),i||(c+=` (max: ${e.max})`),{status:l?"pass":"fail",actual:s,message:c}}function j(e,o){const t=v(o,e.selector);if(t==null)return{status:"unknown",actual:t,message:`${e.selector} not found in world state`};if(e.pattern){const s=new RegExp(e.pattern),i=(Array.isArray(t)?t:Object.values(t)).every(l=>typeof l=="string"&&s.test(l));return{status:i?"pass":"fail",actual:t,message:i?`All values match /${e.pattern}/`:`Some values don't match /${e.pattern}/`}}if(e.distribution){const s=e.tolerance??.1,n=t,i=[];for(const[c,p]of Object.entries(e.distribution)){const f=n[c]??0;Math.abs(f-p)>s&&i.push(`${c}: got ${(f*100).toFixed(1)}%, expected ${(p*100).toFixed(1)}%`)}const l=i.length===0;return{status:l?"pass":"fail",actual:t,message:l?"Distribution within tolerance":i.join("; ")}}return{status:"unknown",actual:t,message:"No evaluation criteria defined"}}function N(e,o){if(e.enabled===!1)return{status:"unknown",actual:void 0,message:"Goal disabled"};switch(e.type){case"Invariant":return S(e,o);case"Threshold":return z(e,o);case"Distribution":return j(e,o);default:return{status:"unknown",actual:void 0,message:"Unknown goal type"}}}const I=3e4;function D(){const[e,o]=h([]),[t,s]=h(null),[n,i]=h(!0),[l,c]=h(null);async function p(){try{const[r,d]=await Promise.all([fetch("/api/goals"),fetch("/api/world-state")]);if(!r.ok)throw new Error(`/api/goals: ${r.status}`);if(!d.ok)throw new Error(`/api/world-state: ${d.status}`);const m=await r.json(),y=await d.json(),w=Array.isArray(m.data)?m.data:[],k=y.data??null,_=w.map(g=>({goal:g,result:N(g,k)}));_.sort((g,$)=>{const b={fail:0,unknown:1,pass:2};return(b[g.result.status]??1)-(b[$.result.status]??1)}),o(_),s(null),c(new Date)}catch(r){s(r instanceof Error?r.message:String(r))}finally{i(!1)}}C(()=>{p();const r=setInterval(p,I);return()=>clearInterval(r)},[]);const f=e.filter(r=>r.result.status==="pass").length,x=e.filter(r=>r.result.status==="fail").length,u=e.filter(r=>r.result.status==="unknown").length;return a("div",{class:"goal-status",children:[a("div",{class:"goal-status__header",children:[a("h2",{class:"goal-status__title",children:"Goal Definitions"}),a("div",{class:"goal-status__meta",children:[l&&a("span",{class:"goal-status__updated",children:["Updated ",l.toLocaleTimeString()]}),!n&&e.length>0&&a("div",{class:"goal-status__counts",children:[a("span",{class:"badge badge-green",children:[f," pass"]}),a("span",{class:"badge badge-red",children:[x," fail"]}),u>0&&a("span",{class:"badge badge-blue",children:[u," unknown"]})]})]})]}),n&&a("div",{class:"card",children:a("p",{class:"placeholder-content",children:"Loading goals…"})}),!n&&t&&a("div",{class:"card",style:{borderColor:"rgba(248,81,73,0.4)"},children:a("p",{style:{color:"var(--text-danger)",fontSize:"13px"},children:["Failed to load goals: ",t]})}),!n&&!t&&e.length===0&&a("div",{class:"card",children:a("p",{class:"placeholder-content",children:"No goals defined"})}),!n&&!t&&e.length>0&&a("div",{class:"goal-status__list",children:e.map(({goal:r,result:d})=>a(A,{goal:r,result:d},r.id))}),a("style",{children:`
        .goal-status {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .goal-status__header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .goal-status__title {
          font-size: 16px;
          font-weight: 600;
        }
        .goal-status__meta {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .goal-status__updated {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .goal-status__counts {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .goal-status__list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
      `})]})}export{D as default};
