import{d as i,y,T as m}from"./hooks.module.JM0_Ku3s.js";import{u as r}from"./jsxRuntime.module.BbxW1e5M.js";import{S as v}from"./preact.module.DaYdYXBZ.js";const _=2;function h({value:e,depth:l=0}){const[n,t]=i(l<_);if(e===null)return r("span",{class:"json-null",children:"null"});if(typeof e=="boolean")return r("span",{class:"json-bool",children:String(e)});if(typeof e=="number")return r("span",{class:"json-number",children:String(e)});if(typeof e=="string")return r("span",{class:"json-string",children:['"',e,'"']});if(Array.isArray(e))return e.length===0?r("span",{class:"json-bracket",children:"[]"}):r("span",{children:[r("button",{class:"json-toggle",onClick:()=>t(!n),children:n?"▼":"▶"}),r("span",{class:"json-bracket",children:"["}),n?r("div",{class:"json-children",children:e.map((s,a)=>r("div",{class:"json-row",children:[r("span",{class:"json-index",children:[a,": "]}),r(h,{value:s,depth:l+1}),a<e.length-1&&r("span",{class:"json-comma",children:","})]},a))}):r("span",{class:"json-collapsed",children:[" ",e.length," items "]}),r("span",{class:"json-bracket",children:"]"})]});if(typeof e=="object"){const s=Object.keys(e);return s.length===0?r("span",{class:"json-bracket",children:"{}"}):r("span",{children:[r("button",{class:"json-toggle",onClick:()=>t(!n),children:n?"▼":"▶"}),r("span",{class:"json-bracket",children:"{"}),n?r("div",{class:"json-children",children:s.map((a,d)=>r("div",{class:"json-row",children:[r("span",{class:"json-key",children:['"',a,'"']}),r("span",{class:"json-colon",children:": "}),r(h,{value:e[a],depth:l+1}),d<s.length-1&&r("span",{class:"json-comma",children:","})]},a))}):r("span",{class:"json-collapsed",children:[" ",s.length," keys "]}),r("span",{class:"json-bracket",children:"}"})]})}return r("span",{class:"json-unknown",children:String(e)})}function j({value:e}){return r(v,{children:[r("style",{children:`
        .json-tree {
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
          font-size: 12px;
          line-height: 1.6;
          color: #c9d1d9;
        }
        .json-children {
          padding-left: 20px;
          border-left: 1px solid #30363d;
          margin-left: 4px;
        }
        .json-row {
          display: block;
        }
        .json-toggle {
          background: none;
          border: none;
          color: #8b949e;
          cursor: pointer;
          font-size: 10px;
          padding: 0 4px 0 0;
          vertical-align: middle;
          line-height: 1;
        }
        .json-toggle:hover {
          color: #c9d1d9;
        }
        .json-key { color: #79c0ff; }
        .json-string { color: #a5d6ff; }
        .json-number { color: #79c0ff; }
        .json-bool { color: #ff7b72; }
        .json-null { color: #8b949e; font-style: italic; }
        .json-bracket { color: #c9d1d9; }
        .json-colon { color: #8b949e; }
        .json-comma { color: #8b949e; }
        .json-index { color: #8b949e; }
        .json-collapsed { color: #8b949e; font-style: italic; }
        .json-unknown { color: #c9d1d9; }
      `}),r("div",{class:"json-tree",children:r(h,{value:e,depth:0})})]})}function k(e){const l=Date.now()-e,n=Math.floor(l/1e3);if(n<60)return`${n}s ago`;const t=Math.floor(n/60);return t<60?`${t}m ago`:`${Math.floor(t/60)}h ago`}function S({name:e,data:l,metadata:n}){const[t,s]=i(!1),a=n.failed===!0;return r("div",{class:"card domain-card",style:{borderColor:a?"rgba(248, 81, 73, 0.5)":"var(--border-default)",background:a?"rgba(248, 81, 73, 0.06)":"var(--bg-default)"},children:[r("div",{class:"domain-card__header",children:[r("div",{class:"domain-card__title-row",children:[r("span",{class:"domain-card__status-dot",style:{background:a?"var(--text-danger)":"var(--text-success)"}}),r("span",{class:"domain-card__name",children:e}),a&&r("span",{class:"badge badge-red",style:{marginLeft:"8px"},children:"failed"})]}),r("div",{class:"domain-card__meta",children:[r("span",{class:"domain-card__meta-item",title:new Date(n.collectedAt).toISOString(),children:k(n.collectedAt)}),r("span",{class:"domain-card__meta-sep",children:"·"}),r("span",{class:"domain-card__meta-item",children:["tick #",n.tickNumber]})]})]}),a&&n.errorMessage&&r("div",{class:"domain-card__error",children:n.errorMessage}),r("button",{class:"domain-card__toggle",onClick:()=>s(!t),children:t?"Hide data ▲":"Show data ▼"}),t&&r("div",{class:"domain-card__data",children:r(j,{value:l})}),r("style",{children:`
        .domain-card {
          display: flex;
          flex-direction: column;
          gap: 10px;
          transition: border-color 0.2s;
        }
        .domain-card__header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .domain-card__title-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .domain-card__status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .domain-card__name {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        }
        .domain-card__meta {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
        }
        .domain-card__meta-item {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .domain-card__meta-sep {
          color: var(--border-default);
          font-size: 12px;
        }
        .domain-card__error {
          font-size: 12px;
          color: var(--text-danger);
          background: rgba(248, 81, 73, 0.1);
          border: 1px solid rgba(248, 81, 73, 0.3);
          border-radius: 4px;
          padding: 6px 10px;
        }
        .domain-card__toggle {
          align-self: flex-start;
          background: none;
          border: 1px solid var(--border-muted);
          border-radius: 4px;
          color: var(--text-secondary);
          cursor: pointer;
          font-size: 12px;
          padding: 4px 10px;
          transition: border-color 0.1s, color 0.1s;
        }
        .domain-card__toggle:hover {
          border-color: var(--border-default);
          color: var(--text-primary);
        }
        .domain-card__data {
          background: var(--bg-inset);
          border: 1px solid var(--border-default);
          border-radius: 4px;
          padding: 12px;
          max-height: 400px;
          overflow-y: auto;
        }
      `})]})}const M=15e3;function A(){const[e,l]=i(null),[n,t]=i(null),[s,a]=i(null),[d,u]=i(""),[p,w]=i("all");async function x(){try{const o=await fetch("/api/world-state");if(!o.ok)throw new Error(`${o.status} ${o.statusText}`);const f=await o.json();l(f),a(new Date),t(null)}catch(o){t(o instanceof Error?o.message:"Failed to fetch world state")}}y(()=>{x();const o=setInterval(x,M);return()=>clearInterval(o)},[]);const c=m(()=>e?Object.keys(e.domains).sort():[],[e]),g=m(()=>e?c.filter(o=>p!=="all"&&o!==p?!1:d.trim()?o.toLowerCase().includes(d.toLowerCase()):!0):[],[c,p,d,e]),b=m(()=>e?Object.values(e.domains).filter(o=>o.metadata.failed).length:0,[e]);return r(v,{children:[r("style",{children:`
        .wsv-toolbar {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 20px;
          flex-wrap: wrap;
        }
        .wsv-filter {
          flex: 1;
          min-width: 160px;
          background: var(--bg-default);
          border: 1px solid var(--border-default);
          border-radius: 6px;
          color: var(--text-primary);
          font-size: 13px;
          padding: 6px 10px;
          outline: none;
        }
        .wsv-filter:focus {
          border-color: var(--accent-fg);
        }
        .wsv-filter::placeholder {
          color: var(--text-secondary);
        }
        .wsv-select {
          background: var(--bg-default);
          border: 1px solid var(--border-default);
          border-radius: 6px;
          color: var(--text-primary);
          font-size: 13px;
          padding: 6px 10px;
          outline: none;
          cursor: pointer;
        }
        .wsv-select:focus {
          border-color: var(--accent-fg);
        }
        .wsv-meta {
          font-size: 12px;
          color: var(--text-secondary);
          margin-left: auto;
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .wsv-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
          gap: 16px;
        }
        .wsv-error {
          background: rgba(248, 81, 73, 0.1);
          border: 1px solid rgba(248, 81, 73, 0.3);
          border-radius: 6px;
          color: var(--text-danger);
          font-size: 13px;
          padding: 12px 16px;
          margin-bottom: 16px;
        }
        .wsv-empty {
          color: var(--text-secondary);
          font-style: italic;
          text-align: center;
          padding: 48px 24px;
        }
        .wsv-failed-badge {
          display: inline-flex;
          align-items: center;
          background: rgba(248, 81, 73, 0.15);
          color: var(--text-danger);
          border-radius: 12px;
          font-size: 11px;
          font-weight: 500;
          padding: 2px 8px;
        }
      `}),r("div",{class:"wsv-toolbar",children:[r("input",{class:"wsv-filter",type:"text",placeholder:"Filter domains…",value:d,onInput:o=>u(o.target.value)}),c.length>0&&r("select",{class:"wsv-select",value:p,onChange:o=>w(o.target.value),children:[r("option",{value:"all",children:["All domains (",c.length,")"]}),c.map(o=>r("option",{value:o,children:o},o))]}),r("div",{class:"wsv-meta",children:[b>0&&r("span",{class:"wsv-failed-badge",children:[b," failed"]}),s&&r("span",{children:["Updated ",s.toLocaleTimeString()]})]})]}),n&&r("div",{class:"wsv-error",children:["Error: ",n]}),!e&&!n&&r("div",{class:"wsv-empty",children:"Loading world state…"}),e&&g.length===0&&r("div",{class:"wsv-empty",children:"No domains match the current filter."}),e&&g.length>0&&r("div",{class:"wsv-grid",children:g.map(o=>{const f=e.domains[o];return r(S,{name:o,data:f.data,metadata:f.metadata},o)})})]})}export{A as default};
