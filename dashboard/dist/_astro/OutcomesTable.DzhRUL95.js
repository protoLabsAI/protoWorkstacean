import{d as a,y as g}from"./hooks.module.JM0_Ku3s.js";import{u as e}from"./jsxRuntime.module.BbxW1e5M.js";import{S as f}from"./preact.module.DaYdYXBZ.js";const x=3e4;function b(t){return new Date(t).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}function v(t){return t<1e3?`${t}ms`:t<6e4?`${(t/1e3).toFixed(1)}s`:`${(t/6e4).toFixed(1)}m`}const y={success:"badge badge-green",failure:"badge badge-red",timeout:"badge badge-yellow"};function M(){const[t,m]=a(null),[n,p]=a([]),[c,d]=a(null),[r,_]=a(!0),[i,h]=a(null);async function u(){try{const o=await fetch("/api/outcomes");if(!o.ok)throw new Error(`/api/outcomes: ${o.status}`);const l=await o.json();m(l.summary??{success:0,failure:0,timeout:0,total:0}),p(Array.isArray(l.recent)?l.recent.slice().reverse():[]),d(null),h(new Date)}catch(o){d(o instanceof Error?o.message:String(o))}finally{_(!1)}}g(()=>{u();const o=setInterval(u,x);return()=>clearInterval(o)},[]);const s=t&&t.total>0?(t.success/t.total*100).toFixed(1):null;return e("div",{class:"outcomes",children:[e("div",{class:"outcomes__header",children:[e("h2",{class:"outcomes__title",children:"Action Outcomes"}),i&&e("span",{class:"outcomes__updated",children:["Updated ",i.toLocaleTimeString()]})]}),r&&e("div",{class:"card",children:e("p",{class:"placeholder-content",children:"Loading outcomes…"})}),!r&&c&&e("div",{class:"card",style:{borderColor:"rgba(248,81,73,0.4)"},children:e("p",{style:{color:"var(--text-danger)",fontSize:"13px"},children:["Failed to load outcomes: ",c]})}),!r&&!c&&t&&e(f,{children:[e("div",{class:"outcomes__summary",children:[e("div",{class:"outcomes__stat-card card",children:[e("span",{class:"outcomes__stat-label",children:"Total"}),e("span",{class:"outcomes__stat-value",children:t.total})]}),e("div",{class:"outcomes__stat-card card",children:[e("span",{class:"outcomes__stat-label",children:"Success"}),e("span",{class:"outcomes__stat-value",style:{color:"var(--text-success)"},children:t.success})]}),e("div",{class:"outcomes__stat-card card",children:[e("span",{class:"outcomes__stat-label",children:"Failure"}),e("span",{class:"outcomes__stat-value",style:{color:"var(--text-danger)"},children:t.failure})]}),e("div",{class:"outcomes__stat-card card",children:[e("span",{class:"outcomes__stat-label",children:"Timeout"}),e("span",{class:"outcomes__stat-value",style:{color:"var(--text-warning)"},children:t.timeout})]}),s!==null&&e("div",{class:"outcomes__stat-card card",children:[e("span",{class:"outcomes__stat-label",children:"Success Rate"}),e("span",{class:"outcomes__stat-value",style:{color:Number(s)>=70?"var(--text-success)":Number(s)>=40?"var(--text-warning)":"var(--text-danger)"},children:[s,"%"]})]})]}),e("div",{class:"card outcomes__table-card",children:[e("div",{class:"card-title",children:"Recent Dispatches"}),n.length===0?e("p",{class:"placeholder-content",style:{padding:"24px"},children:"No outcomes recorded yet"}):e("div",{class:"outcomes__table-wrapper",children:e("table",{class:"outcomes__table",children:[e("thead",{children:e("tr",{children:[e("th",{children:"Time"}),e("th",{children:"Action"}),e("th",{children:"Goal"}),e("th",{children:"Status"}),e("th",{children:"Duration"})]})}),e("tbody",{children:n.map(o=>e("tr",{children:[e("td",{class:"outcomes__td-time",children:b(o.startedAt)}),e("td",{class:"outcomes__td-action",children:e("code",{children:o.actionId})}),e("td",{class:"outcomes__td-goal",children:e("code",{children:o.goalId})}),e("td",{children:e("span",{class:y[o.status]??"badge badge-blue",children:o.status})}),e("td",{class:"outcomes__td-duration",children:v(o.durationMs)})]},o.correlationId))})]})})]})]}),e("style",{children:`
        .outcomes {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .outcomes__header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .outcomes__title {
          font-size: 16px;
          font-weight: 600;
        }
        .outcomes__updated {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .outcomes__summary {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .outcomes__stat-card {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 12px 16px;
          min-width: 80px;
          align-items: center;
        }
        .outcomes__stat-label {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .outcomes__stat-value {
          font-size: 24px;
          font-weight: 700;
          color: var(--text-primary);
          line-height: 1;
        }
        .outcomes__table-card {
          padding: 0;
          overflow: hidden;
        }
        .outcomes__table-card .card-title {
          padding: 12px 16px 0;
        }
        .outcomes__table-wrapper {
          overflow-x: auto;
        }
        .outcomes__table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }
        .outcomes__table th {
          text-align: left;
          padding: 8px 16px;
          color: var(--text-secondary);
          font-weight: 600;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          border-bottom: 1px solid var(--border-default);
          white-space: nowrap;
        }
        .outcomes__table td {
          padding: 8px 16px;
          border-bottom: 1px solid var(--border-muted);
          color: var(--text-primary);
          vertical-align: middle;
        }
        .outcomes__table tr:last-child td {
          border-bottom: none;
        }
        .outcomes__table tr:hover td {
          background: var(--bg-subtle);
        }
        .outcomes__td-time {
          white-space: nowrap;
          color: var(--text-secondary) !important;
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        }
        .outcomes__td-action code,
        .outcomes__td-goal code {
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
          color: var(--accent-fg);
          font-size: 11px;
        }
        .outcomes__td-duration {
          white-space: nowrap;
          color: var(--text-secondary) !important;
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        }
      `})]})}export{M as default};
